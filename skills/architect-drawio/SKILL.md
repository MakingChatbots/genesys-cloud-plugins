---
name: architect-drawio
description: This skill should be used whenever a Genesys Cloud Architect flow, task, bot or IVR is wanted as a draw.io / diagrams.net diagram, a .drawio file, or "a canvas I can move boxes around" — "push it to draw.io", "open it in drawio", "editable Architect diagram", "make it look like Architect in draw.io" — for a deployed flow, a proposed change, or a fictional flow. Use it even when the user does not say "Architect" if the thing being drawn is a contact-centre flow and the destination is draw.io. It hand-writes draw.io XML that matches the Architect editor's canvas (numbered action boxes with a grey header, branch pills under a bus, dashed empty slots, End of Flow footers), with every box a separate movable shape. For a static PNG/SVG of that look use the architect-diagram skill's flow_diagram tool; for Mermaid in markdown use flow-diagram.
---

# Architect-style diagrams in draw.io

Produce a native draw.io diagram where every action box, branch pill and empty slot is its own movable shape, drawn to match the Architect editor's canvas. The output is a `.drawio` file (plain mxGraphModel XML) and a link that opens it in app.diagrams.net.

## Workflow

1. **Get the structure.** For a fictional flow or a sketch, take it from the user. For a deployed flow, read it with `flow_ir` (chains, outputs, loops). When exact editor positions matter, run `flow_diagram` first: its result's `boxes` lists every action's badge, `x`, `y`, `width`, `height`, usable verbatim as draw.io geometry (same units, same 24 px margin). Pills, slots and bus lines still need placing with the rules below.
2. **Write the XML** by hand using the geometry and cell patterns below. Compute column centres first, then box positions, then edge waypoints; the bus lines only look right when every waypoint on a bus shares the same `y`. Write every edge before any vertex in the file: draw.io paints cells in file order, so this keeps connectors underneath boxes and highlight tags, as in the editor.
3. **Save** it as `<name>.drawio` in the scratchpad (or where the user asks).
4. **Check and deliver** with the script below, which runs anywhere Node does (macOS, Linux, and Windows under Git Bash, which Claude Code uses there). It stops with a line number if the XML will not parse. A bare `<`, `&` or `"` inside a label is the usual cause of a blank canvas, and this catches it before the user sees it. Otherwise it saves the link beside the file as `<name>.drawio.url.txt` and opens it in the default browser. On Windows it opens the link through a `.url` shortcut, because `cmd` would cut the link at `&` and `#`. Add `--no-open` after the file name to skip opening, for example on a machine with no browser. Then tell the user where the `.drawio` file is. The link is a view, not storage: draw.io shows it as "Untitled Diagram" until they save it, so the file is the persistent copy. The draw.io desktop app, if installed, can also export PNG/SVG (see the `drawio` skill); it is not needed for the link.

