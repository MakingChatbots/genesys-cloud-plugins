---
name: interpret-flow-ir
description: This skill should be used when interpreting the JSON returned by the flow_ir or flow_action tools, or when the user asks questions about a deployed Genesys Cloud Architect flow. Structural questions such as "analyse this flow", "trace the path through the flow", "what happens when the customer says X", "why is this task unreachable", "check the flow for missing error handling", "find dead logic", or "does this flow loop". Semantic questions such as "what does this decision check", "what prompt does it play", "what does this data action send", or "what does pressing 2 do". Use it to answer control-flow questions from the IR instead of guessing from the flow's raw configuration JSON, and to fetch the per-action settings the IR omits.
---

# Interpreting Flow IRs

The `flow_ir` tool returns a deployed flow's **intermediate representation (IR)**:
the flow parsed into an explicit control-flow graph, flattened to a node list.
Branches, loops, IVR menu choices, and cross-task jumps are already resolved
into edges. Answer structural questions from this IR, never by re-deriving
control flow from the flow's raw configuration JSON.

The two tools are a pair: `flow_ir` owns **structure** — what connects to what —
and `flow_action` owns **semantics** — what an individual action is configured to
do (see "Action semantics").

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
configuration matters, then make **one batched call**. Do not call once per
action; each call refetches the whole flow configuration.

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
Prefer passing plain action GUIDs. `<taskId>::start` is a task marker rather than
an action, so it can never match.

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

- **Intent routing is absent** (see `UNRESOLVED_INTENT_FANOUT`). Qualify
  reachability and path claims wherever a listen action appears.
- **Digital-bot menu choices** (`DigitalMenuAction`) are not expanded. IVR
  `menuChoiceList` menus are resolved. The unexpanded choices are visible in the
  action's raw config via `flow_action`, but their routing is not in the graph.
- **Loop back-edges are not synthesised**: a loop body's tail does not point
  back to the loop head, and `ExitLoopAction` is not resolved. Do not report
  "the loop never repeats"; that is a modelling gap, not a flow defect.

When a finding depends on one of these gaps, say so explicitly rather than
presenting it as a property of the flow.
