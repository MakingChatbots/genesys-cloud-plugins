# Example: Bot Flow

Bot flow with NLU intent detection, slot filling, and confirmation. Bot flows use `AskForIntent` and `AskForSlot` for natural language conversations — the Genesys Dialog Engine handles intent matching and entity extraction at runtime. After deploying and publishing, use the `test_bot_flow` MCP tool to simulate a text conversation and verify the NLU behaves as expected.

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

    // AskForIntent — the Dialog Engine matches user input to configured intents
    const askIntent = archFactoryActions.addActionAskForIntent(
        initialState,
        "Detect Intent",
    );

    // Create tasks for each intent — then associate them in botFlowSettings
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

    // Associate intents with tasks via botFlowSettings
    const balanceIntent =
        flow.botFlowSettings.getIntentSettingsByIntentName("CheckBalance");
    if (balanceIntent) {
        balanceIntent.confirmation.setExpression(
            '"I think you want to check your balance, is that correct?"',
        );
        balanceIntent.associateWithTask(balanceTask);
    }

    const paymentIntent =
        flow.botFlowSettings.getIntentSettingsByIntentName("MakePayment");
    if (paymentIntent) {
        paymentIntent.confirmation.setExpression(
            '"You want to make a payment, is that correct?"',
        );
        paymentIntent.associateWithTask(paymentTask);
    }

    // Handle no intent detected
    const noIntentPath = askIntent.outputNoIntent;
    const fallback = archFactoryActions.addActionCommunicate(
        noIntentPath,
        "No Intent",
    );
    fallback.communication.setExpression(
        '"I\'m sorry, I didn\'t understand that. Could you try rephrasing?"',
    );

    return await flow.publishAsync();
}
```

## Testing with `test_bot_flow`

Bot flows must be **published** before testing. The example above uses `publishAsync()` which validates, saves, and publishes in one call.

**Start a test session** with the flow ID returned by `deploy_flow`:
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