import { Buffer } from "node:buffer";
import process from "node:process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const FIGMA_API_BASE = "https://api.figma.com/v1";
const DEFAULT_DEPTH = 3;
const DEFAULT_MAX_CHILDREN = 12;
const DEFAULT_PREVIEW_SCALE = 2;
const MAX_TEXT_LENGTH = 280;

const FIGMA_TOOL_PARAMS = Type.Object({
	url: Type.Optional(
		Type.String({
			description: "Figma file, frame, or node URL. Prefer a frame/node URL when implementing a specific UI.",
		}),
	),
	fileKey: Type.Optional(Type.String({ description: "Figma file key. Use when URL is not available." })),
	nodeId: Type.Optional(Type.String({ description: "Figma node id, e.g. 1:2. Optional when URL already includes node-id." })),
	depth: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 5,
			description: "Tree depth to fetch. Default 3. Use smaller depth to keep context lean.",
		}),
	),
	maxChildren: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 40,
			description: "Maximum children to include per node in the summarized output. Default 12.",
		}),
	),
	includePreview: Type.Optional(
		Type.Boolean({
			description: "When true, attach a rendered preview image for a specific node/frame if available.",
		}),
	),
	previewScale: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 4,
			description: "Preview render scale. Default 2.",
		}),
	),
	includeRaw: Type.Optional(
		Type.Boolean({
			description: "When true, include a trimmed raw JSON payload after the summarized design context.",
		}),
	),
});

type ToolParams = {
	url?: string;
	fileKey?: string;
	nodeId?: string;
	depth?: number;
	maxChildren?: number;
	includePreview?: boolean;
	previewScale?: number;
	includeRaw?: boolean;
};

type ResolvedTarget = {
	fileKey: string;
	nodeId?: string;
	source: "url" | "params";
	originalUrl?: string;
};

function cleanObject<T extends Record<string, unknown>>(obj: T): T {
	for (const key of Object.keys(obj) as Array<keyof T>) {
		const value = obj[key];
		if (
			value === undefined ||
			value === null ||
			(Array.isArray(value) && value.length === 0) ||
			(typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0)
		) {
			delete obj[key];
		}
	}
	return obj;
}

function round(value: unknown, digits = 1): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function clampText(value: unknown, max = MAX_TEXT_LENGTH): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.replace(/\s+/g, " ").trim();
	if (!trimmed) return undefined;
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max - 1)}…`;
}

function normalizeNodeId(nodeId?: string): string | undefined {
	if (!nodeId) return undefined;
	const decoded = decodeURIComponent(nodeId).trim();
	if (!decoded) return undefined;
	if (decoded.includes(":")) return decoded;
	if (decoded.includes("-")) return decoded.replace(/-/g, ":");
	return decoded;
}

function parseFigmaUrl(raw: string): ResolvedTarget | undefined {
	try {
		const url = new URL(raw.trim());
		if (!url.hostname.includes("figma.com")) return undefined;

		const match = url.pathname.match(/\/(?:file|design|proto|board)\/([a-zA-Z0-9]+)(?:\/|$)/);
		const fileKey = match?.[1];
		if (!fileKey) return undefined;

		const nodeId = normalizeNodeId(url.searchParams.get("node-id") || undefined);
		return {
			fileKey,
			nodeId,
			source: "url",
			originalUrl: raw,
		};
	} catch {
		return undefined;
	}
}

function resolveTarget(params: ToolParams): ResolvedTarget {
	if (params.url) {
		const parsed = parseFigmaUrl(params.url);
		if (!parsed) {
			throw new Error("Could not parse the Figma URL. Pass a full figma.com file/design URL or use fileKey/nodeId.");
		}
		if (params.nodeId && !parsed.nodeId) parsed.nodeId = normalizeNodeId(params.nodeId);
		return parsed;
	}

	if (!params.fileKey) {
		throw new Error("Missing Figma target. Pass url or fileKey.");
	}

	return {
		fileKey: params.fileKey.trim(),
		nodeId: normalizeNodeId(params.nodeId),
		source: "params",
	};
}

function getApiKey(): string {
	const apiKey = process.env.FIGMA_API_KEY?.trim();
	if (!apiKey) {
		throw new Error(
			"FIGMA_API_KEY is not set. Export a personal access token before using the Figma extension.",
		);
	}
	return apiKey;
}

async function figmaRequest(path: string, apiKey: string, signal?: AbortSignal): Promise<any> {
	const response = await fetch(`${FIGMA_API_BASE}${path}`, {
		headers: {
			"X-Figma-Token": apiKey,
			"Content-Type": "application/json",
		},
		signal,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Figma API request failed (${response.status}): ${text.slice(0, 1200)}`);
	}

	return response.json();
}

