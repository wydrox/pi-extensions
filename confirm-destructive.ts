/**
 * Confirm Destructive Actions Extension
 *
 * Prompts for confirmation before destructive session actions (clear, switch, branch).
 * Can be toggled with /confirm-destructive on|off|toggle|status.
 * Demonstrates how to cancel session events using the before_* events.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, SessionBeforeSwitchEvent, SessionMessageEntry } from "@mariozechner/pi-coding-agent";

type ConfirmDestructiveArg = "on" | "off" | "toggle" | "status";

const STATE_PATH = path.join(os.homedir(), ".pi", "agent", "state", "confirm-destructive.json");

let confirmDestructiveEnabled = loadConfirmDestructive();

function loadConfirmDestructive(): boolean {
	try {
		const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
		return parsed?.enabled !== false;
	} catch {
		return true;
	}
}

function saveConfirmDestructive(enabled: boolean) {
	fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
	fs.writeFileSync(STATE_PATH, JSON.stringify({ enabled, updatedAt: new Date().toISOString() }, null, 2));
}

function parseArg(raw: string): ConfirmDestructiveArg {
	const arg = raw.trim().toLowerCase();
	if (arg === "") return "toggle";
	if (arg === "on" || arg === "enable" || arg === "enabled" || arg === "true" || arg === "1") return "on";
	if (arg === "off" || arg === "disable" || arg === "disabled" || arg === "false" || arg === "0") return "off";
	if (arg === "toggle") return "toggle";
	if (arg === "status" || arg === "show" || arg === "?") return "status";
	return "status";
}

function renderStatus(ctx: {
	ui: { theme: { fg(color: "warning" | "dim", text: string): string }; setStatus(key: string, text: string | undefined): void };
}) {
	const label = confirmDestructiveEnabled
		? ctx.ui.theme.fg("warning", " destructive confirm:on")
		: ctx.ui.theme.fg("dim", " destructive confirm:off");
	ctx.ui.setStatus("confirm-destructive", label);
}

function isEnabled(): boolean {
	confirmDestructiveEnabled = loadConfirmDestructive();
	return confirmDestructiveEnabled;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		confirmDestructiveEnabled = loadConfirmDestructive();
		renderStatus(ctx);
	});

	pi.registerCommand("confirm-destructive", {
		description: "Toggle confirmations before destructive session actions",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "toggle", "status"];
			const matches = options.filter((option) => option.startsWith(prefix.trim().toLowerCase()));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const action = parseArg(args);

			if (action === "toggle") {
				confirmDestructiveEnabled = !loadConfirmDestructive();
			} else if (action === "on") {
				confirmDestructiveEnabled = true;
			} else if (action === "off") {
				confirmDestructiveEnabled = false;
			} else {
				confirmDestructiveEnabled = loadConfirmDestructive();
			}

			if (action !== "status") saveConfirmDestructive(confirmDestructiveEnabled);
			if (ctx.hasUI) renderStatus(ctx);

			ctx.ui.notify(`Destructive confirmations ${confirmDestructiveEnabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx) => {
		if (!ctx.hasUI || !isEnabled()) return;

		if (event.reason === "new") {
			const confirmed = await ctx.ui.confirm(
				"Clear session?",
				"This will delete all messages in the current session.",
			);

			if (!confirmed) {
				ctx.ui.notify("Clear cancelled", "info");
				return { cancel: true };
			}
			return;
		}

		// reason === "resume" - check if there are unsaved changes (messages since last assistant response)
		const entries = ctx.sessionManager.getEntries();
		const hasUnsavedWork = entries.some(
			(e): e is SessionMessageEntry => e.type === "message" && e.message.role === "user",
		);

		if (hasUnsavedWork) {
			const confirmed = await ctx.ui.confirm(
				"Switch session?",
				"You have messages in the current session. Switch anyway?",
			);

			if (!confirmed) {
				ctx.ui.notify("Switch cancelled", "info");
				return { cancel: true };
			}
		}
	});

	pi.on("session_before_fork", async (event, ctx) => {
		if (!ctx.hasUI || !isEnabled()) return;

		const choice = await ctx.ui.select(`Fork from entry ${event.entryId.slice(0, 8)}?`, [
			"Yes, create fork",
			"No, stay in current session",
		]);

		if (choice !== "Yes, create fork") {
			ctx.ui.notify("Fork cancelled", "info");
			return { cancel: true };
		}
	});
}
