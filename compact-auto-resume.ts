import { compact as generateDefaultCompaction, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MAX_CONTINUE_PREVIEW = 2_500;

interface ContinuationDetails {
	autoResume: true;
	version: 1;
	source: "compact-auto-resume";
	[key: string]: unknown;
}

let manualCompactRequested = false;
let manualCompactTimer: ReturnType<typeof setTimeout> | undefined;

const markManualCompactRequest = () => {
	manualCompactRequested = true;
	if (manualCompactTimer) {
		clearTimeout(manualCompactTimer);
	}
	manualCompactTimer = setTimeout(() => {
		manualCompactRequested = false;
		manualCompactTimer = undefined;
	}, 20_000);
};

const trimText = (text: string, limit: number): string => {
	if (text.length <= limit) return text;
	return `${text.slice(0, 200)}... [compact snippet] ...${text.slice(-(limit - 220))}`;
};

const createContinuationPrompt = (summary: string): string => {
	const compactSummary = trimText(summary.trim(), MAX_CONTINUE_PREVIEW);
	return [
		"AUTO-COMPACT CONTINUATION:",
		"The last context was compacted automatically.",
		"Continue work from the summary below without asking for prior details:",
		"",
		compactSummary,
		"",
		"If there is an open task, proceed with the most important next step and report what changed.",
		"If something is impossible to continue, ask one short clarification question.",
	].join("\n");
};

const isCompactCommand = (text: string): boolean => {
	const trimmed = text.trim();
	return /^\/compact(?:\s|$)/.test(trimmed);
};

const hasAutoResumeDetails = (details: unknown): details is ContinuationDetails => {
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		return false;
	}

	const candidate = details as Partial<ContinuationDetails>;
	return candidate.autoResume === true && candidate.source === "compact-auto-resume" && candidate.version === 1;
};

export default function (pi: ExtensionAPI) {
	pi.on("input", (event) => {
		if (isCompactCommand(event.text)) {
			markManualCompactRequest();
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		// Only add the continuation marker for automatic compaction.
		// Manual /compact calls are tracked via input event and should stay untouched.
		const isManualCompact = manualCompactRequested || Boolean(event.customInstructions);
		manualCompactRequested = false;
		if (manualCompactTimer) {
			clearTimeout(manualCompactTimer);
			manualCompactTimer = undefined;
		}

		if (isManualCompact) {
			return;
		}

		if (!ctx.model) {
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) {
			return;
		}

		try {
			const result = await generateDefaultCompaction(
				event.preparation,
				ctx.model,
				auth.apiKey,
				auth.headers,
				undefined,
				event.signal,
			);

			const baseDetails =
				typeof result.details === "object" && result.details !== null && !Array.isArray(result.details)
					? (result.details as Record<string, unknown>)
					: ({} as Record<string, unknown>);

			return {
				compaction: {
					summary: result.summary,
					firstKeptEntryId: result.firstKeptEntryId,
					tokensBefore: result.tokensBefore,
					details: {
						...baseDetails,
						autoResume: true,
						version: 1,
						source: "compact-auto-resume",
					} as ContinuationDetails,
				},
			};
		} catch (error) {
			if (ctx.hasUI && error instanceof Error && error.name !== "AbortError") {
				ctx.ui.notify(`Auto-resume compaction failed: ${error.message}`, "warning");
			}
			return;
		}
	});

	pi.on("session_compact", async (event, ctx) => {
		const details = event.compactionEntry?.details;
		const shouldAutoResume = hasAutoResumeDetails(details);
		if (!shouldAutoResume) {
			return;
		}

		if (ctx.hasUI) {
			ctx.ui.notify("Auto compacted. Sending continuation cue…", "info");
		}

		const continuationPrompt = createContinuationPrompt(event.compactionEntry.summary ?? "");
		await pi.sendUserMessage(continuationPrompt, { deliverAs: "followUp" });
	});

	pi.registerCommand("compact-resume", {
		description: "Trigger a resume continuation message from last auto-compact summary",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const lastCompaction = [...branch]
				.reverse()
				.find((entry) => {
					if (entry.type !== "compaction") {
						return false;
					}
					return hasAutoResumeDetails((entry as { details?: unknown }).details);
				});

			if (!lastCompaction || lastCompaction.type !== "compaction") {
				if (ctx.hasUI) {
					ctx.ui.notify("No auto-compact continuation summary found.", "warning");
				}
				return;
			}

			await pi.sendUserMessage(
				createContinuationPrompt((lastCompaction as { summary?: string }).summary ?? ""),
				{ deliverAs: "followUp" },
			);

			if (ctx.hasUI) {
				ctx.ui.notify("Sent continuation prompt to continue work.", "info");
			}
		},
	});
}
