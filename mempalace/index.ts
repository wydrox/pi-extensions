import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

/**
 * MemPalace + pi extension
 *
 * - Read tools: status, search, wake-up, list_wings, list_rooms, list_drawers, get_drawer, traverse, kg_query
 * - Write tools: mine, add_drawer, update_drawer, delete_drawer, kg_add, kg_invalidate
 *
 * If MemPalace is not installed globally, set MEMPALACE_SOURCE_PATH to a local checkout:
 *   /Users/you/dev/mempalace
 * If your python executable differs, set MEMPALACE_PYTHON.
 */

type ExecResult = { stdout: string; stderr: string; code: number };

type MemtoolResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
	isError?: boolean;
};

type RuntimeProbe = {
	ok: boolean;
	source: "cli" | "mcp";
	checkedWith: string;
	error?: string;
	hint?: string;
};

type AutosaveMode = "off" | "explicit" | "aggressive";

type MempalaceSettings = {
	sourcePath?: string;
	python?: string;
	bin?: string;
	palace?: string;
	autosaveMode?: AutosaveMode;
	backgroundWrites?: boolean;
	injectReminders?: boolean;
};

const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
const GLOBAL_SETTINGS_PATH = join(PI_AGENT_DIR, "settings.json");
const PROJECT_SETTINGS_PATH = join(process.cwd(), ".pi", "settings.json");
const MEMPALACE_WRITE_JOBS_DIR = join(PI_AGENT_DIR, "state", "mempalace-write-jobs");
const MEMPALACE_BACKGROUND_WRITE_ENV = "PI_MEMPALACE_BACKGROUND_WRITE";
const RUNTIME_PROBE_TTL_MS = 15_000;

const EXPLICIT_MEMORY_WRITE_RE = /(remember (this|that|for later)|save (this|that|for later|to mempalace)|store (this|that|for later|in mempalace)|persist (this|that|for later)|write (this|that) down|log this|zapamiętaj (to|to sobie)|zapamietaj (to|to sobie)|zapisz (to|to sobie|w mempalace)|zanotuj (to|to sobie)|dodaj (to )?do mempalace)/i;

const MEMORY_WRITE_SYSTEM_PROMPT = [
	"MemPalace write policy:",
	"- Write proactively when information is durable and likely to matter in future sessions, even without an explicit remember request.",
	"- Prefer not saving if future value is unclear.",
	"- Prefer one concise, normalized, self-contained note over a verbose summary or multiple overlapping notes.",
	"- Do not save transient task chatter, temporary bugs, implementation scratch notes, speculative ideas, or duplicate information already captured.",
	"- For mempalace_add_drawer, write clean notes that can be understood without the surrounding chat transcript.",
	"- For mempalace_kg_add, use short clean subject/predicate/object values; avoid paths, stack traces, and sentence fragments.",
].join("\n");

let mcpRuntimeCache: { at: number; probe: RuntimeProbe } | null = null;
let settingsCache: MempalaceSettings | null = null;

const MEMPALACE_WRITABLE_TOOL_NAMES = [
	"mempalace_mine",
	"mempalace_add_drawer",
	"mempalace_update_drawer",
	"mempalace_delete_drawer",
	"mempalace_kg_add",
	"mempalace_kg_invalidate",
];

const MEMPALACE_ASYNC_WRITE_TOOL_NAMES = new Set([
	"mempalace_mine",
	"mempalace_add_drawer",
	"mempalace_update_drawer",
	"mempalace_delete_drawer",
	"mempalace_kg_add",
] as const);

type AsyncWriteToolName = "mempalace_mine" | "mempalace_add_drawer" | "mempalace_update_drawer" | "mempalace_delete_drawer" | "mempalace_kg_add";

function resolveSettingPath(value?: string, baseDir?: string) {
	if (!value) return undefined;
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	if (isAbsolute(value)) return value;
	if (value.includes("/") || value.startsWith(".")) {
		return resolve(baseDir || process.cwd(), value);
	}
	return value;
}

function readSettingsFile(path: string, baseDir: string): MempalaceSettings {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		const mem = raw?.mempalace || {};
		return {
			sourcePath: resolveSettingPath(mem.sourcePath, baseDir),
			python: resolveSettingPath(mem.python, baseDir),
			bin: resolveSettingPath(mem.bin, baseDir),
			palace: resolveSettingPath(mem.palace, baseDir),
			autosaveMode: mem.autosaveMode,
			backgroundWrites: typeof mem.backgroundWrites === "boolean" ? mem.backgroundWrites : undefined,
			injectReminders: typeof mem.injectReminders === "boolean" ? mem.injectReminders : undefined,
		};
	} catch {
		return {};
	}
}