function colorToHex(color: any, opacity?: number): string | undefined {
	if (!color || typeof color.r !== "number" || typeof color.g !== "number" || typeof color.b !== "number") {
		return undefined;
	}
	const toChannel = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
	const hex = [toChannel(color.r), toChannel(color.g), toChannel(color.b)]
		.map((v) => v.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase();
	const alpha = typeof opacity === "number" && opacity < 1 ? Math.round(opacity * 100) : undefined;
	return alpha !== undefined ? `#${hex} @ ${alpha}%` : `#${hex}`;
}

function summarizePaint(paint: any): any {
	if (!paint || paint.visible === false) return undefined;
	const type = typeof paint.type === "string" ? paint.type : undefined;
	if (!type) return undefined;

	if (type === "SOLID") {
		return cleanObject({
			type,
			color: colorToHex(paint.color, typeof paint.opacity === "number" ? paint.opacity : 1),
		});
	}

	if (type.startsWith("GRADIENT")) {
		return cleanObject({
			type,
			stops: Array.isArray(paint.gradientStops)
				? paint.gradientStops.slice(0, 5).map((stop: any) =>
						cleanObject({
							position: round(stop.position, 2),
							color: colorToHex(stop.color, stop.color?.a),
						}),
				  )
				: undefined,
		});
	}

	if (type === "IMAGE") {
		return cleanObject({
			type,
			scaleMode: paint.scaleMode,
			imageRef: paint.imageRef ? "image-ref" : undefined,
		});
	}

	return cleanObject({ type });
}

function summarizeEffects(effects: any[]): any[] | undefined {
	if (!Array.isArray(effects)) return undefined;
	const summarized = effects
		.filter((effect) => effect && effect.visible !== false)
		.slice(0, 6)
		.map((effect) =>
			cleanObject({
				type: effect.type,
				radius: round(effect.radius),
				color: colorToHex(effect.color, effect.color?.a),
				offset:
					effect.offset && (typeof effect.offset.x === "number" || typeof effect.offset.y === "number")
						? cleanObject({ x: round(effect.offset.x), y: round(effect.offset.y) })
						: undefined,
			}),
		);
	return summarized.length > 0 ? summarized : undefined;
}

function summarizeLayout(node: any): any {
	return cleanObject({
		layoutMode: node.layoutMode,
		primaryAxisSizingMode: node.primaryAxisSizingMode,
		counterAxisSizingMode: node.counterAxisSizingMode,
		primaryAxisAlignItems: node.primaryAxisAlignItems,
		counterAxisAlignItems: node.counterAxisAlignItems,
		itemSpacing: round(node.itemSpacing),
		layoutWrap: node.layoutWrap,
		layoutAlign: node.layoutAlign,
		layoutGrow: round(node.layoutGrow),
		padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].some(
			(v) => typeof v === "number",
		)
			? cleanObject({
				top: round(node.paddingTop),
				right: round(node.paddingRight),
				bottom: round(node.paddingBottom),
				left: round(node.paddingLeft),
			})
			: undefined,
		constraints: node.constraints
			? cleanObject({ horizontal: node.constraints.horizontal, vertical: node.constraints.vertical })
			: undefined,
	});
}

function summarizeText(node: any): any {
	if (node.type !== "TEXT" && !node.characters) return undefined;
	const style = node.style || {};
	return cleanObject({
		content: clampText(node.characters),
		fontFamily: style.fontFamily,
		fontWeight: style.fontWeight,
		fontSize: round(style.fontSize),
		lineHeightPx: round(style.lineHeightPx),
		letterSpacing: round(style.letterSpacing),
		textAlignHorizontal: style.textAlignHorizontal,
		textAlignVertical: style.textAlignVertical,
		textCase: style.textCase,
		textDecoration: style.textDecoration,
		fills: Array.isArray(node.fills) ? node.fills.map(summarizePaint).filter(Boolean) : undefined,
	});
}

