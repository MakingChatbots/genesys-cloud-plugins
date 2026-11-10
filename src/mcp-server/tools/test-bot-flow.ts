import type {
    ArchitectApi,
    Models,
    TextbotsApi,
} from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import {
    authHint,
    formatApiError,
    toApiError,
} from "../utilities/api-error.ts";
import { nameKey } from "../utilities/name-match.ts";
import type { ToolFactory } from "../utilities/types.ts";

const TEXTBOTS_PERMISSION =
    "Text Bots > Bot Flow Session > Execute (textbots:botFlowSession:execute)";
const ARCHITECT_PERMISSION = "Architect > Flow > View (architect:flow:view)";

type InputValue = string | number | boolean;

/** A problem with the tool's arguments, reported to the caller verbatim. */
class ToolInputError extends Error {}

/**
 * formatApiError plus the parts of a Genesys error body that say which field
 * was wrong. The SDK rejects with the raw response body, so these fields sit
 * on the rejected value itself.
 */
function describeApiError(err: unknown): string {
    const base = formatApiError(err);
    if (err === null || typeof err !== "object") return base;
    const extra: Record<string, unknown> = {};
    for (const field of ["details", "errors", "messageParams"] as const) {
        const value = (err as Record<string, unknown>)[field];
        const isEmpty =
            value === undefined ||
            value === null ||
            (Array.isArray(value) && value.length === 0) ||
            (typeof value === "object" && Object.keys(value).length === 0);
        if (!isEmpty) extra[field] = value;
    }
    return Object.keys(extra).length > 0
        ? `${base} ${JSON.stringify(extra)}`
        : base;
}

function normaliseVariableName(name: string): string {
    return nameKey(name.trim().replace(/^flow\./i, ""));
}

const EXPECTED_VALUE: Record<string, string> = {
    string: "a string",
    boolean: "true or false",
    integer: "a whole number",
    number: "a number",
};

/**
 * The value types the schema allows that we can check, or undefined when the
 * schema's type includes one we don't model (dates, collections, ...), which
 * is left for the API to validate. "null" is ignored: inputs are never null.
 */
function checkableTypes(schemaType: unknown): string[] | undefined {
    const types = [
        ...new Set(Array.isArray(schemaType) ? schemaType : [schemaType]),
    ].filter((t) => t !== "null");
    if (types.length === 0) return undefined;
    return types.every(
        (t) => typeof t === "string" && Object.hasOwn(EXPECTED_VALUE, t),
    )
        ? (types as string[])
        : undefined;
}

interface SchemaNode {
    type?: unknown;
    $ref?: unknown;
    oneOf?: unknown;
    anyOf?: unknown;
}

