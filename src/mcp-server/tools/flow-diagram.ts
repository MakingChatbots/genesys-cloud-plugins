import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    boxBottom,
    type DiagramFlow,
    type DiagramGraphJson,
    DiagramHighlightError,
    diagramForTask,
    diagramFromGraph,
    diagramToSvg,
    type FlowIR,
    layoutDiagram,
    parseFlow,
    type TaskDiagram,
} from "@makingchatbots/genesys-cloud-architect-diagram-lib";
import type { ArchitectApi } from "purecloud-platform-client-v2";
import { z } from "zod/v3";
import { createRasteriser, type RasterResult } from "../diagram/raster.ts";
import {
    type ConfigurationSource,
    describeConfiguration,
    fetchFlowConfiguration,
    flowVersionInput,
} from "../utilities/fetch-flow-configuration.ts";
import { isExactNameMatch } from "../utilities/name-match.ts";
import type { ToolFactory } from "../utilities/types.ts";

export interface ToolConfig {
    architectApi: ArchitectApi;
    /** Where the rasteriser's wasm module and fonts are; see servers/assets/README.md. */
    assetsPath?: string;
}

const highlightInput = z.object({
    id: z
        .string()
        .trim()
        .min(1)
        .describe(
            "The action to outline in red: its badge number as the editor shows it " +
                '(the raw `trackingId`, e.g. "53") or its flow_ir action id.',
        ),
    tag: z
        .string()
        .trim()
        .max(60)
        .optional()
        .describe(
            "Optional short caption drawn in a red tab over the box, e.g. " +
                '"312 customers dropped out here". Clipped to the box width at ' +
                "about 45 characters.",
        ),
});

const inputSchema = {
    flowId: z
        .string()
        .min(1)
        .optional()
        .describe(
            "The Genesys Cloud Architect flow ID to draw. Omit only when passing `graph`.",
        ),
    flowVersion: flowVersionInput,
    task: z
        .string()
        .min(1)
        .optional()
        .describe(
            "The task to draw, by task id or its exact name (case-insensitive). One diagram " +
                "draws one task. Omit to draw the flow's entry task, which is what a " +
                "user means by the main task. The result lists every task of the flow " +
                "either way.",
        ),
    highlights: z
        .array(highlightInput)
        .max(20)
        .optional()
        .describe(
            "Actions to point at: a red outline round each, with an optional tag. " +
                "Not an editor feature; say so when delivering the picture. An id " +
                "that is not in the drawn task is an error that names the task it is in.",
        ),
    outputDir: z
        .string()
        .min(1)
        .describe(
            "Absolute path of a directory to write the SVG and PNG into; created if " +
                "missing. Use a scratch folder: the user wants the image, not the files " +
                "around it.",
        ),
    fileName: z
        .string()
        .regex(/^[A-Za-z0-9._-]+$/)
        .optional()
        .describe(
            "Base name for the files, without extension. Defaults to the task name " +
                "with unsafe characters replaced.",
        ),
    png: z
        .boolean()
        .default(true)
        .describe(
            "Also write a PNG, rendered in-process in the editor's typeface (bundled " +
                "Noto Sans); nothing needs installing. The SVG is always written and is " +
                "self-contained (the web font is its only external reference).",
        ),
    scale: z
        .number()
        .min(0.5)
        .max(4)
        .default(2)
        .describe("Device pixels per CSS pixel for the PNG; 2 is retina."),
    webFont: z
        .boolean()
        .default(true)
        .describe(
            "Have the SVG import Noto Sans, the editor's face, from Google Fonts so it " +
                "also looks right opened in a browser; false leaves the browser to its " +
                "sans-serif. The PNG is set in the bundled Noto Sans either way.",
        ),
    graph: z
        .union([
            z.object({ chain: z.array(z.unknown()) }).passthrough(),
            z.string().min(1),
        ])
        .optional()
        .describe(
            "Instead of a flow (do not pass flowId, flowVersion or task with it): a " +
                "hand-written graph to draw, for a sketch of a proposed change, as an " +
                'object or a JSON string. Shape: {"start": true, "chain": [ACTION, ...]} ' +
                'where ACTION = {"id": 38, "kind": "communicate", "title": ' +
                '"...", "body": ["line"], "outputs": [{"label": "Success", ' +
                '"chain": [ACTION]}], "loop_body": [ACTION]}. Kinds: communicate, ' +
                "decision, switch, update_data, set_participant_data, data_action, " +
                "loop, exit_loop, next_loop, call_task, call_module, jump_to_task, " +
                "end_task, exit_bot_flow, end_flow, disconnect, digital_menu, " +
                "ask_for_slot, ask_for_intent, call_ava, call_bot, transfer_to_acd, " +
                "play_audio, collect_input, generic.",
        ),
};

function slug(name: string): string {
    return (
        name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") ||
        "diagram"
    );
}

function err(text: string) {
    return { isError: true, content: [{ type: "text" as const, text }] };
}

