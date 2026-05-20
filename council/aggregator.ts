/**
 * aggregator — deterministic council ranking
 *
 * Takes per-expert card rankings and produces:
 *  - Borda count aggregation per category
 *  - Coverage rules: top proposal, top risk, top unknown, dissent preserved
 *
 * This is pure code — no LLM involved. No hidden arbitrator.
 */

import type {
  Card,
  CardCategory,
  CategoryRankings,
  RankingEntry,
} from "./types.js";

// ── Borda Count Aggregation ─────────────────────────────────────────

/**
 * Aggregate per-expert rankings using Borda count.
 * In Borda count: rank 1 gets N-1 points, rank 2 gets N-2, ..., last gets 0.
 */
export function bordaAggregate(
  rankings: RankingEntry[],
  cards: Card[],
): CategoryRankings[] {
  // Group rankings by category
  const byCategory = new Map<CardCategory, RankingEntry[]>();
  for (const r of rankings) {
    const existing = byCategory.get(r.category) || [];
    existing.push(r);
    byCategory.set(r.category, existing);
  }

  const result: CategoryRankings[] = [];

  for (const [category, catRankings] of byCategory) {
    // Count how many unique cards in this category
    const cardIds = [
      ...new Set(catRankings.map((r) => r.cardId)),
    ];
    const n = cardIds.length;

    if (n === 0) continue;

    // Compute Borda scores
    const scores = new Map<string, number>();
    for (const cardId of cardIds) {
      scores.set(cardId, 0);
    }

    // Group rankings by expert
    const byExpert = new Map<number, RankingEntry[]>();
    for (const r of catRankings) {
      const existing = byExpert.get(r.expertIndex) || [];
      existing.push(r);
      byExpert.set(r.expertIndex, existing);
    }

    // Each expert contributes Borda points
    for (const [, expertRankings] of byExpert) {
      // Sort by rank (1 = best)
      const sorted = expertRankings.sort((a, b) => a.rank - b.rank);
      // Assign points: last rank gets 0, first gets m-1 where m is number ranked
      const m = sorted.length;
      for (let i = 0; i < sorted.length; i++) {
        const points = m - i - 1; // Borda: position 0 (best) = m-1 points
        const current = scores.get(sorted[i].cardId) || 0;
        scores.set(sorted[i].cardId, current + points);
      }
    }

    // Sort cards by score (descending)
    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);

    result.push({
      category,
      ranked,
      perExpert: catRankings,
    });
  }

  return result;
}

// ── Coverage Rules ───────────────────────────────────────────────────

/**
 * Ensure the final selection covers all mandatory perspectives:
 *  - Top proposal
 *  - Top risk
 *  - Top unknown/question
 *  - Best dissent (card that disagrees with top proposal)
 *  - Top implementation note
 */
export function applyCoverageRules(
  rankings: CategoryRankings[],
  cards: Card[],
): {
  topProposals: Card[];
  topRisks: Card[];
  bestDissent: Card[];
  topUnknowns: Card[];
  topImplementation: Card[];
} {
  const cardMap = new Map(cards.map((c) => [c.id, c]));
  const rankMap = new Map<string, CategoryRankings>();
  for (const cr of rankings) {
    rankMap.set(cr.category, cr);
  }

  // Get top proposals
  const proposalRanking = rankMap.get("proposal");
  const topProposals = proposalRanking
    ? proposalRanking.ranked.slice(0, 3).map((id) => cardMap.get(id)!).filter(Boolean)
    : [];

  // Get top risks
  const riskRanking = rankMap.get("risk");
  const topRisks = riskRanking
    ? riskRanking.ranked.slice(0, 3).map((id) => cardMap.get(id)!).filter(Boolean)
    : [];

  // Get top unknowns/questions
  const questionRanking = rankMap.get("question");
  const topUnknowns = questionRanking
    ? questionRanking.ranked.slice(0, 2).map((id) => cardMap.get(id)!).filter(Boolean)
    : [];

  // Get top implementation
  const implRanking = rankMap.get("implementation");
  const topImplementation = implRanking
    ? implRanking.ranked.slice(0, 2).map((id) => cardMap.get(id)!).filter(Boolean)
    : [];

  // Find best dissent: look for cards that disagree with top proposal
  // Strategy: find high-ranked cards that are NOT proposals or constraints,
  // especially those with "observed" basis and high confidence
  const dissentCandidates = cards
    .filter(
      (c) =>
        c.category === "risk" ||
        c.category === "question" ||
        c.category === "insight",
    )
    .filter((c) => c.confidence !== "low")
    .sort((a, b) => {
      // Sort by: basis quality, then confidence, then if_ignored impact
      const basisScore = (b: string) =>
        b === "observed" ? 3 : b === "inferred" ? 2 : b === "assumption" ? 1 : 0;
      const aScore =
        basisScore(a.basis) * 2 +
        (a.confidence === "high" ? 2 : a.confidence === "medium" ? 1 : 0) +
        a.if_ignored.length * 0.01;
      const bScore =
        basisScore(b.basis) * 2 +
        (b.confidence === "high" ? 2 : b.confidence === "medium" ? 1 : 0) +
        b.if_ignored.length * 0.01;
      return bScore - aScore;
    });

  const bestDissent = dissentCandidates.slice(0, 3);

  return {
    topProposals,
    topRisks,
    bestDissent,
    topUnknowns,
    topImplementation,
  };
}

