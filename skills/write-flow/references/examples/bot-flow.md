# Example: Bot Flow

Bot flow with NLU intent detection and per-intent routing. Bot flows use `AskForIntent` and `AskForSlot` for natural language conversations — the Genesys Dialog Engine handles intent matching and entity extraction at runtime. In a (voice) bot flow each intent is a **dynamic output of the `AskForIntent` action**; `associateWithTask` on the intent settings is only valid in digital bot flows and the SDK rejects it here. After deploying and publishing, use the `test_bot_flow` MCP tool to simulate a text conversation and verify the NLU behaves as expected.

```typescript
import type { ArchitectScripting } from "purecloud-flow-scripting-api-sdk-javascript";

const nluCreationData = {
    nluDomainVersion: {
        language: "en-us",
        intents: [
            {
                name: "CheckBalance",
                utterances: [
                    { segments: [{ text: "I want to check my balance" }] },
                    { segments: [{ text: "What is my account balance" }] },
                    { segments: [{ text: "How much do I owe" }] },
                ],
            },
            {
                name: "MakePayment",
                utterances: [
                    { segments: [{ text: "I want to make a payment" }] },
                    { segments: [{ text: "Pay my bill" }] },
                    { segments: [{ text: "I need to pay" }] },
                ],
            },
        ],
    },
};

export async function buildFlow(scripting: ArchitectScripting) {
    const { archFactoryFlows, archFactoryActions, archFactoryTasks } =
        scripting.factories;

    const flow = await archFactoryFlows.createFlowBotAsync(
        "Example Bot Flow",
        "Bot flow with NLU intent detection, slot filling, and task routing",
        undefined,
        undefined,
        undefined,
        nluCreationData,
    );

    const initialState = flow.startUpObject;

    // Greet the user — bot flows use Communicate with plain string expressions
    const greeting = archFactoryActions.addActionCommunicate(
        initialState,
        "Greeting",
    );
    greeting.communication.setExpression(
        '"Hello! How can I help you today?"',
    );

    // AskForIntent — the Dialog Engine matches user input to configured intents.
    // The action gets one dynamic output per intent in nluCreationData.
    const askIntent = archFactoryActions.addActionAskForIntent(
        initialState,
        "Detect Intent",
    );

    // Create a reusable task per intent, then jump to it from the intent's output
    const balanceTask = archFactoryTasks.addTask(flow, "Check Balance");
    const balanceReply = archFactoryActions.addActionCommunicate(
        balanceTask,
        "Balance Response",
    );
    balanceReply.communication.setExpression(
        '"Let me look up your balance. One moment please."',
    );
    archFactoryActions.addActionExitBotFlow(balanceTask, "Done");

    const paymentTask = archFactoryTasks.addTask(flow, "Make Payment");
    const paymentReply = archFactoryActions.addActionCommunicate(
        paymentTask,
        "Payment Response",
    );
    paymentReply.communication.setExpression(
        '"I can help you make a payment. Let me transfer you to an agent."',
    );
    archFactoryActions.addActionExitBotFlow(paymentTask, "Done");

    // Route each intent output to its task. Intent outputs are dynamic, so the
    // `true` flag is required (same as DigitalMenu choices).
    archFactoryActions.addActionJumpToTask(
        askIntent.getOutputByName("CheckBalance", true),
        "Go to Check Balance",
        balanceTask,
    );
    archFactoryActions.addActionJumpToTask(
        askIntent.getOutputByName("MakePayment", true),
        "Go to Make Payment",
        paymentTask,
    );

    // Handle no intent detected. The No Intent output is disabled by default
    // in bot flows, so enable it or everything on it is unreachable. Every
    // path also needs a terminating action or validation fails with
    // "The bot does not contain a terminating action".
    const noIntentPath = askIntent.outputNoIntent;
    noIntentPath.enabled = true;
    const fallback = archFactoryActions.addActionCommunicate(
        noIntentPath,
        "No Intent",
    );
    fallback.communication.setExpression(
        '"I\'m sorry, I didn\'t understand that. Could you try rephrasing?"',
    );
    archFactoryActions.addActionExitBotFlow(noIntentPath, "Exit After No Intent");

    return await flow.publishAsync();
}
```

## Testing with `test_bot_flow`

Bot flows must be **published** before testing. The example above uses `publishAsync()` which validates, saves, and publishes in one call.

**Start a test session** with the `flowId` from the `deploy_flow` result (its `status` must be `published`):
```
Tool: test_bot_flow
Input: { "flowId": "<flow-id>" }
```

The bot responds with its greeting and waits for input. Send a message to trigger intent detection:
```
Tool: test_bot_flow
Input: { "sessionId": "<session-id>", "message": "I want to check my balance" }
```

The response includes:
- **Text segments** — the bot's reply (greeting, confirmation, slot prompts)
- **RichMedia segments** — quick reply buttons (e.g. Yes/No for intent confirmation)
- **`nextActionType`** — `WaitForInput` (send another message), `Disconnect`/`Exit` (conversation ended)

Walk through each conversation path to verify intent detection, slot filling, and task routing work correctly. The Genesys Cloud UI does not expose this testing capability for Bot Flows.

Key differences from Digital Bot Flows:
- **`createFlowBotAsync`** — creates a bot flow with NLU support via Genesys Dialog Engine
- **`AskForIntent`** — lets the Dialog Engine match user input to configured intents (vs `DigitalMenu` with explicit choices)
- **`AskForSlot`** — prompts for and extracts slot values using NLU entity recognition
- **`botFlowSettings.getIntentSettingsByIntentName()`** — configures confirmation prompts and associates intents with reusable tasks
- **`settingsPrompts`** — bot flows have prompt settings (not available on digital bot flows)