---
name: write-flow
description: Write and deploy Genesys Cloud Architect flows as TypeScript using the Architect Scripting SDK. Guides Claude to produce correct flow code that typechecks and deploys.
trigger:
  - write a flow
  - create a flow
  - build a flow
  - architect flow
  - inbound call flow
  - inbound email flow
  - inbound message flow
  - IVR flow
  - email flow
  - test a bot flow
  - test bot flow
  - SMS flow
  - workflow flow
  - bot flow
  - digital bot flow
  - deploy a flow
---

# Write & Deploy Architect Flows

Create Genesys Cloud Architect flows as TypeScript, typecheck them, and deploy them via the `deploy_flow` MCP tool.

## Prerequisites

The user's project must have the Architect Scripting SDK installed for type checking:

```bash
npm install --save-dev purecloud-flow-scripting-api-sdk-javascript
```

## Deploy only (existing flow file)

If the user already has a flow file and just wants to deploy it, skip straight to **step 5** — call the `deploy_flow` MCP tool with the file path. Only fall back to steps 1–4 if deployment fails or the user asks for help writing/fixing the flow.

## Workflow

### 1. Understand the requirement

Ask the user:
- **Flow type**: inbound call, bot flow, digital bot flow, inbound email, inbound message (SMS), or workflow
- **What it should do**: routing, menus, greetings, queue transfers, data lookups, etc.
- **Flow name**: what to name the flow in Architect

Only ask about queue names if the user's description involves queue transfers. Not every flow routes to a queue.

### 2. Read the relevant references

Before writing any flow code, read these reference files from this skill:

1. **Always read**: `references/sdk-patterns.md` — core SDK patterns and the `buildFlow` contract
2. **Always read**: `references/gotchas.md` — SDK quirks that cause silent failures
3. **Always read**: `references/action-reference.md` — available action types
4. **Read when the flow uses expressions**: `references/expression-reference.md` — expression language syntax, functions, operators, data types, and common patterns. Read this whenever the flow involves conditional logic, dynamic text, variable manipulation, date/time calculations, or any `setExpression()` / expression property usage.
5. **Read the matching example** from `references/examples/`:
   - `bot-flow.md` — bot flow with NLU intent detection, slot filling, and testing
   - `digital-bot-flow.md` — digital bot with menu, free-text fallback, and exit
   - `inbound-call.md` — IVR with menus and queue transfers
   - `inbound-email.md` — auto-reply and queue transfer
   - `inbound-message.md` — SMS auto-reply and queue transfer
   - `workflow.md` — callback workflow

### 3. Write the flow file

Write a TypeScript file in the user's project that exports a `buildFlow` function:

```typescript
import type { ArchitectScripting } from "purecloud-flow-scripting-api-sdk-javascript";

export async function buildFlow(scripting: ArchitectScripting): Promise<void> {
    const { archFactoryFlows, archFactoryActions } = scripting.factories;

    const flow = await archFactoryFlows.createFlowInboundCallAsync(
        "Flow Name",
        "Flow Description",
    );

    // Build the flow...

    await flow.checkInAsync();
}
```

**Rules:**
- The function receives the SDK as a parameter — never `require()` the SDK in the flow file
- Only use `import type` from the SDK (stripped at runtime)
- Always call `flow.checkInAsync()` at the end to save the flow
- Use the exact patterns from the reference docs — the SDK is quirky

### 4. Typecheck

Run the TypeScript compiler against the flow file directly (the user's project may not have a `tsconfig.json`):

```bash
npx tsc --noEmit --strict --moduleResolution bundler --module ES2022 --target ES2022 --allowImportingTsExtensions --skipLibCheck path/to/flow.ts
```

`--skipLibCheck` is required because the SDK's own `types.d.ts` has internal errors (duplicate identifiers, missing type references). Without it, `tsc` fails on the SDK — not on your flow code.

Fix any errors before deploying.

### 5. Deploy

Use the `deploy_flow` MCP tool:

```
Tool: deploy_flow
Input: { "flowFile": "./path/to/flow.ts" }
```

The tool spawns an isolated process that:
1. Starts an authenticated SDK session using the plugin's Genesys credentials
2. Imports the flow file and calls `buildFlow(scripting)`
3. Returns success/failure with SDK logs

If deployment fails, read the error logs carefully — the SDK has three error channels (logging callback, TRACE lines, HTTP errors) and the deploy runner captures all of them.

**Bot flows — publish before testing:** The `deploy_flow` tool checks in the flow but does not publish it. To test a bot flow or digital bot flow with the `test_bot_flow` tool (step 6), the flow must be published first. Replace `flow.checkInAsync()` with `flow.publishAsync()` in the `buildFlow` function — do not call both, because `checkInAsync` releases the lock and `publishAsync` will fail with a 409:

```typescript
return await flow.publishAsync();
```

### 6. Test (bot flows and digital bot flows)

After deploying and publishing a bot flow or digital bot flow, test it using the `test_bot_flow` MCP tool. The deploy result includes the flow ID.

**Start a session:**
```
Tool: test_bot_flow
Input: { "flowId": "<flow-id-from-deploy>" }
```

The tool returns the bot's opening messages and a `sessionId`. Each turn includes `nextActionType`:
- `WaitForInput` — the bot is waiting for a user message
- `Disconnect` / `Exit` — the conversation has ended

**Send a message:**
```
Tool: test_bot_flow
Input: { "sessionId": "<session-id>", "message": "Billing" }
```

Walk through the flow's conversation paths to verify the bot responds correctly. If the bot behaves unexpectedly, update the flow file, re-deploy, re-publish, and test again.
