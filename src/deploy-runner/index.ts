// biome-ignore-all lint/suspicious/noExplicitAny: monkey-patching the SDK requires unsafe casts
// biome-ignore-all lint/complexity/noBannedTypes: same reason
// biome-ignore-all lint/style/noNonNullAssertion: statusCode is guaranteed non-null inside the >= 400 guard
import type { IncomingMessage, RequestOptions } from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type {
    DeployResultPayload,
    DeployStatus,
    DeployValidation,
} from "../shared/deploy-result.ts";
import { createRedactor, credentialSecrets } from "../shared/redact.ts";

const TIMEOUT_MS = 90_000;

// Built before the SDK is loaded so every output channel below is covered.
const redact = createRedactor(
    credentialSecrets(
        process.env.GENESYS_CLIENT_ID,
        process.env.GENESYS_CLIENT_SECRET,
    ),
);

type LogLevel = "info" | "warn" | "error";

function emit(type: "log", level: LogLevel, message: string): void;
function emit(type: "result", payload: DeployResultPayload): void;
function emit(type: string, ...args: unknown[]): void {
    if (type === "log") {
        const [level, message] = args as [LogLevel, string];
        process.stdout.write(
            `${JSON.stringify({ type, level, message: redact(message) })}\n`,
        );
    } else {
        const [payload] = args as [DeployResultPayload];
        const error =
            payload.error === undefined ? {} : { error: redact(payload.error) };
        process.stdout.write(
            `${JSON.stringify({ type, ...payload, ...error })}\n`,
        );
    }
}

// ── HTTPS interceptor ──────────────────────────────────────────────────
// Must be installed before requiring the SDK so all its requests are wrapped.

interface HttpError {
    status: number;
    method: string;
    path: string | undefined;
    body: unknown;
}

const httpErrors: HttpError[] = [];
const traces: string[] = [];

function wrapResponseCallback(args: any[], opts: RequestOptions): void {
    const lastIdx = args.length - 1;
    if (lastIdx < 0 || typeof args[lastIdx] !== "function") return;
    const origCb = args[lastIdx] as (res: IncomingMessage) => void;
    args[lastIdx] = (res: IncomingMessage) => {
        if (res.statusCode && res.statusCode >= 400) {
            let body = "";
            res.on("data", (chunk: Buffer) => (body += chunk));
            res.on("end", () => {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(body);
                } catch {
                    parsed = body;
                }
                const entry: HttpError = {
                    status: res.statusCode!,
                    method: opts.method || "GET",
                    path: opts.path ?? undefined,
                    body: parsed,
                };
                httpErrors.push(entry);
                const msg =
                    typeof parsed === "object" && parsed !== null
                        ? (parsed as any).message ||
                          (parsed as any).error ||
                          JSON.stringify(parsed)
                        : parsed;
                emit(
                    "log",
                    "error",
                    `HTTP ${entry.status} ${entry.method} ${entry.path} — ${msg}`,
                );
            });
        }
        origCb(res);
    };
}

function extractOpts(args: any[]): RequestOptions {
    for (const arg of args) {
        if (typeof arg === "object" && arg !== null && !(arg instanceof URL))
            return arg as RequestOptions;
    }
    return {};
}

const origRequest = https.request;
(https as any).request = function patchedRequest(...args: any[]) {
    wrapResponseCallback(args, extractOpts(args));
    return origRequest.apply(this, args as any);
};

const origGet = https.get;
(https as any).get = function patchedGet(...args: any[]) {
    wrapResponseCallback(args, extractOpts(args));
    return origGet.apply(this, args as any);
};

// ── TRACE interceptor ──────────────────────────────────────────────────
// The SDK writes TRACE: lines directly to the console, bypassing the logging
// callback. The severity is carried by the console method it picks
// (console.error for failures, which often hold the actual permission error
// text), not by the text, so each interception point passes its own level.

const origConsoleLog = console.log;
const origConsoleWarn = console.warn;
const origConsoleError = console.error;
const tracePrefix = "TRACE:";

const SUPPRESSED_TRACES = [/Unknown feature being requested/];

function interceptTrace(text: string, level: LogLevel): boolean {
    if (text.startsWith(tracePrefix)) {
        const msg = text.slice(tracePrefix.length).trim();
        if (SUPPRESSED_TRACES.some((p) => p.test(msg))) return true;
        traces.push(msg);
        emit("log", level, msg);
        return true;
    }
    return false;
}

console.log = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string") {
        if (interceptTrace(first, "info")) return;
        if (first.startsWith("- ") || first.startsWith("navigator unavailable"))
            return;
    }
    // Console writes through the patched process.stdout.write below, which
    // redacts, so nothing more is needed here.
    origConsoleLog.apply(console, args);
};

