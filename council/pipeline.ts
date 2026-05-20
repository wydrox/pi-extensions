/**
 * pipeline — council orchestrator
 *
 * Discovers council agents from ~/.pi/agent/agents/council-*.md
 * and runs the Grounded Blind Atomic Delphi protocol.
 *
 * Each expert is a subagent (spawned pi subprocess with isolated context).
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import type {
  Card,
  CardCategory,
  CategoryRankings,
  CouncilParams,
  CouncilResult,
  CouncilMeta,
  ExpertConfig,
  ExpertCardOutput,
  ExpertRankingOutput,
  ModeratorBrief,
  PhaseUpdate,
  RankingEntry,
} from "./types.js";
import {
  runExpertCards,
  runExpertRanking,
  runSynthesis,
  runModerator,
  type SpawnResult,
} from "./pi-council.js";
import {
  bordaAggregate,
  applyCoverageRules,
  permuteCards,
  restoreCardIds,
  detectGroupthink,
} from "./aggregator.js";

// ── Agent Discovery ──────────────────────────────────────────────────

const AGENTS_DIR = path.join(
  process.env.HOME || "/tmp",
  ".pi/agent/agents",
);

function parseFrontmatterSimple(
  content: string,
): { fm: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { fm: {}, body: content };
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      fm[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
    }
  }
  return { fm, body: content.slice(match[0].length).trim() };
}

function discoverCouncilAgents(): ExpertConfig[] {
  const agents: ExpertConfig[] = [];

  if (!fs.existsSync(AGENTS_DIR)) return agents;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("council-")) continue;
    if (!entry.name.endsWith(".md")) continue;
    // Skip synthesizer and non-expert definitions
    if (entry.name.includes("synthesizer")) continue;

    const filePath = path.join(AGENTS_DIR, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { fm, body } = parseFrontmatterSimple(content);
    if (!fm.name || !fm.description) continue;

    const cardTools = (fm.tools || "read")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    agents.push({
      name: fm.name,
      role: fm.description?.split("—")[0]?.trim() || fm.name,
      perspective: body,
      cardTools,
      rankingTools: ["read", "grep"],
      model: fm.model,
      thinking: (fm.thinking as ExpertConfig["thinking"]) || "low",
    });
  }

  return agents;
}

// ── Evidence Gathering ───────────────────────────────────────────────

/** Extract @file references from command string */
function parseAtFiles(rawArgs: string): string[] {
  const matches = rawArgs.match(/@(\S+)/g);
  if (!matches) return [];
  return matches.map((m) => {
    const p = m.slice(1);
    return p.startsWith("/") ? p : path.resolve(process.cwd(), p);
  });
}

/** Max file size for evidence (bytes) */
const MAX_EVIDENCE_SIZE = 100_000;

function isReasonableEvidenceFile(p: string): boolean {
  try {
    const stats = fs.statSync(p);
    if (!stats.isFile()) return false;
    if (stats.size > MAX_EVIDENCE_SIZE) return false;
    return true;
  } catch {
    return false;
  }
}

