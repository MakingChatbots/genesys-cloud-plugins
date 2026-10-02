---
name: interpret-flow-ir
description: This skill should be used when interpreting the JSON returned by the flow_ir, flow_action, search_in_flow, find_flow_execution or flow_execution_data tools, or when the user asks questions about a deployed Genesys Cloud Architect flow, including one they name only by its flow name (resolve it with find_flow first). Structural questions such as "analyse this flow", "trace the path through the flow", "what happens when the customer says X", "why is this task unreachable", "check the flow for missing error handling", "find dead logic", or "does this flow loop". Semantic questions such as "what does this decision check", "what prompt does it play", "what does this data action send", or "what does pressing 2 do". Search questions such as "find every action that references this queue", "which actions use Flow.DNIS", "where does this flow mention that data action", or "which actions play a prompt containing X". Execution questions such as "what did this conversation do in the flow", "why did the customer loop", "which path did the call take", "did the flow error for conversation X", "is this flow working in production", or "show me how my test run went through the flow". Use it to answer control-flow questions from the IR instead of guessing from the flow's raw configuration JSON, to find the actions worth looking at without fetching them all, to fetch the per-action settings the IR omits, and to read one run's execution data against the IR.
---

# Interpreting Flow IRs

The `flow_ir` tool returns a deployed flow's **intermediate representation (IR)**:
the flow parsed into an explicit control-flow graph, flattened to a node list.
Branches, loops, IVR menu choices, and cross-task jumps are already resolved
into edges. Answer structural questions from this IR, never by re-deriving
control flow from the flow's raw configuration JSON.

The static tools are a trio. `search_in_flow` owns **discovery** — which actions
mention a given name, expression, or phrase (see "Content search"). `flow_ir` owns
**structure** — what connects to what. `flow_action` owns **semantics** — what an
individual action is configured to do (see "Action semantics"). The usual order
runs the same way: search to find the ids worth caring about, trace to see how
they connect, then inspect only those. A fourth concern, **what actually happened
on one run**, belongs to `find_flow_execution` and `flow_execution_data` (see
"Execution data"); they join back to the same ids.

The static tools take a flow id, not a flow name. When only the name is known (e.g.
"analyse Book_Payment"), resolve it first with `find_flow`, which searches flow
names and returns each match's id, name, type, and published version.

Likewise, when the user names a *queue* (e.g. "which actions transfer to Sales"),
resolve it first with `find_queue`, which searches queue names and returns each
match's id, exact name, division and in-queue flows. Give `search_in_flow` the
exact name it returns, since a fragment the user typed may not be how the queue is
spelled in the flow.

## Tool output shape

On success the tool returns compact JSON: `{ flowId, ir, warnings }`. Failures
(flow not found, unparseable configuration, unknown or ambiguous `task` value)
arrive as plain-text tool errors, so any JSON response is a successful parse.
`warnings` is always present; read it before making claims, because each
warning scopes what can be asserted (see "Warnings").

`ir` fields:

| Field                    | Meaning                                                                                                                                                                                                                   |
|--------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `flowName`, `flowType`   | Flow identity (e.g. `inboundcall`, `digitalbot`)                                                                                                                                                                          |
| `entryTaskId`            | The flow's entry task, when known. **Absent** when the flow declares no entry or the declared entry is unresolvable (`UNRESOLVED_INITIAL_SEQUENCE`). Do not fall back to `tasks[0]`, which is then just declaration order |
| `reachabilityIsComplete` | `false` when the flow contains intent listen actions whose routing is unmodelled (`UNRESOLVED_INTENT_FANOUT`). When false, treat every `reachable: false` as "not provably reachable", never "dead"                       |
| `tasks`                  | Task list `{ id, name, reusable }`. `reusable: true` marks tasks flagged reusable in Architect                                                                                                                            |
| `nodes`                  | Flat node list, sorted ascending by `order`                                                                                                                                                                               |

Each node:

