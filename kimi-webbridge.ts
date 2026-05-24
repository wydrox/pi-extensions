import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

const TOOL_PREFIX = "webbridge";
const DEFAULT_BASE_URL = "http://127.0.0.1:10086";
const DEFAULT_SESSION = "pi";
const DEFAULT_SCREENSHOT_DIR = join(tmpdir(), "kimi-webbridge-screenshots");
const DEFAULT_CLI_PATH = "~/.kimi-webbridge/bin/kimi-webbridge";
const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const PROJECT_SETTINGS_PATH = join(process.cwd(), ".pi", "settings.json");

const SESSION_PROP = {
	session: Type.Optional(
		Type.String({
			description: `WebBridge session/tab-group name. Defaults to '${DEFAULT_SESSION}'. Use distinct names for parallel sites.`,
		}),
	),
};

const STATUS_PARAMS = Type.Object({});
const SNAPSHOT_PARAMS = Type.Object({ ...SESSION_PROP });
const CLOSE_SESSION_PARAMS = Type.Object({ ...SESSION_PROP });
const LIST_TABS_PARAMS = Type.Object({ ...SESSION_PROP });
const CLOSE_TAB_PARAMS = Type.Object({ ...SESSION_PROP });

const NAVIGATE_PARAMS = Type.Object({
	url: Type.String({ description: "URL to open" }),
	newTab: Type.Optional(Type.Boolean({ description: "Open in a new tab. Use true on the first call for a task." })),
	group_title: Type.Optional(Type.String({ description: "Visible browser tab-group label" })),
	...SESSION_PROP,
});

const FIND_TAB_PARAMS = Type.Object({
	url: Type.String({ description: "URL or domain to match among existing tabs" }),
	active: Type.Optional(Type.Boolean({ description: "When true, prefer the tab the user is currently viewing" })),
	...SESSION_PROP,
});

const CLICK_PARAMS = Type.Object({
	selector: Type.String({ description: "Snapshot @e ref or CSS selector to click" }),
	...SESSION_PROP,
});

const FILL_PARAMS = Type.Object({
	selector: Type.String({ description: "Snapshot @e ref or CSS selector for an input, textarea, or contenteditable element" }),
	value: Type.String({ description: "Text value to insert; replaces existing content" }),
	...SESSION_PROP,
});

const EVALUATE_PARAMS = Type.Object({
	code: Type.String({ description: "JavaScript to evaluate in the current page. Supports async/await." }),
	...SESSION_PROP,
});

const SCREENSHOT_PARAMS = Type.Object({
	format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")], { description: "Image format; default png" })),
	quality: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: "JPEG quality; ignored by PNG" })),
	selector: Type.Optional(Type.String({ description: "Optional @e ref or CSS selector to capture only one element" })),
	outputPath: Type.Optional(Type.String({ description: "Optional file path. Relative paths resolve from the current project cwd." })),
	...SESSION_PROP,
});

const NETWORK_PARAMS = Type.Object({
	cmd: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("list"), Type.Literal("detail")], { description: "Network recorder command" }),
	filter: Type.Optional(Type.String({ description: "Optional URL/content filter for list/detail commands" })),
	requestId: Type.Optional(Type.String({ description: "Request id for detail command" })),
	...SESSION_PROP,
});

const UPLOAD_PARAMS = Type.Object({
	selector: Type.String({ description: "Snapshot @e ref or CSS selector for a file input" }),
	files: Type.Array(Type.String({ description: "File path to upload. Relative paths resolve from the current project cwd." }), {
		description: "Files to upload",
	}),
	...SESSION_PROP,
});

const SAVE_PDF_PARAMS = Type.Object({
	paper_format: Type.Optional(
		Type.Union([Type.Literal("letter"), Type.Literal("a4"), Type.Literal("legal"), Type.Literal("a3"), Type.Literal("tabloid")], {
			description: "Paper format",
		}),
	),
	landscape: Type.Optional(Type.Boolean({ description: "Use landscape orientation" })),
	scale: Type.Optional(Type.Number({ minimum: 0.1, maximum: 2.0, description: "Print scale" })),
	print_background: Type.Optional(Type.Boolean({ description: "Keep background colors/images" })),
	file_name: Type.Optional(Type.String({ description: "Output PDF filename under the daemon PDF directory" })),
	...SESSION_PROP,
});

type WebBridgeSettings = {
	baseUrl?: string;
	defaultSession?: string;
	screenshotDir?: string;
	cliPath?: string;
};

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
	isError?: boolean;
};

