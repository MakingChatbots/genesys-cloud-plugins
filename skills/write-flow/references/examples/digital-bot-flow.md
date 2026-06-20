# Example: Digital Bot Flow

Digital bot flow with a greeting, a menu for topic selection, free-text fallback, and a graceful exit. After deploying and publishing, use the `test_bot_flow` MCP tool to simulate a text conversation and verify the bot behaves as expected.

```typescript
import type { ArchitectScripting } from "purecloud-flow-scripting-api-sdk-javascript";

export async function buildFlow(scripting: ArchitectScripting) {
    const { archFactoryFlows, archFactoryActions } = scripting.factories;

    const flow = await archFactoryFlows.createFlowDigitalBotAsync(
        "Example Digital Bot Flow",
        "Bot flow with menu, free-text handling, and exit",
    );

    // "Initial Greeting" (ArchStateBot) is auto-created as the startup object
    const initialState = flow.startUpObject;

    // Greet the user — use plain string expressions, NOT ToAudioTTS()
    const greeting = archFactoryActions.addActionCommunicate(
        initialState,
        "Greeting",
    );
    greeting.communication.setExpression(
        '"Hello! I can help you with billing or technical support."',
    );

    // DigitalMenu for topic selection and free-text fallback
    const menu = archFactoryActions.addActionDigitalMenu(
        initialState,
        "Topic Menu",
    );
    menu.question.setExpression('"Please choose a topic or type your question:"');

    // Named choices
    menu.addChoice("Billing");
    const billingOutput = menu.getOutputByName("Billing", true);
    const billingReply = archFactoryActions.addActionCommunicate(
        billingOutput,
        "Billing Info",
    );
    billingReply.communication.setExpression(
        '"For billing enquiries, please visit your account page or contact our billing team."',
    );
    archFactoryActions.addActionExitBotFlow(billingOutput, "Exit After Billing");

    menu.addChoice("Technical Support");
    const supportOutput = menu.getOutputByName("Technical Support", true);
    const supportReply = archFactoryActions.addActionCommunicate(
        supportOutput,
        "Support Info",
    );
    supportReply.communication.setExpression(
        '"Let me transfer you to our technical support team."',
    );
    archFactoryActions.addActionExitBotFlow(supportOutput, "Exit After Support");

    // Free-text fallback via MaxNoMatches
    menu.customizeNoMatch.setLiteralTrue();
    menu.outputMaxNoMatches.enabled = true;
    const noMatchPath = menu.outputMaxNoMatches;
    const fallback = archFactoryActions.addActionCommunicate(
        noMatchPath,
        "Fallback",
    );
    fallback.communication.setExpression(
        '"I didn\'t understand that. Let me connect you with someone who can help."',
    );
    archFactoryActions.addActionExitBotFlow(noMatchPath, "Exit After Fallback");

    return await flow.publishAsync();
}
```

## Adding NLU Intent Recognition

Digital bot flows support NLU via `nluCreationData` passed to `createFlowDigitalBotAsync`. This trains the Genesys Dialog Engine to match free-text user input to intents, so users don't have to click menu buttons — they can type naturally and the bot routes them to the right task.

**Note:** `AskForIntent` is NOT available in digital bot flows. NLU works through the DigitalMenu + `botFlowSettings` intent-task association pattern shown below.