| Field                | Meaning                                                                                                                                                               |
|----------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `id`                 | Join key. Actions use their Architect GUID; synthetic ids are `<taskId>::start` (task-start) and `<actionId>::<outputId>` (branch-output, e.g. `<guid>::__FAILURE__`) |
| `kind`               | `task-start`, `action`, or `branch-output` (see below)                                                                                                                |
| `actionType`         | Architect `__type` (e.g. `DecisionAction`), actions only                                                                                                              |
| `label`              | Human-readable name (action name, task name, or branch label like `Failure`)                                                                                          |
| `description`        | Optional summary of what the action does                                                                                                                              |
| `predecessors`       | **Incoming** edges `{ id, label?, backEdge }`; `id` is the source node. See "Navigating"                                                                              |
| `successors`         | **Outgoing** edges `{ id, label?, backEdge }`; `id` is the target node. Mirror of `predecessors`; see "Navigating"                                                    |
| `order`              | DFS discovery order, not execution order; sibling branches appear sequentially                                                                                        |
| `taskId`, `taskName` | Owning task                                                                                                                                                           |
| `reachable`          | Reached by DFS from **any** task-start; see the orphaned-tasks recipe                                                                                                 |
| `terminal`           | Control leaves the flow here (disconnect, end, transfer success)                                                                                                      |

### Node kinds

- **`task-start`**: one per task; a structural marker, not a real action. Its
  predecessors are the jumps *into* the task (`CallTaskAction`, `TaskAction`,
  `TransferTaskAction`, menu references).
- **`action`**: a real Architect action. Only these count when listing "the
  actions in a task".
- **`branch-output`**: one per outcome of a branching action (a Decision's
  Yes/No, a data action's Success/Failure, a loop's body). Not an action; it is
  a labelled fork. A branch-output with `successors: []` is a dangling outcome
  (see recipes).

## Navigating the graph

Every node carries its edges **both ways**. Pick the direction that matches the
question instead of deriving one from the other:

- **`successors`** (outgoing) for forward walks — "the caller presses 1, then
  what?", "what happens after this action".
- **`predecessors`** (incoming) for backwards walks — "what leads here", "what
  condition guards this action", "does anything call this task".

There is never a reason to build a successor map by inverting `predecessors`;
the IR already ships both lists, mirrored and deduped.

**Forward trace.** Start at `<entryTaskId>::start` and follow `successors`,
passing through branch-output nodes and using their `label` as the branch
condition ("on Failure, ..."). If `entryTaskId` is absent, say the entry is
unknown rather than guessing a starting task. Stop a trace at `terminal: true`
nodes.

Edge `label` carries the branch or jump meaning in **both** lists: branch
outcome labels (`Success`, `Failure`, `Yes`/`No`), IVR menu choice names, and
the target task name on jump edges. `backEdge: true`, in either list, marks a
real cycle.

An unlabelled **successor** leaving a branching action directly (rather than
leaving one of its branch-outputs) is that action's fall-through: the path taken
after the action completes, e.g. a loop's continue-after-exit edge.

Never narrate `nodes` in array order as if it were the call sequence. `order`
is depth-first discovery: after a branch, one entire arm appears before the
other arm begins.

## Large flows: the `task` parameter

A large flow can be tens of thousands of tokens. Call `flow_ir` with the
optional `task` parameter to fetch one task at a time:

- `task` matches a task id first, then a task name case-insensitively. A name
  shared by several tasks is refused with the candidate ids; retry with an id.
- `ir.tasks` always lists every task even when filtered, so the full inventory
  survives; walk tasks one call each.
- A filtered node's `predecessors` and `successors` may both name ids from other
  tasks; those ids are absent from the filtered `nodes` array. That is a
  cross-task jump, not a dangling reference.

## Action semantics: the `flow_action` tool

The IR deliberately omits action settings — a Decision's expression, a
Communicate's prompt text, a data action's inputs. `flow_action` returns those
raw settings for actions you name.