console.warn = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && interceptTrace(first, "warn")) return;
    origConsoleWarn.apply(console, args);
};

console.error = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && interceptTrace(first, "error")) return;
    origConsoleError.apply(console, args);
};

const origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    const str = typeof chunk === "string" ? chunk : String(chunk);
    if (str.startsWith(tracePrefix)) {
        interceptTrace(str.trimEnd(), "info");
        return true;
    }
    return (origStdoutWrite as Function)(
        typeof chunk === "string" ? redact(chunk) : chunk,
        ...rest,
    );
}) as typeof process.stdout.write;

// Anything that reaches stderr without going through console.warn/error
// above (e.g. a direct write) is treated as an error; the suppressed-trace
// list keeps the feature-config notices out of the diagnosis.
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    const str = typeof chunk === "string" ? chunk : String(chunk);
    if (str.startsWith(tracePrefix)) {
        interceptTrace(str.trimEnd(), "error");
        return true;
    }
    return (origStderrWrite as Function)(
        typeof chunk === "string" ? redact(chunk) : chunk,
        ...rest,
    );
}) as typeof process.stderr.write;

// ── SDK logging ────────────────────────────────────────────────────────

import type {
    ArchitectScripting,
    ArchSession,
} from "purecloud-flow-scripting-api-sdk-javascript";

const LEVEL_PREFIX: Record<string, LogLevel> = {
    error: "error",
    warning: "warn",
    info: "info",
};

interface SdkLogMessage {
    logType?: string;
    messageParts?: { message?: string };
    messageFull?: string;
}

let publishedFlowId: string | undefined;
let publishedFlowName: string | undefined;
let replacedFlowId: string | undefined;
let publishSucceeded = false;
let checkInSucceeded = false;
let sdkVersion: string | undefined;

interface ValidationIssue {
    severity: "error" | "warning";
    text: string;
}

const validationIssues: ValidationIssue[] = [];
let inValidationSummary = false;
let summaryHeaderIndent: number | undefined;
let summaryHeader: string | undefined;

/**
 * Captures the SDK's validation summary from the log. Current SDKs log it as
 * one multi-line message (older ones a line per message), laid out as:
 *
 *     Validation Summary
 *       <object logStr>
 *         <issue text>
 *       - Validation Summary Done
 *
 * The issue lines carry no severity marker (the SDK's "Error: "/"Warning: "
 * prefixes are lost to an operator-precedence slip in its getSummaryStr), so
 * the level the summary is logged at is the only severity signal: error when
 * any issue is an error, warning otherwise. Issues are prefixed with their
 * object's logStr, matching the validateAsync() path.
 *
 * Returns true when the message was part of the summary.
 */
function captureValidationSummary(msg: string, level: string): boolean {
    let consumed = false;
    for (const line of msg.split("\n")) {
        if (line.includes("Validation Summary Done")) {
            inValidationSummary = false;
            summaryHeaderIndent = undefined;
            summaryHeader = undefined;
            consumed = true;
        } else if (line.includes("Validation Summary")) {
            inValidationSummary = true;
            consumed = true;
        } else if (inValidationSummary) {
            consumed = true;
            const text = line.trim();
            if (!text || text === "No validation issues.") continue;
            const indent = line.length - line.trimStart().length;
            if (
                summaryHeaderIndent === undefined ||
                indent <= summaryHeaderIndent
            ) {
                summaryHeaderIndent = indent;
                summaryHeader = text;
                continue;
            }
            validationIssues.push({
                severity: level === "error" ? "error" : "warning",
                text: summaryHeader ? `[${summaryHeader}] ${text}` : text,
            });
        }
    }
    return consumed;
}

const FLOW_CREATED_RE =
    /successfully created flow name '(.+?)' \(id: '(.+?)'\)/;
// Logged by createAsync when it deletes an existing flow of the same name
// before creating the new one. The id is the one the caller no longer has.
const FLOW_REPLACED_RE =
    /successfully posted request to delete the existing flow named '.+?' \(id: '(.+?)'\)/;
const PUBLISH_SUCCEEDED_RE = /publishAsync - publish successful/;
const CHECK_IN_SUCCEEDED_RE = /checkInAsync - checked in/;

