import { writeSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import platformClient from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import { createRedactor, credentialSecrets } from "../shared/redact.ts";
import { deployFlow } from "./tools/deploy-flow.ts";
import { findFlow } from "./tools/find-flow.ts";
import { findFlowExecution } from "./tools/find-flow-execution.ts";
import { findQueue } from "./tools/find-queue.ts";
import { flowAction } from "./tools/flow-action.ts";
import { flowDependencies } from "./tools/flow-dependencies.ts";
import { flowDiagram } from "./tools/flow-diagram.ts";
import { flowExecutionData } from "./tools/flow-execution-data.ts";
import { flowIr } from "./tools/flow-ir.ts";
import { flowVersions } from "./tools/flow-versions.ts";
import { getPrompts } from "./tools/get-prompts.ts";
import { orgDetails } from "./tools/org-details.ts";
import { searchInFlow } from "./tools/search-in-flow.ts";
import { testBotFlow } from "./tools/test-bot-flow.ts";

/**
 * Writes the message synchronously before exiting: console.error to a pipe is
 * asynchronous on macOS, so process.exit straight after it can drop the line.
 */
function exitWithError(message: string): never {
    writeSync(2, `${message}\n`);
    process.exit(1);
}

const envResults = z
    .object({
        GENESYS_REGION: z.string().min(1),
        GENESYS_CLIENT_ID: z.string().min(1),
        GENESYS_CLIENT_SECRET: z.string().min(1),
        DEPLOY_SCRIPT_PATH: z.string().min(1),
        // Where flow_diagram's rasteriser assets are; defaults to servers/assets
        DIAGRAM_ASSETS_PATH: z.string().min(1).optional(),
        // Used for MCP Server smoke test in CI workflow
        PREVENT_LOGIN: z
            .enum(["TRUE", "FALSE"])
            .default("FALSE")
            .transform((v) => v === "TRUE"),
    })
    .safeParse(process.env);

if (!envResults.success) {
    const missing = envResults.error.issues.map((i) => i.path[0]).join("\n ");
    exitWithError(`Missing required environment variables:\n ${missing}`);
}

const envVars = envResults.data;

const server = new McpServer({
    name: "genesys-cloud-architect",
    version: process.env.npm_package_version ?? "0.0.0",
});

const architectApi = new platformClient.ArchitectApi();
const routingApi = new platformClient.RoutingApi();

const orgDetailsTool = orgDetails({
    organizationApi: new platformClient.OrganizationApi(),
});
server.registerTool(
    "org_details",
    orgDetailsTool.config,
    orgDetailsTool.handler,
);

const findFlowTool = findFlow({ architectApi });
server.registerTool("find_flow", findFlowTool.config, findFlowTool.handler);

const findQueueTool = findQueue({ routingApi });
server.registerTool("find_queue", findQueueTool.config, findQueueTool.handler);

const flowDependenciesTool = flowDependencies({ architectApi });
server.registerTool(
    "flow_dependencies",
    flowDependenciesTool.config,
    flowDependenciesTool.handler,
);

const flowVersionsTool = flowVersions({ architectApi });
server.registerTool(
    "flow_versions",
    flowVersionsTool.config,
    flowVersionsTool.handler,
);

const flowIrTool = flowIr({ architectApi });
server.registerTool("flow_ir", flowIrTool.config, flowIrTool.handler);

const flowActionTool = flowAction({ architectApi });
server.registerTool(
    "flow_action",
    flowActionTool.config,
    flowActionTool.handler,
);

const flowDiagramTool = flowDiagram({
    architectApi,
    assetsPath: envVars.DIAGRAM_ASSETS_PATH,
});
server.registerTool(
    "flow_diagram",
    flowDiagramTool.config,
    flowDiagramTool.handler,
);

const searchInFlowTool = searchInFlow({ architectApi });
server.registerTool(
    "search_in_flow",
    searchInFlowTool.config,
    searchInFlowTool.handler,
);

const findFlowExecutionTool = findFlowExecution({ architectApi });
server.registerTool(
    "find_flow_execution",
    findFlowExecutionTool.config,
    findFlowExecutionTool.handler,
);

const flowExecutionDataTool = flowExecutionData({ architectApi });
server.registerTool(
    "flow_execution_data",
    flowExecutionDataTool.config,
    flowExecutionDataTool.handler,
);

const getPromptsTool = getPrompts({ architectApi });
server.registerTool(
    "get_prompts",
    getPromptsTool.config,
    getPromptsTool.handler,
);

const deployFlowTool = deployFlow({
    region: envVars.GENESYS_REGION,
    clientId: envVars.GENESYS_CLIENT_ID,
    clientSecret: envVars.GENESYS_CLIENT_SECRET,
    deployScriptPath: envVars.DEPLOY_SCRIPT_PATH,
});
server.registerTool(
    "deploy_flow",
    deployFlowTool.config,
    deployFlowTool.handler,
);

const testBotFlowTool = testBotFlow({
    textbotsApi: new platformClient.TextbotsApi(),
    architectApi,
});
server.registerTool(
    "test_bot_flow",
    testBotFlowTool.config,
    testBotFlowTool.handler,
);

void (async () => {
    if (envVars.PREVENT_LOGIN) {
        console.warn(
            "Login for Platform API skipped. Calling tools will result in an auth failure.",
        );
    } else {
        const client = platformClient.ApiClient.instance;
        client.setEnvironment(envVars.GENESYS_REGION);
        await client.loginClientCredentialsGrant(
            envVars.GENESYS_CLIENT_ID,
            envVars.GENESYS_CLIENT_SECRET,
        );
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
})().catch((err) => {
    const redact = createRedactor(
        credentialSecrets(
            envVars.GENESYS_CLIENT_ID,
            envVars.GENESYS_CLIENT_SECRET,
        ),
    );
    // Never log the raw error: the SDK's login failures are Axios errors whose
    // config and request carry the `Authorization: Basic` header.
    const message = err instanceof Error ? err.message : String(err);
    const reply = err?.response?.data;
    exitWithError(
        redact(
            `Failed to start server: ${message}${reply ? ` - ${JSON.stringify(reply)}` : ""}`,
        ),
    );
});
