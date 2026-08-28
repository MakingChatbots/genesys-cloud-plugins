import type platformClient from "purecloud-platform-client-v2";
import type { ArchitectApi } from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import type { ToolFactory } from "./types.ts";

const MAX_RETURNED_FLOWS = 50;
/**
 * Caps how many flows are fetched before ranking; exact-name ranking can only
 * consider fetched flows, so a match beyond this many API results is missed.
 */
const MAX_FETCHED_FLOWS = 200;

interface FlowSummary {
    id: string;
    name: string;
    type: string;
    publishedVersion: string | null;
    description?: string;
}

interface FindFlowResult {
    query: string;
    flows: FlowSummary[];
    total: number;
    notes?: string[];
}

function toWildcardQuery(name: string): string {
    return name.includes("*") ? name : `*${name}*`;
}

function toFlowSummary(flow: platformClient.Models.Flow): FlowSummary {
    return {
        id: flow.id ?? "",
        name: flow.name,
        type: flow.type ?? "",
        // Unpublished flows have no publishedVersion; null is reported rather
        // than a default so callers can tell "never published" apart.
        publishedVersion: flow.publishedVersion?.commitVersion ?? null,
        ...(flow.description ? { description: flow.description } : {}),
    };
}

export interface ToolConfig {
    architectApi: ArchitectApi;
}

const inputSchema = {
    name: z
        .string()
        .min(1)
        .describe(
            "The flow name, or a fragment of it, to search for. Matched " +
                "case-insensitively against flow names and descriptions as a " +
                "substring, so a partial name like 'payment' finds " +
                "'Book_Payment'. A `*` in the query is treated as a wildcard " +
                "and disables the automatic substring wrapping.",
        ),
    type: z
        .array(z.string())
        .optional()
        .describe(
            "Optional flow types to restrict the search to, e.g. " +
                '["inboundcall"], ["bot", "digitalbot"], ["workflow"]. ' +
                "Omit to search flows of every type.",
        ),
};

export const findFlow: ToolFactory<ToolConfig, typeof inputSchema> = ({
    architectApi,
}: ToolConfig) => ({
    config: {
        description:
            "Finds Genesys Cloud Architect flows by name, resolving the " +
            "human-readable name users know (e.g. 'Book_Payment') to the flow " +
            "id every other flow tool requires. Returns each matching flow's " +
            "id, name, type and published version. Matching is a " +
            "case-insensitive substring search over flow names and " +
            "descriptions; flows whose name equals the query exactly are " +
            "listed first. The returned id is accepted verbatim by flow_ir, " +
            "flow_action, search_in_flow and flow_dependencies. A " +
            "publishedVersion of null means the flow has never been " +
            "published.",
        annotations: {
            title: "Find Flow",
            readOnlyHint: true,
            destructiveHint: false,
        },
        inputSchema,
    },
    handler: async ({ name, type }) => {
        try {
            const flows: platformClient.Models.Flow[] = [];

            let total = 0;
            let pageNumber = 1;
            while (true) {
                const page = await architectApi.getFlows({
                    nameOrDescription: toWildcardQuery(name),
                    pageSize: 100,
                    pageNumber,
                    ...(type && type.length > 0 ? { type } : {}),
                });

                if (page.entities) flows.push(...page.entities);
                total = page.total ?? flows.length;

                if (!page.nextUri || flows.length >= MAX_FETCHED_FLOWS) break;

                pageNumber++;
            }

            const lowerName = name.toLowerCase();
            const ranked = flows
                .map((flow, index) => ({ flow, index }))
                .sort((a, b) => {
                    const aExact =
                        a.flow.name.toLowerCase() === lowerName ? 0 : 1;
                    const bExact =
                        b.flow.name.toLowerCase() === lowerName ? 0 : 1;
                    return aExact - bExact || a.index - b.index;
                })
                .map(({ flow }) => flow);

            const returned = ranked.slice(0, MAX_RETURNED_FLOWS);

            const notes: string[] = [];
            if (returned.length === 0) {
                notes.push(
                    `No flows matched "${name}". The search already covers ` +
                        "substrings of names and descriptions, so try a " +
                        "shorter fragment of the name, or drop the type " +
                        "filter if one was given.",
                );
            }

            if (total > returned.length) {
                notes.push(
                    `${total} flows matched; only ${returned.length} are ` +
                        "returned, exact name matches first. Use a longer " +
                        "fragment of the name to narrow the search.",
                );
            }

            const result: FindFlowResult = {
                query: name,
                flows: returned.map(toFlowSummary),
                total,
                ...(notes.length > 0 ? { notes } : {}),
            };
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
            };
        } catch (err) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Failed to search for flows: ${err instanceof Error ? err.message : String(err)}`,
                    },
                ],
            };
        }
    },
});
