import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function shortenHome(path: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function colorizeOhMyZshPath(path: string, theme: any): string {
	const displayPath = shortenHome(path);
	const isAbsolute = displayPath.startsWith("/");
	const parts = displayPath.split("/").filter(Boolean);

	if (displayPath === "/") return theme.fg("accent", "/");
	if (displayPath === "~") return theme.fg("success", "~");

	let prefix = "";
	if (displayPath.startsWith("~/")) {
		prefix = theme.fg("success", "~") + theme.fg("dim", "/");
		parts.shift();
	} else if (isAbsolute) {
		prefix = theme.fg("dim", "/");
	}

	return (
		prefix +
		parts
			.map((part, index) => {
				const isLast = index === parts.length - 1;
				const colored = isLast ? theme.bold(theme.fg("accent", part)) : theme.fg("muted", part);
				return index === 0 ? colored : theme.fg("dim", "/") + colored;
			})
			.join("")
	);
}

export default function statusBarExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					let cost = 0;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const message = entry.message as AssistantMessage;
							input += message.usage.input;
							output += message.usage.output;
							cacheRead += message.usage.cacheRead;
							cacheWrite += message.usage.cacheWrite;
							cost += message.usage.cost.total;
						}
					}

					const branch = footerData.getGitBranch();
					const sessionName = ctx.sessionManager.getSessionName();
					const branchPart = branch ? ` ${theme.fg("warning", `(${branch})`)}` : "";
					const sessionPart = sessionName ? ` ${theme.fg("dim", "•")} ${theme.fg("muted", sessionName)}` : "";
					const pathLine = truncateToWidth(
						colorizeOhMyZshPath(ctx.cwd, theme) + branchPart + sessionPart,
						width,
						theme.fg("dim", "..."),
					);

					const usage = ctx.getContextUsage();
					const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const percent = usage?.percent;
					const contextText =
						percent === null || percent === undefined
							? `?/${formatTokens(contextWindow)}`
							: `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
					const contextColored =
						(percent ?? 0) > 90
							? theme.fg("error", contextText)
							: (percent ?? 0) > 80
								? theme.fg("warning", contextText)
								: contextText;

					const statsParts = [];
					if (input) statsParts.push(`↑${formatTokens(input)}`);
					if (output) statsParts.push(`↓${formatTokens(output)}`);
					if (cacheRead) statsParts.push(`R${formatTokens(cacheRead)}`);
					if (cacheWrite) statsParts.push(`W${formatTokens(cacheWrite)}`);
					if (cost) statsParts.push(`$${cost.toFixed(3)}`);
					statsParts.push(contextColored);

					const left = statsParts.join(" ");
					const model = ctx.model?.id ?? "no-model";
					const branchEntries = ctx.sessionManager.getBranch();
					const lastThinking = [...branchEntries]
						.reverse()
						.find((entry) => entry.type === "thinking_level_change") as { thinkingLevel?: string } | undefined;
					const thinkingLevel = lastThinking?.thinkingLevel ?? "off";
					const right = `${model}${ctx.model?.reasoning ? ` • ${thinkingLevel}` : ""}`;
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					const statsLine = truncateToWidth(theme.fg("dim", left + pad + right), width, theme.fg("dim", "..."));

					const statusTexts = Array.from(footerData.getExtensionStatuses().entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
						.filter(Boolean);

					return statusTexts.length
						? [pathLine, statsLine, truncateToWidth(statusTexts.join(" "), width, theme.fg("dim", "..."))]
						: [pathLine, statsLine];
				},
			};
		});
	});
}