**The join.** Every IR node with `kind: "action"` has an `id` that *is* the
Architect GUID, which is exactly what `flow_action`'s `actionIds` accepts. So the
workflow is: trace structurally with `flow_ir` first, collect every action whose
configuration matters, then batch them into **as few calls as possible**. Do not
call once per action; each call refetches the whole flow configuration. A single
call accepts at most **50 ids**; a larger join must be chunked into successive
calls of up to 50. Exceeding the cap is rejected before any lookup happens, so
size the batches up front rather than discovering the limit mid-analysis.

**The envelope.**
`{ flowId, found: [{ actionId, action, taskId, taskName, menuChoice? }], notFound, notes? }`

- `actionId` echoes the id you asked for and is the grouping key. An action id
  occurring more than once in a flow yields **several `found` entries**, one per
  occurrence, told apart by `taskId`. Group by `actionId`; do not assume one
  entry per id.
- `action` is the raw Genesys JSON subtree, passed through untouched. It is **not
  a stable schema**: field names and nesting vary by `__type` and change when
  Architect changes. Read it defensively and report what is actually there rather
  than asserting a fixed shape.
- `notes`, when present, is advisory prose about the lookup itself. Read it, but
  key no logic off its exact wording.

**Scoping rule — the one thing not to do.** Never derive control flow from the
raw wiring fields (`nextAction`, `paths[].nextActionId`, `path`). The IR has
already resolved those, and its resolution accounts for what the raw JSON does
not reflect: disabled branches, edges dropped for unknown endpoints, and
menu/task-jump indirection. Where raw JSON and the IR seem to disagree about
where something leads, the IR is the answer.

The nuance: a `paths[]` entry's pairing of a **condition with a named outcome**
is legitimate semantics, and often the very reason to make the lookup — which
case expression belongs to which Switch outcome, which expression a Decision's
Yes/No tests. Take the condition and the outcome name from the raw action; take
where that outcome *leads* from the IR's branch-output node, never from
`nextActionId`.

**Branch-output ids.** `<actionId>::<outputId>` is accepted: the suffix is
stripped, the underlying action is returned, and `notes` flags that it happened.
Ids in one call that strip to the same GUID collapse to a single lookup,
reported only under whichever form was requested first — the other requested id
appears in neither `found` nor `notFound`, so never send both forms of one
action and never treat the absent form as a missing action. Prefer passing
plain action GUIDs. `<taskId>::start` is a task marker rather than an action,
so it can never match.

**`menuChoice`.** Present only when the action sits inside an IVR menu choice.
Its `digit` and `name` are the choice's *presentation* — the keypress and the
spoken or displayed label that select that action. This is what answers "what
does pressing 2 do".

**`notFound` and staleness.** An id in `notFound` is absent from the flow's
*latest* configuration. Because `flow_ir` and `flow_action` are separate fetches,
the flow may have been redeployed between them. Re-run `flow_ir` and re-join
before concluding that an action was deleted.

**What it does and does not unlock.** `flow_action` does retrieve raw config for
actions the IR treats as blind spots: a `DigitalMenuAction`'s unexpanded choices
live in its subtree, and a listen action's own settings come back in full. It
does **not** close the intent-routing gap — per-intent routing lives in the
flow's top-level `nluMetaData`, not under any action, so no action lookup can
reveal it. Intent fan-out stays unresolved, and reachability claims still need
the qualification described in "Known blind spots".

## Common raw shapes

These are shapes *observed* in returned `action` subtrees, not a contract. The
raw JSON is not a stable schema (see "The envelope"), so treat the paths below
as where to look first and verify each against what actually comes back rather
than assuming it is present. The scoping rule still holds throughout: take the
condition and the outcome name from the raw action, take where that outcome
leads from the IR's branch-output node, never from `paths[].nextActionId`.

**`DecisionAction`.** The tested expression lives at `action.expression.text`,
an Architect boolean expression string. Pair it with the action's Yes and No
branch-output nodes in the IR for the two destinations; the expression says what
is tested, the IR says where each answer goes.

