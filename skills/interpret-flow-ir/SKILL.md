---
name: interpret-flow-ir
description: This skill should be used when interpreting the JSON returned by the flow_ir tool, or when the user asks structural questions about a deployed Genesys Cloud Architect flow, such as "analyse this flow", "trace the path through the flow", "what happens when the customer says X", "why is this task unreachable", "check the flow for missing error handling", "find dead logic", or "does this flow loop". Use it to answer control-flow questions from the IR instead of guessing from the flow's raw configuration JSON.
---

# Interpreting Flow IRs

The `flow_ir` tool returns a deployed flow's **intermediate representation (IR)**:
the flow parsed into an explicit control-flow graph, flattened to a node list.
Branches, loops, IVR menu choices, and cross-task jumps are already resolved
into edges. Answer structural questions from this IR, never by re-deriving
control flow from the flow's raw configuration JSON.

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
| `predecessors`       | **Incoming** edges `{ id, label?, backEdge }`; see "Navigating"                                                                                                       |
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
  a labelled fork. A branch-output with no successors is a dangling outcome
  (see recipes).

## Navigating the graph

Edges are stored **incoming**: each node lists its predecessors, not its
successors. To answer "what happens next", invert once:

1. Build a successor map: for every node N and every predecessor P in
   `N.predecessors`, record "P leads to N" with the predecessor's `label` and
   `backEdge`.
2. Trace forward from `<entryTaskId>::start` for the caller-visible path. Pass
   through branch-output nodes, using their `label` as the branch condition
   ("on Failure, ..."). If `entryTaskId` is absent, say the entry is unknown
   rather than guessing a starting task.
3. Stop a trace at `terminal: true` nodes.

Edge `label` carries the branch or jump meaning: branch outcome labels
(`Success`, `Failure`, `Yes`/`No`), IVR menu choice names, and the target task
name on jump edges. `backEdge: true` marks a real cycle.

An unlabelled predecessor pointing directly at a branching action (not at one
of its branch-outputs) is that action's fall-through: the path taken after the
action completes, e.g. a loop's continue-after-exit edge.

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
- A filtered node's `predecessors` may name ids from other tasks; those ids are
  absent from the filtered `nodes` array. That is a cross-task jump, not a
  dangling reference.

## Analysis recipes

**Trace "what happens when..."**: walk successors from the entry task-start,
narrating action labels and branch labels at each fork. Present paths as the
caller would experience them, not as node ids.

**Missing error handling**: find `branch-output` nodes whose label indicates
failure, error, or timeout, with `terminal: false` and no successors. That
outcome silently drops out of the flow. (A terminal branch-output with no
successor is correct, e.g. a transfer's Success leaves the flow by design.)

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

**Loops**: any predecessor with `backEdge: true` closes a real cycle. Describe
the cycle path and check it has a terminal or branch exit.

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
  `menuChoiceList` menus are resolved.
- **Loop back-edges are not synthesised**: a loop body's tail does not point
  back to the loop head, and `ExitLoopAction` is not resolved. Do not report
  "the loop never repeats"; that is a modelling gap, not a flow defect.

When a finding depends on one of these gaps, say so explicitly rather than
presenting it as a property of the flow.
