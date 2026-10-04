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
    const byValue = new Map<string, Secret & { value: string }>();
    for (const s of secrets) {
        if (
            typeof s.value === "string" &&
            s.value.length >= MIN_SECRET_LENGTH &&
            !byValue.has(s.value)
        ) {
            byValue.set(s.value, s as Secret & { value: string });
        }
    }
    // Longest first so a secret containing another is replaced whole.
    const active = [...byValue.values()].sort(
        (a, b) => b.value.length - a.value.length,
    );

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

/**
 * The client credentials in every form the SDK transmits or logs them: the
 * raw values, the secret as it appears percent-encoded in the token request
 * body or escaped inside serialised JSON, and the `Authorization: Basic`
 * header, which is base64 of "id:secret".
 */
export function credentialSecrets(
    clientId: string | undefined,
    clientSecret: string | undefined,
): Secret[] {
    const secrets: Secret[] = [
        { label: "client-secret", value: clientSecret },
        { label: "client-id", value: clientId },
    ];
    if (clientSecret !== undefined) {
        for (const form of encodedForms(clientSecret)) {
            secrets.push({ label: "client-secret", value: form });
        }
    }
    if (clientId !== undefined && clientSecret !== undefined) {
        secrets.push({
            label: "client-credentials",
            value: Buffer.from(`${clientId}:${clientSecret}`).toString(
                "base64",
            ),
        });
    }
    return secrets;
}

/** How a value looks once percent-encoded (both encodeURIComponent and the
 *  application/x-www-form-urlencoded dialect) or JSON-escaped. */
function encodedForms(value: string): string[] {
    return [
        encodeURIComponent(value),
        new URLSearchParams({ v: value }).toString().slice(2),
        JSON.stringify(value).slice(1, -1),
    ];
}