function installLogging(scripting: ArchitectScripting): void {
    const logging = scripting.services.archLogging;
    logging.setLoggingCallback((logMessage: SdkLogMessage) => {
        const level = logMessage.logType || "info";
        const msg =
            logMessage.messageParts?.message || logMessage.messageFull || "";
        // Returning true tells the SDK the line was handled, so it does not
        // echo it to the console itself; false would print the credential.
        if (msg.includes("clientSecret:") || msg.includes("auth token"))
            return true;

        const created = msg.match(FLOW_CREATED_RE);
        if (created) {
            publishedFlowName = created[1];
            publishedFlowId = created[2];
        }
        const replaced = msg.match(FLOW_REPLACED_RE);
        if (replaced) {
            replacedFlowId = replaced[1];
        }
        if (PUBLISH_SUCCEEDED_RE.test(msg)) {
            publishSucceeded = true;
        }
        if (CHECK_IN_SUCCEEDED_RE.test(msg)) {
            checkInSucceeded = true;
        }

        const isSummary = captureValidationSummary(msg, level);
        if (
            !isSummary &&
            level === "warning" &&
            !msg.includes("end method is being called")
        ) {
            validationIssues.push({ severity: "warning", text: msg });
        }

        emit("log", LEVEL_PREFIX[level] || "info", msg);
        return false;
    });
}

// ── Session wrapper ────────────────────────────────────────────────────

interface SessionConfig {
    region: string;
    clientId: string;
    clientSecret: string;
}

function startSession(
    scripting: ArchitectScripting,
    { region, clientId, clientSecret }: SessionConfig,
): Promise<ArchSession> {
    const session = scripting.environment.archSession;
    session.endTerminatesProcess = false;

    return new Promise((resolve, reject) => {
        let started = false;
        session.startWithClientIdAndSecret(
            region,
            function onStarted() {
                started = true;
                resolve(session);
            },
            clientId,
            clientSecret,
            function onEnding() {
                if (started) return;
                const lastHttp = httpErrors[httpErrors.length - 1];
                const lastTrace = traces[traces.length - 1];
                const detail = lastHttp
                    ? `HTTP ${lastHttp.status}: ${typeof lastHttp.body === "object" ? (lastHttp.body as any).message || JSON.stringify(lastHttp.body) : lastHttp.body}`
                    : lastTrace ||
                      "Session ended before authentication completed";
                reject(new Error(`Session start failed — ${detail}`));
            },
            true,
        );
    });
}

// ── Region mapping ────────────────────────────────────────────────────
// The Platform Client SDK uses API domains (e.g. "usw2.pure.cloud") but
// the Architect Scripting SDK expects enum strings (e.g. "prod_us_west_2").

const API_DOMAIN_TO_SDK_REGION: Record<string, string> = {
    "mypurecloud.com": "prod_us_east_1",
    "use2.us-gov-pure.cloud": "prod_us_east_2",
    "usw2.pure.cloud": "prod_us_west_2",
    "cac1.pure.cloud": "prod_ca_central_1",
    "mypurecloud.ie": "prod_eu_west_1",
    "euw2.pure.cloud": "prod_eu_west_2",
    "euc1.pure.cloud": "prod_eu_central_1",
    "euc2.pure.cloud": "prod_eu_central_2",
    "apse2.pure.cloud": "prod_ap_southeast_2",
    "apne1.pure.cloud": "prod_ap_northeast_1",
    "apne2.pure.cloud": "prod_ap_northeast_2",
    "apne3.pure.cloud": "prod_ap_northeast_3",
    "aps1.pure.cloud": "prod_ap_south_1",
    "apse1.pure.cloud": "prod_ap_southeast_1",
    "mec1.pure.cloud": "prod_me_central_1",
    "sae1.pure.cloud": "prod_sa_east_1",
    "afs1.pure.cloud": "prod_af_south_1",
};

function toArchitectSdkRegion(
    scripting: ArchitectScripting,
    apiDomain: string,
): string | undefined {
    const mapped = API_DOMAIN_TO_SDK_REGION[apiDomain];
    if (mapped) return mapped;
    const locations = scripting.enums.archEnums.LOCATIONS as Record<
        string,
        string
    >;
    if (Object.values(locations).includes(apiDomain)) return apiDomain;
    return undefined;
}

// ── Result assembly ───────────────────────────────────────────────────

/** Validation issues captured from the SDK log, split by severity. */
function validationFromLog(): DeployValidation {
    const texts = (severity: ValidationIssue["severity"]) =>
        validationIssues
            .filter((i) => i.severity === severity)
            .map((i) => i.text);
    return { errors: texts("error"), warnings: texts("warning") };
}

function failure(error: string): DeployResultPayload {
    return {
        success: false,
        status: "failed",
        flowId: publishedFlowId,
        flowName: publishedFlowName,
        replacedFlowId,
        validation: validationFromLog(),
        sdkVersion,
        error,
    };
}

function successStatus(): DeployStatus {
    if (publishSucceeded) return "published";
    if (checkInSucceeded) return "checked_in";
    return "saved";
}

/** Shape of the object the flow file's buildFlow() resolves to when it returns
 *  the result of checkInAsync()/publishAsync()/saveAsync(), all of which
 *  resolve to the flow itself. Everything is optional because a flow file
 *  may return anything. */
