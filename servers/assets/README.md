# Diagram rasteriser assets

The `flow_diagram` tool turns its SVG into a PNG in-process with resvg (WebAssembly),
using these files so the picture is set in the Architect editor's own typeface on every
machine, with no browser and no network. The server finds this folder through
`DIAGRAM_ASSETS_PATH`, which `.mcp.json` sets to `${CLAUDE_PLUGIN_ROOT}/servers/assets`.

Unlike the rest of `servers/`, the font files here are hand-placed, not built:

- `NotoSans-Regular.ttf`, `NotoSans-Bold.ttf`: Noto Sans 400 and 700, the Latin subsets
  Google Fonts serves, under the SIL Open Font License 1.1 (`OFL.txt`).
- `resvg.wasm` is the one built file: `pnpm run build:diagram-assets` (part of
  `pnpm run build:mcp-server`) copies it from `@resvg/resvg-wasm`, so a dependency bump
  refreshes it.

A flow whose text is outside Latin renders those glyphs from resvg's fallback; add the
matching Noto subset here and to the font list in `src/mcp-server/diagram/raster.ts` if
that matters.
