/**
 * Magneto — long-running execution supervisor / control plane for pi.
 *
 * Magneto is intentionally not a todo app and not a worker loop.
 * It supervises very long sessions by maintaining a cross-domain contract,
 * watching tactical execution signals, enforcing quality/skill policies,
 * tracking subagent allocation, and preserving continuity across compact/handoff.
 *
 * Integrates with, but does not replace:
 *   - todo.ts       tactical work queue / local task status
 *   - ralph-loop.ts worker auto-continue motor
 *   - subagent/     execution pool
 *   - handoff.ts    continuity mechanism
 *   - skills        superpowers, frontend-design, design-reviewer, council, etc.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

type GoalStatus = "planned" | "active" | "done" | "blocked" | "dropped";
type EvidenceKind = "test" | "review" | "council" | "design_review" | "tooluse" | "handoff" | "decision" | "log" | "subagent" | "manual";
type EvidenceStatus = "pass" | "fail" | "partial" | "unknown";
type JobStatus = "queued" | "running" | "done" | "failed" | "blocked" | "cancelled";
type RiskStatus = "open" | "mitigated" | "accepted" | "closed";
type InterventionSeverity = "info" | "warning" | "critical";
type MagnetoMode = "observe" | "supervise" | "strict";
type Domain = "code" | "frontend" | "design" | "infra" | "research" | "refactor" | "data" | "docs" | "unknown";

interface Goal {
	id: string;
	text: string;
	status: GoalStatus;
	priority: number;
	progress: number; // 0-100
	outcomeIds: string[];
	notes?: string;
}

interface Outcome {
	id: string;
	text: string;
	status: GoalStatus;
	criteria: string[];
	evidenceIds: string[];
	progress: number; // 0-100
}

interface QualityBar {
	domain: Domain;
	requiredEvidence: EvidenceKind[];
	checks: string[];
	status: EvidenceStatus;
	notes?: string;
}

interface SkillPolicy {
	domain: Domain;
	when: string;
	recommend: string[];
	required?: string[];
	notes?: string;
}

interface Evidence {
	id: string;
	kind: EvidenceKind;
	status: EvidenceStatus;
	summary: string;
	refs: string[];
	createdAt: string;
}

interface SubagentJob {
	id: string;
	title: string;
	agent: string;
	status: JobStatus;
	priority: number;
	dependsOn: string[];
	todoIds: number[];
	evidenceIds: string[];
	deliverables: string[];
	result?: string;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
}

interface Risk {
	id: string;
	text: string;
	status: RiskStatus;
	severity: InterventionSeverity;
	mitigation?: string;
	createdAt: string;
}

interface Blocker {
	id: string;
	text: string;
	owner: "user" | "agent" | "subagent" | "external";
	status: "open" | "resolved" | "accepted";
	createdAt: string;
	resolvedAt?: string;
}

interface Decision {
	id: string;
	text: string;
	rationale?: string;
	createdAt: string;
}

interface Intervention {
	id: string;
	severity: InterventionSeverity;
	reason: string;
	recommendation: string;
	createdAt: string;
	resolvedAt?: string;
}

interface ProgressModel {
	goalCompletion: number; // 0-100, strategic outcome completion
	contractFit: number; // 0-100, execution fit against contract/constraints
	qualityCoverage: number; // 0-100, required evidence coverage
	executionHealth: number; // 0-100, tool/subagent/todo health
	parallelism: number; // running jobs / capacity * 100
	summary: string;
	updatedAt: string;
}

interface ToolUseHealth {
	totalCalls: number;
	failedCalls: number;
	repeatedFailures: number;
	suspiciousPatterns: string[];
	recent: Array<{ toolName: string; ok: boolean; signature: string; at: string }>;
}

interface TodoSnapshot {
	total: number;
	todo: number;
	inprogress: number;
	done: number;
	blocked: number;
	skipping: number;
	source: string;
	updatedAt: string;
}

interface MagnetoContract {
	version: 2;
	id: string;
	mission: string;
	domains: Domain[];
	goals: Goal[];
	outcomes: Outcome[];
	constraints: string[];
	nonGoals: string[];
	qualityBars: QualityBar[];
	skillPolicy: SkillPolicy[];
	delegationPolicy: {
		maxParallelSubagents: number;
		preferParallel: boolean;
		notes?: string;
	};
	evidence: Evidence[];
	subagentJobs: SubagentJob[];
	risks: Risk[];
	blockers: Blocker[];
	decisions: Decision[];
	interventions: Intervention[];
	progress: ProgressModel;
	createdAt: string;
	updatedAt: string;
}

interface MagnetoState {
	version: 2;
	mode: MagnetoMode;
	enabled: boolean;
	autoCompact: boolean;
	compactTokenThreshold: number;
	handoffTokenThreshold: number;
	contract?: MagnetoContract;
	lastTodoSnapshot?: TodoSnapshot;
	toolUse: ToolUseHealth;
	lastAuditAt?: string;
	lastHandoffAt?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAGNETO_STATE_TYPE = "magneto-state";
const LEGACY_CONTRACT_STATE_TYPE = "ralph-contract-state";
const CARRYOVER_TYPES = [MAGNETO_STATE_TYPE, LEGACY_CONTRACT_STATE_TYPE, "todo-state", "ralph-loop-state", "fast-state"];
const MAX_RECENT_TOOL_CALLS = 40;
const MAX_INTERVENTIONS = 80;
const MAX_EVIDENCE = 200;

const DEFAULT_STATE: MagnetoState = {
	version: 2,
	mode: "supervise",
	enabled: true,
	autoCompact: false,
	compactTokenThreshold: 120_000,
	handoffTokenThreshold: 145_000,
	toolUse: {
		totalCalls: 0,
		failedCalls: 0,
		repeatedFailures: 0,
		suspiciousPatterns: [],
		recent: [],
	},
};

const DEFAULT_SKILL_POLICY: SkillPolicy[] = [
	{
		domain: "code",
		when: "non-trivial coding, refactors, multi-file changes, risky fixes",
		recommend: ["superpowers-for-pi"],
		notes: "Use repo recon, working spec, plan, incremental verification, and review.",
	},
	{
		domain: "frontend",
		when: "landing pages, product UI, app UI, visual polish, responsive layout",
		recommend: ["frontend-design-pro", "frontend-skill"],
		required: ["design-reviewer"],
		notes: "Require design review for user-visible UI before final summary.",
	},
	{
		domain: "design",
		when: "implementation from Figma, screenshots, visual QA, or UI refinements",
		recommend: ["figma_get_design_context", "design-reviewer"],
	},
	{
		domain: "research",
		when: "claims need external evidence or current information",
		recommend: ["exasearch", "council"],
	},
	{
		domain: "infra",
		when: "deployment, platform CLI, migrations, cloud resources",
		recommend: ["platform-clis", "council"],
		notes: "Use dry runs and explicit validation before destructive changes.",
	},
];

const DEFAULT_QUALITY_BARS: QualityBar[] = [
	{
		domain: "code",
		requiredEvidence: ["test", "review"],
		checks: ["repo evidence inspected", "implementation scoped", "tests/build/lint considered", "final diff reviewed"],
		status: "unknown",
	},
	{
		domain: "frontend",
		requiredEvidence: ["design_review", "test"],
		checks: ["responsive states checked", "visual QA against intent", "accessibility basics considered"],
		status: "unknown",
	},
	{
		domain: "research",
		requiredEvidence: ["council", "manual"],
		checks: ["sources cited", "uncertainty preserved", "decision pressure-tested when expensive"],
		status: "unknown",
	},
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Enum<T extends readonly string[]>(values: T) {
	return StringEnum(values) as any;
}

function nowIso(): string {
	return new Date().toISOString();
}

function makeId(prefix = "m"): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampScore(value: unknown, fallback = 0): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(0, Math.min(100, Math.round(n)));
}

function asArrayOfStrings(input: unknown): string[] {
	return Array.isArray(input) ? input.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];
}

function uniq<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function safeJson(value: unknown, max = 500): string {
	try {
		return JSON.stringify(value).slice(0, max);
	} catch {
		return String(value).slice(0, max);
	}
}

function inferDomains(text: string): Domain[] {
	const lower = text.toLowerCase();
	const domains: Domain[] = [];
	if (/frontend|ui|ux|figma|design|css|responsive|landing|screen|visual/.test(lower)) domains.push("frontend", "design");
	if (/deploy|vercel|supabase|cloud|terraform|infra|migration|database|convex|wrangler/.test(lower)) domains.push("infra");
	if (/research|compare|investigate|sources|evidence|market|benchmark/.test(lower)) domains.push("research");
	if (/refactor|cleanup|rewrite|architecture|modular/.test(lower)) domains.push("refactor", "code");
	if (/docs|readme|documentation/.test(lower)) domains.push("docs");
	if (/data|memory|graph|database|etl|extract/.test(lower)) domains.push("data");
	if (!domains.includes("code")) domains.push("code");
	return uniq(domains.length ? domains : ["unknown"]);
}

function createProgress(summary = "Contract initialized; strategic progress not audited yet."): ProgressModel {
	return {
		goalCompletion: 0,
		contractFit: 100,
		qualityCoverage: 0,
		executionHealth: 100,
		parallelism: 0,
		summary,
		updatedAt: nowIso(),
	};
}

function createContract(mission: string, inputs?: Partial<MagnetoContract>): MagnetoContract {
	const domains = inputs?.domains?.length ? inputs.domains : inferDomains(mission);
	const primaryGoal: Goal = {
		id: makeId("goal"),
		text: mission,
		status: "active",
		priority: 1,
		progress: 0,
		outcomeIds: [],
	};

	return {
		version: 2,
		id: makeId("contract"),
		mission,
		domains,
		goals: inputs?.goals?.length ? inputs.goals : [primaryGoal],
		outcomes: inputs?.outcomes ?? [],
		constraints: inputs?.constraints ?? [],
		nonGoals: inputs?.nonGoals ?? [],
		qualityBars: inputs?.qualityBars?.length ? inputs.qualityBars : DEFAULT_QUALITY_BARS.filter((bar) => domains.includes(bar.domain) || bar.domain === "code"),
		skillPolicy: inputs?.skillPolicy?.length ? inputs.skillPolicy : DEFAULT_SKILL_POLICY.filter((policy) => domains.includes(policy.domain) || policy.domain === "code"),
		delegationPolicy: inputs?.delegationPolicy ?? {
			maxParallelSubagents: 4,
			preferParallel: true,
		},
		evidence: inputs?.evidence ?? [],
		subagentJobs: inputs?.subagentJobs ?? [],
		risks: inputs?.risks ?? [],
		blockers: inputs?.blockers ?? [],
		decisions: inputs?.decisions ?? [],
		interventions: inputs?.interventions ?? [],
		progress: inputs?.progress ?? createProgress(),
		createdAt: inputs?.createdAt ?? nowIso(),
		updatedAt: nowIso(),
	};
}

function createEvidence(kind: EvidenceKind, status: EvidenceStatus, summary: string, refs: string[] = []): Evidence {
	return { id: makeId("ev"), kind, status, summary, refs, createdAt: nowIso() };
}

function addIntervention(contract: MagnetoContract, severity: InterventionSeverity, reason: string, recommendation: string): Intervention {
	const intervention: Intervention = { id: makeId("int"), severity, reason, recommendation, createdAt: nowIso() };
	contract.interventions.unshift(intervention);
	contract.interventions = contract.interventions.slice(0, MAX_INTERVENTIONS);
	contract.updatedAt = nowIso();
	return intervention;
}

function summarizeTodoFromData(data: any, source: string): TodoSnapshot | undefined {
	if (!data || typeof data !== "object") return undefined;
	const todos = Array.isArray(data.todos) ? data.todos : Array.isArray(data.items) ? data.items : undefined;
	if (!todos) return undefined;

	const counts = { todo: 0, inprogress: 0, done: 0, blocked: 0, skipping: 0 };
	for (const item of todos) {
		const raw = String(item?.status ?? (item?.done ? "done" : "todo")).toLowerCase().replace(/[\s-]+/g, "");
		if (raw === "inprogress" || raw === "in_progress" || raw === "doing") counts.inprogress += 1;
		else if (raw === "done" || raw === "complete" || raw === "completed") counts.done += 1;
		else if (raw === "blocked" || raw === "waiting") counts.blocked += 1;
		else if (raw === "skipping" || raw === "skipped" || raw === "skip") counts.skipping += 1;
		else counts.todo += 1;
	}

	return {
		total: todos.length,
		...counts,
		source,
		updatedAt: nowIso(),
	};
}

function latestCustomEntry(branch: SessionEntry[], customType: string): { customType: string; data: unknown } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === customType) {
			return { customType, data: entry.data };
		}
	}
	return undefined;
}

function getTodoSnapshot(branch: SessionEntry[]): TodoSnapshot | undefined {
	const latest = latestCustomEntry(branch, "todo-state");
	if (latest) return summarizeTodoFromData(latest.data, "todo-state");
	return undefined;
}

function migrateLegacyContract(data: any): MagnetoState | undefined {
	const legacyContract = data?.contract;
	if (!legacyContract || typeof legacyContract.goal !== "string") return undefined;
	const contract = createContract(legacyContract.goal, {
		createdAt: legacyContract.createdAt,
		progress: createProgress("Migrated from legacy ralph-contract-state phase tracker."),
	});
	contract.decisions.push({
		id: makeId("decision"),
		text: "Migrated from legacy phase-oriented ralph-contract-state to Magneto supervisor contract.",
		createdAt: nowIso(),
	});
	return {
		...DEFAULT_STATE,
		contract,
	};
}

function formatPercent(value: number): string {
	return `${clampScore(value)}%`;
}

function runningJobs(contract: MagnetoContract): SubagentJob[] {
	return contract.subagentJobs.filter((job) => job.status === "running");
}

function queuedJobs(contract: MagnetoContract): SubagentJob[] {
	return contract.subagentJobs.filter((job) => job.status === "queued");
}

function openRisks(contract: MagnetoContract): Risk[] {
	return contract.risks.filter((risk) => risk.status === "open");
}

function openBlockers(contract: MagnetoContract): Blocker[] {
	return contract.blockers.filter((blocker) => blocker.status === "open");
}

function updateDerivedProgress(contract: MagnetoContract, todo?: TodoSnapshot, toolUse?: ToolUseHealth): void {
	const goals = contract.goals.length ? contract.goals : [];
	const outcomes = contract.outcomes.length ? contract.outcomes : [];
	const goalCompletion = outcomes.length
		? Math.round(outcomes.reduce((sum, o) => sum + clampScore(o.progress), 0) / outcomes.length)
		: goals.length
			? Math.round(goals.reduce((sum, g) => sum + clampScore(g.progress), 0) / goals.length)
			: 0;

	const requiredEvidenceKinds = new Set<EvidenceKind>();
	for (const bar of contract.qualityBars) for (const kind of bar.requiredEvidence) requiredEvidenceKinds.add(kind);
	const passedEvidenceKinds = new Set(contract.evidence.filter((ev) => ev.status === "pass" || ev.status === "partial").map((ev) => ev.kind));
	const qualityCoverage = requiredEvidenceKinds.size === 0 ? 0 : Math.round(([...requiredEvidenceKinds].filter((kind) => passedEvidenceKinds.has(kind)).length / requiredEvidenceKinds.size) * 100);

	const blockerPenalty = openBlockers(contract).length * 15;
	const riskPenalty = openRisks(contract).filter((risk) => risk.severity !== "info").length * 8;
	const failedToolPenalty = toolUse && toolUse.totalCalls > 0 ? Math.min(40, Math.round((toolUse.failedCalls / toolUse.totalCalls) * 100)) : 0;
	const contractFit = clampScore(100 - blockerPenalty - riskPenalty);
	const executionHealth = clampScore(100 - failedToolPenalty - toolUseRepeatedPenalty(toolUse));
	const capacity = Math.max(1, contract.delegationPolicy.maxParallelSubagents);
	const parallelism = clampScore((runningJobs(contract).length / capacity) * 100);

	const todoText = todo ? `todo ${todo.done}/${todo.total} done, ${todo.inprogress} in progress, ${todo.blocked} blocked` : "todo snapshot unavailable";
	contract.progress = {
		goalCompletion,
		contractFit,
		qualityCoverage,
		executionHealth,
		parallelism,
		summary: `Strategic progress ${goalCompletion}%; ${todoText}; quality evidence ${qualityCoverage}%; contract fit ${contractFit}%.`,
		updatedAt: nowIso(),
	};
	contract.updatedAt = nowIso();
}

function toolUseRepeatedPenalty(toolUse?: ToolUseHealth): number {
	return toolUse ? Math.min(25, toolUse.repeatedFailures * 5) : 0;
}

function auditContract(contract: MagnetoContract, todo?: TodoSnapshot, toolUse?: ToolUseHealth): string[] {
	updateDerivedProgress(contract, todo, toolUse);
	const findings: string[] = [];
	const running = runningJobs(contract).length;
	const queued = queuedJobs(contract).length;
	const capacity = contract.delegationPolicy.maxParallelSubagents;

	if (!contract.outcomes.length) findings.push("No explicit outcomes defined. Add measurable outcomes beyond todo completion.");
	if (!contract.constraints.length) findings.push("No constraints captured. Add non-negotiables to prevent drift.");
	if (contract.progress.qualityCoverage < 50) findings.push(`Quality evidence coverage low (${contract.progress.qualityCoverage}%). Add tests/review/council/design-review evidence.`);
	if (todo && todo.total > 30 && contract.delegationPolicy.preferParallel && running < capacity && queued > 0) {
		findings.push(`Subagent capacity underused: ${running}/${capacity} running with ${queued} queued.`);
	}
	if (todo && todo.blocked > 0) findings.push(`${todo.blocked} todo items are blocked; classify as blocker/risk or unblock.`);
	if (toolUse && toolUse.failedCalls >= 3) findings.push(`Tool health degraded: ${toolUse.failedCalls}/${toolUse.totalCalls} calls failed.`);
	if (toolUse && toolUse.repeatedFailures > 0) findings.push(`Repeated tool failures detected (${toolUse.repeatedFailures}); stop retry loops and change strategy.`);
	if (openBlockers(contract).length) findings.push(`${openBlockers(contract).length} open blockers require owner/decision.`);
	if (!findings.length) findings.push("No major governance gaps detected.");
	return findings;
}

function formatStatus(state: MagnetoState): string {
	const contract = state.contract;
	if (!contract) {
		return [
			"# Magneto",
			`Mode: ${state.mode} | enabled=${state.enabled}`,
			"No active contract. Start one with `/magneto start <mission>`.",
		].join("\n");
	}

	updateDerivedProgress(contract, state.lastTodoSnapshot, state.toolUse);
	const findings = auditContract(contract, state.lastTodoSnapshot, state.toolUse).slice(0, 8);
	const activeJobs = contract.subagentJobs.filter((job) => job.status === "queued" || job.status === "running");

	const lines = [
		"# Magneto Supervisor",
		`Mode: ${state.mode} | enabled=${state.enabled} | autoCompact=${state.autoCompact}`,
		`Mission: ${contract.mission}`,
		`Domains: ${contract.domains.join(", ")}`,
		`Progress: goal=${formatPercent(contract.progress.goalCompletion)} contractFit=${formatPercent(contract.progress.contractFit)} quality=${formatPercent(contract.progress.qualityCoverage)} health=${formatPercent(contract.progress.executionHealth)} parallelism=${formatPercent(contract.progress.parallelism)}`,
		`Todo: ${state.lastTodoSnapshot ? `${state.lastTodoSnapshot.done}/${state.lastTodoSnapshot.total} done, ${state.lastTodoSnapshot.inprogress} in progress, ${state.lastTodoSnapshot.blocked} blocked` : "unknown"}`,
		`Subagents: ${runningJobs(contract).length}/${contract.delegationPolicy.maxParallelSubagents} running, ${queuedJobs(contract).length} queued`,
		`Risks: ${openRisks(contract).length} open | Blockers: ${openBlockers(contract).length} open | Evidence: ${contract.evidence.length}`,
		"",
		"## Strategic findings",
		...findings.map((finding) => `- ${finding}`),
	];

	if (activeJobs.length) {
		lines.push("", "## Active subagent jobs");
		for (const job of activeJobs.slice(0, 12)) {
			lines.push(`- [${job.status}] ${job.id} ${job.agent}: ${job.title}`);
		}
	}

	if (contract.constraints.length) {
		lines.push("", "## Contract constraints");
		for (const constraint of contract.constraints.slice(0, 10)) lines.push(`- ${constraint}`);
	}

	return lines.join("\n");
}

function buildSupervisorPrompt(state: MagnetoState): string {
	const contract = state.contract;
	if (!state.enabled || !contract) return "";
	updateDerivedProgress(contract, state.lastTodoSnapshot, state.toolUse);
	const audit = auditContract(contract, state.lastTodoSnapshot, state.toolUse).slice(0, 6);
	const capacity = contract.delegationPolicy.maxParallelSubagents;
	const running = runningJobs(contract).length;
	const queued = queuedJobs(contract).length;
	const activePolicies = contract.skillPolicy
		.filter((policy) => contract.domains.includes(policy.domain) || policy.domain === "code")
		.slice(0, 8)
		.map((policy) => `- ${policy.domain}: when ${policy.when}; recommend ${policy.recommend.join(", ")}${policy.required?.length ? `; required ${policy.required.join(", ")}` : ""}`)
		.join("\n");

	return [
		"\n\n## Magneto Supervisor Contract",
		"Magneto is the strategic control plane. Todo is tactical; do not treat todo completion as goal completion.",
		`Mission: ${contract.mission}`,
		`Strategic progress: goal=${contract.progress.goalCompletion}%, contractFit=${contract.progress.contractFit}%, quality=${contract.progress.qualityCoverage}%, executionHealth=${contract.progress.executionHealth}%.`,
		`Subagent capacity: ${running}/${capacity} running, ${queued} queued. If useful work is independent and capacity remains, delegate via subagent and record it with the magneto tool.`,
		`Todo signal: ${state.lastTodoSnapshot ? `${state.lastTodoSnapshot.done}/${state.lastTodoSnapshot.total} done; ${state.lastTodoSnapshot.blocked} blocked` : "unknown; call todo list if execution state matters"}.`,
		"\nNon-negotiable supervisor rules:",
		"- Keep execution aligned to the Magneto mission, outcomes, constraints, and quality bars.",
		"- Use todo for tactical queue management, but update Magneto for strategic progress, evidence, risks, blockers, decisions, and subagent jobs.",
		"- If the work is non-trivial, use the appropriate skill/tool policy instead of improvising.",
		"- If tool use starts failing repeatedly, stop retrying blindly; diagnose, change strategy, or ask for a decision.",
		"- Before summary, ensure evidence covers tests/review/design-review/council as required by domain.",
		"- Preserve continuity: when context pressure is high, run /magneto handoff or compact with Magneto state carried forward.",
		"\nSkill / extension policy:",
		activePolicies || "- No active policy configured.",
		"\nCurrent governance findings:",
		...audit.map((finding) => `- ${finding}`),
	].join("\n");
}

function buildHandoffPrompt(state: MagnetoState): string {
	const contract = state.contract;
	if (!contract) return "# Magneto Handoff\nNo active contract.";
	updateDerivedProgress(contract, state.lastTodoSnapshot, state.toolUse);
	const audit = auditContract(contract, state.lastTodoSnapshot, state.toolUse);
	return [
		"# Magneto Continuation Prompt",
		"You are continuing a long-running supervised execution. Treat the Magneto contract below as the source of truth.",
		"",
		`## Mission\n${contract.mission}`,
		"",
		`## Strategic progress\nGoal completion: ${contract.progress.goalCompletion}%\nContract fit: ${contract.progress.contractFit}%\nQuality coverage: ${contract.progress.qualityCoverage}%\nExecution health: ${contract.progress.executionHealth}%\n${contract.progress.summary}`,
		"",
		"## Goals",
		...(contract.goals.length ? contract.goals.map((g) => `- [${g.status}] ${g.progress}% ${g.text}`) : ["- None defined"]),
		"",
		"## Outcomes",
		...(contract.outcomes.length ? contract.outcomes.map((o) => `- [${o.status}] ${o.progress}% ${o.text} (criteria: ${o.criteria.join("; ") || "none"})`) : ["- None defined yet"]),
		"",
		"## Constraints / non-goals",
		...(contract.constraints.map((c) => `- CONSTRAINT: ${c}`)),
		...(contract.nonGoals.map((n) => `- NON-GOAL: ${n}`)),
		"",
		"## Active todo signal",
		state.lastTodoSnapshot ? `- ${state.lastTodoSnapshot.done}/${state.lastTodoSnapshot.total} done; ${state.lastTodoSnapshot.todo} todo; ${state.lastTodoSnapshot.inprogress} in progress; ${state.lastTodoSnapshot.blocked} blocked.` : "- Unknown; call todo list.",
		"",
		"## Active subagent jobs",
		...(contract.subagentJobs.filter((j) => j.status === "queued" || j.status === "running").map((j) => `- [${j.status}] ${j.id} ${j.agent}: ${j.title}`) || []),
		"",
		"## Open blockers / risks",
		...(openBlockers(contract).map((b) => `- BLOCKER (${b.owner}): ${b.text}`)),
		...(openRisks(contract).map((r) => `- RISK (${r.severity}): ${r.text}${r.mitigation ? ` — mitigation: ${r.mitigation}` : ""}`)),
		"",
		"## Evidence ledger (latest)",
		...(contract.evidence.slice(-12).map((e) => `- [${e.status}] ${e.kind}: ${e.summary}${e.refs.length ? ` (${e.refs.join(", ")})` : ""}`)),
		"",
		"## Supervisor findings",
		...audit.map((finding) => `- ${finding}`),
		"",
		"## Next operating rule",
		"Continue under Magneto supervision. Use todo for tactical work; update magneto for strategic progress/evidence/jobs/risks. Use subagents aggressively up to capacity for independent work. Use appropriate skills/extensions before major decisions or UI/review work.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export default function magnetoExtension(pi: ExtensionAPI): void {
	let state: MagnetoState = { ...DEFAULT_STATE, toolUse: { ...DEFAULT_STATE.toolUse, recent: [] } };
	const toolCallSignatures = new Map<string, { toolName: string; signature: string; at: string }>();
	const subagentToolJobs = new Map<string, string[]>();

	const persist = () => {
		pi.appendEntry(MAGNETO_STATE_TYPE, state);
	};

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		try {
			ctx.ui.notify(message, level);
		} catch {
			// no-op in non-interactive modes
		}
	};

	const hydrate = (ctx: ExtensionContext) => {
		state = { ...DEFAULT_STATE, toolUse: { ...DEFAULT_STATE.toolUse, recent: [] } };
		let found = false;
		let legacy: MagnetoState | undefined;
		const branch = ctx.sessionManager.getBranch();

		for (const entry of branch) {
			if (entry.type !== "custom") continue;
			if (entry.customType === MAGNETO_STATE_TYPE && entry.data && typeof entry.data === "object") {
				state = {
					...state,
					...(entry.data as Partial<MagnetoState>),
					toolUse: {
						...DEFAULT_STATE.toolUse,
						...((entry.data as Partial<MagnetoState>).toolUse ?? {}),
						recent: ((entry.data as Partial<MagnetoState>).toolUse?.recent ?? []).slice(-MAX_RECENT_TOOL_CALLS),
					},
				};
				found = true;
			}
			if (entry.customType === LEGACY_CONTRACT_STATE_TYPE && entry.data && typeof entry.data === "object") {
				legacy = migrateLegacyContract(entry.data);
			}
		}

		if (!found && legacy) {
			state = legacy;
			found = true;
			persist();
		}

		state.lastTodoSnapshot = getTodoSnapshot(branch) ?? state.lastTodoSnapshot;
		if (state.contract) updateDerivedProgress(state.contract, state.lastTodoSnapshot, state.toolUse);
		return found;
	};

	const refreshTodoSignal = (ctx: ExtensionContext) => {
		state.lastTodoSnapshot = getTodoSnapshot(ctx.sessionManager.getBranch()) ?? state.lastTodoSnapshot;
		if (state.contract) updateDerivedProgress(state.contract, state.lastTodoSnapshot, state.toolUse);
	};

	const recordEvidence = (kind: EvidenceKind, status: EvidenceStatus, summary: string, refs: string[] = []) => {
		if (!state.contract) return;
		state.contract.evidence.push(createEvidence(kind, status, summary, refs));
		state.contract.evidence = state.contract.evidence.slice(-MAX_EVIDENCE);
		state.contract.updatedAt = nowIso();
	};

	const recordToolResult = (toolCallId: string, toolName: string, result: unknown, isError: boolean) => {
		const signature = toolCallSignatures.get(toolCallId)?.signature ?? `${toolName}:${safeJson(result, 120)}`;
		state.toolUse.totalCalls += 1;
		if (isError) state.toolUse.failedCalls += 1;

		const recentSameFailure = state.toolUse.recent.filter((r) => !r.ok && r.signature === signature).length;
		if (isError && recentSameFailure >= 1) {
			state.toolUse.repeatedFailures += 1;
			const pattern = `Repeated failure: ${toolName} ${signature.slice(0, 80)}`;
			state.toolUse.suspiciousPatterns = uniq([pattern, ...state.toolUse.suspiciousPatterns]).slice(0, 20);
			if (state.contract) {
				addIntervention(
					state.contract,
					"warning",
					pattern,
					"Stop retrying the same failing tool call. Diagnose root cause, change approach, or ask for a decision.",
				);
			}
		}

		state.toolUse.recent.push({ toolName, ok: !isError, signature, at: nowIso() });
		state.toolUse.recent = state.toolUse.recent.slice(-MAX_RECENT_TOOL_CALLS);
		if (state.contract) updateDerivedProgress(state.contract, state.lastTodoSnapshot, state.toolUse);
	};

	const maybeSuggestContextAction = (ctx: ExtensionContext) => {
		if (!state.enabled || !state.contract) return;
		const usage = ctx.getContextUsage?.();
		if (!usage) return;

		if (usage.tokens >= state.handoffTokenThreshold) {
			addIntervention(
				state.contract,
				"critical",
				`Context pressure high: ${usage.tokens} tokens`,
				"Run /magneto handoff before strategic context becomes unreliable.",
			);
			notify(ctx, `Magneto: context ${usage.tokens} tokens. Run /magneto handoff.`, "warning");
			persist();
			return;
		}

		if (usage.tokens >= state.compactTokenThreshold) {
			addIntervention(
				state.contract,
				"warning",
				`Context pressure rising: ${usage.tokens} tokens`,
				state.autoCompact ? "Auto-compact requested by Magneto." : "Consider /magneto handoff or enable auto-compact.",
			);
			if (state.autoCompact) {
				ctx.compact?.({
					customInstructions: "Preserve Magneto contract, strategic progress, evidence ledger, open blockers/risks, active subagent jobs, and current todo signal. Omit stale reasoning and false starts.",
					onComplete: () => notify(ctx, "Magneto: compact completed.", "info"),
					onError: (error: Error) => notify(ctx, `Magneto: compact failed: ${error.message}`, "error"),
				});
			} else {
				notify(ctx, `Magneto: context ${usage.tokens} tokens. Consider /magneto handoff.`, "warning");
			}
			persist();
		}
	};

	const createHandoffSession = async (ctx: ExtensionCommandContext) => {
		const currentSessionFile = ctx.sessionManager.getSessionFile();
		if (!currentSessionFile) {
			ctx.ui.notify("Magneto: no session file for handoff", "error");
			return;
		}

		if (state.contract) {
			state.contract.evidence.push(createEvidence("handoff", "unknown", "Magneto handoff requested", [currentSessionFile]));
			state.contract.updatedAt = nowIso();
		}
		state.lastHandoffAt = nowIso();
		persist();

		const handoffPrompt = buildHandoffPrompt(state);
		const branch = ctx.sessionManager.getBranch();
		const carry = CARRYOVER_TYPES
			.map((type) => latestCustomEntry(branch, type))
			.filter((entry): entry is { customType: string; data: unknown } => Boolean(entry));

		const result = await (ctx.newSession as any)({
			parentSession: currentSessionFile,
			setup: async (session) => {
				for (const entry of carry) session.appendCustomEntry(entry.customType, entry.data);
			},
			withSession: async (newCtx) => {
				newCtx.ui.setEditorText(handoffPrompt);
				newCtx.ui.notify("Magneto handoff ready. Submit the continuation prompt when ready.", "info");
			},
		});

		if (result.cancelled) ctx.ui.notify("Magneto handoff cancelled", "warning");
	};

	// -------------------------------------------------------------------------
	// Lifecycle hooks
	// -------------------------------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		const found = hydrate(ctx);
		if ((event.reason === "new" || event.reason === "fork") && !found) {
			state = { ...DEFAULT_STATE, toolUse: { ...DEFAULT_STATE.toolUse, recent: [] } };
			persist();
		}
		notify(ctx, state.contract ? `Magneto loaded: ${state.contract.mission.slice(0, 80)}` : "Magneto ready. Start with /magneto start <mission>.");
	});

	pi.on("session_tree", async (_event, ctx) => {
		hydrate(ctx);
		notify(ctx, state.contract ? "Magneto restored from session tree." : "Magneto restored; no active contract.");
	});

	pi.on("before_agent_start", async (event, ctx) => {
		refreshTodoSignal(ctx);
		const prompt = buildSupervisorPrompt(state);
		if (!prompt) return;
		return { systemPrompt: event.systemPrompt + prompt };
	});

	pi.on("tool_call", async (event) => {
		const signature = `${event.toolName}:${safeJson(event.input, 260)}`;
		toolCallSignatures.set(event.toolCallId, { toolName: event.toolName, signature, at: nowIso() });
		if (event.toolName === "subagent" && state.contract) {
			const input = event.input as any;
			const tasks = Array.isArray(input?.tasks) ? input.tasks : input?.task ? [{ agent: input.agent ?? "subagent", task: input.task }] : [];
			const jobIds: string[] = [];
			for (const task of tasks) {
				const id = makeId("job");
				jobIds.push(id);
				state.contract.subagentJobs.push({
					id,
					title: String(task.task ?? "subagent task"),
					agent: String(task.agent ?? input?.agent ?? "subagent"),
					status: "running",
					priority: 1,
					dependsOn: [],
					todoIds: [],
					evidenceIds: [],
					deliverables: [],
					createdAt: nowIso(),
					startedAt: nowIso(),
				});
			}
			if (jobIds.length) subagentToolJobs.set(event.toolCallId, jobIds);
			state.contract.updatedAt = nowIso();
			persist();
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		recordToolResult(event.toolCallId, event.toolName, event.result, event.isError);
		if (event.toolName === "todo" || event.toolName === "todo_sidebar" || event.toolName === "todo-sidebar") {
			const result = event.result as any;
			state.lastTodoSnapshot = summarizeTodoFromData(result?.details ?? result, `tool:${event.toolName}`) ?? state.lastTodoSnapshot;
			refreshTodoSignal(ctx);
		}
		if (event.toolName === "subagent" && state.contract) {
			const jobIds = subagentToolJobs.get(event.toolCallId) ?? [];
			for (const id of jobIds) {
				const job = state.contract.subagentJobs.find((item) => item.id === id);
				if (!job) continue;
				job.status = event.isError ? "failed" : "done";
				job.completedAt = nowIso();
				job.result = safeJson(event.result, 1_000);
			}
			subagentToolJobs.delete(event.toolCallId);
			recordEvidence("subagent", event.isError ? "fail" : "pass", event.isError ? "Subagent execution failed" : "Subagent execution completed", jobIds);
		}
		persist();
	});

	pi.on("agent_end", async (_event, ctx) => {
		refreshTodoSignal(ctx);
		if (state.contract) {
			const findings = auditContract(state.contract, state.lastTodoSnapshot, state.toolUse);
			if (findings.some((f) => /underused|failed|blocked|low/i.test(f))) {
				addIntervention(state.contract, "warning", "Agent end audit found governance gaps", findings.slice(0, 4).join(" | "));
			}
		}
		maybeSuggestContextAction(ctx);
		persist();
	});

	// -------------------------------------------------------------------------
	// LLM tool
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "magneto",
		label: "Magneto",
		description: "Update or inspect Magneto supervisor state: contract, strategic progress, evidence, risks, blockers, subagent jobs, and metrics.",
		promptSnippet: "Use this to keep Magneto's strategic contract and evidence ledger current during long-running work.",
		parameters: Type.Object({
			action: Enum([
				"init",
				"set_contract",
				"update_progress",
				"add_goal",
				"update_goal",
				"add_outcome",
				"update_outcome",
				"add_evidence",
				"add_risk",
				"update_risk",
				"add_blocker",
				"resolve_blocker",
				"add_decision",
				"add_job",
				"update_job",
				"audit",
				"get_status",
			] as const),
			mission: Type.Optional(Type.String()),
			domains: Type.Optional(Type.Array(Enum(["code", "frontend", "design", "infra", "research", "refactor", "data", "docs", "unknown"] as const))),
			constraints: Type.Optional(Type.Array(Type.String())),
			non_goals: Type.Optional(Type.Array(Type.String())),
			goal_id: Type.Optional(Type.String()),
			goal: Type.Optional(Type.String()),
			goal_status: Type.Optional(Enum(["planned", "active", "done", "blocked", "dropped"] as const)),
			progress: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
			outcome_id: Type.Optional(Type.String()),
			outcome: Type.Optional(Type.String()),
			criteria: Type.Optional(Type.Array(Type.String())),
			evidence_kind: Type.Optional(Enum(["test", "review", "council", "design_review", "tooluse", "handoff", "decision", "log", "subagent", "manual"] as const)),
			evidence_status: Type.Optional(Enum(["pass", "fail", "partial", "unknown"] as const)),
			summary: Type.Optional(Type.String()),
			refs: Type.Optional(Type.Array(Type.String())),
			risk_id: Type.Optional(Type.String()),
			risk: Type.Optional(Type.String()),
			severity: Type.Optional(Enum(["info", "warning", "critical"] as const)),
			mitigation: Type.Optional(Type.String()),
			blocker_id: Type.Optional(Type.String()),
			blocker: Type.Optional(Type.String()),
			owner: Type.Optional(Enum(["user", "agent", "subagent", "external"] as const)),
			decision: Type.Optional(Type.String()),
			rationale: Type.Optional(Type.String()),
			job_id: Type.Optional(Type.String()),
			job_title: Type.Optional(Type.String()),
			job_agent: Type.Optional(Type.String()),
			job_status: Type.Optional(Enum(["queued", "running", "done", "failed", "blocked", "cancelled"] as const)),
			deliverables: Type.Optional(Type.Array(Type.String())),
			result: Type.Optional(Type.String()),
			capacity: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
		}) as any,
		async execute(_toolCallId, rawArgs): Promise<any> {
			const args = rawArgs as any;
			const action = args.action;
			if (action === "init") {
				const mission = args.mission?.trim() || args.goal?.trim();
				if (!mission) return { content: [{ type: "text", text: "❌ magneto.init requires mission" }], details: { error: "missing mission" } };
				state.contract = createContract(mission, {
					domains: (args.domains as Domain[] | undefined) ?? inferDomains(mission),
					constraints: asArrayOfStrings(args.constraints),
					nonGoals: asArrayOfStrings(args.non_goals),
				});
				persist();
				return { content: [{ type: "text", text: `Magneto contract initialized: ${mission}` }], details: { action, contract: state.contract } };
			}

			if (action === "get_status" || action === "audit") {
				if (state.contract) {
					const findings = auditContract(state.contract, state.lastTodoSnapshot, state.toolUse);
					state.lastAuditAt = nowIso();
					persist();
					return { content: [{ type: "text", text: `${formatStatus(state)}\n\n## Audit\n${findings.map((f) => `- ${f}`).join("\n")}` }], details: { action, state } };
				}
				return { content: [{ type: "text", text: formatStatus(state) }], details: { action, state } };
			}

			if (!state.contract) return { content: [{ type: "text", text: "No active Magneto contract. Use magneto action=init first." }], details: { action, error: "no contract" } };
			const contract = state.contract;

			switch (action) {
				case "set_contract": {
					if (args.mission) contract.mission = args.mission;
					if (args.domains) contract.domains = args.domains as Domain[];
					if (args.constraints) contract.constraints = asArrayOfStrings(args.constraints);
					if (args.non_goals) contract.nonGoals = asArrayOfStrings(args.non_goals);
					if (args.capacity) contract.delegationPolicy.maxParallelSubagents = args.capacity;
					break;
				}
				case "update_progress": {
					if (args.progress !== undefined) {
						contract.progress.goalCompletion = clampScore(args.progress);
					}
					if (args.summary) contract.progress.summary = args.summary;
					contract.progress.updatedAt = nowIso();
					break;
				}
				case "add_goal": {
					if (!args.goal) return { content: [{ type: "text", text: "❌ add_goal requires goal" }], details: { action, error: "missing goal" } };
					contract.goals.push({ id: makeId("goal"), text: args.goal, status: args.goal_status ?? "planned", priority: contract.goals.length + 1, progress: clampScore(args.progress), outcomeIds: [] });
					break;
				}
				case "update_goal": {
					const goal = contract.goals.find((g) => g.id === args.goal_id) ?? contract.goals.find((g) => g.text === args.goal);
					if (!goal) return { content: [{ type: "text", text: "❌ goal not found" }], details: { action, error: "goal not found" } };
					if (args.goal) goal.text = args.goal;
					if (args.goal_status) goal.status = args.goal_status;
					if (args.progress !== undefined) goal.progress = clampScore(args.progress);
					break;
				}
				case "add_outcome": {
					if (!args.outcome) return { content: [{ type: "text", text: "❌ add_outcome requires outcome" }], details: { action, error: "missing outcome" } };
					contract.outcomes.push({ id: makeId("outcome"), text: args.outcome, status: "planned", criteria: asArrayOfStrings(args.criteria), evidenceIds: [], progress: clampScore(args.progress) });
					break;
				}
				case "update_outcome": {
					const outcome = contract.outcomes.find((o) => o.id === args.outcome_id) ?? contract.outcomes.find((o) => o.text === args.outcome);
					if (!outcome) return { content: [{ type: "text", text: "❌ outcome not found" }], details: { action, error: "outcome not found" } };
					if (args.outcome) outcome.text = args.outcome;
					if (args.goal_status) outcome.status = args.goal_status;
					if (args.criteria) outcome.criteria = asArrayOfStrings(args.criteria);
					if (args.progress !== undefined) outcome.progress = clampScore(args.progress);
					break;
				}
				case "add_evidence": {
					if (!args.summary) return { content: [{ type: "text", text: "❌ add_evidence requires summary" }], details: { action, error: "missing summary" } };
					contract.evidence.push(createEvidence(args.evidence_kind ?? "manual", args.evidence_status ?? "unknown", args.summary, asArrayOfStrings(args.refs)));
					contract.evidence = contract.evidence.slice(-MAX_EVIDENCE);
					break;
				}
				case "add_risk": {
					if (!args.risk) return { content: [{ type: "text", text: "❌ add_risk requires risk" }], details: { action, error: "missing risk" } };
					contract.risks.push({ id: makeId("risk"), text: args.risk, status: "open", severity: args.severity ?? "warning", mitigation: args.mitigation, createdAt: nowIso() });
					break;
				}
				case "update_risk": {
					const risk = contract.risks.find((r) => r.id === args.risk_id);
					if (!risk) return { content: [{ type: "text", text: "❌ risk not found" }], details: { action, error: "risk not found" } };
					if (args.risk) risk.text = args.risk;
					if (args.severity) risk.severity = args.severity;
					if (args.mitigation) risk.mitigation = args.mitigation;
					if (args.evidence_status === "pass") risk.status = "mitigated";
					break;
				}
				case "add_blocker": {
					if (!args.blocker) return { content: [{ type: "text", text: "❌ add_blocker requires blocker" }], details: { action, error: "missing blocker" } };
					contract.blockers.push({ id: makeId("blocker"), text: args.blocker, owner: args.owner ?? "agent", status: "open", createdAt: nowIso() });
					break;
				}
				case "resolve_blocker": {
					const blocker = contract.blockers.find((b) => b.id === args.blocker_id);
					if (!blocker) return { content: [{ type: "text", text: "❌ blocker not found" }], details: { action, error: "blocker not found" } };
					blocker.status = "resolved";
					blocker.resolvedAt = nowIso();
					break;
				}
				case "add_decision": {
					if (!args.decision) return { content: [{ type: "text", text: "❌ add_decision requires decision" }], details: { action, error: "missing decision" } };
					contract.decisions.push({ id: makeId("decision"), text: args.decision, rationale: args.rationale, createdAt: nowIso() });
					break;
				}
				case "add_job": {
					if (!args.job_title || !args.job_agent) return { content: [{ type: "text", text: "❌ add_job requires job_title and job_agent" }], details: { action, error: "missing job" } };
					contract.subagentJobs.push({ id: args.job_id || makeId("job"), title: args.job_title, agent: args.job_agent, status: args.job_status ?? "queued", priority: 1, dependsOn: [], todoIds: [], evidenceIds: [], deliverables: asArrayOfStrings(args.deliverables), result: args.result, createdAt: nowIso(), startedAt: args.job_status === "running" ? nowIso() : undefined });
					break;
				}
				case "update_job": {
					const job = contract.subagentJobs.find((j) => j.id === args.job_id);
					if (!job) return { content: [{ type: "text", text: "❌ job not found" }], details: { action, error: "job not found" } };
					if (args.job_title) job.title = args.job_title;
					if (args.job_agent) job.agent = args.job_agent;
					if (args.job_status) {
						job.status = args.job_status;
						if (args.job_status === "running" && !job.startedAt) job.startedAt = nowIso();
						if (["done", "failed", "blocked", "cancelled"].includes(args.job_status)) job.completedAt = nowIso();
					}
					if (args.deliverables) job.deliverables = asArrayOfStrings(args.deliverables);
					if (args.result) job.result = args.result;
					break;
				}
				default:
					return { content: [{ type: "text", text: `Unknown magneto action: ${action}` }], details: { action, error: "unknown action" } };
			}

			updateDerivedProgress(contract, state.lastTodoSnapshot, state.toolUse);
			persist();
			return { content: [{ type: "text", text: `Magneto updated: ${action}\n${contract.progress.summary}` }], details: { action, contract } };
		},
	});

	// -------------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------------

	pi.registerCommand("magneto", {
		description: "Control Magneto long-running execution supervisor",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const [rawCommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const command = (rawCommand || "status").toLowerCase();
			const restText = rest.join(" ");
			hydrate(ctx);

			switch (command) {
				case "start": {
					if (!restText) {
						ctx.ui.notify("Usage: /magneto start <mission>", "warning");
						return;
					}
					state.contract = createContract(restText);
					state.enabled = true;
					state.mode = "supervise";
					persist();
					ctx.ui.notify(`Magneto mission started: ${restText}`, "info");
					return;
				}
				case "status": {
					refreshTodoSignal(ctx);
					ctx.ui.setEditorText(formatStatus(state));
					ctx.ui.notify("Magneto status written to editor", "info");
					return;
				}
				case "audit": {
					refreshTodoSignal(ctx);
					if (state.contract) state.lastAuditAt = nowIso();
					persist();
					ctx.ui.setEditorText(formatStatus(state));
					ctx.ui.notify("Magneto audit complete", "info");
					return;
				}
				case "supervise": {
					const value = rest[0]?.toLowerCase();
					state.enabled = value !== "off" && value !== "false";
					state.mode = state.enabled ? "supervise" : "observe";
					persist();
					ctx.ui.notify(`Magneto supervision ${state.enabled ? "enabled" : "disabled"}`, state.enabled ? "info" : "warning");
					return;
				}
				case "mode": {
					const value = rest[0] as MagnetoMode | undefined;
					if (value !== "observe" && value !== "supervise" && value !== "strict") {
						ctx.ui.notify("Usage: /magneto mode observe|supervise|strict", "warning");
						return;
					}
					state.mode = value;
					state.enabled = value !== "observe" ? true : state.enabled;
					persist();
					ctx.ui.notify(`Magneto mode: ${state.mode}`, "info");
					return;
				}
				case "capacity": {
					const n = Number(rest[0]);
					if (!Number.isFinite(n) || n < 1) {
						ctx.ui.notify("Usage: /magneto capacity <positive-number>", "warning");
						return;
					}
					if (!state.contract) state.contract = createContract("Unspecified long-running mission");
					state.contract.delegationPolicy.maxParallelSubagents = Math.floor(n);
					state.contract.updatedAt = nowIso();
					persist();
					ctx.ui.notify(`Magneto subagent capacity set to ${Math.floor(n)}`, "info");
					return;
				}
				case "auto-compact": {
					const value = rest[0]?.toLowerCase();
					state.autoCompact = value === "on" || value === "true";
					persist();
					ctx.ui.notify(`Magneto auto-compact ${state.autoCompact ? "enabled" : "disabled"}`, state.autoCompact ? "info" : "warning");
					return;
				}
				case "threshold": {
					const compact = Number(rest[0]);
					const handoff = Number(rest[1] ?? rest[0]);
					if (!Number.isFinite(compact) || !Number.isFinite(handoff)) {
						ctx.ui.notify("Usage: /magneto threshold <compactTokens> [handoffTokens]", "warning");
						return;
					}
					state.compactTokenThreshold = Math.floor(compact);
					state.handoffTokenThreshold = Math.floor(handoff);
					persist();
					ctx.ui.notify(`Magneto thresholds compact=${state.compactTokenThreshold} handoff=${state.handoffTokenThreshold}`, "info");
					return;
				}
				case "handoff": {
					await createHandoffSession(ctx);
					return;
				}
				case "compact": {
					ctx.compact?.({
						customInstructions: "Preserve Magneto contract, goal progress, evidence ledger, quality gaps, active subagent jobs, open blockers/risks, and tactical todo signal. Omit stale reasoning.",
						onComplete: () => ctx.ui.notify("Magneto compact complete", "info"),
						onError: (error: Error) => ctx.ui.notify(`Magneto compact failed: ${error.message}`, "error"),
					});
					return;
				}
				case "reset": {
					state = { ...DEFAULT_STATE, toolUse: { ...DEFAULT_STATE.toolUse, recent: [] } };
					persist();
					ctx.ui.notify("Magneto reset", "info");
					return;
				}
				default:
					ctx.ui.notify("Usage: /magneto start|status|audit|supervise|mode|capacity|auto-compact|threshold|compact|handoff|reset", "warning");
			}
		},
	});
}
