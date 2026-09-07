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
