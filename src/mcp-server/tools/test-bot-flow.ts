import type { Models, TextbotsApi } from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import type { ToolFactory } from "./types.ts";

const sessions = new Map<string, string>();

function stripProtocolFields(
    turn: Models.TextBotFlowTurnResponse,
): Omit<Models.TextBotFlowTurnResponse, "id" | "previousTurn"> {
    const { id, previousTurn, ...rest } = turn;
    return rest;
}

async function drainNoOps(
    textbotsApi: TextbotsApi,
    activeSessionId: string,
    firstTurn: Models.TextBotFlowTurnResponse,
): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}> {
    const turns: Omit<Models.TextBotFlowTurnResponse, "id" | "previousTurn">[] =
        [];
    let turn = firstTurn;

    while (true) {
        turns.push(stripProtocolFields(turn));
        sessions.set(activeSessionId, turn.id);

        if (turn.nextActionType !== "NoOp") break;

        turn = await textbotsApi.postTextbotsBotflowsSessionTurns(
            activeSessionId,
            {
                previousTurn: { id: turn.id },
                inputEventType: "NoOp",
                inputEventUserInput: {
                    mode: "Text",
                    alternatives: [{ transcript: { text: "" } }],
                },
            },
        );
    }

    const lastAction = turn.nextActionType;
    if (lastAction === "Disconnect" || lastAction === "Exit") {
        sessions.delete(activeSessionId);
    }

    const result = {
        sessionId: activeSessionId,
        turns,
    };

    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
}

export interface TestBotFlowConfig {
    textbotsApi: TextbotsApi;
}

const inputSchema = {
    flowId: z
        .string()
        .optional()
        .describe(
            "The bot flow ID to test. Required when starting a new session.",
        ),
    sessionId: z
        .string()
        .optional()
        .describe(
            "Session ID from a previous call. Required when continuing an existing conversation.",
        ),
    message: z
        .string()
        .optional()
        .describe(
            "User message to send to the bot. Required when continuing a session.",
        ),
};

export const testBotFlow: ToolFactory<
    TestBotFlowConfig,
    typeof inputSchema
> = ({ textbotsApi }) => ({
    config: {
        description:
            "Tests a deployed Genesys Cloud Architect Bot Flow and Digital Bot Flow by simulating a text conversation. " +
            "To start: provide flowId. To continue: provide the returned sessionId and a message. " +
            "Turn tracking is managed server-side — only the sessionId is needed between calls. " +
            "Returns { sessionId, turns[] } where each turn contains the raw API response (prompts with segments, outputLanguage, nextActionType, and action-specific data like modeConstraints or outputData). " +
            "Multiple turns are returned when the flow sends consecutive messages (NoOp turns are automatically drained). " +
            "nextActionType values: WaitForInput (send another message), Disconnect/Exit (conversation ended).",
        annotations: {
            title: "Test Bot Flow",
            readOnlyHint: false,
            destructiveHint: false,
        },
        inputSchema,
    },
    handler: async ({ flowId, sessionId, message }) => {
        try {
            if (sessionId && flowId) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: "Provide either flowId (to start) or sessionId (to continue), not both.",
                        },
                    ],
                };
            }

            if (!sessionId && !flowId) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: "Provide flowId to start a new session or sessionId to continue an existing one.",
                        },
                    ],
                };
            }

            if (flowId) {
                const session = await textbotsApi.postTextbotsBotflowsSessions({
                    flow: { id: flowId },
                    externalSessionId: "",
                    inputData: { variables: {} },
                    channel: {
                        inputModes: ["Text"],
                        outputModes: ["Text"],
                        name: "Messaging",
                        userAgent: { name: "GenesysWebWidget" },
                    },
                    language: "",
                });

                const turn = await textbotsApi.postTextbotsBotflowsSessionTurns(
                    session.id,
                    {
                        inputEventType: "NoOp",
                        inputEventUserInput: {
                            mode: "Text",
                            alternatives: [{ transcript: { text: "" } }],
                        },
                    },
                );

                return drainNoOps(textbotsApi, session.id, turn);
            }

            if (!sessionId || !message) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: "A message is required when continuing an existing session.",
                        },
                    ],
                };
            }

            const previousTurnId = sessions.get(sessionId);
            if (!previousTurnId) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `No active session found for ID "${sessionId}". It may have expired or already ended. Start a new session with a flowId.`,
                        },
                    ],
                };
            }

            const turn = await textbotsApi.postTextbotsBotflowsSessionTurns(
                sessionId,
                {
                    previousTurn: { id: previousTurnId },
                    inputEventType: "UserInput",
                    inputEventUserInput: {
                        mode: "Text",
                        alternatives: [
                            {
                                transcript: {
                                    text: message,
                                },
                            },
                        ],
                    },
                },
            );

            return drainNoOps(textbotsApi, sessionId, turn);
        } catch (err) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Bot flow test failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
                    },
                ],
            };
        }
    },
});
