import {
    type RawActionSearchMatch,
    searchRawActions,
} from "@makingchatbots/genesys-cloud-architect-diagram-lib";
import type { ArchitectApi } from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import type { ToolFactory } from "./types.ts";

export interface ToolConfig {
    architectApi: ArchitectApi;
}

/** Caps the response size; matched actions beyond this are counted but not returned. */
const MAX_MATCHED_ACTIONS = 100;
/** Caps matchedPaths per action; passed to the library as maxMatchesPerAction. */
const MAX_PATHS_PER_ACTION = 10;
/** Excerpt window for matched leaf values; whole short values pass through untouched. */
const EXCERPT_LENGTH = 160;
/** Length cap on pattern; also a cheap guard against pathological regexes. */
const MAX_PATTERN_LENGTH = 512;

type QueryPlan =
    | { ok: true; query: string | RegExp }
    | { ok: false; error: string };

function buildQuery(
    pattern: string,
    regex: boolean,
    caseSensitive: boolean,
): QueryPlan {
    if (!regex) {
        return { ok: true, query: pattern };
    }

    try {
        return {
            ok: true,
            query: new RegExp(pattern, caseSensitive ? "" : "i"),
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            error:
                `Invalid regular expression "${pattern}": ${message}. ` +
                "Set regex to false for a literal substring search.",
        };
    }
}

function toExcerpt(
    value: string,
    matchIndex: number,
    matchLength: number,
): string {
    if (value.length <= EXCERPT_LENGTH) {
        return value;
    }

    const matchMiddle = matchIndex + Math.floor(matchLength / 2);
    const start = Math.max(
        0,
        Math.min(
            matchMiddle - Math.floor(EXCERPT_LENGTH / 2),
            value.length - EXCERPT_LENGTH,
        ),
    );
    const end = start + EXCERPT_LENGTH;

    return `${start > 0 ? "…" : ""}${value.slice(start, end)}${
        end < value.length ? "…" : ""
    }`;
}

const inputSchema = {
    flowId: z.string().min(1).describe("The Genesys Cloud Architect flow ID"),
    pattern: z
        .string()
        .min(1)
        .max(MAX_PATTERN_LENGTH)
        .describe(
            "Text to find anywhere in the flow's configuration: action names, queue and " +
                "data-action references, decision and update expressions, prompt text, menu " +
                "choice labels. Matched against string values only, never key names. " +
                "Treated as a literal substring unless regex is true.",
        ),
    regex: z
        .boolean()
        .default(false)
        .describe(
            "Interpret pattern as a JavaScript regular expression. An invalid expression is " +
                "rejected before the flow is fetched.",
        ),
    caseSensitive: z
        .boolean()
        .default(false)
        .describe("Match case-sensitively. Defaults to false."),
};

export const searchInFlow: ToolFactory<ToolConfig, typeof inputSchema> = ({
    architectApi,
}: ToolConfig) => ({
    config: {
        description:
            "Searches the raw Architect configuration of a Genesys Cloud Architect flow for " +
            "text, and returns the actions containing it along with where in each action it " +
            "matched. " +
            'Answers "which actions reference X" — a queue name, a data action, a variable ' +
            "such as Flow.DNIS, a phrase in a prompt — in a single call. Use it instead of " +
            "sweeping a flow with bulk flow_action lookups, which return whole action " +
            "subtrees for actions that may not be relevant at all. " +
            "Each returned actionId is an Architect GUID: it joins directly to flow_ir nodes " +
            'whose kind is "action", and is accepted verbatim by flow_action. Search here to ' +
            "find the ids, then fetch those ids with flow_action when an excerpt is not " +
            "enough. " +
            "Matching is against string values only, never key names. A match in a wiring " +
            "field locates text and is not a control-flow claim; flow_ir owns wiring.",
        annotations: {
            title: "Search In Flow",
            readOnlyHint: true,
            destructiveHint: false,
        },
        inputSchema,
    },
    handler: async ({ flowId, pattern, regex, caseSensitive }) => {
        // Compiled before the fetch so a bad expression costs nothing.
        const plan = buildQuery(pattern, regex, caseSensitive);
        if (!plan.ok) {
            return {
                isError: true,
                content: [{ type: "text", text: plan.error }],
            };
        }

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

        // `searchRawActions` never throws and always answers, so a flow where
        // nothing matched is a successful search rather than an error.
        const result = searchRawActions(configuration, plan.query, {
            caseSensitive,
            maxMatchesPerAction: MAX_PATHS_PER_ACTION,
        });
        const matches = result.hasMatches ? result.matches : [];

        const returned = matches.slice(0, MAX_MATCHED_ACTIONS);
        const matchedActions = returned.map((match: RawActionSearchMatch) => ({
            ...match,
            matchedPaths: match.matchedPaths.map((hit) => ({
                path: hit.path,
                // Expose excerpt as Architect prompt etc can be very long
                excerpt: toExcerpt(hit.value, hit.matchIndex, hit.matchLength),
            })),
        }));

        const notes: string[] = [];
        if (matches.length > returned.length) {
            notes.push(
                `${matches.length} actions matched; only the first ${MAX_MATCHED_ACTIONS} are ` +
                    "returned, in encounter order. Narrow the pattern to see the rest.",
            );
        }
        if (returned.some((match) => match.truncated)) {
            notes.push(
                `Some actions matched in more than ${MAX_PATHS_PER_ACTION} places; matchedPaths ` +
                    "is not exhaustive for entries marked truncated.",
            );
        }
        if (
            returned.some((match) =>
                match.matchedPaths.some(
                    (hit) => hit.value.length > EXCERPT_LENGTH,
                ),
            )
        ) {
            notes.push(
                "Excerpts are clipped windows around the match, not whole values; fetch the " +
                    "action with flow_action when the full text matters.",
            );
        }

        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        flowId,
                        pattern,
                        totalMatchedActions: matches.length,
                        matchedActions,
                        ...(notes.length > 0 ? { notes } : {}),
                    }),
                },
            ],
        };
    },
});
