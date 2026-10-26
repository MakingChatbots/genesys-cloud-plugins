---
name: architect-diagram
description: Draw a deployed Genesys Cloud Architect flow task as an image that looks like the Architect editor's own canvas (numbered action boxes with icons, branch pills under a bus, dashed rejoins, inline loops, "End of Flow" footers), with optional red highlights and tags on the actions being discussed, using the flow_diagram tool. Use when the user asks for a picture, image, screenshot-like diagram or PNG/SVG of a flow or task "like Architect" / "as it looks in the editor", wants a diagram that points at where a flow is broken, wants to show stakeholders where customers drop out or which path a conversation took, or wants a static base image for an animation of customers moving through a flow. For a quick text diagram that renders in GitHub markdown, use the flow-diagram skill (Mermaid) instead.
---

# Architect-style flow diagrams

The `flow_diagram` tool draws one task of a flow as SVG and PNG in the look of the
Architect editor, measured box by box from editor screenshots and set in its typeface.
It reads the flow itself and writes the files where you tell it; nothing here writes to
Genesys, and nothing needs installing for the PNG.

Pick this over the Mermaid `flow-diagram` skill when the picture has to be recognisable to
someone who works in Architect every day: a bug report, a "this is the box to change"
message, a slide, or a frame for an animation. Pick Mermaid for a README or a PR.

## Workflow

1. **Resolve the flow.** `find_flow` by name; note the id and `publishedVersion`. For a
   past version, take the `flowVersion` from `flow_versions` or `find_flow_execution`.
2. **Draw.** `flow_diagram` with the flow id, an absolute `outputDir` (a scratch folder:
   the session scratchpad if the environment gives you one), and `task` by name or id.
   Omit `task` for the entry task, which is what a user means by "the main task"; the
   result lists every task of the flow either way, so a wrong guess costs one call.
   `highlights` takes the badge numbers the editor shows (the raw `trackingId`, so a
   number the user reads off a screenshot goes straight in) or IR action ids (what
   `flow_ir`, `search_in_flow` and `flow_execution_data` report), each with an optional
   tag of up to about 45 characters. Badge numbers appear only in this tool's result
   (`boxes`), not in `flow_ir`; to highlight an action by what it does, find its id
   with `flow_ir` or `search_in_flow` first. A highlight that is not in the drawn task
   is an error naming the task that holds it.
3. **Deliver the image**, not the SVG text: the `pngPath`, or an Artifact / HTML page
   with the SVG inline (it is self-contained; the web font is its only external
   reference). Say which task it shows and which configuration: without `flowVersion`
   that is the latest saved configuration, so say "latest configuration (published
   version X)" from the result's `configurationDescription` and `publishedVersion`
   (`configuration` itself is the same object the other flow tools return), and call
   `flow_versions` only when the user needs to know whether unpublished edits exist
   (the picture will be compared with the live canvas, or the flow is actively being
   edited). Mention any `hiddenOutputs`, since `flow_ir` lists them and the picture,
   like the editor, does not. Say that
   the red outline and tag are additions the editor does not draw. If the result lists
   anything under `standIns`, say those boxes are drawn with the nearest look rather than
   from an editor capture; when it is empty there is nothing more to add. Relay any
   `notes`: a PNG that could not be written, actions with no configuration.

For a sketch of a proposed change, or a flow the plugin cannot read, pass `graph` instead
of a flow id; the tool's description gives the shape and the kinds.

## Reading the picture (so the explanation matches it)

- The badge number is `trackingId`, the number Architect shows; it continues across tasks.
- Branch pills hang under a bus; an output with nothing under it is a dashed empty slot.
- A dashed line back to the bus means that branch *left* the sequence (Exit Bot Flow, End
  Task, Jump to Task); solid means it rejoins and continues. Exit Loop / Next Loop rejoin
  solid.
- A loop's body is drawn inline, offset right, with a dashed back edge carrying two open
  triangles; the body is everything in that gutter.
- A Digital Menu's choices come first, left to right in their order, in tinted pills; its
  Max No Matches / Max No Inputs outputs come last in white pills, and one switched off in
  the flow (`outOfService`) is not drawn, as the editor hides it.
- A Call Task shows the callee's named paths first and Default last; a blank "Add Path"
  button appears only when Default is the sole path.
- Body text is clipped at the box edge with no ellipsis, as the editor does; quote the full
  expression from `flow_action` in the explanation rather than relying on the picture.
- A task that does not end in a terminating action ends in an arrow and an empty slot.

## What is verified and what is a stand-in

Every rule above was settled against editor captures of digital bot flows: decisions,
switches, digital menus with and without a visible system output, data actions, update
data, set participant data, loops with and without Exit/Next Loop, Call Task with and
without named paths, Jump to Task, End Task, Exit Bot Flow, hidden menu outputs, badges.

Known only from one inbound-call-flow screenshot, so drawn with the nearest look and
reported under `standIns`: Menu, Play Audio, Transfer to ACD, Collect Input, Call Agentic
Virtual Agent, Disconnect. Not modelled at all: collapsed actions, left-to-right layouts,
shadows and selection states. An action type the renderer does not know draws as a gear
with the IR's description as its body.

Highlights are this renderer's addition, not an editor feature.

## Animating customers through a flow

The SVG is a static base. The result's `boxes` give every action's badge, IR action id
and position, so a script can map execution data (`flow_execution_data`, per action id)
onto coordinates and draw dots, counts or a walked path on top. Manim loads the SVG with
`SVGMobject`; a browser can animate it with CSS or JS on the `g.node[data-id]` groups.