/** Collect default evidence files from the project */
function gatherDefaultEvidence(cwd: string): string[] {
  const files: string[] = [];

  for (const name of [
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "package.json",
    "tsconfig.json",
    ".pi/settings.json",
  ]) {
    const p = path.join(cwd, name);
    if (isReasonableEvidenceFile(p)) files.push(p);
  }

  try {
    const diffOut = execSync("git diff --name-only HEAD", {
      cwd,
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const changed = diffOut
      .split("\n")
      .filter((f) => f.trim() && isReasonableEvidenceFile(path.join(cwd, f.trim())))
      .slice(0, 10)
      .map((f) => path.join(cwd, f.trim()));
    files.push(...changed);
  } catch {
    // not a git repo — skip
  }

  try {
    const statusOut = execSync("git status --short", {
      cwd,
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const untracked = statusOut
      .split("\n")
      .filter(
        (l) => l.startsWith("??") || l.startsWith("A ") || l.startsWith("AM"),
      )
      .map((l) => l.slice(3).trim())
      .filter((f) => f && isReasonableEvidenceFile(path.join(cwd, f)))
      .slice(0, 5)
      .map((f) => path.join(cwd, f));
    files.push(...untracked);
  } catch {
    // skip
  }

  return [...new Set(files)];
}

// ── Params ───────────────────────────────────────────────────────────

function parseParams(rawArgs: string): CouncilParams {
  const experts = discoverCouncilAgents();
  experts.forEach((e, i) => (e.index = i));

  const atFiles = parseAtFiles(rawArgs);
  const explicitEvidence =
    atFiles.length > 0
      ? atFiles.filter(isReasonableEvidenceFile)
      : [];
  const defaultEvidence =
    explicitEvidence.length === 0 ? gatherDefaultEvidence(process.cwd()) : [];
  const allEvidence = [...explicitEvidence, ...defaultEvidence].slice(0, 15);

  const question = rawArgs
    .replace(/@\S+/g, "")
    .replace(/--\S+/g, "")
    .trim();

  return {
    question,
    depth: rawArgs.includes("--deep") ? "deep" : "standard",
    blind: !rawArgs.includes("--no-blind"),
    criteria: ["correctness", "risk", "simplicity", "user-value"],
    cardsPerExpert: 4,
    experts,
    evidence: allEvidence,
    cwd: process.cwd(),
  };
}

// ── Phase 1: Generate Cards ─────────────────────────────────────────

async function generateCards(
  params: CouncilParams,
  retryFailed = true,
): Promise<{ cards: Card[]; errors: string[] }> {
  const errors: string[] = [];
  const allCards: Card[] = [];
  const failedExperts: ExpertConfig[] = [];

  // Build evidence block for the prompt
  const evidenceBlock =
    params.evidence.length > 0
      ? `\n\n## Evidence Files (USE THE READ TOOL TO EXAMINE THESE)\n${params.evidence.map((f, i) => `  ${i + 1}. ${f}`).join("\n")}\n\nIMPORTANT: Before writing your cards, use the read tool to examine AT LEAST 3 of these files. Every factual claim MUST cite which file you observed it in.`
      : "\n\n## Evidence\nNo specific evidence files provided. If you need context, use the read tool to explore the codebase. Mark all unsupported claims with basis: 'inferred' or 'assumption'.";

  const enrichedQuestion = `${params.question}${evidenceBlock}`;

  const runOneExpert = async (expert: ExpertConfig, isRetry = false) => {
    try {
      const result = await runExpertCards({
        rolePrompt: expert.perspective,
        tools: expert.cardTools,
        question: enrichedQuestion,
        evidence: params.evidence,
        cwd: params.cwd,
        index: expert.index!,
        name: expert.name,
      });
      if (!result.ok || !result.json) {
        const tag = isRetry ? " (retry)" : "";
        errors.push(`${expert.name}: ${result.error || "no output"}${tag}`);
        return null;
      }
      const output = result.json as ExpertCardOutput;
      if (!output.cards || !Array.isArray(output.cards) || output.cards.length === 0) {
        const tag = isRetry ? " (still no cards)" : " (no cards)";
        errors.push(`${expert.name}${tag}`);
        return null;
      }
      const tagged = output.cards.slice(0, params.cardsPerExpert).map(
        (c): Card => ({
          ...c,
          id: `${expert.name}-${Math.random().toString(36).slice(2, 8)}`,
          expertIndex: expert.index,
          expertRole: expert.role,
          category: c.category || "insight",
          claim: c.claim || "",
          why: c.why || "",
          if_ignored: c.if_ignored || "",
          confidence: c.confidence || "medium",
          basis: c.basis || "unknown",
          sources: c.sources || [],
        }),
      );
      return tagged;
    } catch (err) {
      const tag = isRetry ? " (retry)" : "";
      errors.push(`${expert.name}: ${String(err)}${tag}`);
      return null;
    }
  };

  // First pass: all experts in parallel
  const results = await Promise.all(
    params.experts.map((e) => runOneExpert(e)),
  );

  for (let i = 0; i < results.length; i++) {
    const cards = results[i];
    if (cards && cards.length > 0) {
      allCards.push(...cards);
    } else {
      failedExperts.push(params.experts[i]);
    }
  }

  // Retry failed experts only if they didn't time out (timeouts rarely fix on retry)
  const nonTimeoutFailures = failedExperts.filter((e) =>
    !errors.some((err) => err.startsWith(e.name) && err.includes("timeout"))
  );
  if (retryFailed && nonTimeoutFailures.length > 0) {
    for (const expert of nonTimeoutFailures) {
      const retryCards = await runOneExpert(expert, true);
      if (retryCards && retryCards.length > 0) {
        allCards.push(...retryCards);
        const errIdx = errors.findIndex((e) =>
          e.startsWith(expert.name),
        );
        if (errIdx >= 0) errors.splice(errIdx, 1);
      }
    }
  }

  return { cards: allCards, errors };
}

// ── Phase 2: Rank Cards ─────────────────────────────────────────────

async function rankCards(
  params: CouncilParams,
  anonymousCards: Card[],
): Promise<{ rankings: RankingEntry[]; errors: string[] }> {
  const errors: string[] = [];
  const allRankings: RankingEntry[] = [];

  const byCategory: Record<string, Array<{
    id: string;
    claim: string;
    why: string;
    if_ignored: string;
    confidence: string;
    basis: string;
  }>> = {};

  for (const card of anonymousCards) {
    const cat = card.category;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push({
      id: card.id,
      claim: card.claim,
      why: card.why,
      if_ignored: card.if_ignored,
      confidence: card.confidence,
      basis: card.basis,
    });
  }

  const promises = params.experts.map(async (expert) => {
    try {
      const result = await runExpertRanking({
        rolePrompt: expert.perspective,
        cards: byCategory,
        criteria: params.criteria,
        index: expert.index!,
        name: expert.name,
      });
      if (!result.ok || !result.json) {
        errors.push(
          `${expert.name} ranking: ${result.error || "no output"}`,
        );
        return [];
      }
      const output = result.json as ExpertRankingOutput;
      if (!output.rankings || !Array.isArray(output.rankings)) {
        errors.push(`${expert.name} ranking: invalid format`);
        return [];
      }
      return output.rankings.map(
        (r): RankingEntry => ({
          cardId: r.cardId,
          expertIndex: expert.index!,
          rank: r.rank,
          category: r.category,
        }),
      );
    } catch (err) {
      errors.push(`${expert.name} ranking: ${String(err)}`);
      return [];
    }
  });

  const results = await Promise.all(promises);
  for (const rankings of results) {
    allRankings.push(...rankings);
  }

  return { rankings: allRankings, errors };
}

// ── Phase 3: Synthesize ─────────────────────────────────────────────

async function synthesize(
  question: string,
  coverage: ReturnType<typeof applyCoverageRules>,
  groupthinkDetected: boolean,
): Promise<{
  recommendation: string;
  agreements: string[];
  clashes: string[];
  blindSpots: string[];
  firstStep: string;
  confidence: "low" | "medium" | "high";
  dissentSummary: string;
}> {
  const contextParts: string[] = [];

  contextParts.push(`## Question\n${question}`);

  contextParts.push("\n## Top Proposals");
  for (const p of coverage.topProposals) {
    contextParts.push(
      `- [${p.id}] (${p.confidence}, ${p.basis}) ${p.claim}\n  Why: ${p.why}\n  If ignored: ${p.if_ignored}`,
    );
  }

  contextParts.push("\n## Top Risks");
  for (const r of coverage.topRisks) {
    contextParts.push(
      `- [${r.id}] (${r.confidence}, ${r.basis}) ${r.claim}\n  Why: ${r.why}\n  If ignored: ${r.if_ignored}`,
    );
  }

  contextParts.push("\n## Top Unknowns");
  for (const u of coverage.topUnknowns) {
    contextParts.push(
      `- [${u.id}] (${u.confidence}, ${u.basis}) ${u.claim}`,
    );
  }

  contextParts.push("\n## Best Dissent");
  for (const d of coverage.bestDissent) {
    contextParts.push(
      `- [${d.id}] (${d.confidence}, ${d.basis}) ${d.claim}\n  Why: ${d.why}`,
    );
  }

  if (groupthinkDetected) {
    contextParts.push(
      "\n⚠ WARNING: Groupthink detected — experts agreed too strongly.",
    );
  }

  // Load synthesizer prompt from agent definition
  const synthPath = path.join(AGENTS_DIR, "council-synthesizer.md");
  let synthPrompt = "";
  if (fs.existsSync(synthPath)) {
    const content = fs.readFileSync(synthPath, "utf-8");
    synthPrompt = content.replace(/^---\n[\s\S]*?\n---/, "").trim();
  }

  const result = await runSynthesis({
    prompt: synthPrompt || "Synthesize the council results.",
    context: contextParts.join("\n"),
  });

  if (!result.ok || !result.json) {
    return {
      recommendation: `Synthesis failed: ${result.error || "no output"}`,
      agreements: [],
      clashes: [],
      blindSpots: ["Synthesizer failed to produce output"],
      firstStep: "Re-run council",
      confidence: "low",
      dissentSummary: "",
    };
  }

  return result.json as {
    recommendation: string;
    agreements: string[];
    clashes: string[];
    blindSpots: string[];
    firstStep: string;
    confidence: "low" | "medium" | "high";
    dissentSummary: string;
  };
}

// ── Main Pipeline ────────────────────────────────────────────────────

export type PhaseCallback = (update: PhaseUpdate) => void;

export async function runCouncil(
  rawArgs: string,
  onPhase?: PhaseCallback,
): Promise<CouncilResult> {
  const emit = (update: PhaseUpdate) => onPhase?.(update);
  const startTime = Date.now();

  const meta: CouncilMeta = {
    mode: "standard",
    expertsUsed: [],
    cardsGenerated: 0,
    phaseErrors: [],
    durationMs: 0,
  };

  const params = parseParams(rawArgs);
  meta.mode = params.depth;
  meta.expertsUsed = params.experts.map((e) => e.name);
  const n = params.experts.length;

  if (!params.question) {
    throw new Error("No question provided. Usage: /council <question>");
  }
  if (n === 0) {
    throw new Error(
      "No council experts found. Create agent definitions in ~/.pi/agent/agents/council-*.md",
    );
  }

  emit({ phase: "init", message: `Council: ${n} experts evaluating…`, detail: params.question.slice(0, 120) });

  // ── Phase 0: Moderator (deep only) ──────────────────────────────

  let moderatorBrief: ModeratorBrief | null = null;

  if (params.depth === "deep") {
    emit({ phase: "moderator", message: "Moderator analyzing question…" });

    const modResult = await runModerator({
      question: params.question,
      evidence: params.evidence,
      cwd: params.cwd,
      expertSummary: `${n} experts: ${params.experts.map((e) => e.role).join(", ")}`,
    });

    if (modResult.ok && modResult.json) {
      moderatorBrief = modResult.json as ModeratorBrief;
      emit({
        phase: "moderator",
        message: `Brief ready`,
        detail: moderatorBrief.brief?.slice(0, 200),
      });
    } else {
      meta.phaseErrors.push(`Moderator: ${modResult.error || "no output"}`);
    }
  }

  // ── Phase 1: Cards ──────────────────────────────────────────────

  emit({ phase: "cards", message: `Generating cards (${n} experts in parallel)…`, progress: { current: 0, total: n } });

  const enrichedQuestion = moderatorBrief
    ? `${params.question}\n\n[Moderator brief: ${moderatorBrief.brief}]\n[Constraints: ${(moderatorBrief.constraints || []).join("; ")}]`
    : params.question;

  const { cards: rawCards, errors: cardErrors } = await generateCards({
    ...params,
    question: enrichedQuestion,
  });
  meta.cardsGenerated = rawCards.length;
  meta.phaseErrors.push(...cardErrors);

  emit({ phase: "cards", message: `${rawCards.length} cards from ${n} experts`, progress: { current: n, total: n } });

  if (rawCards.length === 0) {
    emit({ phase: "error", message: "No cards generated" });
    return {
      recommendation: "Council failed: no cards generated.",
      topProposals: [], topRisks: [], bestDissent: [],
      blindSpots: [], firstStep: "Debug expert execution",
      confidence: "low", rawCards: [], rankings: [], meta,
    };
  }

  // ── Phase 2: Permute & Rank ─────────────────────────────────────

  emit({ phase: "permute", message: params.blind ? `Permuting ${rawCards.length} cards (full blind)…` : `Grouping ${rawCards.length} cards…` });

  const { permuted, reverseMapping } = params.blind
    ? permuteCards(rawCards)
    : { permuted: rawCards, reverseMapping: new Map<string, string>(), mapping: new Map<string, string>() };

  emit({ phase: "ranking", message: `Ranking (${n} experts)…`, progress: { current: 0, total: n } });

  const { rankings: permutedRankings, errors: rankErrors } = await rankCards(params, permuted);
  meta.phaseErrors.push(...rankErrors);

  emit({ phase: "ranking", message: `Rankings collected`, progress: { current: n, total: n } });

  const { rankings, cards: restoredCards } = params.blind
    ? restoreCardIds(permutedRankings, reverseMapping, rawCards)
    : { rankings: permutedRankings, cards: rawCards };

  // ── Phase 3: Aggregate ──────────────────────────────────────────

  emit({ phase: "aggregate", message: "Aggregating (Borda count)…" });

  const categoryRankings = bordaAggregate(rankings, restoredCards);
  const coverage = applyCoverageRules(categoryRankings, restoredCards);
  const groupthinkDetected = detectGroupthink(rankings);

  // ── Phase 4: Synthesize ─────────────────────────────────────────

  emit({ phase: "synthesize", message: groupthinkDetected ? "Synthesizing (⚠ groupthink)…" : "Synthesizing…" });

  const synthesis = await synthesize(params.question, coverage, groupthinkDetected);

  meta.durationMs = Date.now() - startTime;

  emit({ phase: "done", message: `Complete · ${meta.cardsGenerated}C · ${(meta.durationMs / 1000).toFixed(1)}s`, detail: synthesis.recommendation?.slice(0, 150) });

  return {
    recommendation: synthesis.recommendation,
    topProposals: coverage.topProposals,
    topRisks: coverage.topRisks,
    bestDissent: coverage.bestDissent,
    blindSpots: synthesis.blindSpots,
    firstStep: synthesis.firstStep,
    confidence: synthesis.confidence,
    rawCards: restoredCards,
    rankings: categoryRankings,
    meta,
  };
}

// ── Format Output ────────────────────────────────────────────────────

export function formatCouncilResult(result: CouncilResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("═══ Council Result ═══");
  lines.push("");
  lines.push(`**Recommendation:** ${result.recommendation}`);
  lines.push(`**Confidence:** ${result.confidence}`);
  lines.push(`**Mode:** ${result.meta.mode} | **Experts:** ${result.meta.expertsUsed.join(", ")} | **Cards:** ${result.meta.cardsGenerated} | **Time:** ${result.meta.durationMs}ms`);
  lines.push("");

  if (result.topProposals.length > 0) {
    lines.push("### Top Proposals");
    for (const p of result.topProposals) {
      lines.push(`- **${p.claim}** (${p.confidence}, ${p.basis})`);
      lines.push(`  ${p.why}`);
    }
    lines.push("");
  }

  if (result.topRisks.length > 0) {
    lines.push("### Top Risks");
    for (const r of result.topRisks) {
      lines.push(`- **${r.claim}** (${r.confidence}, ${r.basis})`);
      lines.push(`  If ignored: ${r.if_ignored}`);
    }
    lines.push("");
  }

  if (result.bestDissent.length > 0) {
    lines.push("### Best Dissent");
    for (const d of result.bestDissent) {
      lines.push(`- **${d.claim}** (${d.confidence}, ${d.basis})`);
    }
    lines.push("");
  }

  if (result.blindSpots.length > 0) {
    lines.push("### Blind Spots");
    for (const s of result.blindSpots) lines.push(`- ${s}`);
    lines.push("");
  }

  lines.push(`**First Step:** ${result.firstStep}`);
  lines.push("");

  if (result.meta.phaseErrors.length > 0) {
    lines.push("### Errors");
    for (const e of result.meta.phaseErrors) lines.push(`- ${e}`);
    lines.push("");
  }

  return lines.join("\n");
}
