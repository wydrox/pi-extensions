import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const COMPACT_THRESHOLD_RATIO = 0.95;

export default function (pi: ExtensionAPI) {
	let previousTokens: number | null | undefined;

	const triggerCompaction = (ctx: ExtensionContext, customInstructions?: string) => {
		if (ctx.hasUI) {
			ctx.ui.notify("Compaction started", "info");
		}
		ctx.compact({
			customInstructions,
			onComplete: () => {
				if (ctx.hasUI) {
					ctx.ui.notify("Compaction completed", "info");
				}
			},
			onError: (error) => {
				if (ctx.hasUI) {
					ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
				}
			},
		});
	};

	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		const currentTokens = usage?.tokens ?? null;
		const contextWindow = usage?.contextWindow ?? null;
		if (currentTokens === null || contextWindow === null || contextWindow <= 0) {
			return;
		}

		const compactThresholdTokens = Math.floor(contextWindow * COMPACT_THRESHOLD_RATIO);
		const crossedThreshold =
			previousTokens !== undefined && previousTokens !== null && previousTokens <= compactThresholdTokens;
		previousTokens = currentTokens;
		if (!crossedThreshold || currentTokens <= compactThresholdTokens) {
			return;
		}
		triggerCompaction(ctx);
	});

	pi.registerCommand("trigger-compact", {
		description: "Trigger compaction immediately",
		handler: async (args, ctx) => {
			const instructions = args.trim() || undefined;
			triggerCompaction(ctx, instructions);
		},
	});
}
