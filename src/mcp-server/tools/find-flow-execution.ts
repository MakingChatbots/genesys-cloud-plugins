import type { ArchitectApi, Models } from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import { authHint, formatApiError, toApiError } from "./api-error.ts";
import type { ToolFactory } from "./types.ts";

/** The API's own ceiling on results per query, per the help centre. */
const MAX_RESULTS = 200;

/** How long Genesys Cloud keeps execution data, per the help centre. */
const RETENTION_DAYS = 10;

interface FlowExecutionSummary {
    /** The flow instance id; pass it to flow_execution_data as executionId. */
    executionId: string;
    flowId: string | null;
    flowName: string | null;
    flowType: string | null;
    flowVersion: string | null;
    conversationId: string | null;
    workitemId?: string;
    startDateTime: string | null;
    endDateTime: string | null;
    flowErrorReason?: string;
    flowWarningReason?: string;
}

interface FindFlowExecutionResult {
    query: {
        conversationId?: string;
        flowId?: string;
        onlyWithErrors?: boolean;
    };
    executions: FlowExecutionSummary[];
    total: number;
    notes?: string[];
}

/**
 * The API reports "NONE" rather than omitting a reason, so a caller filtering
 * on presence would see every instance as errored. Normalise to absence.
 */
function reasonOrUndefined(reason: string | undefined): string | undefined {
    return reason && reason !== "NONE" ? reason : undefined;
}

function toSummary(
    entry: Models.FlowExecutionDataQueryResult,
): FlowExecutionSummary {
    const flowErrorReason = reasonOrUndefined(entry.flowErrorReason);
    const flowWarningReason = reasonOrUndefined(entry.flowWarningReason);
    return {
        executionId: entry.id ?? "",
        flowId: entry.flowId ?? null,
        flowName: entry.flowName ?? null,
        flowType: entry.flowType ?? null,
        flowVersion: entry.flowVersion ?? null,
        conversationId: entry.conversationId ?? null,
        ...(entry.workitemId ? { workitemId: entry.workitemId } : {}),
        startDateTime: entry.startDateTime ?? null,
        endDateTime: entry.endDateTime ?? null,
        ...(flowErrorReason ? { flowErrorReason } : {}),
        ...(flowWarningReason ? { flowWarningReason } : {}),
    };
}

function byStartTime(a: FlowExecutionSummary, b: FlowExecutionSummary): number {
    return (a.startDateTime ?? "").localeCompare(b.startDateTime ?? "");
}

/**
 * Best-effort check of the org-wide storage switch, used only to explain an
 * empty result. Needs a permission the search itself does not, so a failure
 * here is swallowed rather than turned into an error.
 */
async function storageEnabled(
    architectApi: ArchitectApi,
): Promise<boolean | undefined> {
    try {
        const settings =
            await architectApi.getFlowsInstancesSettingsExecutiondata();
        return settings.enabled;
    } catch {
        return undefined;
    }
}

export interface ToolConfig {
    architectApi: ArchitectApi;
}

const inputSchema = {
    conversationId: z
        .string()
        .min(1)
        .optional()
        .describe(
            "The Genesys Cloud conversation id. Returns every flow instance " +
                "that conversation ran, so a call that went through an inbound " +
                "flow and then an in-queue flow yields two entries. Preferred " +
                "filter: it is what the API indexes on.",
        ),
    flowId: z
        .string()
        .min(1)
        .optional()
        .describe(
            "The Architect flow id. Returns recent instances of that flow, " +
                "whichever conversation ran them. Combine with conversationId " +
                "to pick one flow out of a conversation.",
        ),
    onlyWithErrors: z
        .boolean()
        .optional()
        .describe(
            "When true, only instances that ended with a flow error are " +
                "returned (flowErrorReason is set). Applied to the instances " +
                "the query fetched, so with a busy flow the errored runs " +
                "beyond the API's 200-instance cap are not seen. Use it to " +
                "find the runs worth inspecting with flow_execution_data.",
        ),
};