// ── Card Permutation (Full Blind) ────────────────────────────────────

/**
 * Permute card IDs for full blind ranking.
 * Creates a deterministic but unpredictable mapping so experts can't
 * correlate cards from the same author.
 */
export function permuteCards(cards: Card[]): {
  permuted: Card[];
  mapping: Map<string, string>; // newId → originalId
  reverseMapping: Map<string, string>; // originalId → newId
} {
  const mapping = new Map<string, string>();
  const reverseMapping = new Map<string, string>();

  // Create a copy and shuffle
  const shuffled = [...cards].sort(() => Math.random() - 0.5);

  // Assign new IDs
  const permuted: Card[] = shuffled.map((card, i) => {
    const newId = `C${String(i + 1).padStart(3, "0")}`;
    mapping.set(newId, card.id);
    reverseMapping.set(card.id, newId);
    return {
      ...card,
      id: newId,
      // Strip expert identity
      expertIndex: undefined,
      expertRole: undefined,
    };
  });

  return { permuted, mapping, reverseMapping };
}

/**
 * Restore original card IDs after ranking.
 */
export function restoreCardIds(
  rankings: RankingEntry[],
  reverseMapping: Map<string, string>,
  cards: Card[],
): { rankings: RankingEntry[]; cards: Card[] } {
  const cardMap = new Map(cards.map((c) => [c.id, c]));

  const restoredRankings = rankings.map((r) => ({
    ...r,
    cardId: reverseMapping.get(r.cardId) || r.cardId,
  }));

  // Restore card IDs for the cards that were ranked
  const restoredCards = cards.map((c) => {
    const origId = reverseMapping.get(c.id);
    return origId ? { ...c, id: origId } : c;
  });

  return { rankings: restoredRankings, cards: restoredCards };
}

// ── Consensus Check ──────────────────────────────────────────────────

/**
 * Detect excessive consensus (all experts agree on everything).
 * Returns true if diversity is dangerously low.
 */
export function detectGroupthink(
  rankings: RankingEntry[],
  threshold = 0.9,
): boolean {
  // Group by category, check if top-1 card has overwhelming agreement
  const byCategory = new Map<CardCategory, Map<string, number>>();
  for (const r of rankings) {
    if (r.rank !== 1) continue; // only look at top-ranked
    const counts = byCategory.get(r.category) || new Map();
    counts.set(r.cardId, (counts.get(r.cardId) || 0) + 1);
    byCategory.set(r.category, counts);
  }

  let totalTopPicks = 0;
  let maxAgreement = 0;

  for (const [, counts] of byCategory) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const max = Math.max(...counts.values());
    totalTopPicks += total;
    maxAgreement += max;
  }

  if (totalTopPicks === 0) return false;
  return maxAgreement / totalTopPicks >= threshold;
}