/** The definition name in a `#/definitions/<name>` reference, if any. */
function refName(node: SchemaNode | undefined): string | undefined {
    return typeof node?.$ref === "string"
        ? node.$ref.match(/^#\/definitions\/(.+)$/)?.[1]
        : undefined;
}

/**
 * Every JSON Schema `type` an input variable allows. Genesys writes a
 * variable as `{"$ref": "#/definitions/archString"}`, and the shared
 * definition as a choice between NOT_SET and the real type:
 * `{"oneOf": [{"type": "null"}, {"type": "string", ...}]}`. So references
 * are followed into the schema's `definitions`, and `oneOf`/`anyOf` branches
 * are combined. Undefined when any part can't be worked out, which leaves
 * the value for the API to validate.
 */
function schemaTypesOf(
    node: SchemaNode | undefined,
    definitions: Record<string, SchemaNode> | undefined,
    depth = 0,
): unknown[] | undefined {
    if (!node || depth > 10) return undefined;
    if (node.type !== undefined) {
        return Array.isArray(node.type) ? node.type : [node.type];
    }
    const name = refName(node);
    if (name !== undefined) {
        return definitions && Object.hasOwn(definitions, name)
            ? schemaTypesOf(definitions[name], definitions, depth + 1)
            : undefined;
    }
    const branches = node.oneOf ?? node.anyOf;
    if (!Array.isArray(branches) || branches.length === 0) return undefined;
    const types: unknown[] = [];
    for (const branch of branches) {
        const branchTypes = schemaTypesOf(branch, definitions, depth + 1);
        if (!branchTypes) return undefined;
        types.push(...branchTypes);
    }
    return types;
}

function matchesType(value: InputValue, type: string): boolean {
    switch (type) {
        case "string":
            return typeof value === "string";
        case "boolean":
            return typeof value === "boolean";
        case "integer":
            return typeof value === "number" && Number.isInteger(value);
        case "number":
            return typeof value === "number";
        default:
            return false;
    }
}

/**
 * Maps the caller's input names onto the exact property names of the flow's
 * published input schema, so either `AccountNumber` or
 * `Flow.AccountNumber` works whichever form the schema uses. Names that
 * aren't flow inputs, two names for the same input, and values of the wrong
 * type throw a ToolInputError rather than being silently dropped or
 * overwritten.
 */
async function resolveInputs(
    architectApi: ArchitectApi,
    flowId: string,
    inputs: Record<string, InputValue>,
): Promise<ResolvedInputs> {
    let page: Models.FlowEntityListing;
    try {
        page = await architectApi.getFlows({
            id: [flowId],
            includeSchemas: true,
        });
    } catch (err) {
        throw new ToolInputError(
            `Couldn't read the input variables of flow "${flowId}": ${describeApiError(err)}.${authHint(toApiError(err).status, ARCHITECT_PERMISSION)}`,
        );
    }
    const flow = page.entities?.find((f) => f.id === flowId);
    if (!flow) {
        throw new ToolInputError(`No flow found with ID "${flowId}".`);
    }
    if (!flow.publishedVersion) {
        throw new ToolInputError(
            `Flow "${flow.name}" has no published version, so it can't be tested.`,
        );
    }

    const schema = flow.publishedVersion.inputSchema as
        | (Models.JsonSchemaDocument & {
              // Returned by the API but missing from the SDK's type.
              definitions?: Record<string, SchemaNode>;
          })
        | undefined;
    const properties = (schema?.properties ?? {}) as Record<string, SchemaNode>;
    const byNormalisedName = new Map(
        Object.keys(properties).map((key) => [normaliseVariableName(key), key]),
    );

    const resolved: Record<string, InputValue> = {};
    const givenAs = new Map<string, string>();
    const unknown: string[] = [];
    const duplicates: string[] = [];
    const wrongType: string[] = [];
    for (const [name, value] of Object.entries(inputs)) {
        const key = byNormalisedName.get(normaliseVariableName(name));
        if (!key) {
            unknown.push(name);
            continue;
        }
        const earlier = givenAs.get(key);
        if (earlier !== undefined) {
            duplicates.push(`"${earlier}" and "${name}" both set ${key}`);
            continue;
        }
        givenAs.set(key, name);

        const types = checkableTypes(
            schemaTypesOf(properties[key], schema?.definitions),
        );
        if (types && !types.some((t) => matchesType(value, t))) {
            const expected = types.map((t) => EXPECTED_VALUE[t]).join(" or ");
            wrongType.push(
                `"${name}" must be ${expected} (the flow input is ${types.join("/")}), got ${JSON.stringify(value)}`,
            );
            continue;
        }
        resolved[key] = value;
    }

    const problems: string[] = [];
    if (unknown.length > 0) {
        const available = Object.keys(properties);
        problems.push(
            `Not input variables of flow "${flow.name}": ${unknown.map((n) => `"${n}"`).join(", ")}. ` +
                (available.length > 0
                    ? `Its input variables are: ${available.join(", ")}.`
                    : "The flow's published version has no input variables (a variable must be marked 'Input to flow' and the flow republished)."),
        );
    }
    if (duplicates.length > 0) {
        problems.push(
            `Each input variable can only be given once: ${duplicates.join("; ")}.`,
        );
    }
    if (wrongType.length > 0) {
        problems.push(`Wrong value types: ${wrongType.join("; ")}.`);
    }
    if (problems.length > 0) {
        throw new ToolInputError(problems.join(" "));
    }
    const definitions: Record<string, unknown> = {};
    for (const key of Object.keys(resolved)) {
        // Include the shared definition a reference points to, so the error
        // shows the whole type, not just "$ref": "#/definitions/archString".
        const name = refName(properties[key]);
        definitions[key] =
            name !== undefined
                ? {
                      ...properties[key],
                      [`definitions.${name}`]:
                          schema?.definitions?.[name] ??
                          "(not in the schema's definitions)",
                  }
                : properties[key];
    }
    return { variables: resolved, definitions };
}

interface ResolvedInputs {
    /** Values keyed by the exact names in the flow's input schema. */
    variables: Record<string, InputValue>;
    /** The schema definition of each variable that was set, by the same key. */
    definitions: Record<string, unknown>;
}

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
    inputDefinitions: Record<string, unknown> = {},
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

    // A flow that fails (including rejecting an input value) doesn't produce
    // an HTTP error: it exits normally with reason "Error". Report that as a
    // tool error, keeping the turns so its outputs can still be inspected.
    const exit = turn.nextActionExit;
    if (lastAction === "Exit" && exit?.reason === "Error") {
        const info = exit.reasonExtendedInfo;
        const invalidInput = info?.match(/^InvalidInputVariable\.(.+)$/)?.[1];
        const definition =
            invalidInput !== undefined
                ? inputDefinitions[invalidInput]
                : undefined;
        const summary = invalidInput
            ? `The flow rejected the value given for input ${invalidInput}; check it matches the variable's type in the flow.` +
              (definition !== undefined
                  ? ` Its definition in the flow's input schema: ${JSON.stringify(definition)}.`
                  : "")
            : `The flow exited with an error${info ? ` (${info})` : ""}.`;
        return {
            isError: true,
            content: [
                { type: "text", text: `${summary} ${JSON.stringify(result)}` },
            ],
        };
    }

    return {
        content: [{ type: "text", text: JSON.stringify(result) }],
    };
}

