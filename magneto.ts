/**
 * Ralph Orchestrator — Goal-based autonomous loop with phases, subagent tracking,
 * and compaction/handoff support.
 *
 * Coordinates with existing extensions:
 *   - handoff.ts   (session continuation, carries ralph-contract-state)
 *   - todo.ts      (task tracking, source of truth for execution)
 *   - ralph-loop.ts (auto-continue loop)
 *
 * Usage:
 *   /contract start "Refactor auth module"
 *   /contract status
 *   /contract next        (advance phase manually)
 *   /contract handoff     (manual handoff with contract carryover)
 *   /contract reset
 *
 * The LLM can also drive the contract via the work_contract tool.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PhaseName = "expectation" | "execution" | "checks" | "tests" | "summary";

interface Phase {
	name: PhaseName;
	status: "pending" | "active" | "completed" | "blocked";
	expectation?: string;
	plan?: string[];
	criteria: string[];
	verificationResult?: string;
	startedAt?: string;
	completedAt?: string;
}

interface SubagentJob {
	id: string;
	phase: PhaseName;
	task: string;
	agent: string;
	status: "queued" | "running" | "done" | "failed";
	deliverables: string[];
	result?: string;
}

interface WorkContract {
	version: 1;
	id: string;
	goal: string;
	phases: Phase[];
	currentPhaseIndex: number;
	subagentJobs: SubagentJob[];
	metrics: {
		loopsTotal: number;
		handoffsTotal: number;
		subagentsSpawned: number;
		testsPassed: number;
		testsFailed: number;
	};
	createdAt: string;
	updatedAt: string;
}

interface ContractState {
	version: 1;
	enabled: boolean;
	contract?: WorkContract;
	autoHandoffThreshold: number; // context token threshold
	lastHandoffAt?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTRACT_STATE_TYPE = "ralph-contract-state";
const HANDOFF_CARRYOVER_TYPES = ["ralph-contract-state", "ralph-loop-state", "todo-state", "fast-state"];
const PHASE_ORDER: PhaseName[] = ["expectation", "execution", "checks", "tests", "summary"];

const DEFAULT_STATE: ContractState = {
	version: 1,
	enabled: true,
	autoHandoffThreshold: 140_000,
};

const PHASE_PROMPTS: Record<PhaseName, string> = {
	expectation:
		"PHASE: EXPECTATION\n" +
		"Before writing code, draft a clear plan and acceptance criteria.\n" +
		"- Define what 'done' means for this goal.\n" +
		"- List specific, verifiable criteria.\n" +
		"- Identify risks, blockers, and open questions.\n" +
		"- Do NOT start implementation until criteria are solid.\n" +
		"- Use work_contract tool to save the plan and criteria.",

	execution:
		"PHASE: EXECUTION\n" +
		"Implement the plan. Use todo as the source of truth.\n" +
		"- List tasks in todo, update statuses as you work.\n" +
		"- Spawn subagents for parallelizable work (track via work_contract).\n" +
		"- Write tests as you go (TDD preferred).\n" +
		"- Stop only for real blockers, missing data, or business decisions.\n" +
		"- Do not ask whether to continue — keep working while tasks remain.",

	checks:
		"PHASE: CHECKS\n" +
		"Verify the work against acceptance criteria.\n" +
		"- Review each criterion: pass / fail / partial.\n" +
		"- Check for regressions, missing files, and edge cases.\n" +
		"- Run static analysis (lint, typecheck) if available.\n" +
		"- Report gaps explicitly before advancing.",

	tests:
		"PHASE: TESTS\n" +
		"Run the full test suite and fix failures.\n" +
		"- build, lint, typecheck, unit tests, integration tests.\n" +
		"- Update metrics in work_contract (testsPassed / testsFailed).\n" +
		"- Do not advance until tests are green or explicitly skipped with reason.",

	summary:
		"PHASE: SUMMARY\n" +
		"Summarize outcomes and prepare continuity context.\n" +
		"- What was done, what was decided, what was deferred.\n" +
		"- List best references (files, commits, docs).\n" +
		"- List open questions and next steps.\n" +
		"- Prepare a concise handoff prompt for future sessions.",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
	return new Date().toISOString();
}

function makeId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function createEmptyPhases(): Phase[] {
	return PHASE_ORDER.map((name) => ({
		name,
		status: name === "expectation" ? "active" : "pending",
		criteria: [],
	}));
}

function createContract(goal: string): WorkContract {
	return {
		version: 1,
		id: makeId(),
		goal,
		phases: createEmptyPhases(),
		currentPhaseIndex: 0,
		subagentJobs: [],
		metrics: {
			loopsTotal: 0,
			handoffsTotal: 0,
			subagentsSpawned: 0,
			testsPassed: 0,
			testsFailed: 0,
		},
		createdAt: nowIso(),
		updatedAt: nowIso(),
	};
}

function currentPhase(contract: WorkContract): Phase | undefined {
	return contract.phases[contract.currentPhaseIndex];
}

function formatContractShort(contract?: WorkContract): string {
	if (!contract) return "no contract";
	const phase = currentPhase(contract);
	const phaseName = phase?.name ?? "?";
	const phaseStatus = phase?.status ?? "?";
	const jobs = contract.subagentJobs.filter((j) => j.status === "running").length;
	return `${contract.goal.slice(0, 40)} | phase=${phaseName}(${phaseStatus}) | jobs=${jobs} | handoffs=${contract.metrics.handoffsTotal}`;
}

function formatContractDetailed(contract?: WorkContract): string {
	if (!contract) return "No active contract. Start one with /contract start <goal>";

	const lines: string[] = [
		`# Work Contract`,
		`Goal: ${contract.goal}`,
		`ID: ${contract.id}`,
		`Created: ${contract.createdAt}`,
		`Handoffs: ${contract.metrics.handoffsTotal} | Subagents: ${contract.metrics.subagentsSpawned}`,
		`Tests: ${contract.metrics.testsPassed} passed, ${contract.metrics.testsFailed} failed`,
		``,
		`## Phases`,
	];

	for (let i = 0; i < contract.phases.length; i++) {
		const p = contract.phases[i];
		const marker = i === contract.currentPhaseIndex ? ">>>" : p.status === "completed" ? "[✓]" : "[ ]";
		lines.push(`${marker} ${p.name}: ${p.status}`);
		if (p.criteria.length) {
			for (const c of p.criteria) lines.push(`    - ${c}`);
		}
		if (p.plan?.length) {
			lines.push(`    Plan:`);
			for (const step of p.plan) lines.push(`      - ${step}`);
		}
		if (p.verificationResult) {
			lines.push(`    Result: ${p.verificationResult}`);
		}
	}

	const activeJobs = contract.subagentJobs.filter((j) => j.status === "running" || j.status === "queued");
	if (activeJobs.length) {
		lines.push(``);
		lines.push(`## Active Subagent Jobs`);
		for (const j of activeJobs) {
			lines.push(`- [${j.status}] ${j.agent}: ${j.task.slice(0, 60)}`);
		}
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let state: ContractState = { ...DEFAULT_STATE };

	const persist = () => {
		pi.appendEntry(CONTRACT_STATE_TYPE, state);
	};

	const hydrate = (ctx: ExtensionContext) => {
		state = { ...DEFAULT_STATE };
		let found = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CONTRACT_STATE_TYPE) {
				if (entry.data && typeof entry.data === "object") {
					state = { ...state, ...(entry.data as Partial<ContractState>) };
					found = true;
				}
			}
		}
		return found;
	};

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" | "success" = "info") => {
		try {
			ctx.ui.notify(message, level);
		} catch {
			// no-op outside interactive mode
		}
	};

	const advancePhase = (contract: WorkContract, verification?: string): boolean => {
		const phase = contract.phases[contract.currentPhaseIndex];
		if (!phase) return false;

		phase.status = "completed";
		phase.completedAt = nowIso();
		if (verification) phase.verificationResult = verification;

		const nextIndex = contract.currentPhaseIndex + 1;
		if (nextIndex >= contract.phases.length) {
			contract.updatedAt = nowIso();
			return true; // all done
		}

		contract.phases[nextIndex].status = "active";
		contract.phases[nextIndex].startedAt = nowIso();
		contract.currentPhaseIndex = nextIndex;
		contract.updatedAt = nowIso();
		return true;
	};

	// ---------------------------------------------------------------------------
	// Event hooks
	// ---------------------------------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		const found = hydrate(ctx);

		if ((event.reason === "new" || event.reason === "fork") && !found) {
			state.enabled = true;
			state.contract = undefined;
			persist();
		}

		if (state.contract) {
			notify(ctx, `Contract loaded: ${formatContractShort(state.contract)}`, "info");
		} else {
			notify(ctx, "Orchestrator ready. No active contract.", "info");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		hydrate(ctx);
		if (state.contract) {
			notify(ctx, `Contract restored: ${formatContractShort(state.contract)}`, "info");
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.enabled || !state.contract) return;

		const contract = state.contract;
		const phase = currentPhase(contract);
		const phasePrompt = phase ? PHASE_PROMPTS[phase.name] : "";

		const contractContext = [
			`\n\n## Work Contract`,
			`Goal: ${contract.goal}`,
			`Current phase: ${phase?.name ?? "unknown"} (${phase?.status ?? "unknown"})`,
			`Handoffs so far: ${contract.metrics.handoffsTotal}`,
			`\n${phasePrompt}`,
			`\nUse the work_contract tool to update progress, advance phases, or register subagent jobs.`,
		].join("\n");

		return {
			systemPrompt: event.systemPrompt + contractContext,
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!state.enabled || !state.contract) return;

		const contract = state.contract;
		contract.metrics.loopsTotal += 1;
		persist();

		// Context pressure check
		const usage = ctx.getContextUsage?.();
		if (usage && usage.tokens > state.autoHandoffThreshold) {
			notify(
				ctx,
				`Context at ${usage.tokens} tokens. Consider /contract handoff to continue in a fresh session.`,
				"warning",
			);
		}
	});

	// ---------------------------------------------------------------------------
	// Tools
	// ---------------------------------------------------------------------------

	pi.registerTool({
		name: "work_contract",
		label: "Work Contract",
		description:
			"Manage the active work contract: update phases, criteria, plans, metrics, or register subagent jobs.",
		promptSnippet: "Update the work contract with progress, phase changes, or job tracking.",
		parameters: Type.Object({
			action: StringEnum([
				"init",
				"update_phase",
				"advance",
				"add_job",
				"update_job",
				"update_metrics",
				"get_status",
			] as const),
			goal: Type.Optional(Type.String({ description: "Goal text (for init)" })),
			phase_name: Type.Optional(StringEnum(PHASE_ORDER)),
			expectation: Type.Optional(Type.String({ description: "Phase expectation / acceptance criteria summary" })),
			plan: Type.Optional(Type.Array(Type.String(), { description: "Plan steps for current phase" })),
			criteria: Type.Optional(Type.Array(Type.String(), { description: "Acceptance criteria" })),
			verification: Type.Optional(Type.String({ description: "Verification result when advancing" })),
			job_id: Type.Optional(Type.String()),
			job_task: Type.Optional(Type.String()),
			job_agent: Type.Optional(Type.String()),
			job_status: Type.Optional(StringEnum(["queued", "running", "done", "failed"] as const)),
			job_result: Type.Optional(Type.String()),
			job_deliverables: Type.Optional(Type.Array(Type.String())),
			tests_passed: Type.Optional(Type.Integer()),
			tests_failed: Type.Optional(Type.Integer()),
		}),

		async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				return {
					content: [{ type: "text", text: "Orchestrator is disabled. Enable with /contract enable" }],
					details: { action: args.action, error: "disabled" },
				};
			}

			const action = args.action;

			// ---- init ----
			if (action === "init") {
				if (!args.goal?.trim()) {
					return {
						content: [{ type: "text", text: "❌ init requires goal" }],
						details: { action, error: "missing goal" },
					};
				}
				state.contract = createContract(args.goal.trim());
				persist();
				return {
					content: [{ type: "text", text: `Contract initialized: ${state.contract.goal}\nCurrent phase: expectation` }],
					details: { action, contract: state.contract },
				};
			}

			// ---- get_status ----
			if (action === "get_status") {
				const text = formatContractDetailed(state.contract);
				return {
					content: [{ type: "text", text }],
					details: { action, contract: state.contract },
				};
			}

			// All other actions require a contract
			if (!state.contract) {
				return {
					content: [{ type: "text", text: "No active contract. Call work_contract with action=init first." }],
					details: { action, error: "no contract" },
				};
			}

			const contract = state.contract;

			// ---- update_phase ----
			if (action === "update_phase") {
				const phaseName = args.phase_name as PhaseName | undefined;
				const target = phaseName
					? contract.phases.find((p) => p.name === phaseName)
					: currentPhase(contract);

				if (!target) {
					return {
						content: [{ type: "text", text: `Phase not found: ${phaseName ?? "current"}` }],
						details: { action, error: "phase not found" },
					};
				}

				if (args.expectation) target.expectation = args.expectation;
				if (args.plan) target.plan = args.plan;
				if (args.criteria) target.criteria = args.criteria;
				contract.updatedAt = nowIso();
				persist();

				return {
					content: [{ type: "text", text: `Updated phase ${target.name}. Criteria: ${target.criteria.length}` }],
					details: { action, phase: target },
				};
			}

			// ---- advance ----
			if (action === "advance") {
				const previousPhase = currentPhase(contract);
				const advanced = advancePhase(contract, args.verification);
				if (!advanced) {
					return {
						content: [{ type: "text", text: "Could not advance phase." }],
						details: { action, error: "advance failed" },
					};
				}
				persist();

				const newPhase = currentPhase(contract);
				const text = previousPhase?.name === "summary"
					? `All phases complete. Contract finished.`
					: `Advanced from ${previousPhase?.name} to ${newPhase?.name}.`;

				return {
					content: [{ type: "text", text }],
					details: { action, previousPhase: previousPhase?.name, newPhase: newPhase?.name, contract },
				};
			}

			// ---- add_job ----
			if (action === "add_job") {
				if (!args.job_task || !args.job_agent) {
					return {
						content: [{ type: "text", text: "❌ add_job requires job_task and job_agent" }],
						details: { action, error: "missing fields" },
					};
				}
				const phase = currentPhase(contract);
				const job: SubagentJob = {
					id: args.job_id || makeId(),
					phase: phase?.name ?? "execution",
					task: args.job_task,
					agent: args.job_agent,
					status: args.job_status ?? "queued",
					deliverables: args.job_deliverables ?? [],
				};
				contract.subagentJobs.push(job);
				contract.metrics.subagentsSpawned += 1;
				contract.updatedAt = nowIso();
				persist();

				return {
					content: [{ type: "text", text: `Registered subagent job ${job.id} (${job.agent}): ${job.task.slice(0, 60)}` }],
					details: { action, job },
				};
			}

			// ---- update_job ----
			if (action === "update_job") {
				if (!args.job_id) {
					return {
						content: [{ type: "text", text: "❌ update_job requires job_id" }],
						details: { action, error: "missing job_id" },
					};
				}
				const job = contract.subagentJobs.find((j) => j.id === args.job_id);
				if (!job) {
					return {
						content: [{ type: "text", text: `Job not found: ${args.job_id}` }],
						details: { action, error: "job not found" },
					};
				}
				if (args.job_status) job.status = args.job_status;
				if (args.job_result) job.result = args.job_result;
				if (args.job_deliverables) job.deliverables = args.job_deliverables;
				contract.updatedAt = nowIso();
				persist();

				return {
					content: [{ type: "text", text: `Updated job ${job.id}: status=${job.status}` }],
					details: { action, job },
				};
			}

			// ---- update_metrics ----
			if (action === "update_metrics") {
				if (args.tests_passed !== undefined) contract.metrics.testsPassed = args.tests_passed;
				if (args.tests_failed !== undefined) contract.metrics.testsFailed = args.tests_failed;
				contract.updatedAt = nowIso();
				persist();
				return {
					content: [{ type: "text", text: `Metrics updated. Tests: ${contract.metrics.testsPassed} passed, ${contract.metrics.testsFailed} failed.` }],
					details: { action, metrics: contract.metrics },
				};
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${action}` }],
				details: { action, error: "unknown action" },
			};
		},
	});

	// ---------------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------------

	pi.registerCommand("contract", {
		description: "Manage the work contract (start, status, next, handoff, reset, enable, disable)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;

			const [cmd, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const command = (cmd || "status").toLowerCase();
			const restText = rest.join(" ");

			switch (command) {
				case "start": {
					if (!restText) {
						ctx.ui.notify("Usage: /contract start <goal>", "warning");
						return;
					}
					state.contract = createContract(restText);
					persist();
					ctx.ui.notify(`Contract started: ${state.contract.goal}`, "success");
					return;
				}

				case "status": {
					const text = formatContractDetailed(state.contract);
					ctx.ui.setEditorText(text);
					ctx.ui.notify("Contract status shown in editor", "info");
					return;
				}

				case "next": {
					if (!state.contract) {
						ctx.ui.notify("No active contract", "warning");
						return;
					}
					const prev = currentPhase(state.contract);
					advancePhase(state.contract);
					persist();
					const next = currentPhase(state.contract);
					if (prev?.name === "summary") {
						ctx.ui.notify("Contract complete!", "success");
					} else {
						ctx.ui.notify(`Advanced: ${prev?.name} → ${next?.name}`, "info");
					}
					return;
				}

				case "handoff": {
					if (!state.contract) {
						ctx.ui.notify("No active contract to handoff", "warning");
						return;
					}
					const currentSessionFile = ctx.sessionManager.getSessionFile();
					if (!currentSessionFile) {
						ctx.ui.notify("No session file", "error");
						return;
					}

					state.contract.metrics.handoffsTotal += 1;
					state.lastHandoffAt = nowIso();
					persist();

					const contract = state.contract;
					const phase = currentPhase(contract);

					const handoffPrompt = [
						`# Work Contract Handoff`,
						`Goal: ${contract.goal}`,
						`Phase: ${phase?.name ?? "unknown"} (${phase?.status ?? "unknown"})`,
						`Handoff #${contract.metrics.handoffsTotal}`,
						``, // contract summary
						`## Progress`,
						...contract.phases.map((p) => `- ${p.name}: ${p.status}${p.verificationResult ? ` — ${p.verificationResult}` : ""}`),
						``, // open items
						`## Active Jobs`,
						...contract.subagentJobs
							.filter((j) => j.status === "running" || j.status === "queued")
							.map((j) => `- [${j.status}] ${j.agent}: ${j.task}`),
						``, // criteria
						`## Current Phase Criteria`,
						...(phase?.criteria.length ? phase.criteria.map((c) => `- ${c}`) : ["None defined yet."]),
						``, // next steps
						`## Next Steps`,
						`Continue working on the current phase. Use todo as source of truth.`,
					].join("\n");

					const newSessionResult = await ctx.newSession({
						parentSession: currentSessionFile,
						setup: async (session) => {
							for (const type of HANDOFF_CARRYOVER_TYPES) {
								// Find latest custom entry of each type in current branch
								const branch = ctx.sessionManager.getBranch();
								for (let i = branch.length - 1; i >= 0; i--) {
									const entry = branch[i];
									if (entry.type === "custom" && entry.customType === type) {
										session.appendCustomEntry(type, entry.data);
										break;
									}
								}
							}
						},
						withSession: async (newCtx) => {
							newCtx.ui.setEditorText(handoffPrompt);
							newCtx.ui.notify(`Handoff #${contract.metrics.handoffsTotal} ready. Submit to continue.`, "info");
						},
					});

					if (newSessionResult.cancelled) {
						ctx.ui.notify("Handoff cancelled", "warning");
					}
					return;
				}

				case "reset": {
					state.contract = undefined;
					persist();
					ctx.ui.notify("Contract reset", "info");
					return;
				}

				case "enable": {
					state.enabled = true;
					persist();
					ctx.ui.notify("Orchestrator enabled", "success");
					return;
				}

				case "disable": {
					state.enabled = false;
					persist();
					ctx.ui.notify("Orchestrator disabled", "warning");
					return;
				}

				case "threshold": {
					const n = Number(restText);
					if (!Number.isFinite(n) || n < 1) {
						ctx.ui.notify("Usage: /contract threshold <token-count>", "warning");
						return;
					}
					state.autoHandoffThreshold = Math.floor(n);
					persist();
					ctx.ui.notify(`Handoff threshold set to ${state.autoHandoffThreshold} tokens`, "info");
					return;
				}

				default: {
					ctx.ui.notify(
						"Usage: /contract [start|status|next|handoff|reset|enable|disable|threshold]",
						"warning",
					);
				}
			}
		},
	});
}