```bash
node -e '
const fs=require("fs"),os=require("os"),path=require("path"),zlib=require("zlib"),{spawn}=require("child_process");
const file=process.argv[1], noOpen=process.argv[2]==="--no-open";
const xml=fs.readFileSync(file,"utf8").replace(/^\uFEFF/,"");
const fail=(i,msg)=>{console.error(`${file}:${xml.slice(0,i).split("\n").length}: ${msg}`);process.exit(1);};
const badAmp=/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
const tag=/<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|\x27[^\x27]*\x27))*)\s*(\/?)>/y;
const stack=[];let i=xml.startsWith("<?xml")?xml.indexOf("?>")+2:0;
while(i<xml.length){
  const lt=xml.indexOf("<",i), text=xml.slice(i,lt<0?xml.length:lt);
  if(text.trim()) fail(i,"text outside any tag: "+JSON.stringify(text.trim().slice(0,40)));
  if(lt<0) break;
  if(xml.startsWith("<!--",lt)) fail(lt,"XML comments are not allowed in a .drawio file");
  tag.lastIndex=lt;const m=tag.exec(xml);
  if(!m) fail(lt,"malformed tag, usually an unescaped < or a stray quote inside a label: "+JSON.stringify(xml.slice(lt,lt+60)));
  for(const v of m[3].matchAll(/=\s*(?:"([^"]*)"|\x27([^\x27]*)\x27)/g)){const val=v[1]??v[2];
    if(val.includes("<")) fail(lt,"unescaped < in an attribute; write &lt;");
    if(badAmp.test(val)) fail(lt,"unescaped & in an attribute; write &amp;");}
  if(m[1]){const open=stack.pop();if(open!==m[2]) fail(lt,`</${m[2]}> closes <${open}>`);}
  else if(!m[4]) stack.push(m[2]);
  i=tag.lastIndex;}
if(stack.length) fail(xml.length,`unclosed <${stack.pop()}>`);
if(!/^\s*(<\?xml[^>]*\?>\s*)?<(mxGraphModel|mxfile)\b/.test(xml)) fail(0,"root element must be mxGraphModel or mxfile");
const url="https://app.diagrams.net/?grid=0&pv=0&border=10&edit=_blank#R"+encodeURIComponent(zlib.deflateRawSync(encodeURIComponent(xml)).toString("base64"));
fs.writeFileSync(file+".url.txt",url);
console.log("OK, link saved to "+file+".url.txt");
if(noOpen) process.exit(0);
if(process.platform==="win32"){const p=path.join(os.tmpdir(),"drawio-"+Date.now()+".url");fs.writeFileSync(p,"[InternetShortcut]\r\nURL="+url+"\r\n");spawn("explorer.exe",[p],{detached:true,stdio:"ignore"}).unref();}
else spawn(process.platform==="darwin"?"open":"xdg-open",[url],{detached:true,stdio:"ignore"}).unref();
' DIAGRAM.drawio
```

Say that red outlines and tags (if used) are additions the editor does not draw. For a large diagram, check that no bus came out crooked by reading back the edge waypoints: every point on one bus shares the same `y`, and each column drops at its own centre `x`. If the session happens to have a browser tool, such as a Playwright or Chrome DevTools MCP server, a screenshot of the link is a quicker check, but do not install one for this.

## Geometry (draw.io units = Architect CSS px)

| Thing | Size | Placement rule |
|---|---|---|
| Action box | 262 × 87 | Centred on its column |
| Header (child of box) | 260 × 24 at (1, 1) | Badge + title |
| Footer (child of box) | 262 × 21 at (0, 66) | Only on Exit Bot Flow / End Flow / Disconnect ("End of Flow") and End Task ("End of Task") |
| Start pill, branch pill | 106 × 25.5 | Centred on its column |
| Empty slot | 106 × 32, dashed | Where an output has no actions |
| Vertical gap | 26 | Between every stacked thing: box→box, box→bus, bus→pill, pill→box, last box→rejoin bus, bus→next box |
| Column gap | 19.5 | Between sibling branch columns |
| Canvas margin | 24 | All sides |

Column rules:
- A plain chain is one column, width 262, centre = x + 131.
- A branching box's columns sit side by side; each column's width is max(106, widest thing in it). The box itself centres over the whole row, so a branching box's column is max(262, sum of column widths + gaps).
- Outputs go left to right in flow order. Digital Menu choices first (tinted pills), then Max No Matches / Max No Inputs (white pills). Call Task: named paths first, Default last.
- Bus `y` = branching box bottom + 26. Pills at bus + 26. Children at pill bottom + 26. Rejoin bus `y` = lowest column bottom + 26. Next box at rejoin + 26.
- A task that does not end in a terminating action ends in an arrow and an empty slot.

Loop rules (the body is drawn inline, indented right, as the editor does):
- The loop box sits at the left edge of its column rather than centred, so the spine stays straight above and below it and the gutter on its left stays clear of the body. Loop column width = max(262, 30 + body width + 14). Body column starts 30 right of the loop box's left edge, 26 below its bottom.
- Loop → first body box: ARROW with waypoints `(loopCx, loopBottom + 13)`, `(bodyCx, loopBottom + 13)`.
- Back edge from the last body box to the loop box: dashed, `endArrow=open;endSize=6;exitX=0.5;exitY=1;entryX=1;entryY=0.5`, waypoints `(leafCx, bodyBottom + 13)`, `(bodyRight + 10, bodyBottom + 13)`, `(bodyRight + 10, loopCy)`. Exit Loop / Next Loop boxes rejoin the same way, solid.
- Loop → next box: ARROW with `exitX=0.05` so it leaves the loop box at the left and runs down the gutter left of the body, waypoints `(loopX + 13, bodyBottom + 13)`, `(nextCx, bodyBottom + 13)`. Next box at bodyBottom + 26.