interface FlowLike {
    id?: unknown;
    name?: unknown;
    flowType?: unknown;
    url?: unknown;
    validateAsync?: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function success(
    flow: FlowLike | undefined,
    validation: DeployValidation,
): DeployResultPayload {
    return {
        success: true,
        status: successStatus(),
        // Prefer what the flow object reports; fall back to what the SDK
        // logged during createAsync, which is all we have when buildFlow()
        // returns something other than the flow.
        flowId: nonEmptyString(flow?.id) ?? publishedFlowId,
        flowName: nonEmptyString(flow?.name) ?? publishedFlowName,
        flowType: nonEmptyString(flow?.flowType),
        flowUrl: nonEmptyString(flow?.url),
        replacedFlowId,
        validation,
        sdkVersion,
    };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const timer = setTimeout(() => {
        emit("result", failure(`Deploy timed out after ${TIMEOUT_MS / 1000}s`));
        process.exit(2);
    }, TIMEOUT_MS);
    timer.unref();

    const { values } = parseArgs({
        options: {
            "flow-file": { type: "string" },
        },
        strict: true,
    });

    const flowFile = values["flow-file"];

    if (!flowFile) {
        emit("result", failure("Missing --flow-file argument"));
        process.exit(1);
    }

    const absoluteFlowPath = path.resolve(flowFile);

    const region = process.env.GENESYS_REGION;
    const clientId = process.env.GENESYS_CLIENT_ID;
    const clientSecret = process.env.GENESYS_CLIENT_SECRET;

    if (!region || !clientId || !clientSecret) {
        emit(
            "result",
            failure(
                "Missing required environment variables: GENESYS_REGION, GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET",
            ),
        );
        process.exit(1);
    }

    emit("log", "info", "Loading Architect Scripting SDK...");
    const scripting: ArchitectScripting = require("purecloud-flow-scripting-api-sdk-javascript");

    installLogging(scripting);
    sdkVersion = nonEmptyString(
        scripting.environment.ArchScriptingInfo?.version,
    );

    const sdkRegion = toArchitectSdkRegion(scripting, region);
    if (!sdkRegion) {
        emit(
            "result",
            failure(
                `Unknown region "${region}". Known API domains: ${Object.keys(API_DOMAIN_TO_SDK_REGION).join(", ")}`,
            ),
        );
        process.exit(1);
    }

    emit("log", "info", `Starting SDK session (region: ${sdkRegion})...`);

    const session = await startSession(scripting, {
        region: sdkRegion,
        clientId,
        clientSecret,
    });

    try {
        emit("log", "info", `Importing flow file: ${absoluteFlowPath}`);
        const mod = await import(pathToFileURL(absoluteFlowPath).href);

        if (typeof mod.buildFlow !== "function") {
            emit(
                "result",
                failure(
                    `Flow file does not export a buildFlow function: ${absoluteFlowPath}`,
                ),
            );
            return;
        }

        const flowResult: FlowLike | undefined = await mod.buildFlow(scripting);

        // "saved" promises the flow exists. Without an id from the returned
        // object or the SDK's create log, and no check-in or publish seen,
        // nothing was created and reporting success would mislead.
        const knownFlowId = nonEmptyString(flowResult?.id) ?? publishedFlowId;
        if (!knownFlowId && !publishSucceeded && !checkInSucceeded) {
            emit(
                "result",
                failure(
                    "buildFlow() returned without creating a flow: no flow id was returned or logged by the SDK",
                ),
            );
            return;
        }

        let validation: DeployValidation = { errors: [], warnings: [] };
        if (typeof flowResult?.validateAsync === "function") {
            try {
                const results = await flowResult.validateAsync();
                if (results.hasErrorsOrWarnings) {
                    for (const issue of results.issues) {
                        const label = issue.archObject?.logStr ?? "Unknown";
                        for (const err of issue.errors ?? [])
                            validation.errors.push(`[${label}] ${err}`);
                        for (const warn of issue.warnings ?? [])
                            validation.warnings.push(`[${label}] ${warn}`);
                    }
                    for (const e of validation.errors)
                        emit("log", "error", `Validation error ${e}`);
                    for (const w of validation.warnings)
                        emit("log", "warn", `Validation warning ${w}`);
                }
            } catch {
                validation = validationFromLog();
            }
        } else {
            validation = validationFromLog();
        }

        emit("result", success(flowResult, validation));
    } catch (err) {
        if (publishSucceeded || checkInSucceeded) {
            // The publish or check-in itself went through; whatever threw
            // afterwards (typically the searchability poll) does not undo it.
            emit("result", success(undefined, validationFromLog()));
        } else {
            const message = err instanceof Error ? err.message : String(err);
            emit("result", failure(message));
        }
    } finally {
        session.endExitCode = 0;
        session.end();
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        emit(
            "result",
            failure(
                `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
            ),
        );
        process.exit(1);
    });
