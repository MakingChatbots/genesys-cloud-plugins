/**
 * SVG to PNG in-process with resvg (WebAssembly), set in bundled Noto Sans, the
 * Architect editor's typeface. No browser, no network, the same bytes on every
 * machine. The assets (the wasm module and the two font files) live beside the
 * server bundle in `servers/assets`; see the README there.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

const WASM_FILE = "resvg.wasm";
const FONT_FILES = ["NotoSans-Regular.ttf", "NotoSans-Bold.ttf"];
const ASSET_FILES = [WASM_FILE, ...FONT_FILES];
const FONT_FAMILY = "Noto Sans";

export interface RasterResult {
    rasteriser: "resvg";
    /** The PNG's pixel size. */
    width: number;
    height: number;
}

/**
 * Where the assets are. An explicit path (`DIAGRAM_ASSETS_PATH`, which `.mcp.json`
 * always sets) is authoritative and a wrong one is an error. Without one, for the
 * TypeScript source run directly: `assets/` beside the bundle, else `servers/assets`
 * under the working directory.
 */
export function resolveAssetsDir(explicit?: string): string {
    const complete = (dir: string): boolean =>
        ASSET_FILES.every((f) => existsSync(path.join(dir, f)));
    const expected = `expected ${ASSET_FILES.join(", ")}`;
    if (explicit !== undefined) {
        if (complete(explicit)) return explicit;
        throw new Error(
            `diagram assets not found in DIAGRAM_ASSETS_PATH (${explicit}): ${expected} ` +
                "there; run the build to populate servers/assets",
        );
    }
    const candidates = [
        typeof __dirname === "string"
            ? path.join(__dirname, "assets")
            : undefined,
        path.resolve(process.cwd(), "servers", "assets"),
    ].filter((c): c is string => Boolean(c));
    const found = candidates.find(complete);
    if (found) return found;
    throw new Error(
        `diagram assets not found (looked in ${candidates.join(", ")}; ${expected}); set ` +
            "DIAGRAM_ASSETS_PATH to the plugin's servers/assets folder, or run the build to populate it",
    );
}

export interface Rasteriser {
    /** Write `svg` to `pngPath` at `scale` device pixels per CSS pixel. */
    toPng(svg: string, pngPath: string, scale: number): Promise<RasterResult>;
}

/**
 * The wasm module is initialised once per process, whichever rasteriser gets there
 * first: `initWasm` throws if it runs twice, so its promise is kept whatever happens.
 */
let wasmReady: Promise<void> | undefined;

/**
 * Loads the fonts and the wasm module once, on first use. Reading the files can be
 * retried after a failure; the files are read before `initWasm` is called so a
 * missing font never leaves the module half-initialised.
 */
export function createRasteriser(assetsDir?: string): Rasteriser {
    let fontsReady: Promise<Uint8Array[]> | undefined;
    const load = (): Promise<Uint8Array[]> => {
        fontsReady ??= (async () => {
            const dir = resolveAssetsDir(assetsDir);
            const [wasm, ...fonts] = await Promise.all(
                ASSET_FILES.map((f) => readFile(path.join(dir, f))),
            );
            wasmReady ??= initWasm(wasm as Uint8Array).then(() => undefined);
            await wasmReady;
            return fonts;
        })().catch((e: unknown) => {
            fontsReady = undefined; // the file reads can be retried
            throw e;
        });
        return fontsReady;
    };
    return {
        async toPng(svg, pngPath, scale) {
            const fontBuffers = await load();
            const resvg = new Resvg(svg, {
                fitTo: { mode: "zoom", value: scale },
                font: {
                    fontBuffers,
                    loadSystemFonts: false,
                    defaultFontFamily: FONT_FAMILY,
                },
            });
            try {
                const rendered = resvg.render();
                try {
                    const png = rendered.asPng();
                    await writeFile(pngPath, png);
                    return {
                        rasteriser: "resvg",
                        width: rendered.width,
                        height: rendered.height,
                    };
                } finally {
                    rendered.free(); // the RGBA buffer lives in wasm memory until freed
                }
            } finally {
                resvg.free();
            }
        },
    };
}