**`SwitchAction`.** Case expressions live at `cases[].value.text`. Each case
joins to its outcome by id: `cases[].referenceId` equals `paths[].outputId`. The
matching `paths[]` entry supplies the outcome *name*, and the IR branch-output
node `<actionId>::<outputId>` supplies where that outcome leads. Use
`paths[].nextActionId` for nothing.

## Content search: the `search_in_flow` tool

`search_in_flow` answers "which actions reference X" in **one call**. It matches
text across every action's raw configuration in a flow and returns only the
actions containing it, each with the path and a short excerpt of what matched.

**When to reach for it.** Before any bulk `flow_action` sweep. "Which actions use
the BookSeller module", "what references `Flow.DNIS`", "which queues does this flow
transfer to", "where is that prompt wording" are each one search, not dozens of
action fetches — and a sweep pulls back whole subtrees for actions that turn out
to be irrelevant. Search to find the ids, trace them in `flow_ir`, then fetch
only the ones that matter with `flow_action`.

**Parameters.** `pattern` is a literal substring unless `regex: true`, in which
case it is a JavaScript regular expression. `caseSensitive` defaults to false in
both modes. Prefer a distinctive
literal (a queue name, a variable reference, a phrase of prompt wording) over a
regex when either would answer the question.

**The envelope.**
`{ flowId, pattern, totalMatchedActions, matchedActions: [{ actionId, actionType?, name?, taskId, taskName, menuChoice?, matchedPaths: [{ path, excerpt }], truncated? }], notes? }`

A search matching nothing is a **success**, not an error: `totalMatchedActions:
0` and an empty `matchedActions`. That is a real answer — the flow does not
contain the text — so report it rather than retrying variations of the pattern.

**The join.** `actionId` is the Architect GUID, so it is simultaneously the id of
the `flow_ir` node whose `kind` is `"action"` and an id `flow_action` accepts
verbatim. `taskId` joins to the IR's `<taskId>::start` node, which is how a
scatter of hits becomes "these three tasks are involved". An action occurring
more than once in a flow yields one entry per occurrence — and occurrences can
share both `actionId` *and* `taskId`, since a duplicate may sit inside a single
task (one in its action list, one under a menu choice). `menuChoice` and each
entry's `matchedPaths` are what tell such occurrences apart; group by
`actionId`, exactly as with `flow_action`.

**Excerpts may be clipped.** A short matched value — up to 160 characters, the
common case for queue names, variable references, and short expressions — comes
back **whole**, with no markers: it is safe to quote as that leaf's value
without re-fetching. A longer value is a window around the match, with `…`
marking whichever ends were cut, and the response carries a note whenever any
excerpt was clipped. So the `…` markers are the tell: an unmarked excerpt is the
complete leaf; a marked one is enough to judge relevance but never enough to
quote. Either way an excerpt is one leaf, not the action — when the surrounding
configuration matters, fetch the action with `flow_action` and read `action`
there.

**Truncation is reported in two places.** `totalMatchedActions` is the count
before any capping, so it stays accurate even when `matchedActions` is shorter;
compare the two before asserting "exactly N actions". A per-entry
`truncated: true` means that action matched in more places than `matchedPaths`
lists, so a path's absence from that entry proves nothing. `notes`, when present,
is advisory prose about the search itself — read it, but key no logic off its
wording.

**What a match does and does not mean.** Matching is against **string values
only**, never key names, so every hit is real content. But:

- A hit in a wiring field (`nextAction`, `paths[].nextActionId`) locates the text
  of an id; it is **not** a control-flow claim. The scoping rule from
  `flow_action` applies unchanged — the IR owns wiring.
- Content search is not reachability. A match inside a disabled branch, an
  unreachable action, or a task nothing ever calls is still reported. Before
  concluding "this flow transfers to queue X", check the matched actions against
  the IR's `reachable` flag and any `DISABLED_BRANCH` warning.
