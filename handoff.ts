/**
 * Handoff extension - create a clean operational continuation prompt.
 *
 * Unlike compaction, handoff does not try to preserve the whole session.
 * It extracts the current task state, objective, plan, progress/drift signals,
 * and best references while filtering out false starts and stale hypotheses.
 *
 * Usage:
 *   /handoff
 *   /handoff focus on the checkout regression
 *   /handoff continue phase one, do not broaden scope
 *
 * The generated prompt appears as a draft in the editor for review/editing.
 */

import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

const SYSTEM_PROMPT = `You are an operational handoff generator for a coding agent.

Your job is not to compact the session or summarize the conversation. Your job is to create a clean, evidence-weighted starting prompt for a new session that continues the current task without inheriting false starts, stale assumptions, or bad hypotheses.

Use the conversation history only as evidence. Prefer confirmed facts: user decisions, tool results, file paths, test/build output, docs, issue links, and explicit constraints. Omit chronology, debate, speculation, and dead-end reasoning unless mentioning it prevents repeating a mistake.

Rules:
- The output must be self-contained and usable as the first prompt in a new session.
- Do not include a preamble such as "Here is the prompt".
- Do not transfer the whole session scope. Transfer the current task boundary, state, objective, and next move.
- Do not present guesses, plans, or hypotheses as facts. If uncertain, say Unknown or list an open question.
- If a hypothesis was disproved or became risky, include it under Do Not Trust / Rejected Leads with the reason or evidence.
- Include only references that are useful for continuing work.
- Keep it concise, usually 400-900 words.

Required output format:
# Handoff

## Objective
State the current task goal and what done means.

## Task Boundary
State what is in scope and, when known, what is intentionally out of scope.

## Current State
List only verified facts: what exists, what changed, what was checked, and relevant constraints.

## Plan
List the shortest credible plan from here.

## Current Stage / Next Step
State which plan step is active and the immediate next action.

## Progress Signals
Concrete observations, checks, or test results that mean work is moving toward the objective.

## Drift Signals
Concrete observations that mean work is moving away from the objective, broadening scope, or relying on weak evidence.

## Do Not Trust / Rejected Leads
List disproved, stale, or risky hypotheses only if useful. Otherwise write None known.

## Best References
List the best files, tests, commands, docs, issues, user instructions, or other anchors. For each, say why it matters.

## Open Questions
List unresolved questions that block or materially affect the next step. Otherwise write None.`;

const HANDOFF_STATE_TYPE = "handoff-state";
const CARRYOVER_CUSTOM_TYPES = ["todo-state", "ralph-loop-state", "fast-state"] as const;

function isCarryoverCustomType(customType: string): boolean {
	return CARRYOVER_CUSTOM_TYPES.includes(customType as (typeof CARRYOVER_CUSTOM_TYPES)[number]);
}

function collectCarryoverEntries(branch: SessionEntry[]): Array<{ customType: string; data: unknown }> {
	const latest = new Map<string, unknown>();

	for (const entry of branch) {
		if (entry.type === "custom" && isCarryoverCustomType(entry.customType)) {
			latest.set(entry.customType, entry.data);
		}
	}

	return [...latest.entries()].map(([customType, data]) => ({ customType, data }));
}

async function runHandoffCommand(commandName: "handoff", args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(`${commandName} requires interactive mode`, "error");
		return;
	}

	if (!ctx.model) {
		ctx.ui.notify("No model selected", "error");
		return;
	}

	const focus = args.trim();

	// Gather conversation context from current branch before replacing the session.
	const branch = ctx.sessionManager.getBranch();
	const messages = branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);

	if (messages.length === 0) {
		ctx.ui.notify("No conversation to hand off", "error");
		return;
	}

	// Convert to LLM format and serialize.
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	const model = ctx.model;

	// Generate the handoff prompt with loader UI.
	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Generating operational handoff...`);
		loader.onAbort = () => done(null);

		const doGenerate = async () => {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
			}

			const userMessage: Message = {
				role: "user",
				content: [
					{
						type: "text",
						text: `## Conversation History\n\n${conversationText}\n\n## Optional User Focus\n\n${
							focus || "No extra focus provided. Infer the current task from the conversation, and mark ambiguity instead of inventing certainty."
						}`,
					},
				],
				timestamp: Date.now(),
			};

			const response = await complete(
				model,
				{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
				{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
			);

			if (response.stopReason === "aborted") {
				return null;
			}

			return response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		};

		doGenerate()
			.then(done)
			.catch((err) => {
				console.error("Handoff generation failed:", err);
				done(null);
			});

		return loader;
	});

	if (result === null) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	// Let user edit the generated prompt before the old context is dropped.
	const editedPrompt = await ctx.ui.editor("Edit handoff prompt", result);

	if (editedPrompt === undefined) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	const carryoverEntries = collectCarryoverEntries(branch);
	const carriedCustomTypes = carryoverEntries.map((entry) => entry.customType);

	// Create a clean child session: old conversation is not copied, only allowlisted custom state.
	const newSessionResult = await ctx.newSession({
		parentSession: currentSessionFile,
		setup: async (session) => {
			session.appendCustomEntry(HANDOFF_STATE_TYPE, {
				version: 1,
				source: "handoff",
				parentSession: currentSessionFile,
				carriedCustomTypes,
				createdAt: new Date().toISOString(),
			});

			for (const entry of carryoverEntries) {
				session.appendCustomEntry(entry.customType, entry.data);
			}
		},
		withSession: async (newCtx) => {
			const carriedStateMessage = carriedCustomTypes.length > 0
				? ` Carried: ${carriedCustomTypes.join(", ")}.`
				: " No carryover state found.";

			newCtx.ui.setEditorText(editedPrompt);
			newCtx.ui.notify(`Handoff ready. Submit when ready.${carriedStateMessage}`, "info");
		},
	});

	// Do not touch ctx after a successful session replacement. It is stale by design.
	if (newSessionResult.cancelled) {
		return;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Create a clean child-session handoff and carry selected state",
		handler: async (args, ctx) => runHandoffCommand("handoff", args, ctx),
	});


}
