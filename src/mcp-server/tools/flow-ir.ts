import {
    type IRTask,
    parseFlow,
} from "@makingchatbots/genesys-cloud-architect-diagram-lib";
import type { ArchitectApi } from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import { fetchFlowConfiguration } from "./fetch-flow-configuration.ts";
import type { ToolFactory } from "./types.ts";

/**
 * Resolve a task by exact id first, then by case-insensitive name. Task names
 * are not unique in Genesys Cloud, so a name matching several tasks is refused rather
 * than silently resolved to the first, leaving the caller to retry with an id.
 */
function findTask(
    tasks: readonly IRTask[],
    query: string,
): { match: IRTask } | { ambiguous: IRTask[] } | undefined {
    const byId = tasks.find((t) => t.id === query);
    if (byId) {
        return { match: byId };
    }
    const lowered = query.toLowerCase();
    const byName = tasks.filter((t) => t.name.toLowerCase() === lowered);
    if (byName.length > 1) {
        return { ambiguous: byName };
    }
    return byName[0] ? { match: byName[0] } : undefined;
}

export interface ToolConfig {
    architectApi: ArchitectApi;
}

const inputSchema = {
    flowId: z.string().min(1).describe("The Genesys Cloud Architect flow ID"),
    task: z
        .string()
        .min(1)
        .optional()
        .describe(
            "Optional. Restrict the returned nodes to a single task, by task id or " +
                "task name (case-insensitive). Use this to explore a large flow one " +
                "task at a time. The full task list is always returned, and a node's " +
                "predecessors and successors may reference nodes in other tasks, which " +
                "will not appear in the filtered node list.",
        ),
};

export const flowIr: ToolFactory<ToolConfig, typeof inputSchema> = ({
    architectApi,
}: ToolConfig) => ({
    config: {
        description:
            "Retrieves the intermediate representation (IR) of a Genesys Cloud Architect flow: " +
            "a flat, ordered list of its actions with the branches connecting them. " +
            "Use this to understand what an existing flow does. It answers what follows an " +
            "action, which branch leads where, which actions are unreachable, and how tasks " +
            "call each other.",
        annotations: {
            title: "Flow IR",
            readOnlyHint: true,
            destructiveHint: false,
        },
        inputSchema,
    },
    handler: async ({ flowId, task }) => {
        const fetched = await fetchFlowConfiguration(architectApi, flowId);
        if (!fetched.ok) {
            return {
                isError: true,
                content: [{ type: "text", text: fetched.message }],
            };
        }

        const result = parseFlow(fetched.configuration);

        if (!result.ok) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Failed to parse flow "${flowId}" (${result.error.code}): ${result.error.message}`,
                    },
                ],
            };
        }

        let ir = result.ir;
        if (typeof task === "string") {
            const found = findTask(ir.tasks, task);
            if (!found) {
                const available = ir.tasks.map((t) => t.name).join(", ");
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text:
                                `No task matching "${task}" in flow "${flowId}". ` +
                                `Available tasks: ${available || "(none)"}.`,
                        },
                    ],
                };
            }
            if ("ambiguous" in found) {
                const candidates = found.ambiguous
                    .map((t) => `"${t.name}" (id: ${t.id})`)
                    .join(", ");
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text:
                                `Task name "${task}" is ambiguous in flow "${flowId}". ` +
                                `It matches ${candidates}. Retry with the task id.`,
                        },
                    ],
                };
            }
            // `tasks` deliberately whole so other tasks stay discoverable
            ir = {
                ...ir,
                nodes: ir.nodes.filter(
                    (node) => node.taskId === found.match.id,
                ),
            };
        }

        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        flowId,
                        ir,
                        warnings: result.warnings,
                    }),
                },
            ],
        };
    },
});
