import type platformClient from "purecloud-platform-client-v2";
import type { ArchitectApi } from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import type { ToolFactory } from "./types.ts";

function flowTypeToObjectType(flowType: string): string {
    const upper = flowType.toUpperCase();
    return upper.endsWith("FLOW") ? upper : `${upper}FLOW`;
}

interface DependencyEntry {
    id: string;
    name: string;
    version?: string;
    deleted: boolean;
    updated: boolean;
}

interface FlowDependenciesResult {
    flow: { id: string; name: string; type: string; version: string };
    dependencies: Record<string, DependencyEntry[]>;
}

function buildResult(
    flow: platformClient.Models.Flow,
    deps: platformClient.Models.Dependency[],
): FlowDependenciesResult {
    const grouped: Record<string, DependencyEntry[]> = {};
    for (const dep of deps) {
        const type = dep.type ?? "UNKNOWN";
        if (!grouped[type]) grouped[type] = [];
        grouped[type].push({
            id: dep.id ?? "",
            name: dep.name ?? "",
            ...(dep.version ? { version: dep.version } : {}),
            deleted: dep.deleted ?? false,
            updated: dep.updated ?? false,
        });
    }
    return {
        flow: {
            id: flow.id ?? "",
            name: flow.name,
            type: flowTypeToObjectType(flow.type ?? ""),
            version: flow.publishedVersion?.commitVersion ?? "1",
        },
        dependencies: grouped,
    };
}

export interface ToolConfig {
    architectApi: ArchitectApi;
}

const inputSchema = {
    flowId: z.string().min(1).describe("The Genesys Cloud Architect flow ID"),
};

export const flowDependencies: ToolFactory<ToolConfig, typeof inputSchema> = ({
    architectApi,
}: ToolConfig) => ({
    config: {
        description:
            "Retrieves all dependencies consumed by a Genesys Cloud Architect flow. " +
            "Returns the flow metadata and its dependencies grouped by type.",
        annotations: {
            title: "Flow Dependencies",
            readOnlyHint: true,
            destructiveHint: false,
        },
        inputSchema,
    },
    handler: async ({ flowId }) => {
        try {
            let flow: platformClient.Models.Flow;
            try {
                flow = await architectApi.getFlow(flowId);
            } catch {
                return {
                    isError: true,
                    content: [
                        { type: "text", text: `Flow "${flowId}" not found.` },
                    ],
                };
            }

            const objectType = flowTypeToObjectType(flow.type ?? "");
            const version = flow.publishedVersion?.commitVersion ?? "1";

            const deps: platformClient.Models.Dependency[] = [];
            let pageNumber = 1;
            while (true) {
                const page =
                    await architectApi.getArchitectDependencytrackingConsumedresources(
                        flow.id as string,
                        version,
                        objectType,
                        { pageSize: 100, pageNumber },
                    );
                if (page.entities) deps.push(...page.entities);
                if (!page.nextUri) break;
                pageNumber++;
            }

            const result = buildResult(flow, deps);
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
            };
        } catch (err) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Failed to retrieve flow dependencies: ${err instanceof Error ? err.message : String(err)}`,
                    },
                ],
            };
        }
    },
});