function summarizeBounds(node: any): any {
	const box = node.absoluteBoundingBox || node.absoluteRenderBounds;
	if (!box) return undefined;
	return cleanObject({
		x: round(box.x),
		y: round(box.y),
		width: round(box.width),
		height: round(box.height),
	});
}

function summarizeNode(node: any, level: number, maxDepth: number, maxChildren: number): any {
	const summary: Record<string, unknown> = {
		id: node.id,
		name: node.name,
		type: node.type,
		visible: node.visible === false ? false : undefined,
		bounds: summarizeBounds(node),
		cornerRadius: round(node.cornerRadius),
		opacity: round(node.opacity, 2),
		blendMode: node.blendMode,
		layout: summarizeLayout(node),
		fills: Array.isArray(node.fills) ? node.fills.map(summarizePaint).filter(Boolean) : undefined,
		strokes: Array.isArray(node.strokes) ? node.strokes.map(summarizePaint).filter(Boolean) : undefined,
		effects: summarizeEffects(node.effects),
		text: summarizeText(node),
		componentId: node.componentId,
		componentPropertyReferences: node.componentPropertyReferences,
	};

	if (Array.isArray(node.children) && level < maxDepth - 1) {
		summary.children = node.children
			.slice(0, maxChildren)
			.map((child: any) => summarizeNode(child, level + 1, maxDepth, maxChildren));
		if (node.children.length > maxChildren) {
			summary.childrenOmitted = node.children.length - maxChildren;
		}
	}

	return cleanObject(summary);
}

function topLevelSummary(document: any): any {
	if (!document || !Array.isArray(document.children)) return undefined;
	return document.children.slice(0, 20).map((child: any) =>
		cleanObject({
			id: child.id,
			name: child.name,
			type: child.type,
			childCount: Array.isArray(child.children) ? child.children.length : undefined,
		}),
	);
}

function trimRawPayload(value: any): any {
	if (Array.isArray(value)) {
		return value.slice(0, 20).map(trimRawPayload);
	}
	if (!value || typeof value !== "object") {
		return value;
	}
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (["componentSets", "components", "styles", "schemaVersion"].includes(key)) continue;
		if (key === "children" && Array.isArray(child)) {
			out[key] = child.slice(0, 10).map(trimRawPayload);
			continue;
		}
		out[key] = trimRawPayload(child);
	}
	return out;
}