function readJsonFile(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function readSettingsFile(path: string): WebBridgeSettings {
	const parsed = readJsonFile(path);
	const value = parsed.kimiWebBridge ?? parsed.kimiWebbridge ?? parsed.webbridge ?? parsed.webBridge;
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const typed = value as Record<string, unknown>;
	return {
		baseUrl: typeof typed.baseUrl === "string" ? typed.baseUrl.trim() : undefined,
		defaultSession: typeof typed.defaultSession === "string" ? typed.defaultSession.trim() : undefined,
		screenshotDir: typeof typed.screenshotDir === "string" ? typed.screenshotDir.trim() : undefined,
		cliPath: typeof typed.cliPath === "string" ? typed.cliPath.trim() : undefined,
	};
}

function getSettings(): Required<WebBridgeSettings> {
	const merged = {
		...readSettingsFile(GLOBAL_SETTINGS_PATH),
		...readSettingsFile(PROJECT_SETTINGS_PATH),
	};

	return {
		baseUrl: normalizeBaseUrl(merged.baseUrl || DEFAULT_BASE_URL),
		defaultSession: merged.defaultSession || DEFAULT_SESSION,
		screenshotDir: expandHome(merged.screenshotDir || DEFAULT_SCREENSHOT_DIR),
		cliPath: expandHome(merged.cliPath || DEFAULT_CLI_PATH),
	};
}

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "") || DEFAULT_BASE_URL;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function resolveUserPath(cwd: string, path: string): string {
	const expanded = expandHome(path.trim());
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded.replace(/^@/, ""));
}

function normalizeSession(input: unknown, settings: Required<WebBridgeSettings>): string | undefined {
	const session = typeof input === "string" && input.trim() ? input.trim() : settings.defaultSession;
	return session || undefined;
}

function buildPayload(action: string, args: Record<string, unknown>, session?: string) {
	const payload: Record<string, unknown> = { action, args };
	if (session) payload.session = session;
	return payload;
}

async function fetchJson(url: string, init: RequestInit | undefined, signal?: AbortSignal): Promise<unknown> {
	const response = await fetch(url, { ...init, signal });
	const raw = await response.text();
	let parsed: unknown = raw;
	try {
		parsed = raw ? JSON.parse(raw) : {};
	} catch {
		// Keep raw text for diagnostics.
	}

	if (!response.ok) {
		const message = typeof parsed === "string" ? parsed : JSON.stringify(sanitizeForOutput(parsed));
		throw new Error(`HTTP ${response.status}: ${truncate(message || response.statusText, 1200)}`);
	}

	return parsed;
}

async function getHttpStatus(settings: Required<WebBridgeSettings>, signal?: AbortSignal): Promise<unknown> {
	return fetchJson(`${settings.baseUrl}/status`, { method: "GET" }, signal);
}

async function getStatus(pi: ExtensionAPI, settings: Required<WebBridgeSettings>, signal?: AbortSignal): Promise<{ status?: unknown; source: string; error?: string }> {
	try {
		return { status: await getHttpStatus(settings, signal), source: `${settings.baseUrl}/status` };
	} catch (httpError) {
		const httpMessage = httpError instanceof Error ? httpError.message : String(httpError);

		if (!existsSync(settings.cliPath)) {
			return {
				source: `${settings.baseUrl}/status`,
				error: `${httpMessage}\n\nKimi WebBridge is not reachable. Expected CLI at ${settings.cliPath}. Install/start it or configure kimiWebBridge.baseUrl / cliPath in settings.`,
			};
		}

		try {
			const cli = await pi.exec(settings.cliPath, ["status"], { timeout: 15000, signal });
			const raw = (cli.stdout || cli.stderr || "").trim();
			let status: unknown = raw;
			try {
				status = raw ? JSON.parse(raw) : {};
			} catch {
				// Keep raw text.
			}
			return {
				status,
				source: `${settings.cliPath} status`,
				error: cli.code === 0 ? undefined : `CLI exited with code ${cli.code}: ${truncate(raw, 1200)}`,
			};
		} catch (cliError) {
			const cliMessage = cliError instanceof Error ? cliError.message : String(cliError);
			return {
				source: `${settings.baseUrl}/status`,
				error: `${httpMessage}\n\nCLI fallback failed (${settings.cliPath} status): ${cliMessage}`,
			};
		}
	}
}

