import type { ArchitectApi, Models } from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import {
    authHint,
    formatApiError,
    toApiError,
} from "../utilities/api-error.ts";
import { type EntityRef, toEntityRef } from "../utilities/entity-ref.ts";
import type { ToolFactory } from "../utilities/types.ts";

const PERMISSION = "Architect > Flow > View (architect:flow:view)";

const PAGE_SIZE = 100;

/**
 * Runaway guard on the pages fetched. The API pages versions in id-string
 * order ("1.0", "10.0", "100.0", ...), not by date, so a flow that exceeds
 * this cap loses an arbitrary set of versions, not simply the oldest; the
 * cap is therefore generous and the note says what was lost.
 */
const MAX_FETCHED_VERSIONS = 2000;

/**
 * What created the version. The API schema declares a `type` of PUBLISH,
 * CHECKIN or SAVE but has not been observed returning it, so the kind is
 * taken from `type` when present and otherwise derived from which dates the
 * API stamps: a version that was ever published carries datePublished, a
 * check-in carries dateCheckedIn without it, and a save carries dateSaved or
 * a saved_version_ id. Old versions with none of these are "unknown"; in
 * practice (seen only before 2023) they are check-ins.
 */
type VersionKind = "publish" | "checkin" | "save" | "unknown";

interface FlowVersionSummary {
    /**
     * The checked-in version number Architect shows, e.g. "57.0" (the
     * API's commitVersion). This is the `flowVersion` that
     * find_flow_execution and the flow aggregates report, so it joins a
     * run to the configuration it executed.
     */
    version: string;
    id: string;
    kind: VersionKind;
    dateCreated: string | null;
    /** When this version became the flow's published version; null if it never was. */
    datePublished: string | null;
    /**
     * When it stopped being the published version. Null while it still is,
     * but also null on versions superseded before the API began recording
     * this (observed from mid-2023), so isPublished is the test for "live".
     */
    datePublishedEnd: string | null;
    /** True for the one version currently published. */
    isPublished: boolean;
    /**
     * Only with includeAuthor: the user who created the version. The API
     * returns only the user's id here, not a name.
     */
    createdBy?: EntityRef | null;
    /** Only with includeAuthor: the OAuth client (integration) it was created through. */
    createdByClient?: EntityRef | null;
}

interface FlowVersionsResult {
    flowId: string;
    flowName: string;
    flowType: string;
    /** The currently published version number; null when the flow is unpublished. */
    publishedVersion: string | null;
    /** Newest first. */
    versions: FlowVersionSummary[];
    /** Every version the flow has, of every kind, before filtering and the fetch cap. */
    total: number;
    /** Present when the flow has been deleted; the history is as it stood at deletion. */
    deleted?: true;
    notes?: string[];
}

