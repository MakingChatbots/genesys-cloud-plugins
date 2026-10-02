import {
    type ExecutionActionNotExecuted,
    type ExecutionEvent,
    type ExecutionSummary,
    findExecutionVariable,
    joinExecutionWithIr,
    parseExecution,
    parseFlow,
} from "@makingchatbots/genesys-cloud-architect-diagram-lib";
import type { ArchitectApi, Models } from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import { formatApiError, toApiError } from "./api-error.ts";
import { fetchFlowConfiguration } from "./fetch-flow-configuration.ts";
import type { ToolFactory } from "./types.ts";

/**
 * Retrieval is a job: the first GET registers it and later GETs report its
 * state. Observed jobs for a single instance complete within a few seconds,
 * so polling is cheap, but the cap keeps a stuck job from pinning the MCP
 * client's own tool timeout.
 */
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_WAIT_MS = 45_000;

/** How long Genesys Cloud keeps execution data, per the help centre. */
const RETENTION_DAYS = 10;

type JobResult = Models.GetFlowExecutionDataJobResult;

export interface ToolConfig {
    architectApi: ArchitectApi;
    /** Fetches the job's download URI. Overridable for offline verification. */
    download?: (uri: string) => Promise<unknown>;
    pollIntervalMs?: number;
    maxWaitMs?: number;
}

interface FlowExecutionDataResult {
    executionId: string;
    /** Taken from the flow's own variables; null on `test_bot_flow` runs. */
    conversationId: string | null;
    durationMs: number | null;
    flowExitReason: string | null;
    logLevel: string | null;
    summary: ExecutionSummary;
    events: ExecutionEvent[];
    ir?: {
        /** Which flow configuration the join used. */
        configuration: { flowVersion: string } | { latest: true };
        unmatchedActionIds: string[];
        unmatchedStateIds: string[];
        actionsNotExecuted: ExecutionActionNotExecuted[];
        warnings: unknown[];
    };
    notes?: string[];
    /** Every other top-level field of the instance, passed through untouched. */
    [field: string]: unknown;
}

