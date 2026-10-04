import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v3";
import type {
    DeployResultPayload,
    DeployStatus,
    DeployValidation,
} from "../../shared/deploy-result.ts";
import { createRedactor, credentialSecrets } from "../../shared/redact.ts";
import type { ToolFactory } from "./types.ts";

interface RunnerLogLine {
    type: "log";
    level?: string;
    message?: string;
}

type RunnerResultLine = DeployResultPayload & { type: "result" };

type RunnerLine = RunnerLogLine | RunnerResultLine;

interface LogEntry {
    level: string;
    message: string;
}

/**
 * The tool's JSON result. Facts the runner could not establish are null rather
 * than omitted so the key set is the same on every call. `error`, `diagnosis`
 * and `log` are present only on failure, except `log`, which `verbose` adds to
 * a success too.
 */
export interface DeployFlowResult {
    status: DeployStatus;
    error?: string;
    /** The SDK's own error-level log lines, in order, deduplicated. */
    diagnosis?: string[];
    flowId: string | null;
    flowName: string | null;
    flowType: string | null;
    flowUrl: string | null;
    /** Id of a same-name flow the SDK deleted before creating this one. The
     *  explicit signal that the flow's id changed on this deploy. */
    replacedFlowId: string | null;
    validation: DeployValidation;
    sdkVersion: string | null;
    durationMs: number;
    log?: string[];
}

const DEPLOY_TIMEOUT_MS = 120_000;
const MAX_DIAGNOSIS_LINES = 10;

export interface DeployFlowConfig {
    readonly deployScriptPath: string;
    readonly region: string;
    readonly clientId: string;
    readonly clientSecret: string;
}

const inputSchema = {
    flowFile: z.string().min(1).describe("Path to the TypeScript flow file"),
    verbose: z
        .boolean()
        .optional()
        .describe(
            "Include the full SDK log in a successful result. The log is " +
                "always included when the deploy fails. Defaults to false.",
        ),
};

function emptyValidation(): DeployValidation {
    return { errors: [], warnings: [] };
}

function formatLog(logs: readonly LogEntry[]): string[] {
    return logs.map((l) => `[${l.level}] ${l.message}`);
}

function diagnosisFrom(logs: readonly LogEntry[]): string[] {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const entry of logs) {
        if (entry.level !== "error" || seen.has(entry.message)) continue;
        seen.add(entry.message);
        lines.push(entry.message);
        if (lines.length >= MAX_DIAGNOSIS_LINES) break;
    }
    return lines;
}

interface BuildResultOptions {
    runnerResult?: RunnerResultLine;
    /** Overrides the runner's own error; used when the runner never reported. */
    error?: string;
    logs: readonly LogEntry[];
    verbose: boolean;
    startedAt: number;
}

function buildResult({
    runnerResult,
    error,
    logs,
    verbose,
    startedAt,
}: BuildResultOptions): DeployFlowResult {
    const failed = error !== undefined || !runnerResult?.success;
    const facts = {
        flowId: runnerResult?.flowId ?? null,
        flowName: runnerResult?.flowName ?? null,
        flowType: runnerResult?.flowType ?? null,
        flowUrl: runnerResult?.flowUrl ?? null,
        replacedFlowId: runnerResult?.replacedFlowId ?? null,
        validation: runnerResult?.validation ?? emptyValidation(),
        sdkVersion: runnerResult?.sdkVersion ?? null,
        durationMs: Date.now() - startedAt,
    };

    if (failed) {
        // Error first, so what went wrong is read before anything else.
        return {
            status: "failed",
            error: error ?? runnerResult?.error ?? "Deploy failed",
            diagnosis: diagnosisFrom(logs),
            ...facts,
            log: formatLog(logs),
        };
    }

    return {
        status: runnerResult.status,
        ...facts,
        ...(verbose ? { log: formatLog(logs) } : {}),
    };
}