## Cell patterns

Model skeleton. Keep the grey canvas; it is what makes it read as Architect:

```xml
<mxGraphModel adaptiveColors="auto" background="#ecedf5" pageVisible="0" grid="0">
  <root><mxCell id="0"/><mxCell id="1" parent="0"/>
  ...cells...
  </root>
</mxGraphModel>
```

**Action box** = body vertex + header child (+ footer child). The header must be a child cell, not a `<div>` in the label: draw.io shrink-wraps HTML labels to their text, so a div never spans the box. Children use coordinates relative to the parent and move with it, so dragging the box takes its header along.

```xml
<mxCell id="a1" value="&lt;div style=&quot;font-size:9.5px;color:#505158;line-height:2&quot;&gt;Hi, welcome!&lt;br&gt;How can I help?&lt;/div&gt;"
  style="rounded=1;arcSize=4;whiteSpace=wrap;html=1;align=left;verticalAlign=top;spacing=0;spacingTop=22;spacingLeft=7;spacingRight=4;strokeColor=#6b6d75;fillColor=#ffffff;fontSize=11;fontColor=#2a2a2e;overflow=hidden;"
  vertex="1" parent="1"><mxGeometry x="86.75" y="75.5" width="262" height="87" as="geometry"/></mxCell>
<mxCell id="a1_h" value="&lt;span style=&quot;background:#2a2a2e;color:#fff;border-radius:3px;padding:0 6px;margin-right:6px&quot;&gt;1&lt;/span&gt;Welcome"
  style="shape=partialRectangle;top=0;left=0;right=0;bottom=1;html=1;align=left;verticalAlign=middle;spacingLeft=8;strokeColor=#6b6d75;fillColor=#ecedf5;fontSize=11;fontStyle=1;fontColor=#2a2a2e;movable=0;resizable=0;rotatable=0;deletable=0;connectable=0;"
  vertex="1" parent="a1"><mxGeometry x="1" y="1" width="260" height="24" as="geometry"/></mxCell>
```

Footer (child of a terminating box):

```xml
<mxCell id="a4_f" value="End of Flow" style="rounded=1;arcSize=10;html=1;strokeColor=#1f3a7a;fillColor=#1f3a7a;fontColor=#ffffff;fontSize=9.5;fontStyle=1;movable=0;resizable=0;connectable=0;"
  vertex="1" parent="a4"><mxGeometry x="0" y="66" width="262" height="21" as="geometry"/></mxCell>
```

**Pills** (Start, outputs). Tinted fill `#d5def7` for Digital Menu choices, `#ffffff` otherwise:

```xml
<mxCell id="a2_yes" value="Yes" style="rounded=1;arcSize=20;whiteSpace=wrap;html=1;strokeColor=#6b6d75;fillColor=#ffffff;fontSize=9.5;fontStyle=1;fontColor=#2a2a2e;"
  vertex="1" parent="1"><mxGeometry x="102" y="327.5" width="106" height="25.5" as="geometry"/></mxCell>
```

**Empty slot:**

```xml
<mxCell id="a2_no_slot" value="" style="rounded=1;arcSize=10;html=1;strokeColor=#6b6d75;dashed=1;fillColor=#ffffff;"
  vertex="1" parent="1"><mxGeometry x="305.25" y="379" width="106" height="32" as="geometry"/></mxCell>
```

**Edges.** Always bottom-centre out, top-centre in, orthogonal. Two styles: `ARROW` for the connector that enters a box or slot, `LINE` (no arrowhead) for box→pill and for rejoins that merge into a bus. Bus lines are waypoints: box→pill passes `(boxCx, busY)` then `(pillCx, busY)`; a rejoin passes `(leafCx, rejoinY)` then `(nextCx, rejoinY)`. Give only the last rejoin into a box the arrowhead, otherwise several arrowheads pile up on one spot. A branch that leaves the sequence (Exit Bot Flow, End Task, Jump to Task) rejoins with `dashed=1` and no arrowhead, which is how the editor shows "this path does not continue". Every edge needs the child `mxGeometry` or it does not render.

