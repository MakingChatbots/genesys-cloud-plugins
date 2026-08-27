import type { ArchitectApi } from "purecloud-platform-client-v2";

export type FetchFlowConfigurationResult =
    | { ok: true; configuration: unknown }
    | { ok: false; message: string };

export async function fetchFlowConfiguration(
    architectApi: ArchitectApi,
    flowId: string,
): Promise<FetchFlowConfigurationResult> {
    try {
        return {
            ok: true,
            configuration:
                await architectApi.getFlowLatestconfiguration(flowId),
        };
    } catch (err) {
        return { ok: false, message: describeFailure(flowId, err) };
    }
}

function describeFailure(flowId: string, err: unknown): string {
    const status =
        err !== null &&
        typeof err === "object" &&
        "status" in err &&
        typeof err.status === "number"
            ? err.status
            : undefined;
    const detail =
        err !== null &&
        typeof err === "object" &&
        "message" in err &&
        typeof err.message === "string" &&
        err.message.length > 0
            ? err.message
            : undefined;

    if (status === 404) {
        return `Flow "${flowId}" not found. Check the flow id.`;
    }
    if (status === 401) {
        return (
            `Not authenticated with Genesys Cloud (401) fetching flow "${flowId}": ` +
            "the access token is missing or expired. The flow may well exist — " +
            "re-authenticate (restart the MCP server) and retry rather than " +
            "concluding anything about the flow."
        );
    }
    if (status === 403) {
        return (
            `Not authorised to read flow "${flowId}" (403): the OAuth client lacks ` +
            "permission or division access to it. The flow exists but this client " +
            "cannot see it."
        );
    }
    if (status === 429) {
        return (
            `Rate limited by Genesys Cloud (429) fetching flow "${flowId}". ` +
            "Transient — wait and retry; this says nothing about the flow."
        );
    }
    if (status !== undefined && status >= 500) {
        return (
            `Genesys Cloud returned ${status} fetching flow "${flowId}". ` +
            "Transient server-side error — retry; this says nothing about the flow."
        );
    }
    return (
        `Failed to fetch flow "${flowId}"` +
        (status !== undefined ? ` (HTTP ${status})` : "") +
        (detail ? `: ${detail}` : ".") +
        " Likely transient (network or gateway) — retry rather than concluding " +
        "the flow does not exist."
    );
}