- `path` (e.g. `outputs.0.value.text`) is a legible pointer, not a parseable
  grammar: keys containing dots are not escaped. Use it to say where a match
  sits, never to reconstruct ids from.
- A match is text, not structure. `search_in_flow` finding a queue name in six
  actions says those six mention it, not that six transfers exist.

## Execution data: `find_flow_execution` and `flow_execution_data`

The IR says what *could* happen. **Execution data** is what *did* happen on one
run: Genesys Cloud's historical record of a single flow instance, an ordered
event log of every action executed with timestamps, the messages sent, variable
snapshots and the exit reason. Reach for it when the question is about a real
conversation or a test run rather than about the flow's design: "what did this
customer's call do", "why did the bot loop", "which branch ran", "did it error",
"is the flow working", "show me how my test went through the flow".

**Two tools.** `find_flow_execution` lists instances by `conversationId` and/or
`flowId` (optionally `onlyWithErrors`), returning each instance's `executionId`,
flow name/type/version, times and any `flowErrorReason`/`flowWarningReason`,
oldest first. A conversation that passed through several flows yields one entry
per flow. `flow_execution_data` takes one `executionId` and returns the log.
Prefer `conversationId` when searching: the API indexes on it, cannot filter by
date, caps results at 200, and only keeps 10 days. A run is listed only once it
has **ended**; one still waiting for input is not yet there. `onlyWithErrors` is
applied to the fetched instances, since the API's query operators have no
negation or null test.

**`test_bot_flow` runs are instances too.** The `sessionId` it returns *is* the
`executionId`; pass it straight to `flow_execution_data` to see exactly how a
test traversed the flow, and expect the data within seconds of the run ending.
Such runs have a null conversation id, so find them by `flowId` rather than
`conversationId`; `Flow.IsTest` is false on them.

### The envelope

`{ executionId, flowId, flowName, flowType, flowVersion, conversationId,
startDateTime, endDateTime, durationMs, flowExitReason, logLevel, executionInfo,
isTruncated, isSecure, flowIsDebug, division, summary, events, ir?, notes? }`

- `summary.eventKinds` counts events per kind; `summary.repeatedActions` lists
  actions executed more than once with the `index` of each occurrence. **A
  non-empty `repeatedActions` is the signature of a loop**; read those indexes
  in `events` to see what changed (or did not) between iterations.
  `summary.loops` lists each Loop action with its `iterations`, counted from
  the `eventLoop` events it emitted (one per completed iteration; the body's
  actions also appear in `repeatedActions`). `summary.asksWithRetries` lists
  ask/menu actions that consumed more than one participant input: a no-match
  or no-input retry happens *inside* the one action (as extra turns in its
  `execution[]`), so it never appears as a repeated action. All three lists
  empty means a straight run.
- `events[]` is the log in **execution order**. Each event is one entry of the
  raw `execution[]` array unwrapped: `index` (array position), `kind` (the raw
  event key), and every field of the payload passed through untouched. Kinds
  seen so far: containers `startedFlow`/`endedFlow`,
  `startedBotState`/`endedBotState` (bot flows), `startedTask`/`endedTask`;
  actions `actionCommunicate`, `actionUpdateData`, `actionDecision`,
  `actionSwitch`, `actionLoop`, `actionAskForIntent`, `actionAskForSlot`,
  `actionDigitalMenu`, `actionJumpToTask`, `actionExitBotFlow`; and the
  non-action events `eventLoop` (end of one Loop iteration, linked to its Loop
  action by `relatedAction`, carrying the new index in `variables[]`) and
  `eventError`. Report unfamiliar kinds by their fields rather than assuming a
  shape.
- An `eventError` carries `context.reason` (e.g.
  `Error.Expression.Value.NotAllowed.NotSet`), `context.functionNameOrOperator`
  and `context.settingName`, and the tool adds `relatedAction` (`index`,
  `actionId`, `actionName`) by matching `context.executionId` to the action
  event that was running. The run then ends with
  `flowExitReason: "FLOW_ERROR_EXIT"`, and `find_flow_execution` shows the same
  reason as `flowErrorReason`.
