import type platformClient from "purecloud-platform-client-v2";
import type { RoutingApi } from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import { formatApiError, toApiError } from "./api-error.ts";
import { isExactNameMatch, moveExactMatchToTop } from "./name-match.ts";
import type { ToolFactory } from "./types.ts";

const MAX_RETURNED_QUEUES = 50;
const MAX_FETCHED_QUEUES = 200;

interface EntityRef {
    id: string;
    name?: string;
}

interface QueueSummary {
    id: string;
    name: string;
    division: EntityRef | null;
    /** Agents configured on the queue. */
    memberCount: number | null;
    /** Agents currently joined to the queue, i.e. taking work from it. */
    joinedMemberCount: number | null;
    dateModified: string | null;
    description?: string;
    queueFlow?: EntityRef;
    emailInQueueFlow?: EntityRef;
    messageInQueueFlow?: EntityRef;
}

interface FindQueueResult {
    query: string;
    queues: QueueSummary[];
    total: number;
    notes?: string[];
}

/**
 * The Routing API's name filter is an exact match unless the value carries
 * leading/trailing asterisks, unlike the Architect flows API which matches a
 * fragment natively. Wrap the fragment so both find_* tools behave alike, and
 * strip any asterisks the caller already added so they aren't doubled up.
 */
function toWildcardName(name: string): string {
    const fragment = name.trim().replace(/^\*+|\*+$/g, "");
    return `*${fragment}*`;
}

function toEntityRef(
    ref: { id?: string; name?: string } | undefined,
): EntityRef | undefined {
    if (!ref?.id) return undefined;
    return { id: ref.id, ...(ref.name ? { name: ref.name } : {}) };
}

function toQueueSummary(queue: platformClient.Models.Queue): QueueSummary {
    const queueFlow = toEntityRef(queue.queueFlow);
    const emailInQueueFlow = toEntityRef(queue.emailInQueueFlow);
    const messageInQueueFlow = toEntityRef(queue.messageInQueueFlow);
    return {
        id: queue.id ?? "",
        name: queue.name ?? "",
        division: toEntityRef(queue.division) ?? null,
        memberCount: queue.memberCount ?? null,
        joinedMemberCount: queue.joinedMemberCount ?? null,
        dateModified: queue.dateModified ?? null,
        ...(queue.description ? { description: queue.description } : {}),
        ...(queueFlow ? { queueFlow } : {}),
        ...(emailInQueueFlow ? { emailInQueueFlow } : {}),
        ...(messageInQueueFlow ? { messageInQueueFlow } : {}),
    };
}

export interface ToolConfig {
    routingApi: RoutingApi;
}

const inputSchema = {
    name: z
        .string()
        .min(1)
        .describe(
            "The queue name, or a portion of it, to search for. Matched " +
                "case-insensitively against queue names, so a partial name " +
                "like 'sales' finds 'UK_Sales'. Wildcards are added " +
                "automatically; do not include asterisks.",
        ),
};

export const findQueue: ToolFactory<ToolConfig, typeof inputSchema> = ({
    routingApi,
}: ToolConfig) => ({
    config: {
        description:
            "Finds Genesys Cloud routing queues by name, resolving the " +
            "human-readable name users know (e.g. 'Sales') to the queue's id " +
            "and exact name. Returns each matching queue's id, name, division " +
            "(id and name), memberCount (agents configured on the queue), " +
            "joinedMemberCount (agents currently joined and taking work), " +
            "dateModified and, when configured, its in-queue flows (queueFlow " +
            "for calls, emailInQueueFlow, messageInQueueFlow). Matching is a " +
            "case-insensitive search that accepts a portion of the name; " +
            "queues whose name equals the query exactly are listed first. " +
            "When several similarly named queues match, dateModified and the " +
            "member counts help tell a live queue from an abandoned one. " +
            "Use the returned exact name as " +
            "the search_in_flow query to find the actions in a flow that " +
            "transfer to the queue. The in-queue flow ids are accepted " +
            "verbatim by flow_ir, flow_action, search_in_flow and " +
            "flow_dependencies.",
        annotations: {
            title: "Find Queue",
            readOnlyHint: true,
            destructiveHint: false,
        },
        inputSchema,
    },
    handler: async ({ name }) => {
        try {
            const queues: platformClient.Models.Queue[] = [];
            const wildcardName = toWildcardName(name);

            let total = 0;
            let pageNumber = 1;
            while (true) {
                const page = await routingApi.getRoutingQueues({
                    name: wildcardName,
                    pageSize: 100,
                    pageNumber,
                });

                if (page.entities) queues.push(...page.entities);
                // A page may omit the optional total; keep the last value a
                // page reported rather than clobbering it.
                total = page.total ?? total;

                if (!page.nextUri || queues.length >= MAX_FETCHED_QUEUES) break;

                pageNumber++;
            }
            // If no page reported a total (or it undercounts what was
            // actually fetched), the fetched count is the better floor.
            total = Math.max(total, queues.length);

            const returned = moveExactMatchToTop(queues, name).slice(
                0,
                MAX_RETURNED_QUEUES,
            );

            const notes: string[] = [];
            if (returned.length === 0) {
                notes.push(
                    `No queues matched "${name}". The search already accepts ` +
                        "a portion of the name, so try a shorter fragment.",
                );
            } else if (total > returned.length) {
                // Only claim exact-first ordering when an exact match was
                // actually fetched; moveExactMatchToTop puts it at index 0.
                let note = `${total} queues matched; only ${returned.length} are returned${
                    isExactNameMatch(returned[0], name)
                        ? ", exact name matches first"
                        : ""
                }.`;
                if (queues.length < total) {
                    note +=
                        ` Only the first ${queues.length} matches were ` +
                        `fetched, so a queue named exactly "${name}" beyond ` +
                        "those would be missing.";
                }
                note +=
                    " Use a longer fragment of the name to narrow the search.";
                notes.push(note);
            }

            const result: FindQueueResult = {
                query: name,
                queues: returned.map(toQueueSummary),
                total,
                ...(notes.length > 0 ? { notes } : {}),
            };
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
            };
        } catch (err) {
            const permissionHint =
                toApiError(err).status === 403
                    ? " The OAuth client needs the 'Routing > Queue > View' permission."
                    : "";
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Failed to search for queues: ${formatApiError(err)}${permissionHint}`,
                    },
                ],
            };
        }
    },
});
