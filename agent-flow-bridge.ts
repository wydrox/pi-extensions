import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type BridgeSettings = {
	enabled?: boolean;
	outputPath?: string;
	truncateOnSessionStart?: boolean;
	includeMessages?: boolean;
	includeToolUpdates?: boolean;
	postToRelay?: boolean;
};

type AgentFlowEvent = {
	time: number;
	type:
		| "agent_spawn"
		| "agent_complete"
		| "message"
		| "tool_call_start"
		| "tool_call_end"
		| "subagent_dispatch"
		| "subagent_return"
		| "context_update";
	payload: Record<string, unknown>;
};

type SubagentChild = {
	name: string;
	agent: string;
	task: string;
	parent: string;
	completed?: boolean;
};

const DEFAULT_OUTPUT_PATH = "~/.pi/agent-flow/events.jsonl";
const MAIN_AGENT = "pi";
const MAX_TEXT = 4000;

let startedAt = Date.now();
let activePrompt = "";
const activeSubagents = new Map<string, SubagentChild[]>();

function readJsonFile(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function readSettingsFile(path: string): BridgeSettings {
	const parsed = readJsonFile(path);
	const raw = parsed.agentFlowBridge ?? parsed.agentflowBridge ?? parsed.agentFlow;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const value = raw as Record<string, unknown>;
	return {
		enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
		outputPath: typeof value.outputPath === "string" ? value.outputPath : undefined,
		truncateOnSessionStart:
			typeof value.truncateOnSessionStart === "boolean" ? value.truncateOnSessionStart : undefined,
		includeMessages: typeof value.includeMessages === "boolean" ? value.includeMessages : undefined,
		includeToolUpdates: typeof value.includeToolUpdates === "boolean" ? value.includeToolUpdates : undefined,
		postToRelay: typeof value.postToRelay === "boolean" ? value.postToRelay : undefined,
	};
}

function expandPath(path: string, cwd: string): string {
	const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
	return resolve(cwd, expanded);
}

function getSettings(cwd: string): Required<BridgeSettings> {
	const globalSettingsPath = join(homedir(), ".pi", "agent", "settings.json");
	const projectSettingsPath = join(cwd, ".pi", "settings.json");
	const settings = {
		...readSettingsFile(globalSettingsPath),
		...readSettingsFile(projectSettingsPath),
	};
	return {
		enabled: settings.enabled ?? true,
		outputPath: expandPath(settings.outputPath ?? DEFAULT_OUTPUT_PATH, cwd),
		truncateOnSessionStart: settings.truncateOnSessionStart ?? true,
		includeMessages: settings.includeMessages ?? true,
		includeToolUpdates: settings.includeToolUpdates ?? false,
		postToRelay: settings.postToRelay ?? true,
	};
}

function secondsSinceStart(): number {
	return Math.max(0, (Date.now() - startedAt) / 1000);
}

function truncate(value: unknown, max = MAX_TEXT): string {
	let text: string;
	if (typeof value === "string") text = value;
	else {
		try {
			text = JSON.stringify(value);
		} catch {
			text = String(value);
		}
	}
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return truncate(content);
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const typed = part as Record<string, unknown>;
			if (typed.type === "text" && typeof typed.text === "string") return typed.text;
			if (typed.type === "toolCall") return `[tool:${String(typed.name ?? "unknown")}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function appendEvent(cwd: string, event: AgentFlowEvent): void {
	const settings = getSettings(cwd);
	if (!settings.enabled) return;
	mkdirSync(dirname(settings.outputPath), { recursive: true });
	appendFileSync(settings.outputPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

function resetLogIfNeeded(cwd: string): void {
	const settings = getSettings(cwd);
	if (!settings.enabled || !settings.truncateOnSessionStart) return;
	mkdirSync(dirname(settings.outputPath), { recursive: true });
	writeFileSync(settings.outputPath, "", { encoding: "utf8", mode: 0o600 });
}

function relaySessionId(): string {
	return `pi-${process.pid}`;
}

function emit(cwd: string, type: AgentFlowEvent["type"], payload: Record<string, unknown>): void {
	const event = { time: secondsSinceStart(), type, payload };
	appendEvent(cwd, event);
	postRelayAgentFlowEvent(cwd, event);
}

function getRelayPort(cwd: string): number | undefined {
	const discoveryDir = join(homedir(), ".claude", "agent-flow");
	if (!existsSync(discoveryDir)) return undefined;
	try {
		const candidates = readdirSync(discoveryDir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => join(discoveryDir, name))
			.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
		const normalizedCwd = resolve(cwd);
		for (const file of candidates) {
			const parsed = readJsonFile(file);
			const port = typeof parsed.port === "number" ? parsed.port : undefined;
			const workspace = typeof parsed.workspace === "string" ? resolve(parsed.workspace) : undefined;
			if (port && (!workspace || workspace === normalizedCwd)) return port;
		}
		for (const file of candidates) {
			const parsed = readJsonFile(file);
			if (typeof parsed.port === "number") return parsed.port;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function postRelayAgentFlowEvent(cwd: string, event: AgentFlowEvent): void {
	const settings = getSettings(cwd);
	if (!settings.enabled || !settings.postToRelay) return;
	const port = getRelayPort(cwd);
	if (!port || typeof fetch !== "function") return;
	void fetch(`http://127.0.0.1:${port}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ session_id: relaySessionId(), agent_flow_event: event }),
	}).catch(() => undefined);
}

