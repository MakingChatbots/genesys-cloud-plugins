import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v3";
import type { ToolFactory } from "./types.ts";

interface DeployRunnerLine {
    type: "log" | "result";
    level?: string;
    message?: string;
    success?: boolean;
    flowId?: string;
    flowName?: string;
    warnings?: string[];
    error?: string;
}

const DEPLOY_TIMEOUT_MS = 120_000;

export interface DeployFlowConfig {
    readonly deployScriptPath: string;
    readonly region: string;
    readonly clientId: string;
    readonly clientSecret: string;
}

const inputSchema = {
    flowFile: z.string().min(1).describe("Path to the TypeScript flow file"),
};

export const deployFlow: ToolFactory<DeployFlowConfig, typeof inputSchema> = (
    toolConfig,
) => ({
    config: {
        description:
            "Deploys a Genesys Cloud Architect flow from a TypeScript file. " +
            "The file must export an async buildFlow(scripting) function that " +
            "creates and saves the flow using the Architect Scripting SDK. " +
            'The project\'s package.json must have "type": "module" for the ES module import to work.',
        annotations: {
            title: "Deploy Flow",
            readOnlyHint: false,
            destructiveHint: true,
        },
        inputSchema,
    },
    handler: async ({ flowFile }) => {
        const absolutePath = path.resolve(flowFile);
        if (!fs.existsSync(absolutePath)) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Flow file not found: ${absolutePath}`,
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
            const logs: string[] = [];
            let resultLine: DeployRunnerLine | undefined;
            let settled = false;

            const settle = (value: {
                isError?: boolean;
                content: Array<{ type: "text"; text: string }>;
            }) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
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

            const timer = setTimeout(() => {
                child.kill("SIGTERM");
                settle({
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Deploy timed out after ${DEPLOY_TIMEOUT_MS / 1000}s.\n\nLogs:\n${logs.join("\n")}`,
                        },
                    ],
                });
            }, DEPLOY_TIMEOUT_MS);

            child.on("error", (err) => {
                settle({
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Failed to start deploy runner: ${err.message}`,
                        },
                    ],
                });
            });

            let stdoutBuf = "";
            child.stdout.on("data", (chunk: Buffer) => {
                stdoutBuf += chunk.toString();
                const lines = stdoutBuf.split("\n");
                stdoutBuf = lines.pop() ?? "";

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const parsed = JSON.parse(line) as DeployRunnerLine;
                        if (parsed.type === "log") {
                            logs.push(`[${parsed.level}] ${parsed.message}`);
                        } else if (parsed.type === "result") {
                            resultLine = parsed;
                        }
                    } catch {
                        logs.push(line);
                    }
                }
            });

            let stderrBuf = "";
            child.stderr.on("data", (chunk: Buffer) => {
                stderrBuf += chunk.toString();
            });

            child.on("close", (code) => {
                if (stdoutBuf.trim()) {
                    try {
                        const parsed = JSON.parse(
                            stdoutBuf.trim(),
                        ) as DeployRunnerLine;
                        if (parsed.type === "result") resultLine = parsed;
                        else if (parsed.type === "log")
                            logs.push(`[${parsed.level}] ${parsed.message}`);
                    } catch {
                        if (stdoutBuf.trim()) logs.push(stdoutBuf.trim());
                    }
                }

                const filteredStderr = stderrBuf
                    .split("\n")
                    .filter(
                        (l) =>
                            !l.includes("url.parse()") &&
                            !l.includes("[DEP0169]"),
                    )
                    .join("\n")
                    .trim();
                if (filteredStderr) {
                    logs.push(`[stderr] ${filteredStderr}`);
                }

                const logOutput = logs.length
                    ? `\n\nLogs:\n${logs.join("\n")}`
                    : "";

                if (resultLine?.success) {
                    const parts = ["Flow deployed successfully."];
                    if (resultLine.flowId)
                        parts.push(`Flow ID: ${resultLine.flowId}`);
                    if (resultLine.flowName)
                        parts.push(`Flow Name: ${resultLine.flowName}`);
                    if (resultLine.warnings?.length)
                        parts.push(
                            `\nValidation warnings:\n${resultLine.warnings.join("\n")}`,
                        );

                    settle({
                        content: [
                            {
                                type: "text",
                                text: parts.join("\n") + logOutput,
                            },
                        ],
                    });
                } else {
                    const errorMsg =
                        resultLine?.error ??
                        `Deploy runner exited with code ${code}`;
                    settle({
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `Deploy failed: ${errorMsg}${logOutput}`,
                            },
                        ],
                    });
                }
            });
        });
    },
});