```typescript
import type { ArchitectScripting } from "purecloud-flow-scripting-api-sdk-javascript";

const nluCreationData = {
    nluDomainVersion: {
        language: "en-us",
        intents: [
            {
                name: "ReturnBook",
                utterances: [
                    { segments: [{ text: "I want to return a book" }] },
                    { segments: [{ text: "I have a book I want to give back" }] },
                    { segments: [{ text: "I need a refund for a book" }] },
                    { segments: [{ text: "How do I return a purchase" }] },
                ],
            },
            {
                name: "BuyBook",
                utterances: [
                    { segments: [{ text: "I want to buy a book" }] },
                    { segments: [{ text: "I'd like to purchase a book" }] },
                    { segments: [{ text: "I'm looking for a book to buy" }] },
                ],
            },
        ],
    },
};

export async function buildFlow(scripting: ArchitectScripting) {
    const { archFactoryFlows, archFactoryActions, archFactoryTasks } =
        scripting.factories;

    const flow = await archFactoryFlows.createFlowDigitalBotAsync(
        "Example NLU Digital Bot",
        "Digital bot with NLU intent recognition",
        undefined,
        undefined,
        undefined,
        nluCreationData,
    );

    // Create reusable tasks as empty shells first
    const returnTask = archFactoryTasks.addTask(flow, "Handle Return");
    const purchaseTask = archFactoryTasks.addTask(flow, "Handle Purchase");

    // Associate intents with tasks via botFlowSettings
    const returnIntent =
        flow.botFlowSettings.getIntentSettingsByIntentName("ReturnBook");
    if (returnIntent) {
        returnIntent.confirmation.setExpression(
            '"I think you want to return a book, is that correct?"',
        );
        returnIntent.associateWithTask(returnTask);
    }

    const buyIntent =
        flow.botFlowSettings.getIntentSettingsByIntentName("BuyBook");
    if (buyIntent) {
        buyIntent.confirmation.setExpression(
            '"You want to buy a book, is that correct?"',
        );
        buyIntent.associateWithTask(purchaseTask);
    }

    // --- Initial Greeting ---
    const initialState = flow.startUpObject;

    const greeting = archFactoryActions.addActionCommunicate(
        initialState,
        "Welcome",
    );
    greeting.communication.setExpression(
        '"Welcome! How can I help you today?"',
    );

    const mainMenu = archFactoryActions.addActionDigitalMenu(
        initialState,
        "Main Menu",
    );
    mainMenu.question.setExpression('"Return a book or buy a book?"');

    mainMenu.addChoice("Return a book");
    const returnOutput = mainMenu.getOutputByName("Return a book", true);
    archFactoryActions.addActionJumpToTask(returnOutput, "Go to Returns", returnTask);

    mainMenu.addChoice("Buy a book");
    const purchaseOutput = mainMenu.getOutputByName("Buy a book", true);
    archFactoryActions.addActionJumpToTask(purchaseOutput, "Go to Purchase", purchaseTask);

    mainMenu.customizeNoMatch.setLiteralTrue();
    mainMenu.outputMaxNoMatches.enabled = true;
    const noMatchPath = mainMenu.outputMaxNoMatches;
    archFactoryActions.addActionCommunicate(noMatchPath, "Not Understood")
        .communication.setExpression('"Sorry, I didn\'t understand that."');
    archFactoryActions.addActionExitBotFlow(noMatchPath, "Exit");

    // --- Populate tasks with actions ---
    archFactoryActions.addActionCommunicate(returnTask, "Return Greeting")
        .communication.setExpression('"I can help with your return."');
    archFactoryActions.addActionExitBotFlow(returnTask, "Exit Returns");

    archFactoryActions.addActionCommunicate(purchaseTask, "Purchase Greeting")
        .communication.setExpression('"I\'d love to help you find a book!"');
    archFactoryActions.addActionExitBotFlow(purchaseTask, "Exit Purchase");

    return await flow.publishAsync();
}
```

## Regex Slot with AskForSlot and Decision

When you need to capture and validate structured input (like a number in a range), use a regex entity type with `AskForSlot` and `Decision` instead of building a DigitalMenu with many choices. This pattern handles validation, reprompting, and graceful exit on repeated failures.