export interface TestBotFlowConfig {
    textbotsApi: TextbotsApi;
    architectApi: ArchitectApi;
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
    inputs: z
        .record(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe(
            "Values for the flow's input variables, set when starting a session (only valid with flowId). " +
                'Keys are variable names with or without the "Flow." prefix, e.g. { "Flow.AccountNumber": "12345678" } or { "AccountNumber": "12345678" }. ' +
                "Values must match the variable's type: string, boolean, or number (integer variables need a whole number).",
        ),
};

export const testBotFlow: ToolFactory<
    TestBotFlowConfig,
    typeof inputSchema
> = ({ textbotsApi, architectApi }) => ({
    config: {
        description:
            "Tests a deployed Genesys Cloud Architect Bot Flow and Digital Bot Flow by simulating a text conversation. " +
            "To start: provide flowId, and optionally inputs to set the flow's input variables (e.g. values a calling flow would normally pass in). To continue: provide the returned sessionId and a message. " +
            "Input names are matched against the published flow's input schema and sent under the exact name the schema uses, so the Flow. prefix is optional; a name that isn't a flow input, or a value of the wrong type, is returned as an error rather than ignored. " +
            "Turn tracking is managed server-side — only the sessionId is needed between calls. " +
            "Returns { sessionId, turns[] } where each turn contains the raw API response (prompts with segments, outputLanguage, nextActionType, and action-specific data like modeConstraints or outputData). " +
            "Multiple turns are returned when the flow sends consecutive messages (NoOp turns are automatically drained). " +
            "nextActionType values: WaitForInput (send another message), Disconnect/Exit (conversation ended). " +
            'An Exit with reason "Error" (e.g. reasonExtendedInfo "InvalidInputVariable.Flow.X" when an input value is rejected) is returned as an error, with the turns still included. ' +
            "When the flow exits, the final turn's outputData.variables holds the flow's output variables, so a test can set inputs and assert on outputs.",
        annotations: {
            title: "Test Bot Flow",
            readOnlyHint: false,
            destructiveHint: false,
        },
        inputSchema,
    },
    handler: async ({ flowId, sessionId, message, inputs }) => {
        try {
            const hasInputs =
                inputs !== undefined && Object.keys(inputs).length > 0;

            if (hasInputs && !flowId) {
                throw new ToolInputError(
                    "inputs can only be set when starting a session with flowId.",
                );
            }
            if (sessionId && flowId) {
                throw new ToolInputError(
                    "Provide either flowId (to start) or sessionId (to continue), not both.",
                );
            }
            if (!sessionId && !flowId) {
                throw new ToolInputError(
                    "Provide flowId to start a new session or sessionId to continue an existing one.",
                );
            }

            if (flowId) {
                const { variables, definitions } = hasInputs
                    ? await resolveInputs(architectApi, flowId, inputs)
                    : { variables: {}, definitions: {} };

                const session = await textbotsApi.postTextbotsBotflowsSessions({
                    flow: { id: flowId },
                    externalSessionId: "",
                    // The SDK types values as object; the API takes JSON
                    // primitives matching each variable's type.
                    inputData: {
                        variables: variables as unknown as Record<
                            string,
                            object
                        >,
                    },
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

                return drainNoOps(textbotsApi, session.id, turn, definitions);
            }

            if (!sessionId || !message) {
                throw new ToolInputError(
                    "A message is required when continuing an existing session.",
                );
            }

            const previousTurnId = sessions.get(sessionId);
            if (!previousTurnId) {
                throw new ToolInputError(
                    `No active session found for ID "${sessionId}". It may have expired or already ended. Start a new session with a flowId.`,
                );
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
            const text =
                err instanceof ToolInputError
                    ? err.message
                    : `Bot flow test failed: ${describeApiError(err)}.${authHint(toApiError(err).status, TEXTBOTS_PERMISSION)}`;
            return {
                isError: true,
                content: [{ type: "text", text }],
            };
        }
    },
});