function parseSubagentChildren(args: unknown): SubagentChild[] {
	let value = args;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return [];
		}
	}
	if (!value || typeof value !== "object") return [];
	const typed = value as Record<string, any>;
	const children: SubagentChild[] = [];
	const add = (agent: unknown, task: unknown, index?: number, parent = MAIN_AGENT) => {
		if (typeof agent !== "string" || typeof task !== "string") return;
		const suffix = index === undefined ? "" : `#${index + 1}`;
		children.push({ name: `${agent}${suffix}`, agent, task, parent });
	};
	if (Array.isArray(typed.tasks)) {
		typed.tasks.forEach((task: any, index: number) => add(task?.agent, task?.task, index));
	} else if (Array.isArray(typed.chain)) {
		typed.chain.forEach((step: any, index: number) => add(step?.agent, step?.task, index));
	} else {
		add(typed.agent, typed.task);
	}
	return children;
}

function resultSummary(result: any): string {
	if (!result || typeof result !== "object") return "";
	if (typeof result.errorMessage === "string" && result.errorMessage) return result.errorMessage;
	if (typeof result.stderr === "string" && result.stderr) return result.stderr;
	const messages = Array.isArray(result.messages) ? result.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant") {
			const text = contentToText(msg.content);
			if (text) return text;
		}
	}
	return "";
}

function emitSubagentCompletion(cwd: string, toolCallId: string, result: any): void {
	const children = activeSubagents.get(toolCallId) ?? [];
	const details = result?.details ?? result?.details?.details ?? result?.result?.details;
	const results = Array.isArray(details?.results) ? details.results : [];

	for (const child of children) {
		const match = results.find((r: any) => r?.agent === child.agent && !r.__agentFlowBridgeSeen);
		if (match) match.__agentFlowBridgeSeen = true;
		const summary = truncate(resultSummary(match), 1200);
		emit(cwd, "subagent_return", {
			child: child.name,
			parent: child.parent,
			summary: summary || (match?.exitCode === 0 ? "completed" : "returned"),
			exitCode: match?.exitCode,
			stopReason: match?.stopReason,
		});
		emit(cwd, "agent_complete", { name: child.name });
		child.completed = true;
	}
	activeSubagents.delete(toolCallId);
}