- `notes`, when present, is advisory prose about this instance (log level,
  truncation, join caveats). Read it before making claims.

### Joining to the IR

The join key is **`actionId`**: every action event carries the design-time GUID,
which is the `id` of the `flow_ir` node whose `kind` is `"action"`, and is
accepted verbatim by `flow_action`. `actionName` equals the IR `label` but names
are not unique, so join on the GUID. A `startedBotState.stateId` (bot flows) is
the IR task id; its node is `<stateId>::start`.

By default (`includeIr: true`) the tool does the join: each action event gains
`ir: { nodeId, actionType, taskId, taskName, terminal, reachable, successors,
takenBranch? }` and each container event (`startedBotState`, `startedTask`)
gains `ir: { nodeId, taskId, taskName }`; an event with `ir: null` found no
node. The response's `ir` block then carries
`configuration` (whether the join used the exact `flowVersion` that ran or fell
back to the latest), `unmatchedActionIds`, `unmatchedStateIds`,
`actionsNotExecuted` (every IR action this run never reached, with its
`reachable` flag) and the parse `warnings`. `actionsNotExecuted` is this run's
*negative space*: the branches not taken. It is not dead logic; one run proves
nothing about other runs.

Three naming traps:

- Event kinds and IR types differ by convention: **`action<Type>` ↔
  `<Type>Action`** (`actionCommunicate` is `CommunicateAction`,
  `actionDecision` is `DecisionAction`, `actionAskForSlot` is
  `AskForSlotAction`, `actionLoop` is `LoopAction`, `actionSwitch` is
  `SwitchAction`), with exceptions where Architect renamed the action:
  `actionUpdateData` is `UpdateVariableAction`, `actionJumpToTask` is
  `TransferTaskAction` and `actionAskForIntent` is `AskForNLUIntentAction`.
  The `ir.actionType` annotation settles it; never guess from the kind alone.
  `AskForNLUIntentAction` carries its per-intent routing on its own outputs
  (one per intent, keyed by intent id, plus `__NO_INTENT__`, `__KNOWLEDGE__`
  and `__MAX_NO_INPUTS__`), so its `takenBranch` resolves to the intent's
  label, its `terminal` flag is `false`, and its `description` lists the
  intents it can recognise. It raises no `UNRESOLVED_INTENT_FANOUT`; that
  warning is for the listen states whose routing lives outside the action.
- The IR's `order` is DFS discovery, **not** execution order. Sequence from
  `events[].index`, never from `order`.
- `trackingId` is the action number shown in the Architect UI. Gaps in it are
  authoring history (deleted actions), **not** missing events. Each event also
  has its own `executionId`, distinct per execution of an action; it tells
  iterations of a looped action apart. The instance-level `executionId` is a
  different thing: the instance id.

### Reading the log