class ExecutionDataError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function defaultDownload(uri: string): Promise<unknown> {
    // The URI is a pre-signed file link: it carries its own authorisation, and
    // adding the platform bearer token would only invalidate the signature.
    const response = await fetch(uri);
    if (!response.ok) {
        throw new ExecutionDataError(
            `Downloading the execution data file failed with HTTP ${response.status}.`,
        );
    }
    return response.json();
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isComplete(job: JobResult): boolean {
    if (job.jobState === "Success" || job.jobState === "Failed") return true;
    // Defensive: a response that already carries results is complete whatever
    // its state field says (or omits).
    return (
        job.entities?.some((e) => e.downloadUri || e.failed === true) ?? false
    );
}

async function awaitJob(
    architectApi: ArchitectApi,
    first: JobResult,
    pollIntervalMs: number,
    maxWaitMs: number,
): Promise<JobResult> {
    let job = first;
    const deadline = Date.now() + maxWaitMs;
    while (!isComplete(job)) {
        if (!job.id) {
            throw new ExecutionDataError(
                `The retrieval job reported state "${job.jobState ?? "unknown"}" without a job id to poll.`,
            );
        }
        if (Date.now() >= deadline) {
            throw new ExecutionDataError(
                `The retrieval job (${job.id}) was still "${job.jobState ?? "unknown"}" after ${Math.round(maxWaitMs / 1000)}s. Retry shortly; the job may complete on its own.`,
            );
        }
        await sleep(pollIntervalMs);
        job = await architectApi.getFlowsInstancesJob(job.id);
    }
    return job;
}

function describeNotFound(executionId: string): string {
    return (
        `No execution data exists for execution id "${executionId}". Either the ` +
        "id is wrong (it is the flow instance id, which for test_bot_flow runs is " +
        "the sessionId it returned, not a conversation id or flow id), the run is " +
        `older than the ${RETENTION_DAYS}-day retention period, the flow was last ` +
        "published before execution data storage was enabled for the org (flows " +
        "must be republished after enabling it), or storage is disabled. Use " +
        "find_flow_execution with a conversationId to list the instances that do exist."
    );
}

function describeEntityFailure(
    executionId: string,
    entity: Models.ExecutionDataEntity,
): string {
    switch (entity.statusCode) {
        case "404":
            return describeNotFound(executionId);
        case "403":
            return (
                `Not authorised to read execution data for "${executionId}" (403): the ` +
                "OAuth client needs the 'Architect > Flow Instance > View' permission " +
                "and division access to the flow."
            );
        default:
            return (
                `Retrieving execution data for "${executionId}" failed` +
                (entity.statusCode ? ` (HTTP ${entity.statusCode})` : "") +
                "."
            );
    }
}

function describeApiFailure(executionId: string, err: unknown): string {
    if (err instanceof ExecutionDataError) return err.message;
    const { status } = toApiError(err);
    if (status === 404) return describeNotFound(executionId);
    if (status === 403) {
        return (
            `Not authorised to read execution data (403): the OAuth client needs the ` +
            "'Architect > Flow Instance > View' permission."
        );
    }
    return `Failed to retrieve execution data for "${executionId}": ${formatApiError(err)}`;
}

/** Unwrap the downloaded file, `{ "flow": {...} }`, tolerating a bare flow. */
function unwrapFlow(body: unknown): Record<string, unknown> {
    if (
        isRecord(body) &&
        isRecord(body.flow) &&
        Array.isArray(body.flow.execution)
    ) {
        return body.flow;
    }
    if (isRecord(body) && Array.isArray(body.execution)) {
        return body;
    }
    const keys = isRecord(body) ? Object.keys(body).join(", ") : typeof body;
    throw new ExecutionDataError(
        `The downloaded execution data had an unexpected shape (top-level: ${keys}); ` +
            "expected { flow: { execution: [...] } }.",
    );
}

const inputSchema = {
    executionId: z
        .string()
        .min(1)
        .describe(
            "The flow instance (execution) id. This is the `id` of an entry " +
                "returned by find_flow_execution, or the sessionId returned by " +
                "test_bot_flow. It is not a conversation id or a flow id.",
        ),
    includeIr: z
        .boolean()
        .default(true)
        .describe(
            "Default true. Joins each action event to the flow's IR (the same " +
                "graph flow_ir returns) using actionId, adding the action's type, " +
                "task and outgoing edges, and lists the IR actions this instance " +
                "never executed. Costs one extra flow configuration fetch. Set false " +
                "when only the raw event log is wanted.",
        ),
};

export const flowExecutionData: ToolFactory<ToolConfig, typeof inputSchema> = ({
    architectApi,
    download = defaultDownload,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
}: ToolConfig) => ({
    config: {
        description:
            "Retrieves the historical execution data of one run of a Genesys Cloud " +
            "Architect flow: the ordered log of what that single conversation " +
            "actually did, action by action, with timestamps, the messages sent and " +
            "received, the branch each decision or menu took, variable assignments, " +
            "errors and the exit reason. Use it to see how a customer traversed a " +
            "flow, to find loops and retries (summary.repeatedActions for actions " +
            "run more than once, summary.loops for Loop actions and their iteration " +
            "counts, summary.asksWithRetries for asks that re-prompted), errors " +
            "(eventError events with a relatedAction) and dead ends, or to confirm a " +
            "flow is behaving. flow_ir " +
            "shows what could happen; this shows what did happen, this time. " +
            "Each action event's actionId is the id of the flow_ir node whose kind " +
            'is "action", and is accepted verbatim by flow_action. An action\'s ' +
            "outputPathId names the branch it took; joined to the IR it is the " +
            "branch-output node <actionId>::<outputPathId> (ir.takenBranch). Event " +
            "kinds are usually named action<Type> for IR actionType <Type>Action " +
            "(actionCommunicate is CommunicateAction, actionDecision is " +
            "DecisionAction), with exceptions: actionUpdateData is " +
            "UpdateVariableAction, actionJumpToTask is TransferTaskAction and " +
            "actionAskForIntent is AskForNLUIntentAction; the ir.actionType " +
            "annotation on each event is authoritative. " +
            "events[] is in execution order; the IR's `order` field is not and must " +
            "not be used for sequencing. trackingId is the action number shown in " +
            "the Architect UI; gaps in it are authoring history, not missing actions. " +
            "The instance's logLevel governs which sections exist: below 'all', " +
            "variables and communications may be absent or empty, which is expected " +
            "rather than an error. Pass the sessionId from test_bot_flow to see " +
            "exactly how a test run traversed the flow; data is available seconds " +
            "after the run ends, and such runs have a null conversationId.",
        annotations: {
            title: "Flow Execution Data",
            readOnlyHint: true,
            destructiveHint: false,
        },
        inputSchema,
    },
    handler: async ({ executionId, includeIr }) => {
        let flow: Record<string, unknown>;
        try {
            const first = await architectApi.getFlowsInstance(executionId);
            const job = await awaitJob(
                architectApi,
                first,
                pollIntervalMs,
                maxWaitMs,
            );
            const entity =
                job.entities?.find((e) => e.id === executionId) ??
                job.entities?.[0];
            if (job.jobState === "Failed" && !entity) {
                throw new ExecutionDataError(
                    `The retrieval job (${job.id ?? "unknown id"}) failed without reporting a cause.`,
                );
            }
            if (!entity) {
                throw new ExecutionDataError(
                    `The retrieval job (${job.id ?? "unknown id"}) completed with no results.`,
                );
            }
            if (entity.failed || !entity.downloadUri) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: describeEntityFailure(executionId, entity),
                        },
                    ],
                };
            }
            flow = unwrapFlow(await download(entity.downloadUri));
        } catch (err) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: describeApiFailure(executionId, err),
                    },
                ],
            };
        }

        const { execution, ...metadata } = flow;
        const parsed = parseExecution(execution);
        let events: ExecutionEvent[] = parsed.events;
        const summary = parsed.summary;
        const notes: string[] = [];

        const endedFlow = events.find((e) => e.kind === "endedFlow");
        const flowExitReason =
            typeof endedFlow?.flowExitReason === "string"
                ? endedFlow.flowExitReason
                : null;
        if (!endedFlow) {
            notes.push(
                "No endedFlow event: the run had not finished when the data was " +
                    "captured, or the log was cut short. Do not treat the last event " +
                    "as where the flow ended.",
            );
        }

        const conversationId = findExecutionVariable(events, ".ConversationId");
        const logLevel = isRecord(metadata.executionInfo)
            ? metadata.executionInfo.logLevel
            : undefined;
        if (typeof logLevel === "string" && logLevel.toLowerCase() !== "all") {
            notes.push(
                `This instance was captured at log level "${logLevel}". Variable ` +
                    "values, communications or action inputs/outputs may be absent " +
                    "because they were not recorded, not because they did not happen.",
            );
        }
        if (metadata.isTruncated === true) {
            notes.push(
                "isTruncated is true: the log was cut off by the execution cap, so " +
                    "later actions ran without being recorded.",
            );
        }
        if (summary.repeatedActions.length > 0) {
            notes.push(
                `${summary.repeatedActions.length} action(s) executed more than once; ` +
                    "see summary.repeatedActions and each occurrence's executionId to " +
                    "tell iterations apart.",
            );
        }
        if (summary.asksWithRetries.length > 0) {
            notes.push(
                `${summary.asksWithRetries.length} ask/menu action(s) needed more than ` +
                    "one participant input (summary.asksWithRetries); the retries " +
                    "are the turns inside that event's execution[], not repeated actions.",
            );
        }
        const errorCount = summary.eventKinds.eventError ?? 0;
        if (errorCount > 0) {
            notes.push(
                `${errorCount} eventError event(s) occurred; each one's relatedAction ` +
                    "names the action that was executing (matched on " +
                    "context.executionId), and context.reason gives the cause.",
            );
        }

        const start = Date.parse(String(metadata.startDateTime));
        const end = Date.parse(String(metadata.endDateTime));
        const durationMs =
            Number.isFinite(start) && Number.isFinite(end) ? end - start : null;

        let ir: FlowExecutionDataResult["ir"];
        if (includeIr) {
            const flowId =
                typeof metadata.flowId === "string"
                    ? metadata.flowId
                    : undefined;
            const flowVersion =
                typeof metadata.flowVersion === "string"
                    ? metadata.flowVersion
                    : undefined;
            if (!flowId) {
                notes.push(
                    "The execution data carried no flowId, so no IR join was possible.",
                );
            } else {
                const fetched = await fetchConfiguration(
                    architectApi,
                    flowId,
                    flowVersion,
                    notes,
                );
                if (fetched) {
                    const parsedFlow = parseFlow(fetched.configuration);
                    if (!parsedFlow.ok) {
                        notes.push(
                            `The flow configuration could not be parsed into an IR ` +
                                `(${parsedFlow.error.code}: ${parsedFlow.error.message}); events are unjoined.`,
                        );
                    } else {
                        const joined = joinExecutionWithIr(
                            events,
                            parsedFlow.ir,
                        );
                        events = joined.events;
                        ir = {
                            configuration: fetched.configuration_source,
                            unmatchedActionIds: joined.unmatchedActionIds,
                            unmatchedStateIds: joined.unmatchedStateIds,
                            actionsNotExecuted: joined.actionsNotExecuted,
                            warnings: parsedFlow.warnings,
                        };
                        if (joined.unmatchedActionIds.length > 0) {
                            notes.push(
                                `${joined.unmatchedActionIds.length} executed action id(s) ` +
                                    "have no node in the IR (ir.unmatchedActionIds). If the " +
                                    "join used the latest configuration rather than the " +
                                    "version that ran, the flow has probably been redeployed " +
                                    "since; otherwise the action may live in a called common " +
                                    "module or bot flow, which the parent's IR does not contain.",
                            );
                        }
                    }
                }
            }
        }

        const result: FlowExecutionDataResult = {
            ...metadata,
            executionId:
                typeof metadata.executionId === "string"
                    ? metadata.executionId
                    : executionId,
            conversationId:
                typeof conversationId === "string" ? conversationId : null,
            durationMs,
            flowExitReason,
            logLevel: typeof logLevel === "string" ? logLevel : null,
            summary,
            events,
            ...(ir ? { ir } : {}),
            ...(notes.length > 0 ? { notes } : {}),
        };
        return {
            content: [{ type: "text", text: JSON.stringify(result) }],
        };
    },
});