```typescript
import type { ArchitectScripting } from "purecloud-flow-scripting-api-sdk-javascript";

const nluCreationData = {
    nluDomainVersion: {
        language: "en-us",
        intents: [
            {
                name: "ProvideNumber",
                utterances: [
                    {
                        segments: [
                            { text: "5", entity: { name: "NumberValue" } },
                        ],
                    },
                    {
                        segments: [
                            { text: "My number is " },
                            { text: "12", entity: { name: "NumberValue" } },
                        ],
                    },
                    {
                        segments: [
                            { text: "I pick " },
                            { text: "7", entity: { name: "NumberValue" } },
                        ],
                    },
                ],
                entityTypeBindings: [
                    { entityName: "NumberValue", entityType: "NumberPattern" },
                ],
            },
        ],
        entityTypes: [
            {
                name: "NumberPattern",
                mechanism: {
                    type: "Regex",
                    restricted: true,
                    items: [{ value: "^([1-9]|1[0-9]|20)$" }],
                },
            },
        ],
    },
};

export async function buildFlow(scripting: ArchitectScripting) {
    const { archFactoryFlows, archFactoryActions, archFactoryTasks } =
        scripting.factories;

    const flow = await archFactoryFlows.createFlowDigitalBotAsync(
        "Example Number Range Bot",
        "Asks for a number 1-20 using a regex slot and conditional expressions",
        undefined,
        undefined,
        undefined,
        nluCreationData,
    );

    // UX settings: remove default "Sorry." prefix and limit retries
    const userInput = flow.userInputSettings;
    userInput.noMatchApology.setExpression('""');
    userInput.noMatchesMax.setLiteralInt(3);

    const processNumberTask = archFactoryTasks.addTask(flow, "Process Number");

    const provideNumberIntent =
        flow.botFlowSettings.getIntentSettingsByIntentName("ProvideNumber");
    if (provideNumberIntent) {
        provideNumberIntent.associateWithTask(processNumberTask);
    }

    const initialState = flow.startUpObject;

    const greeting = archFactoryActions.addActionCommunicate(
        initialState,
        "Welcome",
    );
    greeting.communication.setExpression(
        '"Welcome! I need you to pick a number between 1 and 20."',
    );

    const askSlot = archFactoryActions.addActionAskForSlot(
        initialState,
        "Ask Number",
    );
    askSlot.setSlot("NumberValue", true);
    askSlot.question.setExpression(
        '"Go ahead, type a whole number from 1 to 20."',
    );
    askSlot.noMatch.setExpression(
        '"That doesn\'t look like a number between 1 and 20. Please type just the number, for example 5 or 15."',
    );

    // Graceful exit after max no-match retries
    askSlot.outputMaxNoMatches.enabled = true;
    const maxNoMatchPath = askSlot.outputMaxNoMatches;
    const giveUp = archFactoryActions.addActionCommunicate(
        maxNoMatchPath,
        "Give Up",
    );
    giveUp.communication.setExpression(
        '"I\'m having trouble understanding your response. Let me connect you with someone who can help."',
    );
    archFactoryActions.addActionExitBotFlow(maxNoMatchPath, "Exit Max");

    archFactoryActions.addActionJumpToTask(
        initialState,
        "Go Process",
        processNumberTask,
    );

    // Decision branches on the captured slot value
    const decision = archFactoryActions.addActionDecision(
        processNumberTask,
        "Check Range",
    );
    decision.condition.setExpression(
        "ToInt(Slot.NumberValue) >= 1 and ToInt(Slot.NumberValue) <= 10",
    );

    const yesPath = decision.outputYes;
    const bottomReply = archFactoryActions.addActionCommunicate(
        yesPath,
        "Bottom Result",
    );
    bottomReply.communication.setExpression(
        'Append("You picked ", Slot.NumberValue, ". That\'s in the bottom range (1-10).")',
    );
    archFactoryActions.addActionExitBotFlow(yesPath, "Exit");

    const noPath = decision.outputNo;
    const higherReply = archFactoryActions.addActionCommunicate(
        noPath,
        "Higher Result",
    );
    higherReply.communication.setExpression(
        'Append("You picked ", Slot.NumberValue, ". That\'s in the higher range (11-20).")',
    );
    archFactoryActions.addActionExitBotFlow(noPath, "Exit");

    return await flow.publishAsync();
}
```

### Key patterns in this example

1. **Regex entity type** — `mechanism: { type: "Regex", restricted: true, items: [{ value: "^([1-9]|1[0-9]|20)$" }] }` validates input at extraction time. Use `^...$` anchors to prevent partial matching (e.g. `-5` matching `5` with `\b` word boundaries)
2. **Slot ≠ entity type name** — `entityName: "NumberValue"` and `entityType: "NumberPattern"` must differ or Architect flags "duplicate names"
3. **`flow.userInputSettings`** — flow-level UX controls: `noMatchApology` (the "Sorry." prefix), `noMatchesMax` (retry limit before `outputMaxNoMatches` fires)
4. **`askSlot.noMatch.setExpression()`** — custom per-action no-match message replacing the unhelpful default
5. **`askSlot.outputMaxNoMatches`** — must explicitly enable (`.enabled = true`) and populate with actions for the graceful exit path
6. **`Append()`** — Architect expression function for string concatenation, used to echo the slot value back to the user
7. **`Decision` with `condition.setExpression()`** — conditional branching on slot values using `ToInt()` for numeric comparison

### How NLU works in Digital Bot Flows

1. **`nluCreationData`** trains the Genesys Dialog Engine with intents and sample utterances at flow creation time
2. **`botFlowSettings.getIntentSettingsByIntentName()`** retrieves intent settings for the flow
3. **`associateWithTask()`** wires an intent to a reusable task — when the Dialog Engine matches user input to an intent, it routes directly to that task
4. **`confirmation.setExpression()`** sets a confirmation prompt shown before routing (e.g. "You want to buy a book, is that correct?" with Yes/No buttons)
5. The Dialog Engine generalizes from training utterances — users can type phrases not in the training data and still match intents
6. The DigitalMenu's button choices still work as direct routes, so users can either click a button OR type naturally