- **Branches.** Execution data has no edges, but every branching action
  records the path it took as `outputPathId` (a Decision's `__YES__`/`__NO__`,
  an ask's `__DEFAULT__`/`__MAX_NO_MATCHES__`, an intent ask's intent GUID or
  `__NO_INTENT__`, a Switch case's GUID or `__DEFAULT__`, a menu choice's GUID,
  a Loop's `__LOOP__`) and usually `outputPathName`. That id is exactly the
  suffix of the IR branch-output node, so `ir.takenBranch` gives
  `{ nodeId: "<actionId>::<outputPathId>", label, inIr }`: the branch that ran,
  by its IR label. The sibling branch-outputs in `successors` are the roads not
  taken on this run. A Decision also records `inputData.condition` (the
  evaluated boolean); a Switch records `inputData.value` and the matching
  `inputData.cases[]`; an intent ask records `inputData.enabledIntents[]` and
  the matched intent in `outputVariables[]` as `Session.ActiveIntent`; a slot
  ask records `outputData.askResult` and the slot in `outputVariables[]`; a
  menu records `outputData.selection`; a Loop records `inputData.loopCount` and
  `outputData.currentIndex`.
- **Participant input.** Asks and menus carry an `execution[]` of turns: each
  `toParticipant` is a prompt the customer saw and each `fromParticipant`
  (`digital.text`) is what they typed. A failed attempt shows as an extra turn
  pairing their input with the `inputData.noMatch` prompt. Quote these to
  explain what the customer did.
- **Variables.** `startedFlow.variables[]` is the snapshot at entry: the
  built-ins (`Flow.*`, `Session.*` or `Call.*`) plus the flow's own variables
  (GUID `variableId`), `startedBotState.variables[]` the state's, and
  `endedFlow.outputVariables[]` the declared outputs. Assignments *are* logged:
  `actionUpdateData.statements[]` lists each variable and the value written, in
  order. Sentinels `ValueTooLarge`, `ValueRedacted` and `ValueInvalid` replace a
  value and should be reported as such.
- **Communications.** `communication.toParticipant.digitalItems[].text` is the
  rendered message with expressions already evaluated, so it is what the customer
  saw. Fields such as `queuedAudioFlushed` are shared with voice; expect audio
  items on a call flow.
- **Log level.** `logLevel` governs which sections exist. At levels below `all`,
  variables, communications or action inputs/outputs may be absent or empty
  because they were not recorded. That is expected, not a flow defect, and the
  response notes it.
- **Timestamps.** Each event's `dateTime` is when it ran; a communication's own
  `dateTime` is when the message was emitted and can differ by milliseconds. Use
  `index` for order and the timestamps for duration only.
- **Ending.** `endedFlow.flowExitReason` says how the run ended (`FLOW_EXIT` is
  a normal exit, `FLOW_ERROR_EXIT` an error; see the `eventError` just before
  it). On a bot flow `endedFlow.naturalLanguageUnderstanding.intent.intentName`
  is the intent the run ended with. No `endedFlow` means the run had not
  finished or the log was cut; `isTruncated: true` means the execution cap was
  hit.

### Recipes

**"What did this conversation do?"** `find_flow_execution` with the
`conversationId`, then `flow_execution_data` on each instance oldest first.
Narrate the events as the customer experienced them, quoting `digitalItems[].text`,
and name the task from `ir.taskName` at each transition.

**"Why did it loop?"** Three shapes, told apart by the summary. If
`summary.asksWithRetries` is non-empty, the "loop" is one ask or menu
re-prompting: read that event's `execution[]` turns to see what the customer
typed and which `noMatch` prompt answered them. If `summary.loops` is
non-empty, a Loop action ran its body that many times by design; its
`eventLoop` events carry the index per iteration. If `summary.repeatedActions`
is non-empty *without* a corresponding Loop, control genuinely came back round
through a jump: compare the events at its `eventIndexes` and those between
them, find the decision whose `takenBranch` kept choosing the way back (the IR
marks that jump's edge `backEdge: true`), then fetch it with `flow_action` to
read the condition.

**"Did the flow error?"** `find_flow_execution` with `onlyWithErrors: true`
(by `flowId` to sweep recent runs, or with the `conversationId`). The
`flowErrorReason` names the failure; in the instance, the `eventError` event's
`relatedAction` and `context.reason` say which action failed and why.

**"Is the flow working?"** Run `test_bot_flow` and pass its `sessionId` to
`flow_execution_data`, or sample recent instances by `flowId`. Confirm the
expected actions appear in `events`, and check `actionsNotExecuted` against
what the test was meant to cover.

**Empty or missing data.** Execution data exists only for flows published after
storage was enabled for the org, and only for 10 days. A not-found result or an
empty search is therefore often a configuration or age matter rather than proof
that the conversation never ran the flow; the tool's error text and `notes` list
the possibilities.

## Analysis recipes

**Trace "what happens when..."**: walk successors from the entry task-start,
narrating action labels and branch labels at each fork. Present paths as the
caller would experience them, not as node ids.

**Missing error handling**: find `branch-output` nodes whose label indicates
failure, error, or timeout, with `terminal: false` and `successors: []`. That
outcome silently drops out of the flow. (A terminal branch-output with
`successors: []` is correct, e.g. a transfer's Success leaves the flow by
design.)

**Dead logic**: first check `reachabilityIsComplete`. When `true`,
`reachable: false` nodes (grouped by `taskName`) are provably orphaned actions
no task entry point can reach. When `false`, they are merely not provably
reachable, since the unmodelled intent routing may reach them; report them as
"unverifiable", not dead.

**Orphaned tasks**: `reachable` does NOT mean "reachable from the flow entry".
Every task-start is a traversal root, so a task nothing ever calls still shows
`reachable: true` on all its nodes. To find never-invoked tasks, check each
task's `<taskId>::start` node (excluding `entryTaskId`): **zero predecessors
means nothing jumps to it**. Qualify this too when `reachabilityIsComplete` is
false, since an intent may jump to the task.

**Loops**: any predecessor with `backEdge: true` closes a real cycle; walking
forward, the same cycle shows as a successor with `backEdge: true`. Describe the
cycle path and check it has a terminal or branch exit.

**How does the flow end**: list `terminal: true` action nodes (disconnects,
end-flow/end-task, transfers). Transfers are terminal on success only; their
Failure branch-output stays live and should be checked for handling.

## Warnings

The `code` set is open (new codes may appear in minor releases of the parsing
library); handle unrecognised codes generically. `message` text is
human-readable and non-contractual; key all reasoning off `code`.

| Code                                        | Interpretation                                                                                                                                                                               |
|---------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `UNKNOWN_ACTION_TYPE`                       | Action handled generically; structure kept, but terminality and outputs may be incomplete for that node                                                                                      |
| `UNRESOLVED_INTENT_FANOUT`                  | A listen action's per-intent routing is **not in the IR** (this also sets `reachabilityIsComplete: false`). Do not claim the bot dead-ends or list "all paths" past this node                |
| `UNRESOLVED_REFERENCE`                      | A jump targets a task that does not exist: a genuine broken link worth reporting                                                                                                             |
| `UNRESOLVED_INITIAL_SEQUENCE`               | The flow declares an entry that matches no task (and `entryTaskId` is absent): a broken flow worth reporting                                                                                 |
| `DISABLED_BRANCH`                           | The output is disabled in Architect, **but its edges remain in the graph**; the warning is the only signal. Exclude the flagged output (`nodeId` is the branch-output) from live-path claims |
| `DROPPED_EDGE`                              | An edge referenced an unknown endpoint and was discarded; connectivity near the named node may be understated                                                                                |
| `UNRESOLVED_CALL_TASK`                      | Reserved; currently never emitted                                                                                                                                                            |
| `MISSING_ACTION_ID` / `DUPLICATE_ACTION_ID` | Malformed source data; treat affected nodes with suspicion                                                                                                                                   |

## Known blind spots

- **Intent routing is absent for listen states** (see
  `UNRESOLVED_INTENT_FANOUT`): `WaitForInputAction` and
  `AskForNLUNextIntentAction`. Qualify reachability and path claims wherever
  one appears. `AskForNLUIntentAction` is not affected: its per-intent
  outputs are ordinary edges in the IR.
- **Digital-bot menu choices** (`DigitalMenuAction`) are not expanded. IVR
  `menuChoiceList` menus are resolved. The unexpanded choices are visible in the
  action's raw config via `flow_action`, but their routing is not in the graph.
- **Loop back-edges are not synthesised**: a loop body's tail does not point
  back to the loop head, and `ExitLoopAction` is not resolved. Do not report
  "the loop never repeats"; that is a modelling gap, not a flow defect.

When a finding depends on one of these gaps, say so explicitly rather than
presenting it as a property of the flow.
