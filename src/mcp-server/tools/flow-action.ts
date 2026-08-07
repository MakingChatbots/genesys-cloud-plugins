import {
    findRawActions,
    type RawActionLookup,
} from "@makingchatbots/genesys-cloud-architect-diagram-lib";
import type { ArchitectApi } from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import type { ToolFactory } from "./types.ts";

export interface ToolConfig {
    architectApi: ArchitectApi;
}

/** Caps the response size; one flow's configuration serves the whole batch. */
const MAX_ACTION_IDS = 25;

/**
 * Map each requested id to the action id to look up, tolerating the synthetic
 * node ids `flow_ir` emits.
 *
 * A branch-output node id is `<actionId>::<outputId>`, so it embeds the real
 * GUID losslessly: stripping the suffix is strictly more useful than rejecting
 * the id, which would force callers to hand-edit ids they copied straight out of
 * a trace. Ids stripping to the same GUID collapse to one lookup and are
 * reported under whichever form was requested first. `<taskId>::start` strips to
 * a task id, which matches no action and so lands in `notFound` without needing
 * a special case.
 */
function planLookups(requestedIds: readonly string[]): {
    lookupIds: string[];
    requestedFor: Map<string, string>;
    strippedAny: boolean;
} {
    const lookupIds: string[] = [];
    const requestedFor = new Map<string, string>();
    let strippedAny = false;

    for (const requested of requestedIds) {
        // An id that is only a suffix (`::x`) has no GUID to recover, so it is
        // looked up as-is and reported as not found.
        const lookupId = requested.split("::")[0] || requested;
        if (lookupId !== requested) {
            strippedAny = true;
        }
        if (!requestedFor.has(lookupId)) {
            requestedFor.set(lookupId, requested);
            lookupIds.push(lookupId);
        }
    }

    return { lookupIds, requestedFor, strippedAny };
}

const inputSchema = {
    flowId: z.string().min(1).describe("The Genesys Cloud Architect flow ID"),
    actionIds: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_ACTION_IDS)
        .describe(
            "Action GUIDs, taken from the `id` of flow_ir nodes whose `kind` is " +
                '"action". Batch every action of interest into one call rather than ' +
                "calling this tool repeatedly. Branch-output ids of the form " +
                "`<actionId>::<outputId>` are also accepted; the suffix is stripped and " +
                `the underlying action is returned. Maximum ${MAX_ACTION_IDS} ids.`,
        ),
};

export const flowAction: ToolFactory<ToolConfig, typeof inputSchema> = ({
    architectApi,
}: ToolConfig) => ({
    config: {
        description:
            "Retrieves the raw Architect configuration of specific actions in a Genesys Cloud " +
            "Architect flow: decision expressions, prompt text, data action inputs and outputs, " +
            "and any other per-action settings that the flow_ir tool omits. " +
            "Use flow_ir first to find action ids and to understand the control flow, then use " +
            "this tool to find out what an action actually does. " +
            "Do not use the raw fields returned here to make control-flow claims: flow_ir has " +
            "already resolved those, and its answer accounts for branches the raw " +
            "configuration does not reflect.",
        annotations: {
            title: "Flow Action",
            readOnlyHint: true,
            destructiveHint: false,
        },
        inputSchema,
    },
    handler: async ({ flowId, actionIds }) => {
        let configuration: unknown;
        try {
            configuration =
                await architectApi.getFlowLatestconfiguration(flowId);
        } catch {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Flow "${flowId}" not found or not accessible.`,
                    },
                ],
            };
        }

        const { lookupIds, requestedFor, strippedAny } = planLookups(actionIds);
        // `findRawActions` never throws and always answers for every id, so a
        // batch where nothing matched is still a successful lookup.
        const lookup = findRawActions(configuration, lookupIds);
        const asRequested = (entry: RawActionLookup): RawActionLookup => ({
            ...entry,
            actionId: requestedFor.get(entry.actionId) ?? entry.actionId,
        });

        const notes: string[] = [];
        if (strippedAny) {
            notes.push(
                "Some requested ids were flow_ir synthetic node ids of the form " +
                    "<actionId>::<outputId>; the suffix was stripped and the underlying action " +
                    "looked up, then reported under the id as requested. A <taskId>::start id " +
                    "identifies a task rather than an action, so it never matches.",
            );
        }
        if (lookup.notFound.length > 0) {
            notes.push(
                "Ids in notFound are absent from this flow's latest configuration. The flow " +
                    "may have been redeployed since flow_ir was called, so re-run flow_ir and " +
                    "re-join rather than concluding those actions no longer exist.",
            );
        }

        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        flowId,
                        found: lookup.found.map(asRequested),
                        notFound: lookup.notFound.map(
                            (id) => requestedFor.get(id) ?? id,
                        ),
                        ...(notes.length > 0 ? { notes } : {}),
                    }),
                },
            ],
        };
    },
});
