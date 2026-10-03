import type platformClient from "purecloud-platform-client-v2";
import type { ArchitectApi } from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import { formatApiError } from "./api-error.ts";
import { isExactNameMatch, moveExactMatchToTop } from "./name-match.ts";
import type { ToolFactory } from "./types.ts";

const MAX_RETURNED_FLOWS = 50;
/**
 * Caps the API pages fetched; moveExactMatchToTop only sees fetched flows, so
 * an exactly-named flow beyond this many API results is missed.
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

/**
 * The Architect flows API splits the name filter on whitespace and requires
 * every word to match a whole token of the flow name, ANDed in any order.
 * Underscores do not split tokens, so a bare "Returns" misses
 * "UK_Returns_Desk Main Flow" and "Order Status" misses "Order_Status". Asterisk
 * wildcards are honoured inside a word, so wrap each word in them to get
 * "every word appears somewhere in the name" semantics. Wrapping the whole
 * query is not enough: "*Order Status*" becomes "*Order" and "Status*", which
 * both fail against the single token "Order_Status". Any asterisks the caller
 * already added are stripped so they aren't doubled up.
 */
export function toWildcardName(name: string): string {
    return name
        .trim()
        .split(/\s+/)
        .map((word) => `*${word.replace(/^\*+|\*+$/g, "")}*`)
        .join(" ");
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
            "The flow name, or some words from it, to search for. Every " +
                "word must appear somewhere in the flow name, " +
                "case-insensitively and in any order, so 'payment' finds " +
                "'Book_Payment' and 'Returns' finds 'UK_Returns_Desk Main Flow'. " +
                "Wildcards are added automatically; do not include " +
                "asterisks.",
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
            "case-insensitive search over flow names in which every word of " +
            "the query must appear somewhere in the name, in any order, so " +
            "a fragment of a word or a few words from the name both work; " +
            "flows whose name equals the query exactly are listed first. " +
            "The returned id is accepted verbatim by flow_ir, " +
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
            const wildcardName = toWildcardName(name);

            let total = 0;
            let pageNumber = 1;
            while (true) {
                const page = await architectApi.getFlows({
                    name: wildcardName,
                    pageSize: 100,
                    pageNumber,
                    ...(type?.length ? { type } : {}),
                });

                if (page.entities) flows.push(...page.entities);
                // A page may omit the optional total; keep the last value a
                // page reported rather than clobbering it.
                total = page.total ?? total;

                if (!page.nextUri || flows.length >= MAX_FETCHED_FLOWS) break;

                pageNumber++;
            }
            // If no page reported a total (or it undercounts what was
            // actually fetched), the fetched count is the better floor.
            total = Math.max(total, flows.length);

            const returned = moveExactMatchToTop(flows, name).slice(
                0,
                MAX_RETURNED_FLOWS,
            );

            const notes: string[] = [];
            if (returned.length === 0) {
                notes.push(
                    `No flows matched "${name}". Every word of the query ` +
                        "must appear in the flow name, so drop words you " +
                        "are unsure of (keep the most distinctive one), or " +
                        "drop the type filter if one was given.",
                );
            } else if (total > returned.length) {
                // Only claim exact-first ordering when an exact match was
                // actually fetched; moveExactMatchToTop puts it at index 0.
                let note = `${total} flows matched; only ${returned.length} are returned${
                    isExactNameMatch(returned[0], name)
                        ? ", exact name matches first"
                        : ""
                }.`;
                if (flows.length < total) {
                    note +=
                        ` Only the first ${flows.length} matches were ` +
                        `fetched, so a flow named exactly "${name}" beyond ` +
                        "those would be missing.";
                }
                note +=
                    " Use a longer fragment of the name to narrow the search.";
                notes.push(note);
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
                        text: `Failed to search for flows: ${formatApiError(err)}`,
                    },
                ],
            };
        }
    },
});
