import type platformClient from "purecloud-platform-client-v2";
import type { ArchitectApi } from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import { authHint, formatApiError, toApiError } from "./api-error.ts";
import { type EntityRef, toEntityRef } from "./entity-ref.ts";
import { fetchFlowConfiguration } from "./fetch-flow-configuration.ts";
import { nameKey } from "./name-match.ts";
import type { ToolFactory } from "./types.ts";

/**
 * Applied separately to the ids+names given and to a flow's references, so one
 * call fetches at most twice this many prompts.
 */
const MAX_PROMPTS = 50;

const PERMISSION = "Architect > User Prompt > View (architect:userPrompt:view)";

/** The upload state in which a prompt's recording is complete and playable. */
const TRANSCODED = "transcoded";

/**
 * Flows reference user prompts as `Prompt.<name>`, so callers copying a
 * reference straight out of flow_action output arrive with this prefix.
 */
const PROMPT_REFERENCE_PREFIX = /^Prompt\./i;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Durations arrive with float noise (34.424375000000005); milliseconds are plenty. */
function roundSeconds(seconds: number): number {
    return Math.round(seconds * 1000) / 1000;
}

interface PromptResourceSummary {
    language: string;
    /** True for the language Architect falls back to when the caller's language has no resource. */
    languageDefault: boolean;
    /** Length of the uploaded recording. Null when there is no recording. */
    durationSeconds: number | null;
    /** True when a recording has been uploaded; it then plays instead of ttsString. */
    hasAudio: boolean;
    /** Spoken by text-to-speech when no audio has been uploaded for this language. */
    ttsString: string | null;
    /** Transcript of the uploaded audio; informational only, never spoken. */
    text: string | null;
}

interface PromptSummary {
    id: string;
    name: string;
    description: string | null;
    division: EntityRef | null;
    resources: PromptResourceSummary[];
}

interface SequenceEntry {
    id: string;
    name: string;
    /** Seconds into the sequence at which this prompt starts, counting recorded audio only. */
    startSeconds: number;
    durationSeconds: number | null;
}

interface DurationTotal {
    language: string;
    /** Sum of durationSeconds over the prompts that have a recording in this language. */
    totalDurationSeconds: number;
    promptsWithAudio: number;
    /** Prompts with no recording in this language; their play time is unknown and excluded from the total. */
    promptsWithoutAudio: number;
    /** Prompts in requested order with their start offset into the sequence. */
    sequence: SequenceEntry[];
}

interface FailedLookup {
    requested: string;
    error: string;
}

interface GetPromptsResult {
    flowId?: string;
    /** Prompts in the order requested: promptIds, then promptNames, then flow references in encounter order. */
    prompts: PromptSummary[];
    durationTotals: DurationTotal[];
    /** Requested ids and names (as given) that matched no prompt. */
    notFound: string[];
    /** Requested ids that failed for a reason other than not existing. */
    failed?: FailedLookup[];
    notes?: string[];
}

function toResourceSummary(
    resource: platformClient.Models.PromptAsset,
): PromptResourceSummary {
    return {
        language: resource.language ?? "",
        languageDefault: resource.languageDefault ?? false,
        durationSeconds: resource.durationSeconds ?? null,
        // A resource keeps its mediaUri while an upload is still processing
        // or has failed, so the uri alone does not mean audio plays. Older
        // responses omit uploadStatus; trust the uri then.
        hasAudio:
            Boolean(resource.mediaUri) &&
            (resource.uploadStatus === undefined ||
                resource.uploadStatus === TRANSCODED),
        ttsString: resource.ttsString || null,
        text: resource.text || null,
    };
}

function toPromptSummary(
    prompt: platformClient.Models.Prompt,
    language: string | undefined,
): PromptSummary {
    const wantedLanguage = nameKey(language);
    const resources = (prompt.resources ?? []).filter(
        (r) => !language || nameKey(r.language) === wantedLanguage,
    );
    return {
        id: prompt.id ?? "",
        name: prompt.name ?? "",
        description: prompt.description ?? null,
        division: toEntityRef(prompt.division),
        resources: resources.map(toResourceSummary),
    };
}

function stripPromptReference(name: string): string {
    return name.trim().replace(PROMPT_REFERENCE_PREFIX, "");
}

/**
 * Sum recorded durations per language across the prompts in order, so a
 * hang-up N seconds into a sequence can be attributed to the prompt playing.
 * Only recordings have a duration; TTS play time is unknown and is counted
 * separately rather than silently treated as zero.
 */