/**
 * Prefer the configuration of the version that actually ran, so the join
 * reflects the flow as the customer experienced it; fall back to the latest
 * configuration (what flow_ir uses) when the version is unknown or gone.
 */
async function fetchConfiguration(
    architectApi: ArchitectApi,
    flowId: string,
    flowVersion: string | undefined,
    notes: string[],
): Promise<
    | {
          configuration: unknown;
          configuration_source: { flowVersion: string } | { latest: true };
      }
    | undefined
> {
    if (flowVersion) {
        try {
            const configuration =
                await architectApi.getFlowVersionConfiguration(
                    flowId,
                    flowVersion,
                );
            return {
                configuration,
                configuration_source: { flowVersion },
            };
        } catch (err) {
            if (toApiError(err).status === 410) {
                // Deleted flows have no latest configuration either.
                notes.push(
                    "IR join skipped: the flow has been deleted, so no configuration " +
                        "can be fetched. The events are still complete; only the " +
                        "ir annotations and actionsNotExecuted are unavailable.",
                );
                return undefined;
            }
            notes.push(
                `Could not fetch the configuration of flow version ${flowVersion} ` +
                    `(${formatApiError(err)}); the IR join used the latest ` +
                    "configuration instead, which may differ from what ran.",
            );
        }
    } else {
        notes.push(
            "The execution data carried no flowVersion; the IR join used the " +
                "latest configuration, which may differ from what ran.",
        );
    }
    const latest = await fetchFlowConfiguration(architectApi, flowId);
    if (!latest.ok) {
        notes.push(`IR join skipped: ${latest.message}`);
        return undefined;
    }
    return {
        configuration: latest.configuration,
        configuration_source: { latest: true },
    };
}
