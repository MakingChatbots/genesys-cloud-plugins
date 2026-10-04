/**
 * Value-based credential redaction. Every secret value is replaced wherever it
 * appears in a string.
 */

export interface Secret {
    /** Shown in place of the value, e.g. "client-secret". */
    readonly label: string;
    readonly value: string | undefined;
}

export type Redactor = (text: string) => string;

/** Values shorter than this are not redacted: they would match too freely. */
const MIN_SECRET_LENGTH = 4;

export function createRedactor(secrets: readonly Secret[]): Redactor {
    const active = secrets
        .filter(
            (s): s is Secret & { value: string } =>
                typeof s.value === "string" &&
                s.value.length >= MIN_SECRET_LENGTH,
        )
        // Longest first so a secret containing another is replaced whole.
        .sort((a, b) => b.value.length - a.value.length);

    if (active.length === 0) return (text) => text;

    return (text) => {
        let out = text;
        for (const { label, value } of active) {
            if (out.includes(value)) {
                out = out.split(value).join(`<redacted:${label}>`);
            }
        }
        return out;
    };
}