async function postCommand(
	settings: Required<WebBridgeSettings>,
	action: string,
	args: Record<string, unknown>,
	session: string | undefined,
	signal?: AbortSignal,
): Promise<unknown> {
	try {
		const response = await fetchJson(
			`${settings.baseUrl}/command`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(buildPayload(action, args, session)),
			},
			signal,
		);

		if (response && typeof response === "object" && !Array.isArray(response) && "ok" in response) {
			const wrapped = response as Record<string, unknown>;
			if (wrapped.ok === false) {
				throw new Error(formatUnknown(wrapped.error ?? wrapped.message ?? wrapped, 1200));
			}
			if ("data" in wrapped) return wrapped.data;
		}

		return response;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			[
				`Kimi WebBridge command '${action}' failed: ${message}`,
				`Check status with webbridge_status. If it is not running, start it with: ${settings.cliPath} start`,
				"If the browser extension is disconnected/outdated, update or reconnect Kimi WebBridge: https://kimi.com/features/webbridge",
			].join("\n"),
		);
	}
}

function commandArgs(params: Record<string, unknown>, omit: string[] = ["session"]): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	const omitted = new Set(omit);
	for (const [key, value] of Object.entries(params)) {
		if (omitted.has(key) || value === undefined) continue;
		output[key] = value;
	}
	return output;
}