function getSettings(): MempalaceSettings {
	if (settingsCache) return settingsCache;
	const globalSettings = readSettingsFile(GLOBAL_SETTINGS_PATH, PI_AGENT_DIR);
	const projectSettings = readSettingsFile(PROJECT_SETTINGS_PATH, join(process.cwd(), ".pi"));
	settingsCache = { ...globalSettings, ...projectSettings };
	return settingsCache;
}

function getSourcePath() {
	return process.env.MEMPALACE_SOURCE_PATH ? resolve(process.env.MEMPALACE_SOURCE_PATH) : getSettings().sourcePath;
}

function getPythonBin() {
	if (process.env.MEMPALACE_PYTHON) return process.env.MEMPALACE_PYTHON;
	if (getSettings().python) return getSettings().python;
	const sourcePath = getSourcePath();
	if (sourcePath) {
		const venvPython = join(sourcePath, ".venv", "bin", "python");
		if (existsSync(venvPython)) return venvPython;
	}
	return "python3";
}

function getCliBin() {
	return process.env.MEMPALACE_BIN || getSettings().bin || "mempalace";
}

function getPalacePath() {
	return process.env.MEMPALACE_PALACE || getSettings().palace;
}

function getAutosaveMode(): AutosaveMode {
	const envValue = process.env.PI_MEMPALACE_AUTOSAVE_MODE?.toLowerCase();
	if (envValue === "off" || envValue === "explicit" || envValue === "aggressive") return envValue;
	return getSettings().autosaveMode || "explicit";
}

function getBackgroundWritesEnabled() {
	const envValue = process.env.PI_MEMPALACE_BACKGROUND_WRITES?.toLowerCase();
	if (envValue === "1" || envValue === "true") return true;
	if (envValue === "0" || envValue === "false") return false;
	return getSettings().backgroundWrites ?? false;
}

function getInjectRemindersEnabled() {
	const envValue = process.env.PI_MEMPALACE_INJECT_REMINDERS?.toLowerCase();
	if (envValue === "1" || envValue === "true") return true;
	if (envValue === "0" || envValue === "false") return false;
	return getSettings().injectReminders ?? false;
}

function getBaseEnv() {
	const env: NodeJS.ProcessEnv = { ...(process.env as NodeJS.ProcessEnv) };
	const sourcePath = getSourcePath();
	if (sourcePath) {
		env.PYTHONPATH = `${sourcePath}${env.PYTHONPATH ? `:${env.PYTHONPATH}` : ""}`;
	}
	const palacePath = getPalacePath();
	if (palacePath) {
		env.MEMPALACE_PALACE = palacePath;
	}
	return env;
}