export const deployFlow: ToolFactory<DeployFlowConfig, typeof inputSchema> = (
    toolConfig,
) => ({
    config: {
        description:
            "Deploys a Genesys Cloud Architect flow from a TypeScript file. " +
            "The file must export an async buildFlow(scripting) function that " +
            "creates and saves the flow using the Architect Scripting SDK. " +
            'The project\'s package.json must have "type": "module" for the ES module import to work. ' +
            "Returns JSON with status ('published', 'checked_in', 'saved' or 'failed'), " +
            "flowId, flowName, flowType, flowUrl, replacedFlowId (the id of a same-name " +
            "flow the SDK deleted before creating this one, meaning the flow id changed; " +
            "null when nothing was replaced), validation {errors, warnings}, sdkVersion " +
            "and durationMs. On failure, error and diagnosis (the SDK's own error lines) " +
            "come first and the full log is attached. On success the log is omitted " +
            "unless verbose is true.",
        annotations: {
            title: "Deploy Flow",
            readOnlyHint: false,
            destructiveHint: true,
        },
        inputSchema,
    },
    handler: async ({ flowFile, verbose = false }) => {
        const startedAt = Date.now();
        // The runner redacts its own output; this catches anything it missed.
        const redact = createRedactor(
            credentialSecrets(toolConfig.clientId, toolConfig.clientSecret),
        );
        const absolutePath = path.resolve(flowFile);
        if (!fs.existsSync(absolutePath)) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            buildResult({
                                error: `Flow file not found: ${absolutePath}`,
                                logs: [],
                                verbose,
                                startedAt,
                            }),
                        ),
                    },
                ],
            };
        }

        const nodeArgs = [
            toolConfig.deployScriptPath,
            "--flow-file",
            absolutePath,
        ];

        return new Promise((resolve) => {
            const logs: LogEntry[] = [];
            let resultLine: RunnerResultLine | undefined;
            let settled = false;

            const settle = (result: DeployFlowResult) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({
                    ...(result.status === "failed" ? { isError: true } : {}),
                    content: [{ type: "text", text: JSON.stringify(result) }],
                });
            };

            const fail = (error: string) =>
                settle(
                    buildResult({
                        runnerResult: resultLine,
                        error,
                        logs,
                        verbose,
                        startedAt,
                    }),
                );

            const ingest = (line: string) => {
                if (!line.trim()) return;
                try {
                    const parsed = JSON.parse(line) as RunnerLine;
                    if (parsed.type === "log") {
                        logs.push({
                            level: parsed.level ?? "info",
                            message: redact(parsed.message ?? ""),
                        });
                    } else if (parsed.type === "result") {
                        resultLine = {
                            ...parsed,
                            ...(parsed.error === undefined
                                ? {}
                                : { error: redact(parsed.error) }),
                        };
                    }
                } catch {
                    // Anything the runner (or the SDK underneath it) wrote
                    // to stdout without going through emit().
                    logs.push({ level: "info", message: redact(line) });
                }
            };

            const child = spawn("node", nodeArgs, {
                env: {
                    ...process.env,
                    GENESYS_REGION: toolConfig.region,
                    GENESYS_CLIENT_ID: toolConfig.clientId,
                    GENESYS_CLIENT_SECRET: toolConfig.clientSecret,
                },
                cwd: path.dirname(absolutePath),
                stdio: ["ignore", "pipe", "pipe"],
            });

            const succeed = () =>
                settle(
                    buildResult({
                        runnerResult: resultLine,
                        logs,
                        verbose,
                        startedAt,
                    }),
                );

            let stderrBuf = "";
            child.stderr.on("data", (chunk: Buffer) => {
                stderrBuf += chunk.toString();
            });

            // stderr is where an import failure or uncaught exception lands,
            // so it belongs in the diagnosis whichever path settles the
            // result. Node's own url.parse() deprecation warning is noise
            // from the SDK's dependencies, not a deploy problem.
            const flushStderr = () => {
                const filtered = stderrBuf
                    .split("\n")
                    .filter(
                        (l) =>
                            !l.includes("url.parse()") &&
                            !l.includes("[DEP0169]"),
                    )
                    .join("\n")
                    .trim();
                stderrBuf = "";
                if (filtered) {
                    logs.push({ level: "error", message: redact(filtered) });
                }
            };

            const timer = setTimeout(() => {
                child.kill("SIGTERM");
                flushStderr();
                // A hang after the result line is session teardown, not a
                // failed deploy; keep the outcome the runner reported.
                if (resultLine?.success) succeed();
                else
                    fail(
                        `Deploy timed out after ${DEPLOY_TIMEOUT_MS / 1000}s.`,
                    );
            }, DEPLOY_TIMEOUT_MS);

            child.on("error", (err) => {
                fail(`Failed to start deploy runner: ${err.message}`);
            });

            let stdoutBuf = "";
            child.stdout.on("data", (chunk: Buffer) => {
                stdoutBuf += chunk.toString();
                const lines = stdoutBuf.split("\n");
                stdoutBuf = lines.pop() ?? "";
                for (const line of lines) ingest(line);
            });

            child.on("close", (code) => {
                ingest(stdoutBuf.trim());
                flushStderr();

                if (resultLine?.success) succeed();
                else
                    fail(
                        resultLine?.error ??
                            `Deploy runner exited with code ${code}`,
                    );
            });
        });
    },
});
