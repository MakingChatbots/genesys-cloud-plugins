import type { ArchitectApi } from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import { toApiError } from "./api-error.ts";

/**
 * Which configuration of a flow a tool read. `deleted` is present when the
 * flow has been deleted and the configuration was read as a deleted flow's.
 */
export type ConfigurationSource = (
    | { latest: true }
    | { flowVersion: string }
) & { deleted?: true };

export type FetchFlowConfigurationResult =
    | { ok: true; configuration: unknown; source: ConfigurationSource }
    | { ok: false; status?: number; message: string };

/**
 * Shared `flowVersion` input for every tool that reads a flow's
 * configuration, so the parameter reads the same everywhere.
 */
export const flowVersionInput = z
    .string()
    .min(1)
    .optional()
    .describe(
        "Optional. A specific version of the flow to read, as the `version` " +
            "that flow_versions lists and the `flowVersion` that " +
            'find_flow_execution reports (e.g. "57.0"). Use it to see the ' +
            "flow as it was at a publish, or as it ran for a conversation. " +
            "Omit to read the latest configuration.",
    );

/**
 * Fetches a flow's configuration: a specific version when `flowVersion` is
 * given, otherwise the latest. A deleted flow answers 410, and its
 * configuration is then fetched again as a deleted flow's. The result says
 * which configuration was read so the caller can report it.
 */
export async function fetchFlowConfiguration(
    architectApi: ArchitectApi,
    flowId: string,
    flowVersion?: string,
): Promise<FetchFlowConfigurationResult> {
    const read = (deleted: boolean): Promise<unknown> =>
        flowVersion
            ? architectApi.getFlowVersionConfiguration(
                  flowId,
                  flowVersion,
                  deleted ? { deleted: "true" } : {},
              )
            : architectApi.getFlowLatestconfiguration(
                  flowId,
                  deleted ? { deleted: true } : {},
              );
    const base: ConfigurationSource = flowVersion
        ? { flowVersion }
        : { latest: true };

    try {
        try {
            return { ok: true, configuration: await read(false), source: base };
        } catch (err) {
            if (toApiError(err).status !== 410) throw err;
            return {
                ok: true,
                configuration: await read(true),
                source: { ...base, deleted: true },
            };
        }
    } catch (err) {
        const { status } = toApiError(err);
        return {
            ok: false,
            ...(status !== undefined ? { status } : {}),
            message: describeFailure(flowId, flowVersion, err),
        };
    }
}

/**
 * Phrase for messages: `latest configuration` or `configuration of version
 * "57.0"`, with the deletion noted when the flow has been deleted.
 */
export function describeConfiguration(source: ConfigurationSource): string {
    const which =
        "latest" in source
            ? "latest configuration"
            : `configuration of version "${source.flowVersion}"`;
    return source.deleted
        ? `${which} (the flow has since been deleted)`
        : which;
}

function describeFailure(
    flowId: string,
    flowVersion: string | undefined,
    err: unknown,
): string {
    const { status, message: detail } = toApiError(err);
    const subject = flowVersion
        ? `version "${flowVersion}" of flow "${flowId}"`
        : `flow "${flowId}"`;

    if (status === 404) {
        return flowVersion
            ? `Version "${flowVersion}" of flow "${flowId}" not found. Check the ` +
                  "flow id, and the version against flow_versions: pass its " +
                  '`version` value exactly (e.g. "57.0").'
            : `Flow "${flowId}" not found. Check the flow id.`;
    }
    if (status === 410) {
        return (
            `Flow "${flowId}" has been deleted (410)` +
            (detail ? `: ${detail}` : ".") +
            " Its configuration could not be retrieved even as a deleted " +
            "flow's; execution data recorded before the deletion may still exist."
        );
    }
    if (status === 401) {
        return (
            `Not authenticated with Genesys Cloud (401) fetching ${subject}: ` +
            "the access token is missing or expired. The flow may well exist — " +
            "re-authenticate (restart the MCP server) and retry rather than " +
            "concluding anything about the flow."
        );
    }
    if (status === 403) {
        return (
            `Not authorised to read ${subject} (403): the OAuth client lacks ` +
            "permission or division access to it. The flow exists but this client " +
            "cannot see it."
        );
    }
    if (status === 429) {
        return (
            `Rate limited by Genesys Cloud (429) fetching ${subject}. ` +
            "Transient — wait and retry; this says nothing about the flow."
        );
    }
    if (status !== undefined && status >= 500) {
        return (
            `Genesys Cloud returned ${status} fetching ${subject}. ` +
            "Transient server-side error — retry; this says nothing about the flow."
        );
    }
    return (
        `Failed to fetch ${subject}` +
        (status !== undefined ? ` (HTTP ${status})` : "") +
        (detail ? `: ${detail}` : ".") +
        " Likely transient (network or gateway) — retry rather than concluding " +
        "the flow does not exist."
    );
}
