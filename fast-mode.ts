import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type FastModeArg = "on" | "off" | "toggle" | "status";

const STATE_PATH = path.join(os.homedir(), ".pi", "agent", "state", "codex-fast-mode.json");

let fastModeEnabled = loadFastMode();

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadFastMode(): boolean {
	try {
		const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
		return parsed?.enabled === true;
	} catch {
		return false;
	}
}

function saveFastMode(enabled: boolean) {
	fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
	fs.writeFileSync(STATE_PATH, JSON.stringify({ enabled, updatedAt: new Date().toISOString() }, null, 2));
}

function parseArg(raw: string): FastModeArg {
	const arg = raw.trim().toLowerCase();
	if (arg === "") return "toggle";
	if (arg === "on" || arg === "enable" || arg === "enabled" || arg === "true" || arg === "1") return "on";
	if (arg === "off" || arg === "disable" || arg === "disabled" || arg === "false" || arg === "0") return "off";
	if (arg === "toggle") return "toggle";
	if (arg === "status" || arg === "show" || arg === "?") return "status";
	return "on";
}

function renderFastStatus(ctx: {
	ui: { theme: { fg(color: "success" | "dim", text: string): string }; setStatus(key: string, text: string | undefined): void };
}) {
	const label = fastModeEnabled ? ctx.ui.theme.fg("success", "⚡ codex fast:on") : ctx.ui.theme.fg("dim", "⚡ codex fast:off");
	ctx.ui.setStatus("codex-fast-mode", label);
}

export default function fastModeExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		fastModeEnabled = loadFastMode();
		renderFastStatus(ctx);
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex Fast Mode (service_tier: priority)",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "toggle", "status"];
			const matches = options.filter((option) => option.startsWith(prefix.trim().toLowerCase()));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const action = parseArg(args);

			if (action === "toggle") {
				fastModeEnabled = !fastModeEnabled;
			} else if (action === "on") {
				fastModeEnabled = true;
			} else if (action === "off") {
				fastModeEnabled = false;
			}

			if (action !== "status") saveFastMode(fastModeEnabled);
			renderFastStatus(ctx);

			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown model";
			const status = fastModeEnabled ? "enabled" : "disabled";
			const suffix = ctx.model?.provider === "openai-codex" ? "" : ` (current model is ${model}; applies to openai-codex requests)`;
			ctx.ui.notify(`Codex Fast Mode ${status}: service_tier=${fastModeEnabled ? "priority" : "default"}${suffix}`, "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		fastModeEnabled = loadFastMode();
		if (!fastModeEnabled) return undefined;
		if (ctx.model?.provider !== "openai-codex") return undefined;
		if (!isObject(event.payload)) return undefined;

		return {
			...event.payload,
			service_tier: "priority",
		};
	});
}