async function fetchPreviewImage(fileKey: string, nodeId: string, scale: number, apiKey: string, signal?: AbortSignal) {
	const data = await figmaRequest(
		`/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`,
		apiKey,
		signal,
	);
	const imageUrl = data?.images?.[nodeId];
	if (!imageUrl) return undefined;

	const response = await fetch(imageUrl, { signal });
	if (!response.ok) {
		throw new Error(`Failed to download Figma preview (${response.status})`);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	return {
		mimeType: response.headers.get("content-type") || "image/png",
		data: bytes.toString("base64"),
		imageUrl,
	};
}

function buildContextText(args: {
	target: ResolvedTarget;
	fileName?: string;
	nodeName?: string;
	nodeType?: string;
	depth: number;
	maxChildren: number;
	summary: any;
	topLevel?: any;
	raw?: any;
	previewIncluded: boolean;
}): string {
	const header = [
		`Figma design context${args.nodeName ? ` for ${args.nodeName}` : ""}.`,
		`File key: ${args.target.fileKey}.`,
		args.fileName ? `File name: ${args.fileName}.` : undefined,
		args.nodeType ? `Node type: ${args.nodeType}.` : undefined,
		args.target.nodeId ? `Node id: ${args.target.nodeId}.` : undefined,
		args.target.originalUrl ? `Source URL: ${args.target.originalUrl}.` : undefined,
		`Depth: ${args.depth}. Max children per node: ${args.maxChildren}.`,
		args.previewIncluded ? "A preview image is attached." : undefined,
	]
		.filter(Boolean)
		.join(" ");

	const parts = [header, "", "Summarized context:", "```json", JSON.stringify(args.summary, null, 2), "```"];

	if (args.topLevel) {
		parts.push("", "Top-level pages/canvases:", "```json", JSON.stringify(args.topLevel, null, 2), "```");
	}

	if (args.raw) {
		parts.push("", "Trimmed raw payload:", "```json", JSON.stringify(args.raw, null, 2), "```");
	}

	return parts.join("\n");
}

export default function figmaExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "figma_get_design_context",
		label: "Figma Context",
		description:
			"Fetch structured design context from a Figma file, frame, or node URL and optionally attach a rendered preview image. Use before implementing or refining frontend UI from Figma.",
		promptSnippet: "Fetch structured design context and previews from Figma file/frame URLs.",
		promptGuidelines: [
			"When the user provides a Figma URL or asks to implement UI from Figma, call figma_get_design_context first.",
			"Prefer frame or node URLs over full-file URLs for targeted implementation work.",
			"Use the returned hierarchy, spacing, typography, and fills as implementation guidance, then map it to the codebase's actual components and styles.",
		],
		parameters: FIGMA_TOOL_PARAMS,
		async execute(_toolCallId, params: ToolParams, signal) {
			const apiKey = getApiKey();
			const target = resolveTarget(params);
			const depth = params.depth ?? DEFAULT_DEPTH;
			const maxChildren = params.maxChildren ?? DEFAULT_MAX_CHILDREN;
			const includePreview = params.includePreview ?? Boolean(target.nodeId);
			const previewScale = params.previewScale ?? DEFAULT_PREVIEW_SCALE;

			let fileResponse: any;
			let node: any;
			let fileName: string | undefined;
			let topLevel: any;
			let rawPayload: any;

			if (target.nodeId) {
				fileResponse = await figmaRequest(
					`/files/${encodeURIComponent(target.fileKey)}/nodes?ids=${encodeURIComponent(target.nodeId)}&depth=${depth}`,
					apiKey,
					signal,
				);
				fileName = fileResponse?.name;
				const entry = fileResponse?.nodes?.[target.nodeId];
				node = entry?.document;
				rawPayload = params.includeRaw ? trimRawPayload(entry) : undefined;
				if (!node) {
					throw new Error(`Node ${target.nodeId} was not found in file ${target.fileKey}.`);
				}
			} else {
				fileResponse = await figmaRequest(`/files/${encodeURIComponent(target.fileKey)}?depth=${depth}`, apiKey, signal);
				fileName = fileResponse?.name;
				node = fileResponse?.document;
				topLevel = topLevelSummary(node);
				rawPayload = params.includeRaw ? trimRawPayload(fileResponse) : undefined;
				if (!node) {
					throw new Error(`File ${target.fileKey} did not return a document tree.`);
				}
			}

			const summary = summarizeNode(node, 0, depth, maxChildren);
			let preview: Awaited<ReturnType<typeof fetchPreviewImage>> | undefined;

			if (includePreview && target.nodeId) {
				try {
					preview = await fetchPreviewImage(target.fileKey, target.nodeId, previewScale, apiKey, signal);
				} catch {
					preview = undefined;
				}
			}

			return {
				content: [
					{
						type: "text",
						text: buildContextText({
							target,
							fileName,
							nodeName: summary.name as string | undefined,
							nodeType: summary.type as string | undefined,
							depth,
							maxChildren,
							summary,
							topLevel,
							raw: rawPayload,
							previewIncluded: Boolean(preview),
						}),
					},
					...(preview ? [{ type: "image" as const, data: preview.data, mimeType: preview.mimeType }] : []),
				],
				details: cleanObject({
					fileKey: target.fileKey,
					nodeId: target.nodeId,
					fileName,
					nodeName: summary.name,
					nodeType: summary.type,
					depth,
					maxChildren,
					previewUrl: preview?.imageUrl,
				}),
			};
		},
	});

	pi.registerCommand("figma-status", {
		description: "Show Figma extension status and setup instructions",
		handler: async (_args, ctx) => {
			const hasKey = Boolean(process.env.FIGMA_API_KEY?.trim());
			ctx.ui.notify(
				[
					"Figma extension: installed",
					hasKey ? "FIGMA_API_KEY: configured" : "FIGMA_API_KEY: missing",
					"Tool: figma_get_design_context",
					"",
					"Setup:",
					"  export FIGMA_API_KEY=your_figma_personal_access_token",
					"  Then restart pi or /reload.",
					"",
					"Workflow:",
					"  Paste a Figma frame URL and ask pi to implement it.",
				].join("\n"),
				hasKey ? "info" : "warning",
			);
		},
	});
}
