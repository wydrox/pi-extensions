/**
 * Council Extension — types
 *
 * Grounded Blind Atomic Delphi protocol for pi.
 * Cards are small, evaluable reasoning units, not essays.
 */

// ── Atomic Argument Card ──────────────────────────────────────────

export interface Card {
  /** Unique card id assigned by orchestrator after generation */
  id: string;
  /** Category this argument belongs to */
  category: CardCategory;
  /** Short thesis statement (1 sentence) */
  claim: string;
  /** Justification (1-3 sentences) */
  why: string;
  /** What happens if this is ignored? */
  if_ignored: string;
  /** Confidence level */
  confidence: "low" | "medium" | "high";
  /** Epistemic grounding */
  basis: "observed" | "inferred" | "assumption" | "unknown";
  /** Evidence sources (tool output refs, file paths, URLs) */
  sources: string[];
  /** Expert who generated this card (stripped before ranking phase) */
  expertIndex?: number;
  /** Expert role that generated this card */
  expertRole?: string;
}

export type CardCategory =
  | "proposal"
  | "risk"
  | "insight"
  | "implementation"
  | "question"
  | "constraint";

// ── Expert Configuration ──────────────────────────────────────────

export interface ExpertConfig {
  /** Agent name (matches .md file without extension) */
  name: string;
  /** Human-readable role description */
  role: string;
  /** Perspective/persona prompt */
  perspective: string;
  /** Tools available during card generation phase */
  cardTools: string[];
  /** Tools available during ranking phase (read-only) */
  rankingTools: string[];
  /** Preferred model */
  model?: string;
  /** Thinking level */
  thinking?: "off" | "low" | "medium" | "high";
  /** Expert index in the pipeline (assigned by orchestrator) */
  index?: number;
}

// ── Council Parameters ────────────────────────────────────────────

export interface CouncilParams {
  /** The question or decision to evaluate */
  question: string;
  /** Depth mode */
  depth: "flash" | "standard" | "deep";
  /** Blind mode — cards are anonymized */
  blind: boolean;
  /** Ranking criteria */
  criteria: CouncilCriterion[];
  /** Maximum cards per expert */
  cardsPerExpert: number;
  /** Expert configs to use (defaults to built-in 5) */
  experts: ExpertConfig[];
  /** Optional file paths to include as evidence context */
  evidence: string[];
  /** Working directory */
  cwd: string;
}

export type CouncilCriterion =
  | "correctness"
  | "risk"
  | "simplicity"
  | "speed"
  | "reversibility"
  | "user-value"
  | "cost"
  | "confidence";

// ── Ranking ───────────────────────────────────────────────────────

export interface RankingEntry {
  /** Card id being ranked */
  cardId: string;
  /** Expert who did the ranking */
  expertIndex: number;
  /** Rank (1 = best) within this category */
  rank: number;
  /** Category this ranking applies to */
  category: CardCategory;
}

export interface CategoryRankings {
  category: CardCategory;
  /** Cards sorted best → worst (by aggregated rank) */
  ranked: string[];
  /** Per-expert rankings for transparency */
  perExpert: RankingEntry[];
}

// ── Pipeline Result ───────────────────────────────────────────────

export interface CouncilResult {
  /** Synthesized recommendation text */
  recommendation: string;
  /** Top proposals (sorted) */
  topProposals: Card[];
  /** Top risks (sorted) */
  topRisks: Card[];
  /** Must-not-ignore dissent */
  bestDissent: Card[];
  /** Blind spots and unknowns */
  blindSpots: string[];
  /** Actionable first step */
  firstStep: string;
  /** Overall confidence */
  confidence: "low" | "medium" | "high";
  /** All generated cards (for debugging) */
  rawCards: Card[];
  /** Per-category rankings */
  rankings: CategoryRankings[];
  /** Aggregator metadata */
  meta: CouncilMeta;
}

export interface CouncilMeta {
  mode: string;
  expertsUsed: string[];
  cardsGenerated: number;
  phaseErrors: string[];
  durationMs: number;
}

// ── Spawned Expert Output ─────────────────────────────────────────

export interface ExpertCardOutput {
  cards: Card[];
  notes?: string;
}

export interface ExpertRankingOutput {
  rankings: {
    cardId: string;
    rank: number;
    category: CardCategory;
    comment?: string;
  }[];
  notes?: string;
}

export interface SynthesisOutput {
  recommendation: string;
  agreements: string[];
  clashes: string[];
  blindSpots: string[];
  firstStep: string;
  confidence: "low" | "medium" | "high";
  dissentSummary: string;
}

// ── Moderator Output ─────────────────────────────────────────────

export interface ModeratorBrief {
  brief: string;
  criteria: string[];
  constraints: string[];
  evidenceNeeded: string[];
}

// ── Phase Callback ───────────────────────────────────────────────

/** Phase names for status reporting */
export type CouncilPhase =
  | "init"
  | "moderator"
  | "cards"
  | "permute"
  | "ranking"
  | "aggregate"
  | "synthesize"
  | "done"
  | "error";

export interface PhaseUpdate {
  phase: CouncilPhase;
  message: string;
  detail?: string;
  progress?: { current: number; total: number };
}