```xml
ARROW: edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=#6b6d75;endArrow=blockThin;endFill=1;endSize=5;exitX=0.5;exitY=1;entryX=0.5;entryY=0;
LINE:  edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=#6b6d75;endArrow=none;exitX=0.5;exitY=1;entryX=0.5;entryY=0;

<mxCell id="e3" style="LINE" edge="1" parent="1" source="a2" target="a2_yes">
  <mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="217.75" y="301.5"/><mxPoint x="155" y="301.5"/></Array></mxGeometry>
</mxCell>
```

**Highlight** (optional, not an editor feature). The renderer leaves the box border grey and draws a separate red ring about 3 px outside it, with a small gap, then a red tag whose left edge lines up with the ring and which straddles the top of the box. Add both as children of the box so they move with it. Colouring the box border instead loses the gap and makes the tag look as if it overhangs the box. The tag covers the incoming arrow, which is intended and only works because edges come earlier in the file. Tag width is about 8 + 5.7 per character.

```xml
<mxCell id="a53_ring" value="" style="rounded=1;absoluteArcSize=1;arcSize=8;html=1;fillColor=none;strokeColor=#d0021b;strokeWidth=2;movable=0;resizable=0;rotatable=0;deletable=0;connectable=0;"
  vertex="1" parent="a53"><mxGeometry x="-3" y="-3" width="268" height="93" as="geometry"/></mxCell>
<mxCell id="a53_tag" value="customers drop out here" style="rounded=1;absoluteArcSize=1;arcSize=6;html=1;align=left;verticalAlign=middle;spacingLeft=6;strokeColor=none;fillColor=#d0021b;fontColor=#ffffff;fontSize=9.5;fontStyle=1;movable=0;resizable=0;connectable=0;"
  vertex="1" parent="a53"><mxGeometry x="-3" y="-11" width="140" height="16" as="geometry"/></mxCell>
```

## Escaping

Label text is HTML inside an XML attribute, so escape twice: first HTML-escape the text (`&` `<` `>` to entities), then XML-escape the whole attribute (`&` `<` `>` `"`). An expression such as `Flow.Count > 0` therefore becomes `Flow.Count &amp;gt; 0` in the file. Never put XML comments in the file.

## Worked example

Start → Welcome → decision "Yes / No" where Yes has one box and No is empty → Exit Bot Flow. Columns: Yes 262 wide, No 106 wide, so the row is 387.5 wide and the main centre is 24 + 193.75 = 217.75. Yes centre 155, No centre 358.25.

| Cell | x | y |
|---|---|---|
| start | 164.75 | 24 |
| a1 Welcome | 86.75 | 75.5 |
| a2 Decision | 86.75 | 188.5 (bus 301.5) |
| pills | 102 / 305.25 | 327.5 |
| a3 (under Yes) | 24 | 379 |
| slot (under No) | 305.25 | 379 |
| rejoin bus | | 492 |
| a4 Exit Bot Flow | 86.75 | 518 |

Edges: start→a1 ARROW; a1→a2 ARROW; a2→each pill LINE via bus 301.5; pill→a3 and pill→slot ARROW; a3→a4 LINE via (155, 492),(217.75, 492); slot→a4 ARROW via (358.25, 492),(217.75, 492). A larger flow is the same rules applied recursively: lay out each branch as its own column, then stack columns under their parent.

## Limits

- Icons in the header are not drawn; the badge and title carry the identity.
- The three-dot (⋮) action menu at the right of each header, and of each pill, is not drawn. The `flow_diagram` PNG shows it because it copies the editor; leave it out of the draw.io version, since it is editor chrome with no meaning on a diagram.
- Body text wraps (`whiteSpace=wrap`) where the editor clips it at the box edge; wrapping is kinder in an editable diagram, so keep lines short rather than fighting it.
- Collapsed actions, left-to-right layouts and selection states are not modelled.