function truncate(text: string, maxChars = 30000): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n...[truncated ${text.length - maxChars} chars]`;
}

function sanitizeForOutput(value: unknown, maxString = 10000, depth = 0): unknown {
	if (depth > 5) return "[Max depth reached]";
	if (typeof value === "string") return truncate(value, maxString);
	if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
	if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeForOutput(item, maxString, depth + 1));
	if (typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			if (key === "data" && typeof entry === "string" && entry.length > 1000) {
				output[key] = `[base64 omitted, ${entry.length} chars]`;
			} else {
				output[key] = sanitizeForOutput(entry, key === "tree" ? 30000 : maxString, depth + 1);
			}
		}
		return output;
	}
	return String(value);
}

function formatUnknown(value: unknown, maxChars = 30000): string {
	if (typeof value === "string") return truncate(value, maxChars);
	return truncate(JSON.stringify(sanitizeForOutput(value), null, 2), maxChars);
}

function formatCommandResult(action: string, result: unknown): ToolResult {
	const sanitized = sanitizeForOutput(result);
	return {
		content: [{ type: "text", text: `${TOOL_PREFIX}_${action} result:\n${formatUnknown(sanitized)}` }],
		details: { action, result: sanitized },
	};
}

function formatError(error: unknown, details?: Record<string, unknown>): ToolResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [{ type: "text", text: message }],
		details: { ...details, error: message },
		isError: true,
	};
}

function statusSummary(status: unknown, source: string): string {
	if (!status || typeof status !== "object") return `Kimi WebBridge status from ${source}:\n${formatUnknown(status)}`;
	const typed = status as Record<string, unknown>;
	const lines = [`Kimi WebBridge status from ${source}:`];
	for (const key of ["running", "extension_connected", "version", "extension_version", "port", "uptime_seconds", "extension_id"]) {
		if (typed[key] !== undefined) lines.push(`${key}: ${String(typed[key])}`);
	}
	const extraKeys = Object.keys(typed).filter(
		(key) => !["running", "extension_connected", "version", "extension_version", "port", "uptime_seconds", "extension_id"].includes(key),
	);
	if (extraKeys.length > 0) lines.push(`extra: ${extraKeys.join(", ")}`);
	return lines.join("\n");
}

function safeName(input: string | undefined, fallback: string): string {
	const cleaned = (input || fallback).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned || fallback;
}

function imageExtension(format: string): string {
	return format === "jpeg" ? "jpg" : "png";
}

function decodeBase64Data(value: string): Buffer {
	const stripped = value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
	return Buffer.from(stripped, "base64");
}

function sharedGuidelines(action?: string): string[] {
	const base = [
		"Use webbridge_status before the first WebBridge action in a task; proceed only when running and extension_connected are true.",
		"Use explicit sessions to isolate unrelated sites, and close with webbridge_close_session when the task is done unless the user wants tabs kept open.",
		"Prefer webbridge_snapshot for reading and locating elements; use screenshot only when visual inspection is necessary.",
	];
	if (action === "evaluate") {
		base.push("Wrap JavaScript in an IIFE when declaring const/let across repeated calls, and return compact JSON.stringify(data) for large structured data.");
	}
	return base;
}

function registerCommandTool(
	pi: ExtensionAPI,
	spec: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		action: string;
		guidelines?: string[];
		mapArgs?: (params: Record<string, unknown>, cwd: string) => Record<string, unknown>;
	},
) {
	pi.registerTool({
		name: `${TOOL_PREFIX}_${spec.name}`,
		label: spec.label,
		description: spec.description,
		promptSnippet: spec.description,
		promptGuidelines: spec.guidelines ?? sharedGuidelines(spec.action),
		parameters: spec.parameters,
		async execute(_toolCallId, params: Record<string, unknown>, signal, onUpdate, ctx) {
			const settings = getSettings();
			const session = normalizeSession(params.session, settings);
			const args = spec.mapArgs ? spec.mapArgs(params, ctx.cwd) : commandArgs(params);
			try {
				onUpdate?.({ content: [{ type: "text", text: `Kimi WebBridge: ${spec.action}...` }], details: { action: spec.action, session } });
				const result = await postCommand(settings, spec.action, args, session, signal);
				return formatCommandResult(spec.action, result);
			} catch (error) {
				return formatError(error, { action: spec.action, session, args: sanitizeForOutput(args) as Record<string, unknown> });
			}
		},
	});
}

export default function kimiWebBridgeExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: `${TOOL_PREFIX}_status`,
		label: "Kimi WebBridge Status",
		description: "Check Kimi WebBridge daemon and browser extension status",
		promptSnippet: "Check Kimi WebBridge status before controlling the user's real browser.",
		promptGuidelines: sharedGuidelines(),
		parameters: STATUS_PARAMS,
		async execute(_toolCallId, _params, signal) {
			const settings = getSettings();
			const result = await getStatus(pi, settings, signal);
			if (result.error) return formatError(new Error(result.error), { source: result.source, status: sanitizeForOutput(result.status) });
			return {
				content: [{ type: "text", text: statusSummary(result.status, result.source) }],
				details: { source: result.source, status: sanitizeForOutput(result.status) },
			};
		},
	});

	registerCommandTool(pi, {
		name: "navigate",
		label: "Kimi WebBridge Navigate",
		description: "Open a URL in the user's browser through Kimi WebBridge",
		parameters: NAVIGATE_PARAMS,
		action: "navigate",
		guidelines: [
			...sharedGuidelines("navigate"),
			"Always use newTab:true on the first navigation for a task. Use group_title to label the browser tab group when useful.",
		],
	});

	registerCommandTool(pi, {
		name: "find_tab",
		label: "Kimi WebBridge Find Tab",
		description: "Reuse an already-open browser tab matching a URL or domain",
		parameters: FIND_TAB_PARAMS,
		action: "find_tab",
	});

	registerCommandTool(pi, {
		name: "snapshot",
		label: "Kimi WebBridge Snapshot",
		description: "Read the current page accessibility tree with stable @e element refs",
		parameters: SNAPSHOT_PARAMS,
		action: "snapshot",
	});

	registerCommandTool(pi, {
		name: "click",
		label: "Kimi WebBridge Click",
		description: "Click an element by snapshot @e ref or CSS selector",
		parameters: CLICK_PARAMS,
		action: "click",
	});

	registerCommandTool(pi, {
		name: "fill",
		label: "Kimi WebBridge Fill",
		description: "Fill an input, textarea, or contenteditable element by @e ref or CSS selector",
		parameters: FILL_PARAMS,
		action: "fill",
	});

	registerCommandTool(pi, {
		name: "evaluate",
		label: "Kimi WebBridge Evaluate",
		description: "Evaluate JavaScript in the current browser page",
		parameters: EVALUATE_PARAMS,
		action: "evaluate",
	});

	pi.registerTool({
		name: `${TOOL_PREFIX}_screenshot`,
		label: "Kimi WebBridge Screenshot",
		description: "Capture a page or element screenshot via Kimi WebBridge and save it to disk instead of returning base64",
		promptSnippet: "Capture screenshots through Kimi WebBridge; the tool saves images to disk and returns a path.",
		promptGuidelines: sharedGuidelines("screenshot"),
		parameters: SCREENSHOT_PARAMS,
		async execute(_toolCallId, params: Record<string, unknown>, signal, onUpdate, ctx) {
			const settings = getSettings();
			const session = normalizeSession(params.session, settings);
			const format = params.format === "jpeg" ? "jpeg" : "png";
			const args = commandArgs({ ...params, format }, ["session", "outputPath"]);
			try {
				onUpdate?.({ content: [{ type: "text", text: "Kimi WebBridge: screenshot..." }], details: { action: "screenshot", session } });
				const result = await postCommand(settings, "screenshot", args, session, signal);
				if (!result || typeof result !== "object" || typeof (result as Record<string, unknown>).data !== "string") {
					throw new Error(`Screenshot response did not include base64 image data: ${formatUnknown(result, 1000)}`);
				}

				const response = result as Record<string, unknown>;
				const outputPath =
					typeof params.outputPath === "string" && params.outputPath.trim()
						? resolveUserPath(ctx.cwd, params.outputPath)
						: join(
							settings.screenshotDir,
							`${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName(session, DEFAULT_SESSION)}.${imageExtension(format)}`,
						);
				mkdirSync(dirname(outputPath), { recursive: true });
				writeFileSync(outputPath, decodeBase64Data(response.data as string));

				const sanitized = sanitizeForOutput({ ...response, data: undefined, path: outputPath });
				return {
					content: [
						{
							type: "text",
							text: `Screenshot saved: ${outputPath}\n${formatUnknown(sanitized, 2000)}`,
						},
					],
					details: { action: "screenshot", session, path: outputPath, result: sanitized },
				};
			} catch (error) {
				return formatError(error, { action: "screenshot", session, args: sanitizeForOutput(args) as Record<string, unknown> });
			}
		},
	});

	registerCommandTool(pi, {
		name: "network",
		label: "Kimi WebBridge Network",
		description: "Start, stop, list, or inspect captured network requests for the current WebBridge tab",
		parameters: NETWORK_PARAMS,
		action: "network",
	});

	registerCommandTool(pi, {
		name: "upload",
		label: "Kimi WebBridge Upload",
		description: "Upload local files to a file input in the current browser page",
		parameters: UPLOAD_PARAMS,
		action: "upload",
		mapArgs: (params, cwd) => ({
			selector: params.selector,
			files: Array.isArray(params.files) ? params.files.map((file) => (typeof file === "string" ? resolveUserPath(cwd, file) : file)) : [],
		}),
	});

	registerCommandTool(pi, {
		name: "save_pdf",
		label: "Kimi WebBridge Save PDF",
		description: "Render the current browser page as a PDF via Kimi WebBridge",
		parameters: SAVE_PDF_PARAMS,
		action: "save_as_pdf",
	});

	registerCommandTool(pi, {
		name: "list_tabs",
		label: "Kimi WebBridge List Tabs",
		description: "List browser tabs known to the current WebBridge session",
		parameters: LIST_TABS_PARAMS,
		action: "list_tabs",
	});

	registerCommandTool(pi, {
		name: "close_tab",
		label: "Kimi WebBridge Close Tab",
		description: "Close the current tab in the current WebBridge session",
		parameters: CLOSE_TAB_PARAMS,
		action: "close_tab",
	});

	registerCommandTool(pi, {
		name: "close_session",
		label: "Kimi WebBridge Close Session",
		description: "Close all tabs in the current WebBridge session",
		parameters: CLOSE_SESSION_PARAMS,
		action: "close_session",
	});

	pi.registerCommand("webbridge", {
		description: "Kimi WebBridge helper: /webbridge status|help",
		getArgumentCompletions: (prefix) => ["status", "help"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const subcommand = args.trim().toLowerCase() || "status";
			if (subcommand === "help") {
				ctx.ui.notify(
					[
						"Kimi WebBridge tools: webbridge_status, webbridge_navigate, webbridge_find_tab, webbridge_snapshot, webbridge_click, webbridge_fill, webbridge_evaluate, webbridge_screenshot, webbridge_network, webbridge_upload, webbridge_save_pdf, webbridge_list_tabs, webbridge_close_tab, webbridge_close_session.",
						"Use webbridge_status first. Screenshots are saved to disk to avoid base64 flooding.",
					].join("\n"),
					"info",
				);
				return;
			}

			if (subcommand !== "status") {
				ctx.ui.notify("Usage: /webbridge status|help", "warning");
				return;
			}

			const settings = getSettings();
			const result = await getStatus(pi, settings);
			if (result.error) {
				ctx.ui.notify(result.error, "error");
				return;
			}
			ctx.ui.notify(statusSummary(result.status, result.source), "info");
		},
	});
}