/** The API gives dateCreated as epoch milliseconds. */
function epochToIso(epochMs: number | undefined): string | null {
    if (epochMs === undefined) return null;
    const date = new Date(epochMs);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Saves that were never checked in are listed under this id prefix. */
const SAVED_VERSION_PREFIX = "saved_version_";

const KIND_FROM_API: Record<string, VersionKind> = {
    PUBLISH: "publish",
    CHECKIN: "checkin",
    SAVE: "save",
};

/**
 * `isPublished` is checked first: the currently published version is a
 * publish whatever its dates say, so it is never filtered out of the
 * default view.
 */
function toKind(
    version: Models.FlowVersion,
    isPublished: boolean,
): VersionKind {
    if (isPublished || version.datePublished) return "publish";
    const typed = version.type && KIND_FROM_API[version.type.toUpperCase()];
    if (typed) return typed;
    if (version.dateCheckedIn !== undefined) return "checkin";
    if (
        version.dateSaved !== undefined ||
        version.id?.startsWith(SAVED_VERSION_PREFIX)
    ) {
        return "save";
    }
    return "unknown";
}

/**
 * "57.10" sorts after "57.2", which a string or float compare gets wrong.
 * Non-numeric ids (saved_version_<guid>) compare as 0.
 */
function compareVersionNumberDesc(a: string, b: string): number {
    const parse = (v: string) => v.split(".").map((part) => Number(part) || 0);
    const [aMajor = 0, aMinor = 0] = parse(a);
    const [bMajor = 0, bMinor = 0] = parse(b);
    return bMajor - aMajor || bMinor - aMinor;
}

function newestFirst(a: FlowVersionSummary, b: FlowVersionSummary): number {
    const byDate = (b.dateCreated ?? "").localeCompare(a.dateCreated ?? "");
    return byDate || compareVersionNumberDesc(a.version, b.version);
}

function isPublishedVersion(
    version: Models.FlowVersion,
    published: Models.FlowVersion | undefined,
): boolean {
    if (!published) return false;
    if (published.id && version.id) return published.id === version.id;
    return (
        published.commitVersion !== undefined &&
        published.commitVersion === version.commitVersion
    );
}

function toSummary(
    version: Models.FlowVersion,
    published: Models.FlowVersion | undefined,
    includeAuthor: boolean,
): FlowVersionSummary {
    const isPublished = isPublishedVersion(version, published);
    return {
        version: version.commitVersion ?? "",
        id: version.id ?? "",
        kind: toKind(version, isPublished),
        dateCreated: epochToIso(version.dateCreated),
        datePublished: version.datePublished ?? null,
        datePublishedEnd: version.datePublishedEnd ?? null,
        isPublished,
        ...(includeAuthor
            ? {
                  createdBy: toEntityRef(version.createdBy),
                  createdByClient: toEntityRef(version.createdByClient),
              }
            : {}),
    };
}

export interface ToolConfig {
    architectApi: ArchitectApi;
}

const inputSchema = {
    flowId: z.string().min(1).describe("The Genesys Cloud Architect flow ID"),
    includeCheckIns: z
        .boolean()
        .optional()
        .describe(
            "When true, check-in and save versions are listed alongside " +
                "publishes. Off by default: only published versions, which " +
                "are the ones that ever handled traffic, are returned.",
        ),
    includeAuthor: z
        .boolean()
        .optional()
        .describe(
            "When true, each version carries createdBy (the creating " +
                "user's id; the API gives no name here) and createdByClient " +
                "(the OAuth client, for versions created through the API). " +
                "Off by default so no person identifiers appear in the " +
                "output; set it only when the data owner has agreed to that.",
        ),
};

export const flowVersions: ToolFactory<ToolConfig, typeof inputSchema> = ({
    architectApi,
}: ToolConfig) => ({
    config: {
        description:
            "Lists the versions of a Genesys Cloud Architect flow, newest " +
            "first: each version's number, kind (publish, checkin, save), " +
            "dateCreated, datePublished and datePublishedEnd (the exact " +
            "window in which it was the live version), and whether it is " +
            "the currently published one. Use it to answer when a flow " +
            "changed ('which version was live at 09:30 on the 5th', 'when " +
            "did v58 go out', 'has this been published since Tuesday') " +
            "instead of bucketing flow aggregates by flowVersion. The " +
            "version numbers " +
            "are the flowVersion values find_flow_execution reports, so a " +
            "run joins to the version it executed. The API records no " +
            "publish comment, so what changed must be read from the " +
            "configuration. Only publishes are listed unless " +
            "includeCheckIns is set. Authors are omitted unless " +
            "includeAuthor is set. A deleted flow's history is still " +
            "listed, flagged deleted: true.",
        annotations: {
            title: "Flow Versions",
            readOnlyHint: true,
            destructiveHint: false,
        },
        inputSchema,
    },
    handler: async ({ flowId, includeCheckIns, includeAuthor }) => {
        try {
            const fetchVersions = async (deleted: boolean) => {
                const entities: Models.FlowVersion[] = [];
                let total = 0;
                let pageNumber = 1;
                while (true) {
                    const page = await architectApi.getFlowVersions(flowId, {
                        pageSize: PAGE_SIZE,
                        pageNumber,
                        ...(deleted ? { deleted: true } : {}),
                    });
                    if (page.entities) entities.push(...page.entities);
                    // A page may omit the optional total; keep the last
                    // value a page reported rather than clobbering it.
                    total = page.total ?? total;
                    if (
                        !page.nextUri ||
                        entities.length >= MAX_FETCHED_VERSIONS
                    ) {
                        break;
                    }
                    pageNumber++;
                }
                return { entities, total: Math.max(total, entities.length) };
            };

            // The flow lookup goes first: one call validates the id before
            // the versions are paged. A deleted flow answers 410, and both
            // calls still serve it when asked for deleted flows.
            const loadFlow = async (): Promise<{
                flow: Models.Flow;
                deleted: boolean;
            }> => {
                try {
                    return {
                        flow: await architectApi.getFlow(flowId),
                        deleted: false,
                    };
                } catch (err) {
                    if (toApiError(err).status !== 410) throw err;
                    return {
                        flow: await architectApi.getFlow(flowId, {
                            deleted: true,
                        }),
                        deleted: true,
                    };
                }
            };
            const { flow, deleted } = await loadFlow();
            const fetched = await fetchVersions(deleted);

            const published = flow.publishedVersion;
            const all = fetched.entities.map((v) =>
                toSummary(v, published, includeAuthor ?? false),
            );
            // Only publishes ever handled traffic. An unknown kind (no date
            // stamps at all, seen only before 2023) has in practice always
            // been a check-in, so the default view omits it too.
            const versions = (
                includeCheckIns ? all : all.filter((v) => v.kind === "publish")
            ).sort(newestFirst);
            const omitted = all.length - versions.length;

            const notes: string[] = [];
            if (deleted) {
                notes.push(
                    "This flow has been deleted. Its history is listed as it " +
                        "stood at deletion; find_flow no longer lists it.",
                );
            }
            if (fetched.total === 0) {
                notes.push(
                    "This flow has no versions at all: nothing has been " +
                        "saved, checked in or published.",
                );
            } else if (versions.length === 0 && omitted > 0 && !published) {
                notes.push(
                    `This flow has never been published; its ${omitted} ` +
                        "version(s) are check-ins, saves or undated versions. " +
                        "Set includeCheckIns to list them.",
                );
            } else if (omitted > 0) {
                notes.push(
                    `${omitted} check-in, save or undated version(s) omitted. ` +
                        "Set includeCheckIns to list them.",
                );
            }
            if (fetched.entities.length < fetched.total) {
                notes.push(
                    `${fetched.total} versions exist but only ` +
                        `${fetched.entities.length} were fetched. The API ` +
                        "pages versions by id string, not by date, so the " +
                        "missing ones are an arbitrary set rather than the " +
                        "oldest, and may include recent publishes.",
                );
            }
            if (published && !versions.some((v) => v.isPublished)) {
                notes.push(
                    `The published version (${published.commitVersion ?? published.id}) ` +
                        "is not among the versions listed.",
                );
            }

            const result: FlowVersionsResult = {
                flowId: flow.id ?? flowId,
                flowName: flow.name,
                flowType: flow.type ?? "",
                publishedVersion: published?.commitVersion ?? null,
                versions,
                total: fetched.total,
                ...(deleted ? { deleted: true as const } : {}),
                ...(notes.length > 0 ? { notes } : {}),
            };
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
            };
        } catch (err) {
            const { status } = toApiError(err);
            if (status === 404) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Flow "${flowId}" not found. Check the flow id.`,
                        },
                    ],
                };
            }
            if (status === 410) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Flow "${flowId}" has been deleted (410) and its versions could not be retrieved even as a deleted flow's.`,
                        },
                    ],
                };
            }
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Failed to list flow versions: ${formatApiError(err)}${authHint(status, PERMISSION)}`,
                    },
                ],
            };
        }
    },
});
