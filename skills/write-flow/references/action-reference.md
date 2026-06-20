# Action Reference

All actions are created via `scripting.factories.archFactoryActions` (aliased as `actionFactory` below). Actions are added to a sequence (e.g., `state.outputSequence`).

## Voice Actions

### PlayAudio (TTS)
```typescript
const play = actionFactory.addActionPlayAudio(sequence);
play.setTextToSpeak("Welcome to our service!");
```

### TransferToAcd (Queue Transfer)
```typescript
const transfer = actionFactory.addActionTransferToAcd(sequence);
await transfer.setQueueByName("Sales Queue"); // async — looks up the queue
```

### TransferToNumber
```typescript
const transfer = actionFactory.addActionTransferToNumber(sequence);
transfer.numberExpression = '"+15551234567"';
```

### TransferToUser
```typescript
const transfer = actionFactory.addActionTransferToUser(sequence);
// Configure target user
```

### GetInput (Collect DTMF)
```typescript
const input = actionFactory.addActionGetInput(sequence);
input.maxDigits = 1;
input.digitTerminator = "#";
input.noEntryTimeout = 5000;
```

### JumpToMenu
```typescript
const jump = actionFactory.addActionJumpToMenu(sequence);
jump.targetMenu = menuObject;
```

## Chat / Message Actions

### SendResponse
```typescript
const response = actionFactory.addActionSendResponse(stateOrTask);
response.messageBody.setExpression('"Hello! How can I help?"');
```
Note: pass the state or task object directly — not its `outputSequence`. The expression value must be a quoted string inside the expression (double quotes inside single quotes).

### SendAutoReply (Email)
```typescript
const reply = actionFactory.addActionSendAutoReply(sequence);
reply.setFromAddressByLiteralString("noreply@example.com");
reply.setSubjectByLiteralString("We received your email");
reply.setBodyByLiteralString("Thank you for your email.");
```

## Digital Bot Actions

### Communicate
```typescript
const comm = actionFactory.addActionCommunicate(container, "Greeting");
comm.communication.setExpression('"Hello! How can I help?"');
```
Note: use quoted strings inside the expression, NOT `ToAudioTTS()`.

### DigitalMenu
```typescript
const menu = actionFactory.addActionDigitalMenu(container, "Main Menu");
menu.question.setExpression('"Choose an option:"');
const choice1 = menu.addChoice("Option A");
const choice2 = menu.addChoice("Option B");
// Access choice output: menu.getOutputByName("Option A", true)
```

### ExitBotFlow
```typescript
actionFactory.addActionExitBotFlow(container, "Exit");
```

## Flow Control Actions

### Decision (Branch)
```typescript
const decision = actionFactory.addActionDecision(sequence);
// Configure conditions on decision.outputs
```

### SetVariable
```typescript
const setVar = actionFactory.addActionSetVariable(sequence);
setVar.variableName = "Flow.myVariable";
setVar.variableValue = '"Hello"'; // string values need expression quotes
```

### ChangeState
```typescript
const change = actionFactory.addActionChangeState(sequence);
change.targetState = stateObject;
```

### JumpToTask
```typescript
const jump = actionFactory.addActionJumpToTask(container, "Jump Name", taskObject);
```

### Loop
```typescript
const loop = actionFactory.addActionLoop(sequence);
loop.loopCount = 3;
// Add actions inside loop.loopSequence
```

### Disconnect
```typescript
actionFactory.addActionDisconnect(sequence);
```

### EndWorkflow
```typescript
actionFactory.addActionEndWorkflow(sequence);
```

## Workflow-Specific Actions

### CreateCallback
```typescript
const callback = actionFactory.addActionCreateCallback(sequence);
await callback.setQueueByName("Callback Queue");
callback.callbackNumberExpression = "Flow.callbackNumber";
```

### CallData (Data Action)
```typescript
const dataAction = actionFactory.addActionCallData(sequence);
dataAction.integrationName = "My Integration";
// Configure action and data mapping
```

## Action Naming Convention

Actions follow the pattern: `addAction[ActionType](sequence)`.

The first argument is always the sequence/container to add the action to. Some actions (like `addActionCommunicate`, `addActionDigitalMenu`, `addActionJumpToTask`) take an additional name parameter.