function buildDurationTotals(prompts: PromptSummary[]): DurationTotal[] {
    const languages = new Set<string>();
    for (const prompt of prompts) {
        for (const resource of prompt.resources) {
            languages.add(resource.language);
        }
    }

    return [...languages].sort().map((language) => {
        let total = 0;
        let withAudio = 0;
        let withoutAudio = 0;
        const sequence: SequenceEntry[] = [];
        for (const prompt of prompts) {
            const resource = prompt.resources.find(
                (r) => r.language === language,
            );
            const duration = resource?.hasAudio
                ? (resource.durationSeconds ?? null)
                : null;
            sequence.push({
                id: prompt.id,
                name: prompt.name,
                startSeconds: roundSeconds(total),
                durationSeconds: duration,
            });
            if (duration === null) {
                withoutAudio++;
            } else {
                withAudio++;
                total += duration;
            }
        }
        return {
            language,
            totalDurationSeconds: roundSeconds(total),
            promptsWithAudio: withAudio,
            promptsWithoutAudio: withoutAudio,
            sequence,
        };
    });
}

/**
 * Collect user prompt references from a flow configuration in encounter order.
 *
 * Architect tags everything of the prompt data type with `type: "pmt"`,
 * including *variables* that hold a prompt (`Task.DefaultAudio`), whose ids
 * are variable ids, not prompt ids. Three shapes identify an actual prompt:
 *
 * - `metaData.references[]` entries `{ type: "pmt", id, name: "Prompt.X" }`
 *   next to every expression that mentions a prompt. Variables appear here
 *   too, named `Task.X`/`Flow.X`, so the `Prompt.` prefix is the test.
 * - `ref` operands `{ type: "pmt", text: "Prompt.X", val: <id> }` inside a
 *   parsed expression. Same prefix test; a `Task.X` ref is a variable.
 * - `lit` operands `{ type: "pmt", text: "X", val: <id> }`: a prompt chosen as
 *   a literal value, e.g. when assigning a prompt to a variable. These have no
 *   `metaData.references` entry, so they would otherwise be missed. The text
 *   is the bare name.
 *
 * Flow-level settings (e.g. processing audio) can hold a *system* prompt as a
 * literal. User prompt ids are GUIDs while system prompt ids look like
 * `__processing__`, so id-shaped values are the final filter.
 */
export function collectPromptReferences(configuration: unknown): EntityRef[] {
    const found = new Map<string, EntityRef>();
    const seen = new Set<object>();

    const add = (id: string, name: string | undefined) => {
        const ref = toEntityRef({ id, name });
        if (!ref || found.has(ref.id)) return;
        found.set(ref.id, ref);
    };

    const walk = (node: unknown, key: string | undefined): void => {
        if (node === null || typeof node !== "object") return;
        if (seen.has(node)) return;
        seen.add(node);

        if (Array.isArray(node)) {
            for (const item of node) walk(item, key);
            return;
        }

        const record = node as Record<string, unknown>;
        if (record.type === "pmt") {
            const name =
                typeof record.name === "string" ? record.name : undefined;
            const text =
                typeof record.text === "string" ? record.text : undefined;
            if (
                typeof record.id === "string" &&
                name?.match(PROMPT_REFERENCE_PREFIX)
            ) {
                add(record.id, stripPromptReference(name));
            } else if (
                typeof record.val === "string" &&
                GUID.test(record.val) &&
                text !== undefined
            ) {
                if (text.match(PROMPT_REFERENCE_PREFIX)) {
                    add(record.val, stripPromptReference(text));
                } else if (key === "lit") {
                    add(record.val, text);
                }
            }
        }
        for (const [childKey, value] of Object.entries(record)) {
            walk(value, childKey);
        }
    };

    walk(configuration, undefined);
    return [...found.values()];
}

export interface ToolConfig {
    architectApi: ArchitectApi;
}

const inputSchema = {
    promptIds: z
        .array(z.string().min(1))
        .max(MAX_PROMPTS)
        .optional()
        .describe(
            "User prompt GUIDs, e.g. the `id` of entries under USERPROMPT in " +
                "flow_dependencies output. Returned in the order given. " +
                "Combined with `promptNames` the total must not exceed " +
                `${MAX_PROMPTS}; chunk a larger set into successive calls. ` +
                "`flowId` has its own separate limit.",
        ),
    promptNames: z
        .array(z.string().min(1))
        .max(MAX_PROMPTS)
        .optional()
        .describe(
            "User prompt names, exactly as the flow references them. A " +
                "`Prompt.` prefix is accepted and stripped, so `Prompt.Welcome` " +
                "and `Welcome` both find the prompt named Welcome. Matching is " +
                "exact (ignoring case), not a search. Returned in the order " +
                "given, after any `promptIds`.",
        ),
    flowId: z
        .string()
        .min(1)
        .optional()
        .describe(
            "A Genesys Cloud Architect flow ID. Every user prompt the flow's " +
                "latest configuration references is returned, in the order " +
                "the references are encountered, so one call covers the " +
                `flow's whole script. At most ${MAX_PROMPTS} referenced ` +
                "prompts are fetched; any beyond that are listed in a note " +
                "to fetch via `promptIds`.",
        ),
    language: z
        .string()
        .min(1)
        .optional()
        .describe(
            "Restrict each prompt's resources to one language tag, e.g. " +
                "`en-gb`. Omit to return every language.",
        ),
};