function shouldQueueAsyncWrite(toolName: string) {
	return getBackgroundWritesEnabled() && MEMPALACE_ASYNC_WRITE_TOOL_NAMES.has(toolName as AsyncWriteToolName) && process.env[MEMPALACE_BACKGROUND_WRITE_ENV] !== "1";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function buildAsyncWriteWorkerSystemPrompt(toolName: AsyncWriteToolName) {
	return [
		"You are a background MemPalace write worker.",
		`You must call exactly one tool: ${toolName}.`,
		"Execute immediately with the exact JSON arguments from the user message.",
		"Do not ask questions.",
		"Do not call any other tool.",
		"After the tool call completes, reply with one short status line.",
	].join("\n");
}

function buildAsyncWriteWorkerPrompt(toolName: AsyncWriteToolName, args: Record<string, unknown>) {
	return [
		`Call ${toolName} now with these exact arguments:`,
		"```json",
		JSON.stringify(args, null, 2),
		"```",
		"Do not change any values.",
	].join("\n");
}

async function queueAsyncWriteSubagent(
	toolName: AsyncWriteToolName,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<MemtoolResult> {
	if (signal?.aborted) {
		return toolResult(`${toolName} cancelled before queueing`, { tool: toolName, queued: false }, true);
	}

	const jobId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
	const jobDir = join(MEMPALACE_WRITE_JOBS_DIR, jobId);
	mkdirSync(jobDir, { recursive: true });

	const systemPromptPath = join(jobDir, "system-prompt.md");
	const logPath = join(jobDir, "worker.log");
	const metaPath = join(jobDir, "job.json");
	writeFileSync(systemPromptPath, buildAsyncWriteWorkerSystemPrompt(toolName), "utf8");
	writeFileSync(
		metaPath,
		JSON.stringify(
			{
				jobId,
				toolName,
				queuedAt: new Date().toISOString(),
				status: "queued",
				jobDir,
				logPath,
				args,
			},
			null,
			2,
		),
		"utf8",
	);

	const invocation = getPiInvocation([
		"-p",
		"--no-session",
		"--tools",
		toolName,
		"--append-system-prompt",
		systemPromptPath,
		buildAsyncWriteWorkerPrompt(toolName, args),
	]);

	const stdoutFd = openSync(logPath, "a");
	const stderrFd = openSync(logPath, "a");
	try {
		await new Promise<void>((resolvePromise, rejectPromise) => {
			let settled = false;
			const child = spawn(invocation.command, invocation.args, {
				cwd: process.cwd(),
				env: {
					...getBaseEnv(),
					[MEMPALACE_BACKGROUND_WRITE_ENV]: "1",
					MEMPALACE_BACKGROUND_JOB_ID: jobId,
				},
				detached: true,
				shell: false,
				stdio: ["ignore", stdoutFd, stderrFd],
			});

			child.once("spawn", () => {
				settled = true;
				child.unref();
				resolvePromise();
			});
			child.once("error", (error) => {
				if (settled) return;
				settled = true;
				rejectPromise(error);
			});
		});
	} catch (error) {
		return toolResult(
			`failed to queue ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
			{ tool: toolName, queued: false, jobId, jobDir, logPath },
			true,
		);
	} finally {
		closeSync(stdoutFd);
		closeSync(stderrFd);
	}

	return toolResult(
		`${toolName} queued in background (${jobId})`,
		{ source: "subagent", tool: toolName, queued: true, jobId, jobDir, logPath },
	);
}

function toolResult(text: string, details?: Record<string, unknown>, isError = false): MemtoolResult {
	return {
		content: [{ type: "text", text: text.trim() || "(no output)" }],
		details,
		isError,
	};
}

function looksLikeCommandMissing(stderr: string, stdout: string) {
	const combined = `${stdout} ${stderr}`.toLowerCase();
	return combined.includes("command not found") || combined.includes("no such file or directory") || combined.includes("enoent") || combined.includes("spawn") && combined.includes("mempalace");
}

function firstMeaningfulLine(text: string) {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.findLast((line) => !line.startsWith("File "));
}

function summarizeExecFailure(out: ExecResult) {
	const combined = [out.stderr, out.stdout].filter(Boolean).join("\n").trim();
	const summary = firstMeaningfulLine(combined) || combined || `exit code ${out.code}`;
	return summary.length > 300 ? `${summary.slice(0, 297)}...` : summary;
}

function dependencyHint(error?: string) {
	const lower = (error || "").toLowerCase();
	if (lower.includes("no module named 'chromadb'") || lower.includes('no module named "chromadb"')) {
		return "Install MemPalace runtime deps in the selected Python env, especially chromadb>=0.5.0 and pyyaml.";
	}
	if (lower.includes("no module named 'mempalace'") || lower.includes('no module named "mempalace"')) {
		return "Set MEMPALACE_SOURCE_PATH to a local MemPalace checkout or install mempalace into the selected Python env.";
	}
	if (looksLikeCommandMissing(error || "", "")) {
		return "Install the mempalace CLI or set MEMPALACE_SOURCE_PATH so the extension can fall back to python -m mempalace.cli.";
	}
	return undefined;
}

function jsonParseMaybe(raw: string): unknown {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			try {
				return JSON.parse(lines[index]);
			} catch {
				// ignore
			}
		}
		return undefined;
	}
}

function normalizeMcpTextPayload(value: unknown): string {
	if (typeof value === "string") {
		const trimmed = value.trim();
		const parsed = jsonParseMaybe(trimmed);
		if (parsed !== undefined && parsed !== value) {
			return normalizeMcpTextPayload(parsed);
		}
		return trimmed || "(no output)";
	}
	if (value === undefined || value === null) return "(no output)";
	return JSON.stringify(value, null, 2);
}

function execFailureResult(action: string, out: ExecResult, details?: Record<string, unknown>) {
	const error = summarizeExecFailure(out);
	const hint = dependencyHint(error);
	return toolResult([`${action} failed: ${error}`, hint].filter(Boolean).join("\n"), { ...details, code: out.code, error, hint }, true);
}

function mcpUnavailableResult(toolName: string, probe: RuntimeProbe) {
	const text = [`mcp runtime unavailable for ${toolName}`];
	if (probe.error) text.push(probe.error);
	if (probe.hint) text.push(probe.hint);
	return toolResult(text.join("\n"), { source: "mcp", available: false, error: probe.error, hint: probe.hint }, true);
}

async function runCli(pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<ExecResult> {
	const out = await pi.exec(getCliBin(), args, {
		signal,
		env: getBaseEnv(),
		cwd: process.cwd(),
	});
	if (out.code !== 0 && looksLikeCommandMissing(out.stderr, out.stdout) && process.env.MEMPALACE_SOURCE_PATH) {
		return pi.exec(getPythonBin(), ["-m", "mempalace.cli", ...args], {
			signal,
			env: getBaseEnv(),
			cwd: process.cwd(),
		});
	}
	return out;
}

async function getMcpRuntimeProbe(pi: ExtensionAPI, signal?: AbortSignal, force = false): Promise<RuntimeProbe> {
	if (!force && mcpRuntimeCache && Date.now() - mcpRuntimeCache.at < RUNTIME_PROBE_TTL_MS) {
		return mcpRuntimeCache.probe;
	}
	try {
		const checkScript = [
			"import json, sys",
			"try:",
			"    from mempalace.mcp_server import handle_request  # noqa",
			"    print(json.dumps({'ok': True}))",
			"except Exception as exc:",
			"    print(json.dumps({'ok': False, 'error': f'{type(exc).__name__}: {exc}'}))",
			"    sys.exit(1)",
		].join("\n");
		const pythonBin = getPythonBin();
		const out = await pi.exec(pythonBin, ["-c", checkScript], {
			signal,
			env: getBaseEnv(),
			cwd: process.cwd(),
		});
		const parsed = jsonParseMaybe(out.stdout) as { ok?: boolean; error?: string } | undefined;
		const error = parsed?.error || (out.code === 0 ? undefined : summarizeExecFailure(out));
		const probe: RuntimeProbe = {
			ok: out.code === 0,
			source: "mcp",
			checkedWith: `${pythonBin} -c 'from mempalace.mcp_server import handle_request'`,
			error,
			hint: dependencyHint(error),
		};
		mcpRuntimeCache = { at: Date.now(), probe };
		return probe;
	} catch (error) {
		const probe: RuntimeProbe = {
			ok: false,
			source: "mcp",
			checkedWith: `${getPythonBin()} -c 'from mempalace.mcp_server import handle_request'`,
			error: error instanceof Error ? error.message : String(error),
			hint: dependencyHint(error instanceof Error ? error.message : String(error)),
		};
		mcpRuntimeCache = { at: Date.now(), probe };
		return probe;
	}
}

async function hasMcpRuntime(pi: ExtensionAPI, signal?: AbortSignal): Promise<boolean> {
	return (await getMcpRuntimeProbe(pi, signal)).ok;
}

async function runMcp(pi: ExtensionAPI, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ExecResult> {
	const request = {
		jsonrpc: "2.0",
		id: Date.now(),
		method: "tools/call",
		params: {
			name: toolName,
			arguments: args,
		},
	};
	const encoded = Buffer.from(JSON.stringify(request)).toString("base64");
	const script = `
import base64
import json
import sys
from mempalace.mcp_server import handle_request
payload = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
response = handle_request(payload)
if response is not None:
    print(json.dumps(response), end="")
`;
	return pi.exec(getPythonBin(), ["-c", script, encoded], {
		signal,
		env: getBaseEnv(),
		cwd: process.cwd(),
	});
}

function parseMcpOutput(raw: string, toolName: string): MemtoolResult {
	const parsed = jsonParseMaybe(raw) as Record<string, any> | undefined;
	if (!parsed) {
		return toolResult(raw, { source: "mcp", tool: toolName, parseError: true });
	}
	if (parsed.error) {
		return toolResult(`MemPalace MCP error for ${toolName}: ${JSON.stringify(parsed.error)}`, { error: parsed.error }, true);
	}
	const content = Array.isArray(parsed?.result?.content) ? parsed.result.content : [];
	const textParts = content
		.map((entry: Record<string, unknown>) => (entry?.type === "text" ? normalizeMcpTextPayload(entry.text) : JSON.stringify(entry, null, 2)))
		.filter(Boolean);
	const text = textParts.join("\n\n") || normalizeMcpTextPayload(parsed?.result || {});
	return toolResult(text, { source: "mcp", tool: toolName, raw: parsed });
}

function hasDirectMempalaceMention(prompt: string) {
	return /\bmempalace(?:_(add_drawer|update_drawer|delete_drawer|mine|kg_add|kg_invalidate|search|status|wake_up|list_wings|list_rooms|list_drawers|get_drawer|traverse|kg_query))?\b/i.test(prompt || "");
}

function isWriteIntent(prompt: string) {
	return EXPLICIT_MEMORY_WRITE_RE.test(prompt || "");
}

function shouldInjectWritePolicy(prompt: string) {
	const mode = getAutosaveMode();
	if (mode === "off") return false;
	if (mode === "aggressive") return true;
	return isWriteIntent(prompt);
}

async function formatRuntimeReport(pi: ExtensionAPI, signal?: AbortSignal) {
	const mcp = await getMcpRuntimeProbe(pi, signal, true);
	const status = await runCli(pi, ["status"], signal);
	const cliOk = status.code === 0;
	const cliSummary = cliOk ? "ok" : summarizeExecFailure(status);
	const lines = [
		"MemPalace runtime report",
		`- CLI binary: ${getCliBin()}`,
		`- Python: ${getPythonBin()}`,
		`- MEMPALACE_SOURCE_PATH: ${getSourcePath() || "(unset)"}`,
		`- MEMPALACE_PALACE: ${process.env.MEMPALACE_PALACE || "(unset)"}`,
		`- CLI status command: ${cliOk ? "available" : "unavailable"} (${cliSummary})`,
		`- MCP import: ${mcp.ok ? "available" : "unavailable"} (${mcp.error || "ok"})`,
	];
	if (mcp.hint) {
		lines.push(`- Hint: ${mcp.hint}`);
	}
	return lines.join("\n");
}

async function maybeWriteReminder(_pi: ExtensionAPI, prompt: string) {
	if (!getInjectRemindersEnabled() || !isWriteIntent(prompt)) return;
	if (hasDirectMempalaceMention(prompt)) {
		return;
	}
	return {
		customType: "mempalace-write-reminder",
		display: true,
		content: "Use MemPalace write tools only if this is genuinely worth saving for future sessions. Prefer a single concise high-signal note.",
		details: { reason: "write-intent", prompt },
	};
}

async function syncActiveTools(pi: ExtensionAPI) {
	const allTools = pi.getAllTools();
	const known = new Set(allTools.map((t) => t.name));
	const active = new Set(pi.getActiveTools());
	for (const name of MEMPALACE_WRITABLE_TOOL_NAMES) {
		if (known.has(name)) active.add(name);
	}
	pi.setActiveTools(Array.from(active));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await syncActiveTools(pi);
		if (ctx.hasUI) {
			ctx.ui.notify(`MemPalace extension ready (autosave: ${getAutosaveMode()}, background writes: ${getBackgroundWritesEnabled() ? "on" : "off"})`, "info");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		await syncActiveTools(pi);
		if (ctx.hasUI) {
			ctx.ui.notify("MemPalace tools restored", "success");
		}
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		const prompt = event.prompt || "";
		const reminder = await maybeWriteReminder(pi, prompt);
		const shouldInjectPolicy = shouldInjectWritePolicy(prompt);
		const systemPrompt = shouldInjectPolicy ? `${event.systemPrompt}\n\n${MEMORY_WRITE_SYSTEM_PROMPT}` : undefined;
		if (reminder && systemPrompt) {
			return { message: reminder, systemPrompt };
		}
		if (systemPrompt) {
			return { systemPrompt };
		}
		if (reminder) {
			return { message: reminder };
		}
		return;
	});

	pi.on("input", async (event, _ctx) => {
		if (event.source === "extension") return { action: "continue" };
		return { action: "continue" };
	});

	pi.registerCommand("mempalace", {
		description: "Run a raw mempalace CLI command",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /mempalace <subcommand> [...args] | /mempalace doctor", "warning");
				return;
			}
			const tokens = args.trim().split(/\s+/);
			if (["doctor", "runtime", "check"].includes(tokens[0])) {
				ctx.ui.notify((await formatRuntimeReport(pi)).slice(0, 4000), "info");
				return;
			}
			const out = await runCli(pi, tokens);
			if (out.code !== 0) {
				const error = summarizeExecFailure(out);
				const hint = dependencyHint(error);
				const message = [error, hint].filter(Boolean).join("\n") || `mempalace ${tokens[0]} failed`;
				ctx.ui.notify(message.slice(0, 2000), "error");
				return;
			}
			ctx.ui.notify(out.stdout.trim() || "(no output)", "success");
		},
	});

	pi.registerCommand("mempalace-tools", {
		description: "Re-enable MemPalace toolset in active session",
		handler: async (_args, ctx) => {
			await syncActiveTools(pi);
			await ctx.waitForIdle();
			ctx.ui.notify("MemPalace tools enabled", "success");
		},
	});

	// -------- Read tools --------
	pi.registerTool({
		name: "mempalace_status",
		label: "MemPalace status",
		description: "Get palace-level stats and protocol metadata.",
		promptSnippet: "Get palace-level stats with mempalace_status when asked for overview.",
		promptGuidelines: ["When a user asks for a palace overview, call mempalace_status first."],
		parameters: Type.Object({}),
		execute: async (_id, _params, signal) => {
			if (!(await hasMcpRuntime(pi, signal))) {
				const cli = await runCli(pi, ["status"], signal);
				if (cli.code !== 0) {
					return execFailureResult("status", cli, { source: "cli" });
				}
				return toolResult(cli.stdout, { source: "cli" });
			}
			const mcp = await runMcp(pi, "mempalace_status", {}, signal);
			if (mcp.code !== 0) {
				return execFailureResult("MCP status call", mcp, { source: "mcp" });
			}
			return parseMcpOutput(mcp.stdout, "mempalace_status");
		},
	});

	pi.registerTool({
		name: "mempalace_wake_up",
		label: "MemPalace wake-up",
		description: "Render a compact identity + context starter for one wing.",
		parameters: Type.Object({
			wing: Type.Optional(Type.String()),
		}),
		execute: async (_id, params, signal) => {
			const cliArgs = ["wake-up"];
			if (params.wing) cliArgs.push("--wing", params.wing);
			const out = await runCli(pi, cliArgs, signal);
			if (out.code !== 0) return execFailureResult("wake-up", out, { source: "cli", args: cliArgs });
			return toolResult(out.stdout, { source: "cli", args: cliArgs });
		},
	});

	pi.registerTool({
		name: "mempalace_search",
		label: "MemPalace search",
		description: "Search MemPalace text memories.",
		promptSnippet: "Use for queries about prior discussions, decisions, events, or notes.",
		promptGuidelines: ["When user asks about prior work or old context, use mempalace_search before answering."],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			wing: Type.Optional(Type.String()),
			room: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			max_distance: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
		}),
		execute: async (_id, params, signal) => {
			if (await hasMcpRuntime(pi, signal)) {
				const out = await runMcp(pi, "mempalace_search", {
					query: params.query,
					wing: params.wing,
					room: params.room,
					limit: params.limit,
					max_distance: params.max_distance,
				}, signal);
				if (out.code !== 0) {
					return execFailureResult("MCP search", out, { source: "mcp" });
				}
				return parseMcpOutput(out.stdout, "mempalace_search");
			}

			const cliArgs = ["search", params.query];
			if (params.wing) cliArgs.push("--wing", params.wing);
			if (params.room) cliArgs.push("--room", params.room);
			if (params.limit) cliArgs.push("--results", String(params.limit));
			const out = await runCli(pi, cliArgs, signal);
			if (out.code !== 0) {
				return execFailureResult("search", out, { source: "cli", args: cliArgs });
			}
			return toolResult(out.stdout, { source: "cli", args: cliArgs });
		},
	});

	pi.registerTool({
		name: "mempalace_list_wings",
		label: "MemPalace list wings",
		description: "List all wings in the palace.",
		parameters: Type.Object({}),
		execute: async (_id, _params, signal) => {
			const probe = await getMcpRuntimeProbe(pi, signal);
			if (!probe.ok) {
				return mcpUnavailableResult("mempalace_list_wings", probe);
			}
			const out = await runMcp(pi, "mempalace_list_wings", {}, signal);
			if (out.code !== 0) return execFailureResult("list_wings", out, { source: "mcp" });
			return parseMcpOutput(out.stdout, "mempalace_list_wings");
		},
	});

	pi.registerTool({
		name: "mempalace_list_rooms",
		label: "MemPalace list rooms",
		description: "List all rooms in palace, optionally filtered by wing.",
		parameters: Type.Object({
			wing: Type.Optional(Type.String()),
		}),
		execute: async (_id, params, signal) => {
			const probe = await getMcpRuntimeProbe(pi, signal);
			if (!probe.ok) {
				return mcpUnavailableResult("mempalace_list_rooms", probe);
			}
			const out = await runMcp(pi, "mempalace_list_rooms", { wing: params.wing }, signal);
			if (out.code !== 0) return execFailureResult("list_rooms", out, { source: "mcp" });
			return parseMcpOutput(out.stdout, "mempalace_list_rooms");
		},
	});

	pi.registerTool({
		name: "mempalace_list_drawers",
		label: "MemPalace list drawers",
		description: "Paginated list of drawer IDs with optional wing/room filter.",
		promptSnippet: "Use to locate drawer IDs before fetching/updating/deleting.",
		parameters: Type.Object({
			wing: Type.Optional(Type.String()),
			room: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
		execute: async (_id, params, signal) => {
			const probe = await getMcpRuntimeProbe(pi, signal);
			if (!probe.ok) {
				return mcpUnavailableResult("mempalace_list_drawers", probe);
			}
			const out = await runMcp(pi, "mempalace_list_drawers", {
				wing: params.wing,
				room: params.room,
				limit: params.limit,
				offset: params.offset,
			}, signal);
			if (out.code !== 0) return execFailureResult("list_drawers", out, { source: "mcp" });
			return parseMcpOutput(out.stdout, "mempalace_list_drawers");
		},
	});

	pi.registerTool({
		name: "mempalace_get_drawer",
		label: "MemPalace get drawer",
		description: "Fetch a drawer by ID.",
		parameters: Type.Object({
			drawer_id: Type.String(),
		}),
		execute: async (_id, params, signal) => {
			const probe = await getMcpRuntimeProbe(pi, signal);
			if (!probe.ok) {
				return mcpUnavailableResult("mempalace_get_drawer", probe);
			}
			const out = await runMcp(pi, "mempalace_get_drawer", { drawer_id: params.drawer_id }, signal);
			if (out.code !== 0) return execFailureResult("get_drawer", out, { source: "mcp" });
			return parseMcpOutput(out.stdout, "mempalace_get_drawer");
		},
	});

	pi.registerTool({
		name: "mempalace_traverse",
		label: "MemPalace traverse graph",
		description: "Traverse palace room graph from a start room.",
		parameters: Type.Object({
			start_room: Type.String({ description: "Start room slug" }),
			max_hops: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
		}),
		execute: async (_id, params, signal) => {
			const probe = await getMcpRuntimeProbe(pi, signal);
			if (!probe.ok) {
				return mcpUnavailableResult("mempalace_traverse", probe);
			}
			const out = await runMcp(pi, "mempalace_traverse", params as Record<string, unknown>, signal);
			if (out.code !== 0) return execFailureResult("traverse", out, { source: "mcp" });
			return parseMcpOutput(out.stdout, "mempalace_traverse");
		},
	});

	// -------- Write tools --------
	pi.registerTool({
		name: "mempalace_mine",
		label: "MemPalace mine",
		description: "Mine files or conversation exports into MemPalace.",
		promptSnippet: "Use for bulk writes when user gives a folder and asks to ingest files/conversations.",
		promptGuidelines: ["For explicit requests to ingest or archive code/docs/chats, use mempalace_mine before searching or summarizing."],
		parameters: Type.Object({
			dir: Type.String(),
			mode: Type.Optional(Type.Union([Type.Literal("projects"), Type.Literal("convos")])),
			wing: Type.Optional(Type.String()),
			agent: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer({ minimum: 0 })),
			dry_run: Type.Optional(Type.Boolean()),
		}),
		execute: async (_id, params, signal) => {
			if (!params.dry_run && shouldQueueAsyncWrite("mempalace_mine")) {
				return queueAsyncWriteSubagent("mempalace_mine", params as Record<string, unknown>, signal);
			}
			const args = ["mine", params.dir, "--mode", params.mode || "projects"];
			if (params.wing) args.push("--wing", params.wing);
			if (params.agent) args.push("--agent", params.agent);
			if (typeof params.limit === "number") args.push("--limit", String(params.limit));
			if (params.dry_run) args.push("--dry-run");
			const out = await runCli(pi, args, signal);
			if (out.code !== 0) {
				return execFailureResult("mine", out, { source: "cli", args });
			}
			return toolResult(out.stdout, { source: "cli", args });
		},
	});

	pi.registerTool({
		name: "mempalace_add_drawer",
		label: "MemPalace add drawer",
		description: "Store a verbatim text snippet into a wing/room.",
		promptSnippet: "Use to store high-signal durable notes, preferences, or decisions when they are worth keeping.",
		promptGuidelines: [
			"Use mempalace_add_drawer proactively for durable, reusable information with clear future value.",
			"Prefer one concise self-contained note over verbose summaries or repeated saves.",
			"Do not save transient task chatter, temporary debugging notes, or information already obvious from the active thread unless the user explicitly asks to archive it.",
		],
		parameters: Type.Object({
			wing: Type.String(),
			room: Type.String(),
			content: Type.String(),
			source_file: Type.Optional(Type.String()),
			added_by: Type.Optional(Type.String()),
		}),
		execute: async (_id, params, signal) => {
			if (shouldQueueAsyncWrite("mempalace_add_drawer")) {
				return queueAsyncWriteSubagent("mempalace_add_drawer", {
					wing: params.wing,
					room: params.room,
					content: params.content,
					source_file: params.source_file,
					added_by: params.added_by,
				}, signal);
			}
			const probe = await getMcpRuntimeProbe(pi, signal);
			if (!probe.ok) {
				return mcpUnavailableResult("mempalace_add_drawer", probe);
			}
			const out = await runMcp(pi, "mempalace_add_drawer", {
				wing: params.wing,
				room: params.room,
				content: params.content,
				source_file: params.source_file,
				added_by: params.added_by,
			}, signal);
			if (out.code !== 0) {
				return execFailureResult("add_drawer", out, { source: "mcp" });
			}
			return parseMcpOutput(out.stdout, "mempalace_add_drawer");
		},
	});

	pi.registerTool({
		name: "mempalace_update_drawer",
		label: "MemPalace update drawer",
		description: "Update drawer content or wing/room metadata.",
		parameters: Type.Object({
			drawer_id: Type.String(),
			content: Type.Optional(Type.String()),
			wing: Type.Optional(Type.String()),
			room: Type.Optional(Type.String()),
		}),
		execute: async (_id, params, signal) => {
			if (shouldQueueAsyncWrite("mempalace_update_drawer")) {
				return queueAsyncWriteSubagent("mempalace_update_drawer", params as Record<string, unknown>, signal);
			}
			const probe = await getMcpRuntimeProbe(pi, signal);
			if (!probe.ok) {
				return mcpUnavailableResult("mempalace_update_drawer", probe);
			}
			const out = await runMcp(pi, "mempalace_update_drawer", params as Record<string, unknown>, signal);
			if (out.code !== 0) return execFailureResult("update_drawer", out, { source: "mcp" });
			return parseMcpOutput(out.stdout, "mempalace_update_drawer");
		},
	});

	pi.registerTool({
		name: "mempalace_delete_drawer",
		label: "MemPalace delete drawer",
		description: "Delete a drawer by ID.",
		parameters: Type.Object({ drawer_id: Type.String() }),
		execute: async (_id, params, signal) => {
			if (shouldQueueAsyncWrite("mempalace_delete_drawer")) {
				return queueAsyncWriteSubagent("mempalace_delete_drawer", { drawer_id: params.drawer_id }, signal);
			}
			const probe = await getMcpRuntimeProbe(pi, signal);
			if (!probe.ok) {
				return mcpUnavailableResult("mempalace_delete_drawer", probe);
			}
			const out = await runMcp(pi, "mempalace_delete_drawer", { drawer_id: params.drawer_id }, signal);
			if (out.code !== 0) {
				return execFailureResult("delete_drawer", out, { source: "mcp" });
			}
			return parseMcpOutput(out.stdout, "mempalace_delete_drawer");
		},
	});

	pi.registerTool({
		name: "mempalace_kg_add",
		label: "MemPalace KG add",
		description: "Add a temporal fact to the knowledge graph.",
		promptSnippet: "Use for clean stable factual relationships when they are clearly worth preserving.",
		promptGuidelines: [
			"Use mempalace_kg_add only for stable factual relationships with clean subject, predicate, and object values.",
			"Avoid noisy, transient, path-like, or sentence-fragment values in KG writes.",
		],
		parameters: Type.Object({
			subject: Type.String(),
			predicate: Type.String(),
			object: Type.String(),
			valid_from: Type.Optional(Type.String()),
			source_closet: Type.Optional(Type.String()),
		}),
		execute: async (_id, params, signal) => {
			if (shouldQueueAsyncWrite("mempalace_kg_add")) {
				return queueAsyncWriteSubagent("mempalace_kg_add", params as Record<string, unknown>, signal);
			}
			const probe = await getMcpRuntimeProbe(pi, signal);
			if (!probe.ok) {
				return mcpUnavailableResult("mempalace_kg_add", probe);
			}
			const out = await runMcp(pi, "mempalace_kg_add", params as Record<string, unknown>, signal);
			if (out.code !== 0) return execFailureResult("kg_add", out, { source: "mcp" });
			return parseMcpOutput(out.stdout, "mempalace_kg_add");
		},
	});

	pi.registerTool({
		name: "mempalace_kg_invalidate",
		label: "MemPalace KG invalidate",
		description: "Mark a knowledge graph fact as ended/invalid.",
		parameters: Type.Object({
			subject: Type.String(),
			predicate: Type.String(),
			object: Type.String(),
			ended: Type.Optional(Type.String()),
		}),
		execute: async (_id, params, signal) => {
			const probe = await getMcpRuntimeProbe(pi, signal);
			if (!probe.ok) {
				return mcpUnavailableResult("mempalace_kg_invalidate", probe);
			}
			const out = await runMcp(pi, "mempalace_kg_invalidate", params as Record<string, unknown>, signal);
			if (out.code !== 0) {
				return execFailureResult("kg_invalidate", out, { source: "mcp" });
			}
			return parseMcpOutput(out.stdout, "mempalace_kg_invalidate");
		},
	});

	pi.registerTool({
		name: "mempalace_kg_query",
		label: "MemPalace KG query",
		description: "Query knowledge graph entity facts.",
		parameters: Type.Object({
			entity: Type.String(),
			as_of: Type.Optional(Type.String()),
			direction: Type.Optional(Type.Union([Type.Literal("incoming"), Type.Literal("outgoing"), Type.Literal("both")])),
		}),
		execute: async (_id, params, signal) => {
			const probe = await getMcpRuntimeProbe(pi, signal);
			if (!probe.ok) {
				return mcpUnavailableResult("mempalace_kg_query", probe);
			}
			const out = await runMcp(pi, "mempalace_kg_query", {
				entity: params.entity,
				as_of: params.as_of,
				direction: params.direction,
			}, signal);
			if (out.code !== 0) return execFailureResult("kg_query", out, { source: "mcp" });
			return parseMcpOutput(out.stdout, "mempalace_kg_query");
		},
	});
}