export const findFlowExecution: ToolFactory<ToolConfig, typeof inputSchema> = ({
    architectApi,
}: ToolConfig) => ({
    config: {
        description:
            "Finds the recorded executions (flow instances) of Genesys Cloud " +
            "Architect flows, by conversation id and/or flow id. Returns each " +
            "instance's executionId, flow id/name/type/version, conversationId, " +
            "start and end times, and any flowErrorReason or flowWarningReason, " +
            "oldest first. Use it to answer 'what did this conversation do' or " +
            "'has this flow been failing', then pass an executionId to " +
            "flow_execution_data for the action-by-action log. Only the last " +
            `${RETENTION_DAYS} days are retained, the API cannot filter by date, and at most ` +
            `${MAX_RESULTS} instances are returned per query, so prefer conversationId. ` +
            "A run is listed only once it has ended. test_bot_flow runs have no " +
            "conversation id, so find them by flowId or pass their sessionId " +
            "straight to flow_execution_data.",
        annotations: {
            title: "Find Flow Execution",
            readOnlyHint: true,
            destructiveHint: false,
        },
        inputSchema,
    },
    handler: async ({ conversationId, flowId, onlyWithErrors }) => {
        if (!conversationId && !flowId) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: "Provide a conversationId, a flowId, or both.",
                    },
                ],
            };
        }

        const criteria: Models.CriteriaItem[] = [];
        if (conversationId) {
            criteria.push({
                key: "ConversationId",
                operator: "eq",
                value: conversationId,
            });
        }
        if (flowId) {
            criteria.push({ key: "FlowId", operator: "eq", value: flowId });
        }

        try {
            const page = await architectApi.postFlowsInstancesQuery(
                { query: [{ and: criteria }] },
                { pageSize: MAX_RESULTS },
            );
            // The API's query operators are eq/gt/gte/lt/lte/begins, with no
            // negation or null test, so "has an error" is filtered here.
            const fetched = (page.entities ?? []).map(toSummary);
            const executions = (
                onlyWithErrors
                    ? fetched.filter((e) => e.flowErrorReason !== undefined)
                    : fetched
            ).sort(byStartTime);
            const total = Math.max(page.total ?? 0, fetched.length);

            const notes: string[] = [];
            if (
                onlyWithErrors &&
                executions.length === 0 &&
                fetched.length > 0
            ) {
                notes.push(
                    `None of the ${fetched.length} instance(s) fetched ended with a flow ` +
                        "error. Drop onlyWithErrors to see them.",
                );
            } else if (executions.length === 0) {
                const enabled = await storageEnabled(architectApi);
                if (enabled === false) {
                    notes.push(
                        "No instances matched, and execution data storage is " +
                            "disabled for this org (Architect > Settings > Execution " +
                            "data), so none are being recorded.",
                    );
                } else {
                    notes.push(
                        "No instances matched. A run is listed only after it ends; " +
                            `execution data is kept for ${RETENTION_DAYS} days and is only ` +
                            "captured for flows published after storage was enabled " +
                            "(republish older flows); and test_bot_flow runs have no " +
                            "conversation id, so search for them by flowId. Check the " +
                            "id, or query by flowId to see whether the flow records " +
                            "anything at all.",
                    );
                }
            } else if (total > fetched.length) {
                notes.push(
                    `${total} instances matched but only ${fetched.length} were ` +
                        "fetched. Narrow the query with a conversationId.",
                );
            } else if (fetched.length >= MAX_RESULTS) {
                notes.push(
                    `The API caps results at ${MAX_RESULTS}; older instances may exist.`,
                );
            }

            const result: FindFlowExecutionResult = {
                query: {
                    ...(conversationId ? { conversationId } : {}),
                    ...(flowId ? { flowId } : {}),
                    ...(onlyWithErrors ? { onlyWithErrors } : {}),
                },
                executions,
                total,
                ...(notes.length > 0 ? { notes } : {}),
            };
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
            };
        } catch (err) {
            const { status } = toApiError(err);
            const hint =
                status === 400
                    ? " The query was rejected; check that the conversationId and flowId are well-formed Genesys Cloud ids."
                    : authHint(status, "Architect > Flow Instance > Search");
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Failed to search for flow executions: ${formatApiError(err)}${hint}`,
                    },
                ],
            };
        }
    },
});