export const getPrompts: ToolFactory<ToolConfig, typeof inputSchema> = ({
    architectApi,
}: ToolConfig) => ({
    config: {
        description:
            "Retrieves Genesys Cloud Architect user prompts: the reusable " +
            "audio assets that call and in-queue flows play via " +
            "`Prompt.<name>` references in Play Audio, Communicate, Menu and " +
            "Collect Input actions. For each prompt returns its id, name, " +
            "description, division and one resource per language holding " +
            "what the caller actually hears: `durationSeconds` and " +
            "`hasAudio` (an uploaded recording, which takes precedence), " +
            "`ttsString` (spoken by text-to-speech when there is no " +
            "recording) and `text` (a transcript of the recording, " +
            "informational only). A resource with neither audio nor a TTS " +
            "string plays silence. `durationTotals` sums the recorded " +
            "durations per language across the prompts in requested order " +
            "and gives each prompt's start offset, so a hang-up N seconds " +
            "into a sequence of prompts can be attributed to the prompt that " +
            "was playing. Look prompts up by name when flow_action output " +
            "shows `Prompt.<name>`, by id from flow_dependencies USERPROMPT " +
            "entries, or by `flowId` to get every prompt a flow references " +
            "in one call. Batch every prompt of interest into one call " +
            "rather than calling once per prompt. Does not cover system " +
            "prompts (`PromptSystem.<name>`).",
        annotations: {
            title: "Get Prompts",
            readOnlyHint: true,
            destructiveHint: false,
        },
        inputSchema,
    },
    handler: async ({ promptIds = [], promptNames = [], flowId, language }) => {
        if (promptIds.length === 0 && promptNames.length === 0 && !flowId) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: "Provide at least one of `promptIds`, `promptNames` or `flowId`.",
                    },
                ],
            };
        }
        if (promptIds.length + promptNames.length > MAX_PROMPTS) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text:
                            `At most ${MAX_PROMPTS} prompts can be requested per call ` +
                            `(${promptIds.length} ids + ${promptNames.length} names given). ` +
                            "Chunk the request into successive calls.",
                    },
                ],
            };
        }

        const prompts: PromptSummary[] = [];
        const notFound: string[] = [];
        const failed: FailedLookup[] = [];
        const notes: string[] = [];
        const seenIds = new Set<string>();

        const addPrompt = (prompt: platformClient.Models.Prompt) => {
            if (prompt.id && seenIds.has(prompt.id)) return;
            if (prompt.id) seenIds.add(prompt.id);
            prompts.push(toPromptSummary(prompt, language));
        };

        const fetchById = async (id: string) => {
            if (seenIds.has(id)) return;
            try {
                addPrompt(
                    await architectApi.getArchitectPrompt(id, {
                        includeResources: true,
                        includeMediaUris: true,
                        ...(language ? { language: [language] } : {}),
                    }),
                );
            } catch (err) {
                const { status } = toApiError(err);
                if (status === 404) {
                    notFound.push(id);
                } else if (status === 401) {
                    // An expired token fails every lookup; stop rather than
                    // repeating the same failure per id.
                    throw err;
                } else if (status === 403) {
                    // Per prompt, not org-wide: the prompt exists but sits in
                    // a division this client cannot see (or the client lacks
                    // the permission entirely, which the first 403 reveals).
                    // Keep going so the readable prompts are still returned.
                    failed.push({
                        requested: id,
                        error:
                            `${formatApiError(err)}. The prompt exists but the ` +
                            "OAuth client cannot read it: it lacks division " +
                            `access to it, or the '${PERMISSION}' permission.`,
                    });
                } else {
                    failed.push({ requested: id, error: formatApiError(err) });
                }
            }
        };

        // Fetch the flow first: it is one cheap call, and failing on it
        // before any prompt lookups means a bad flowId cannot discard
        // prompts already retrieved by id or name.
        let flowReferences: EntityRef[] = [];
        if (flowId) {
            const fetched = await fetchFlowConfiguration(architectApi, flowId);
            if (!fetched.ok) {
                return {
                    isError: true,
                    content: [{ type: "text", text: fetched.message }],
                };
            }
            flowReferences = collectPromptReferences(fetched.configuration);
        }

        try {
            for (const id of new Set(promptIds)) {
                await fetchById(id);
            }

            if (promptNames.length > 0) {
                // Keyed case-insensitively so each prompt is matched once,
                // while the name sent to the API keeps the caller's casing in
                // case its filter is case-sensitive.
                const wanted = new Map<
                    string,
                    { requested: string; stripped: string }
                >();
                for (const requested of promptNames) {
                    const stripped = stripPromptReference(requested);
                    const key = nameKey(stripped);
                    if (key && !wanted.has(key)) {
                        wanted.set(key, { requested, stripped });
                    }
                }

                const byName = new Map<string, platformClient.Models.Prompt>();
                let pageNumber = 1;
                while (true) {
                    const page = await architectApi.getArchitectPrompts({
                        name: [...wanted.values()].map((w) => w.stripped),
                        includeResources: true,
                        includeMediaUris: true,
                        ...(language ? { language: [language] } : {}),
                        pageSize: 100,
                        pageNumber,
                    });
                    for (const prompt of page.entities ?? []) {
                        const key = nameKey(prompt.name);
                        // The API's name filter is trusted only as a
                        // pre-filter; keep exact matches so a fragment or
                        // wildcard match never masquerades as the prompt
                        // the flow references.
                        if (wanted.has(key) && !byName.has(key)) {
                            byName.set(key, prompt);
                        }
                    }
                    if (!page.nextUri) break;
                    pageNumber++;
                }

                // Emit in the order the names were requested.
                for (const [key, { requested }] of wanted) {
                    const prompt = byName.get(key);
                    if (prompt) {
                        addPrompt(prompt);
                    } else {
                        notFound.push(requested);
                    }
                }
            }

            if (flowId) {
                const references = flowReferences;
                if (references.length === 0) {
                    notes.push(
                        `Flow "${flowId}" references no user prompts in its ` +
                            "latest configuration. Audio it plays is inline " +
                            "TTS, system prompts or neither.",
                    );
                }
                const toFetch = references.slice(0, MAX_PROMPTS);
                const overflow = references.slice(MAX_PROMPTS);
                if (overflow.length > 0) {
                    notes.push(
                        `Flow "${flowId}" references ${references.length} user ` +
                            `prompts; only the first ${MAX_PROMPTS} were fetched. ` +
                            "Fetch the rest with promptIds: " +
                            overflow.map((r) => r.id).join(", "),
                    );
                }
                let alreadyReturned = 0;
                for (const reference of toFetch) {
                    if (seenIds.has(reference.id)) {
                        alreadyReturned++;
                    } else {
                        await fetchById(reference.id);
                    }
                }
                if (alreadyReturned > 0) {
                    notes.push(
                        `${alreadyReturned} of the flow's referenced prompts ` +
                            "were already returned at their promptIds/promptNames " +
                            "position, so durationTotals.sequence does not follow " +
                            "flow order. Call with flowId alone for a flow-ordered " +
                            "sequence.",
                    );
                }
            }
        } catch (err) {
            const hint = authHint(toApiError(err).status, PERMISSION);
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Failed to retrieve prompts: ${formatApiError(err)}.${hint}`,
                    },
                ],
            };
        }

        if (notFound.length > 0) {
            notes.push(
                "Entries in notFound matched no user prompt in this org. A flow " +
                    "referencing such a prompt plays silence there. Names are " +
                    "matched exactly (ignoring case), so check the spelling " +
                    "against the flow's `Prompt.<name>` reference; if the " +
                    "reference is `PromptSystem.<name>` it is a system prompt, " +
                    "which this tool does not return.",
            );
        }
        if (prompts.some((p) => p.resources.length === 0)) {
            notes.push(
                language
                    ? `A prompt with no resources has no audio or TTS for language "${language}"; ` +
                          "Architect falls back to its languageDefault resource, which was " +
                          "filtered out of this response. Call again without `language` to see it."
                    : "A prompt with no resources has no audio or TTS in any " +
                          "language and plays silence wherever it is referenced.",
            );
        }
        const durationTotals = buildDurationTotals(prompts);
        if (durationTotals.some((t) => t.promptsWithoutAudio > 0)) {
            notes.push(
                "totalDurationSeconds counts recorded audio only. Prompts " +
                    "counted in promptsWithoutAudio play TTS (or silence) for " +
                    "that language, whose duration is not known, so the " +
                    "sequence's real play time is longer than the total.",
            );
        }

        const result: GetPromptsResult = {
            ...(flowId ? { flowId } : {}),
            prompts,
            durationTotals,
            notFound,
            ...(failed.length > 0 ? { failed } : {}),
            ...(notes.length > 0 ? { notes } : {}),
        };
        return {
            content: [{ type: "text", text: JSON.stringify(result) }],
        };
    },
});
