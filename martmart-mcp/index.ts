import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type JsonSchema = Record<string, any>;

type McpTool = {
	name: string;
	description?: string;
	inputSchema?: JsonSchema;
	outputSchema?: JsonSchema;
};

type SpawnConfig = {
	command: string;
	args: string[];
	cwd?: string;
	displayCommand: string;
	source: string;
};

type PendingRequest = {
	resolve: (value: any) => void;
	reject: (reason?: unknown) => void;
	abortCleanup?: () => void;
};

const EXTENSION_NAME = "martmart-mcp";
const STATUS_COMMAND = "martmart-mcp-status";
const RESTART_COMMAND = "martmart-mcp-restart";

const EMPTY_OBJECT_SCHEMA = Type.Object({}, { additionalProperties: false });

function quoteArg(arg: string): string {
	return /^[a-zA-Z0-9_./:@%+=,-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function formatCommand(command: string, args: string[]): string {
	return [command, ...args].map(quoteArg).join(" ");
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function truncateForLlm(text: string): string {
	const truncation = truncateHead(text, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!truncation.truncated) return truncation.content;
	return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
		truncation.outputBytes,
	)} of ${formatSize(truncation.totalBytes)})]`;
}

function humanizeToolName(name: string): string {
	return name
		.split(/[_-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function parseStringEnumFromDescription(description?: string): string[] | undefined {
	if (!description) return undefined;
	const match = description.match(/one of\s+([a-z0-9_,\s-]+)/i);
	if (!match) return undefined;
	const values = match[1]
		.split(",")
		.map((value) => value.trim())
		.map((value) => value.replace(/[.;:]$/, ""))
		.filter(Boolean);
	if (values.length < 2) return undefined;
	if (!values.every((value) => /^[a-z0-9_-]+$/i.test(value))) return undefined;
	return values;
}

function schemaOptions(schema: JsonSchema): Record<string, any> {
	const options: Record<string, any> = {};
	if (typeof schema.description === "string" && schema.description.trim()) {
		options.description = schema.description.trim();
	}
	if (typeof schema.title === "string" && schema.title.trim()) {
		options.title = schema.title.trim();
	}
	if (schema.default !== undefined) {
		options.default = schema.default;
	}
	if (typeof schema.minimum === "number") options.minimum = schema.minimum;
	if (typeof schema.maximum === "number") options.maximum = schema.maximum;
	if (typeof schema.minLength === "number") options.minLength = schema.minLength;
	if (typeof schema.maxLength === "number") options.maxLength = schema.maxLength;
	if (typeof schema.pattern === "string" && schema.pattern) options.pattern = schema.pattern;
	if (typeof schema.minItems === "number") options.minItems = schema.minItems;
	if (typeof schema.maxItems === "number") options.maxItems = schema.maxItems;
	return options;
}

function jsonSchemaToTypeBox(schema?: JsonSchema): any {
	if (!schema || typeof schema !== "object") return EMPTY_OBJECT_SCHEMA;

	if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
		return Type.Union(schema.anyOf.map((item) => jsonSchemaToTypeBox(item)), schemaOptions(schema));
	}
	if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
		return Type.Union(schema.oneOf.map((item) => jsonSchemaToTypeBox(item)), schemaOptions(schema));
	}

	const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
	if (enumValues && enumValues.length > 0 && enumValues.every((value) => typeof value === "string")) {
		return StringEnum(enumValues as readonly string[], schemaOptions(schema));
	}

	const rawType = schema.type;
	if (Array.isArray(rawType) && rawType.length > 0) {
		const uniqueTypes = Array.from(new Set(rawType));
		const members = uniqueTypes.map((type) => jsonSchemaToTypeBox({ ...schema, type, anyOf: undefined, oneOf: undefined }));
		return members.length === 1 ? members[0] : Type.Union(members, schemaOptions(schema));
	}

	const inferredType = rawType ?? (schema.properties ? "object" : undefined);
	const options = schemaOptions(schema);

	if (inferredType === "string") {
		const parsedEnum = parseStringEnumFromDescription(schema.description);
		if (parsedEnum && parsedEnum.length > 1) {
			return StringEnum(parsedEnum as readonly string[], options);
		}
		return Type.String(options);
	}
	if (inferredType === "integer") return Type.Integer(options);
	if (inferredType === "number") return Type.Number(options);
	if (inferredType === "boolean") return Type.Boolean(options);
	if (inferredType === "null") return Type.Null(options);
	if (inferredType === "array") {
		const itemSchema = schema.items && typeof schema.items === "object" ? jsonSchemaToTypeBox(schema.items) : Type.Any();
		return Type.Array(itemSchema, options);
	}
	if (inferredType === "object") {
		const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
		const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
		const mapped: Record<string, any> = {};
		for (const [key, value] of Object.entries(properties)) {
			const child = jsonSchemaToTypeBox(value as JsonSchema);
			mapped[key] = required.has(key) ? child : Type.Optional(child);
		}
		const additionalProperties =
			typeof schema.additionalProperties === "boolean" ? schema.additionalProperties : schema.additionalProperties ? true : false;
		return Type.Object(mapped, { ...options, additionalProperties });
	}

	return Type.Any(options);
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function findOnPath(bin: string): Promise<string | undefined> {
	const pathEnv = process.env.PATH ?? "";
	for (const part of pathEnv.split(":")) {
		if (!part) continue;
		const candidate = join(part, bin);
		if (await isExecutable(candidate)) return candidate;
	}
	return undefined;
}

async function resolveSpawnConfig(): Promise<SpawnConfig> {
	const envCommand = process.env.MARTMART_MCP_COMMAND?.trim();
	const envCwd = process.env.MARTMART_MCP_CWD?.trim();
	if (envCommand) {
		return {
			command: "/bin/sh",
			args: ["-lc", envCommand],
			cwd: envCwd || undefined,
			displayCommand: envCommand,
			source: "MARTMART_MCP_COMMAND",
		};
	}

	const pathBinary = await findOnPath("martmart");
	if (pathBinary) {
		return {
			command: pathBinary,
			args: ["mcp"],
			cwd: envCwd || undefined,
			displayCommand: formatCommand(pathBinary, ["mcp"]),
			source: "PATH",
		};
	}

	const home = homedir();
	const candidates = [
		resolve(home, "dev/martmart-cli/martmart"),
		resolve(home, "dev/martmart-cli/bin/martmart"),
		resolve(process.cwd(), "martmart"),
		resolve(process.cwd(), "bin/martmart"),
	];

	for (const candidate of candidates) {
		if (await isExecutable(candidate)) {
			return {
				command: candidate,
				args: ["mcp"],
				cwd: envCwd || dirname(candidate),
				displayCommand: formatCommand(candidate, ["mcp"]),
				source: candidate,
			};
		}
	}

	throw new Error(
		"Could not find a MartMart binary. Add `martmart` to PATH or set MARTMART_MCP_COMMAND='path/to/martmart mcp'.",
	);
}

class MartMartMcpClient {
	private proc?: ChildProcessWithoutNullStreams;
	private buffer = "";
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private startPromise?: Promise<void>;
	private toolsCache?: McpTool[];
	private lastError?: string;
	private stderrLines: string[] = [];

	constructor(private readonly spawnConfig: SpawnConfig) {}

	getStatus() {
		return {
			running: Boolean(this.proc && this.proc.exitCode === null && !this.proc.killed),
			command: this.spawnConfig.displayCommand,
			source: this.spawnConfig.source,
			cwd: this.spawnConfig.cwd,
			toolCount: this.toolsCache?.length ?? 0,
			lastError: this.lastError,
			stderr: this.stderrLines.slice(-10),
		};
	}

	async restart() {
		await this.dispose();
		this.lastError = undefined;
		this.stderrLines = [];
		this.toolsCache = undefined;
		await this.start();
		await this.listTools(true);
	}

	async dispose() {
		const proc = this.proc;
		this.proc = undefined;
		this.startPromise = undefined;
		this.buffer = "";
		if (proc && proc.exitCode === null && !proc.killed) {
			proc.kill();
		}
		this.rejectAllPending(new Error("MartMart MCP client stopped."));
	}

	async listTools(forceRefresh = false): Promise<McpTool[]> {
		await this.start();
		if (this.toolsCache && !forceRefresh) return this.toolsCache;
		const response = await this.request("tools/list", {});
		const tools = Array.isArray(response?.tools) ? (response.tools as McpTool[]) : [];
		this.toolsCache = tools;
		return tools;
	}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
		await this.start();
		return this.request(
			"tools/call",
			{
				name,
				arguments: args ?? {},
			},
			signal,
		);
	}

	private async start(): Promise<void> {
		if (!this.startPromise) {
			this.startPromise = this.doStart().catch((error) => {
				this.startPromise = undefined;
				throw error;
			});
		}
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		this.proc = spawn(this.spawnConfig.command, this.spawnConfig.args, {
			cwd: this.spawnConfig.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.proc.stdout.setEncoding("utf8");
		this.proc.stderr.setEncoding("utf8");

		this.proc.stdout.on("data", (chunk: string) => {
			this.buffer += chunk;
			let newlineIndex = this.buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = this.buffer.slice(0, newlineIndex).trim();
				this.buffer = this.buffer.slice(newlineIndex + 1);
				if (line) this.handleLine(line);
				newlineIndex = this.buffer.indexOf("\n");
			}
		});

		this.proc.stderr.on("data", (chunk: string) => {
			for (const line of chunk.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				this.stderrLines.push(trimmed);
				if (this.stderrLines.length > 50) this.stderrLines.shift();
			}
		});

		this.proc.on("error", (error) => {
			this.lastError = toErrorMessage(error);
			this.proc = undefined;
			this.startPromise = undefined;
			this.rejectAllPending(error);
		});

		this.proc.on("exit", (code, signal) => {
			const reason = `MartMart MCP exited (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}).`;
			this.lastError = reason;
			this.proc = undefined;
			this.startPromise = undefined;
			this.rejectAllPending(new Error(reason));
		});

		await this.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: {
				name: "pi-martmart-mcp-extension",
				version: "0.1.0",
			},
		});
		this.notify("notifications/initialized", {});
	}

	private notify(method: string, params: Record<string, unknown>) {
		if (!this.proc?.stdin.writable) return;
		this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
		const proc = this.proc;
		if (!proc?.stdin.writable) {
			throw new Error(`MartMart MCP is not running (${this.spawnConfig.displayCommand}).`);
		}
		if (signal?.aborted) {
			throw new Error("MartMart MCP request aborted before send.");
		}

		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });

		const promise = new Promise<any>((resolve, reject) => {
			const pending: PendingRequest = { resolve, reject };
			if (signal) {
				const onAbort = () => {
					this.pending.delete(id);
					reject(new Error(`MartMart MCP request aborted: ${method}`));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				pending.abortCleanup = () => signal.removeEventListener("abort", onAbort);
			}
			this.pending.set(id, pending);
		});

		proc.stdin.write(`${payload}\n`);
		return promise;
	}

	private handleLine(line: string) {
		try {
			const message = JSON.parse(line) as Record<string, any>;
			if (message.id !== undefined && message.id !== null) {
				const id = Number(message.id);
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				pending.abortCleanup?.();

				if (message.error) {
					pending.reject(new Error(this.formatRpcError(message.error)));
					return;
				}
				pending.resolve(message.result);
				return;
			}

			if (message.method === "notifications/tools/list_changed") {
				this.toolsCache = undefined;
			}
		} catch (error) {
			this.lastError = `Failed to parse MartMart MCP output: ${toErrorMessage(error)}`;
		}
	}

	private formatRpcError(error: Record<string, any>): string {
		const code = error?.code !== undefined ? `code ${error.code}` : "unknown code";
		const message = typeof error?.message === "string" ? error.message : "Unknown RPC error";
		const data = error?.data !== undefined ? `\n${JSON.stringify(error.data)}` : "";
		return `MartMart MCP RPC error (${code}): ${message}${data}`;
	}

	private rejectAllPending(error: unknown) {
		for (const [id, pending] of this.pending.entries()) {
			this.pending.delete(id);
			pending.abortCleanup?.();
			pending.reject(error);
		}
	}
}

function contentTextFromCallResult(result: Record<string, any>): string {
	const content = Array.isArray(result.content) ? result.content : [];
	const textParts = content
		.filter((item) => item && typeof item === "object" && item.type === "text" && typeof item.text === "string")
		.map((item) => item.text as string);
	if (textParts.length > 0) return textParts.join("\n\n");
	if (result.structuredContent !== undefined) {
		return JSON.stringify(result.structuredContent, null, 2);
	}
	return JSON.stringify(result, null, 2);
}

function normalizeToolResult(toolName: string, rawResult: Record<string, any>, client: MartMartMcpClient) {
	const text = truncateForLlm(contentTextFromCallResult(rawResult));
	if (rawResult.isError) {
		throw new Error(text || `${toolName} failed via MartMart MCP.`);
	}
	return {
		content: [{ type: "text", text }],
		details: {
			toolName,
			via: EXTENSION_NAME,
			command: client.getStatus().command,
		},
	};
}

export default async function martmartMcpExtension(pi: ExtensionAPI) {
	let client: MartMartMcpClient | undefined;
	let toolNames: string[] = [];
	let startupError: string | undefined;
	const registeredToolNames = new Set<string>();

	const getClient = async () => {
		if (!client) {
			const spawnConfig = await resolveSpawnConfig();
			client = new MartMartMcpClient(spawnConfig);
		}
		return client;
	};

	const registerDiscoveredTools = async (forceRefresh = false) => {
		const mcpClient = await getClient();
		const tools = await mcpClient.listTools(forceRefresh);
		toolNames = tools.map((tool) => tool.name).sort();

		for (const tool of tools) {
			if (registeredToolNames.has(tool.name)) continue;
			registeredToolNames.add(tool.name);
			pi.registerTool({
				name: tool.name,
				label: humanizeToolName(tool.name),
				description: tool.description || `${tool.name} via MartMart MCP`,
				parameters: jsonSchemaToTypeBox(tool.inputSchema),
				async execute(_toolCallId, params, signal) {
					const liveClient = await getClient();
					const result = await liveClient.callTool(tool.name, (params ?? {}) as Record<string, unknown>, signal);
					return normalizeToolResult(tool.name, result as Record<string, any>, liveClient);
				},
			});
		}
	};

	try {
		await registerDiscoveredTools();
	} catch (error) {
		startupError = toErrorMessage(error);
	}

	pi.registerCommand(STATUS_COMMAND, {
		description: "Show MartMart MCP extension status",
		handler: async (_args, ctx) => {
			try {
				const liveClient = await getClient();
				await registerDiscoveredTools(true);
				startupError = undefined;
				const status = liveClient.getStatus();
				ctx.ui.notify(
					[
						`MartMart MCP: ${status.running ? "running" : "stopped"}`,
						`Command: ${status.command}`,
						`Source: ${status.source}`,
						status.cwd ? `cwd: ${status.cwd}` : undefined,
						`Tools: ${toolNames.length}`,
						status.lastError ? `Last error: ${status.lastError}` : undefined,
					]
						.filter(Boolean)
						.join("\n"),
					"info",
				);
			} catch (error) {
				startupError = toErrorMessage(error);
				ctx.ui.notify(`MartMart MCP unavailable: ${startupError}`, "warning");
			}
		},
	});

	pi.registerCommand(RESTART_COMMAND, {
		description: "Restart the MartMart MCP subprocess",
		handler: async (_args, ctx) => {
			try {
				const liveClient = await getClient();
				await liveClient.restart();
				await registerDiscoveredTools(true);
				startupError = undefined;
				ctx.ui.notify(`MartMart MCP restarted. Tools available: ${toolNames.length}`, "success");
			} catch (error) {
				startupError = toErrorMessage(error);
				ctx.ui.notify(`MartMart MCP restart failed: ${startupError}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (startupError) {
			ctx.ui.notify(`MartMart MCP not loaded: ${startupError}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		await client?.dispose();
	});
}
