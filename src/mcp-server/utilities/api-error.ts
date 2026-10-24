export interface ApiError {
    status?: number;
    code?: string;
    message?: string;
}

export function toApiError(err: unknown): ApiError {
    if (err === null || typeof err !== "object") {
        return { message: String(err) };
    }
    const status =
        "status" in err && typeof err.status === "number"
            ? err.status
            : undefined;
    const code =
        "code" in err && typeof err.code === "string" && err.code.length > 0
            ? err.code
            : undefined;
    const message =
        "message" in err &&
        typeof err.message === "string" &&
        err.message.length > 0
            ? err.message
            : undefined;
    return { status, code, message };
}

/**
 * Guidance to append to an auth failure's message. `permission` names the
 * Genesys Cloud permission the tool needs, e.g. "Routing > Queue > View
 * (routing:queue:view)". Empty for any other status.
 */
export function authHint(
    status: number | undefined,
    permission: string,
): string {
    if (status === 401) {
        return (
            " The access token is missing or expired; re-authenticate " +
            "(restart the MCP server) and retry."
        );
    }
    if (status === 403) {
        return ` The OAuth client needs the '${permission}' permission.`;
    }
    return "";
}

export function formatApiError(err: unknown): string {
    const { status, code, message } = toApiError(err);
    const parts: string[] = [];
    if (status !== undefined) {
        parts.push(`HTTP ${status}${code ? ` (${code})` : ""}`);
    } else if (code) {
        parts.push(code);
    }
    if (message) parts.push(message);
    return parts.length > 0 ? parts.join(": ") : "Unknown error";
}