export default function agentFlowBridge(pi: ExtensionAPI): void {
	pi.on("session_start", (event, ctx) => {
		startedAt = Date.now();
		activePrompt = "";
		activeSubagents.clear();
		resetLogIfNeeded(ctx.cwd);
		emit(ctx.cwd, "agent_spawn", {
			name: MAIN_AGENT,
			isMain: true,
			task: `Pi session (${event.reason})`,
		});
	});

	pi.on("before_agent_start", (event, ctx) => {
		activePrompt = event.prompt;
		emit(ctx.cwd, "message", {
			agent: MAIN_AGENT,
			role: "user",
			content: truncate(event.prompt),
		});
		emit(ctx.cwd, "context_update", {
			agent: MAIN_AGENT,
			tokens: event.systemPrompt.length,
			breakdown: { systemPrompt: event.systemPrompt.length, userMessages: event.prompt.length },
		});
	});

	pi.on("agent_start", (_event, ctx) => {
		emit(ctx.cwd, "message", {
			agent: MAIN_AGENT,
			content: activePrompt ? `Working on: ${truncate(activePrompt, 500)}` : "Agent started",
		});
	});

	pi.on("message_end", (event, ctx) => {
		const settings = getSettings(ctx.cwd);
		if (!settings.includeMessages) return;
		const message = event.message as any;
		if (message?.role !== "assistant") return;
		const text = contentToText(message.content);
		if (!text) return;
		emit(ctx.cwd, "message", {
			agent: MAIN_AGENT,
			role: "assistant",
			content: truncate(text),
		});
	});

	pi.on("tool_execution_start", (event, ctx) => {
		const preview = event.toolName === "subagent" ? "Delegating to subagent(s)…" : truncate(event.args, 600);
		emit(ctx.cwd, "tool_call_start", {
			agent: MAIN_AGENT,
			tool: event.toolName,
			args: truncate(event.args),
			preview,
		});
		if (event.toolName === "subagent") {
			const children = parseSubagentChildren(event.args);
			activeSubagents.set(event.toolCallId, children);
			for (const child of children) {
				emit(ctx.cwd, "subagent_dispatch", {
					parent: child.parent,
					child: child.name,
					task: child.task,
					agent: child.agent,
				});
				emit(ctx.cwd, "agent_spawn", {
					name: child.name,
					parent: child.parent,
					task: child.task,
				});
			}
		}
	});

	pi.on("tool_execution_update", (event, ctx) => {
		const settings = getSettings(ctx.cwd);
		if (!settings.includeToolUpdates) return;
		emit(ctx.cwd, "message", {
			agent: MAIN_AGENT,
			content: `${event.toolName} update: ${truncate(event.partialResult, 1000)}`,
		});
	});

	pi.on("tool_execution_end", (event, ctx) => {
		emit(ctx.cwd, "tool_call_end", {
			agent: MAIN_AGENT,
			tool: event.toolName,
			result: truncate(event.result),
			isError: event.isError,
		});
		if (event.toolName === "subagent") {
			emitSubagentCompletion(ctx.cwd, event.toolCallId, event.result);
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		emit(ctx.cwd, "agent_complete", { name: MAIN_AGENT });
	});

	pi.on("session_shutdown", (_event, ctx) => {
		for (const children of activeSubagents.values()) {
			for (const child of children) {
				if (!child.completed) emit(ctx.cwd, "agent_complete", { name: child.name });
			}
		}
		activeSubagents.clear();
		emit(ctx.cwd, "agent_complete", { name: MAIN_AGENT });
	});

	pi.registerCommand("agent-flow", {
		description: "Show Agent Flow bridge status and JSONL path",
		handler: async (_args, ctx) => {
			const settings = getSettings(ctx.cwd);
			const relayPort = getRelayPort(ctx.cwd);
			const message = settings.enabled
				? `Agent Flow bridge is ON\nJSONL: ${settings.outputPath}\nRelay: ${relayPort ? `http://127.0.0.1:${relayPort}` : "not detected"}\nStandalone: run ~/.pi/agent-flow/start-agent-flow.sh\nVS Code: Agent Flow → Connect to Running Agent → Watch JSONL File.`
				: "Agent Flow bridge is OFF (set agentFlowBridge.enabled=true).";
			if (ctx.hasUI) ctx.ui.notify(message, "info");
			else console.log(message);
		},
	});
}