/** Which task holds a badge number or action id, for a highlight that missed. */
function locate(diagram: TaskDiagram, id: string): string | undefined {
    const hit = diagram.actions.find(
        (a) => a.actionId === id || String(a.badge) === id,
    );
    return hit
        ? `"${hit.taskName}" (badge ${hit.badge}, "${hit.title}")`
        : undefined;
}

export const flowDiagram: ToolFactory<ToolConfig, typeof inputSchema> = ({
    architectApi,
    assetsPath,
}: ToolConfig) => {
    const rasteriser = createRasteriser(assetsPath);
    return {
        config: {
            description:
                "Draws one task of a Genesys Cloud Architect flow as an image in the look of " +
                "the Architect editor's own canvas (numbered action boxes with icons, branch " +
                "pills under a bus, dashed rejoins, inline loops, End of Task / End of Flow " +
                "footers), written as SVG and PNG files, with optional red highlights and tags " +
                "on the actions being discussed. Use it when the user wants a picture, " +
                "screenshot-like diagram or PNG of a flow or task as it looks in the editor, " +
                "a diagram that points at where a flow is broken, or an image for a bug " +
                "report, slide or stakeholder message. It reads the flow itself, so nothing " +
                "needs fetching first to draw; to choose which action to highlight by what " +
                "it does, find its id with flow_ir or search_in_flow, and to highlight the " +
                "box a user names from a screenshot pass that badge number straight in " +
                "(badge numbers appear only here, in the result's boxes, not in flow_ir). " +
                "Deliver the PNG path (or the SVG inline), say which task and configuration " +
                "it shows, and name any action the result lists under standIns. For a text " +
                "diagram that renders in markdown, use flow_ir and write Mermaid instead.",
            annotations: {
                title: "Flow Diagram",
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema,
        },
        handler: async ({
            flowId,
            flowVersion,
            task,
            highlights,
            outputDir,
            fileName,
            png,
            scale,
            webFont,
            graph,
        }) => {
            if (!path.isAbsolute(outputDir)) {
                return err(
                    `outputDir must be an absolute path; got "${outputDir}".`,
                );
            }
            const highlightMap: Record<string, string> = {};
            for (const h of highlights ?? []) {
                if (h.id in highlightMap) {
                    return err(
                        `Highlight id "${h.id}" is given more than once; pass each action once, with one tag.`,
                    );
                }
                highlightMap[h.id] = h.tag ?? "";
            }

            let flow: DiagramFlow;
            let ir: FlowIR | undefined;
            let diagram: TaskDiagram | undefined;
            let drawn: { id: string; name: string; entry: boolean } | undefined;
            let configuration: ConfigurationSource | undefined;
            let publishedVersion:
                | Promise<string | null | undefined>
                | undefined;

            if (graph !== undefined) {
                if (
                    flowId !== undefined ||
                    flowVersion !== undefined ||
                    task !== undefined
                ) {
                    return err(
                        "Pass either a graph to draw a sketch, or a flowId (with optional " +
                            "flowVersion and task) to draw a flow, not both.",
                    );
                }
                let parsedGraph: unknown = graph;
                if (typeof graph === "string") {
                    try {
                        parsedGraph = JSON.parse(graph);
                    } catch (e) {
                        return err(
                            `graph is not valid JSON: ${(e as Error).message}. Pass the graph as an ` +
                                'object, or as a JSON string of the shape {"start": true, "chain": [...]}.',
                        );
                    }
                }
                try {
                    flow = diagramFromGraph(parsedGraph as DiagramGraphJson);
                } catch (e) {
                    return err(
                        `graph is not a drawable hand-written graph: ${(e as Error).message}`,
                    );
                }
            } else {
                if (!flowId)
                    return err(
                        "Pass a flowId to draw a flow, or a graph to draw a sketch.",
                    );
                // best effort, alongside the configuration fetch: the delivery line
                // wants "latest configuration (published version X)", which only
                // applies when drawing the latest configuration
                publishedVersion = flowVersion
                    ? undefined
                    : architectApi.getFlow(flowId).then(
                          (meta) =>
                              meta.publishedVersion?.commitVersion ?? null,
                          () => undefined,
                      );
                const fetched = await fetchFlowConfiguration(
                    architectApi,
                    flowId,
                    flowVersion,
                );
                if (!fetched.ok) return err(fetched.message);
                const parsed = parseFlow(fetched.configuration);
                if (!parsed.ok) {
                    return err(
                        `Failed to parse flow "${flowId}" (${parsed.error.code}): ${parsed.error.message}`,
                    );
                }
                ir = parsed.ir;
                configuration = fetched.source;

                const wanted = task ?? ir.entryTaskId;
                if (!wanted) {
                    return err(
                        `Flow "${flowId}" declares no entry task; pass \`task\`. Available tasks: ` +
                            `${ir.tasks.map((t) => t.name).join(", ") || "(none)"}.`,
                    );
                }
                const byId = ir.tasks.filter((t) => t.id === wanted);
                const byName =
                    byId.length > 0
                        ? byId
                        : ir.tasks.filter((t) => isExactNameMatch(t, wanted));
                if (byName.length === 0) {
                    return err(
                        `No task matching "${wanted}" in flow "${flowId}". Available tasks: ` +
                            `${ir.tasks.map((t) => t.name).join(", ") || "(none)"}.`,
                    );
                }
                if (byName.length > 1) {
                    return err(
                        `Task name "${wanted}" is ambiguous in flow "${flowId}". It matches ` +
                            `${byName.map((t) => `"${t.name}" (id: ${t.id})`).join(", ")}. Retry with the task id.`,
                    );
                }
                const target = byName[0] as (typeof ir.tasks)[number];
                drawn = {
                    id: target.id,
                    name: target.name,
                    entry: target.id === ir.entryTaskId,
                };

                diagram = diagramForTask(ir, fetched.configuration, target.id);
                flow = diagram.flow;
            }

            const placement = layoutDiagram(flow);
            let svg: string;
            try {
                svg = diagramToSvg(placement, {
                    webFont,
                    highlights: highlightMap,
                });
            } catch (e) {
                if (!(e instanceof DiagramHighlightError)) throw e;
                if (!diagram) {
                    return err(
                        `Highlighted action(s) not in the sketch: ${e.missing.join(", ")}. ` +
                            "Use the id of an action in the graph.",
                    );
                }
                const taskDiagram = diagram;
                const where = e.missing.map((id) => {
                    const at = locate(taskDiagram, id);
                    return at
                        ? `${id} is in task ${at}`
                        : `${id} is not in this flow`;
                });
                return err(
                    `Highlighted action(s) not in the drawn task "${drawn?.name}": ${where.join("; ")}. ` +
                        "Draw that task instead, or drop the highlight.",
                );
            }

            const base =
                fileName ?? slug(drawn?.name ?? flow.title ?? "sketch");
            await mkdir(outputDir, { recursive: true });
            const svgPath = path.join(outputDir, `${base}.svg`);
            const pngPath = path.join(outputDir, `${base}.png`);
            await writeFile(svgPath, svg, "utf8");

            const notes: string[] = [];
            let raster: RasterResult | undefined;
            if (png) {
                try {
                    raster = await rasteriser.toPng(svg, pngPath, scale);
                } catch (e) {
                    notes.push(
                        `PNG rasterising failed: ${(e as Error).message}. The SVG was written ` +
                            "and is self-contained; deliver it inline or in an HTML page.",
                    );
                }
            }

            const standIns = diagram?.standIns ?? [];
            const hiddenOutputs = diagram?.hiddenOutputs ?? [];
            if (standIns.length > 0) {
                notes.push(
                    "standIns lists actions whose look was not settled against an editor " +
                        "capture: drawn with the nearest icon (or a gear and the IR's " +
                        "description for an unknown type). Say so when delivering the picture.",
                );
            }
            const missingRaw = diagram?.missingConfiguration ?? 0;
            if (missingRaw > 0) {
                notes.push(
                    `${missingRaw} action(s) have no raw configuration and render with a "?" badge and empty body.`,
                );
            }
            if (Object.keys(highlightMap).length > 0) {
                notes.push(
                    "The red outline and tag are this renderer's addition, not an editor feature.",
                );
            }
            if (hiddenOutputs.length > 0) {
                notes.push(
                    "hiddenOutputs lists outputs switched off in the flow (outOfService or " +
                        "disabled); the editor hides them and so does the picture, though flow_ir " +
                        "still lists them.",
                );
            }

            const boxes = placement.boxes
                .filter((b) => b.kind === "node" && b.action)
                .map((b) => ({
                    badge: b.action?.id,
                    actionId: b.action?.ref ?? null,
                    title: b.action?.title,
                    kind: b.action?.kind,
                    x: b.x,
                    y: b.y,
                    width: b.w,
                    height: b.h,
                    bottom: boxBottom(b),
                }));

            const published = await publishedVersion;
            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({
                            ...(flowId ? { flowId } : {}),
                            ...(ir
                                ? {
                                      flowName: ir.flowName,
                                      flowType: ir.flowType,
                                  }
                                : {}),
                            ...(configuration
                                ? {
                                      configuration,
                                      configurationDescription:
                                          describeConfiguration(configuration),
                                  }
                                : {}),
                            ...(published !== undefined
                                ? { publishedVersion: published }
                                : {}),
                            ...(drawn ? { task: drawn } : { sketch: true }),
                            ...(ir
                                ? {
                                      tasks: ir.tasks.map((t) => ({
                                          id: t.id,
                                          name: t.name,
                                          entry: t.id === ir?.entryTaskId,
                                          reusable: t.reusable,
                                      })),
                                  }
                                : {}),
                            svgPath,
                            pngPath: raster ? pngPath : null,
                            rasteriser: raster?.rasteriser ?? null,
                            width: Math.round(placement.width),
                            height: Math.round(placement.height),
                            scale,
                            ...(raster
                                ? {
                                      pngWidth: raster.width,
                                      pngHeight: raster.height,
                                  }
                                : {}),
                            highlighted: Object.keys(highlightMap),
                            standIns,
                            hiddenOutputs,
                            boxes,
                            ...(notes.length > 0 ? { notes } : {}),
                        }),
                    },
                ],
            };
        },
    };
};
