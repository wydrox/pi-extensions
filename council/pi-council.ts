/**
 * pi-spawner — lean subagent spawner for council
 *
 * Spawns pi CLI processes with streaming JSONL parse.
 * No rawEvents buffer — only the final assistant message is retained.
 * Pattern-matched from the native subagent extension for consistency.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

// ── Types ───────────────────────────────────────────────────────────

export interface SpawnOptions {
  /** System prompt to inject (appended or replacing default) */
  systemPrompt?: string;
  /** Append to system prompt instead of replacing */
  appendSystem?: boolean;
  /** Tools to enable */
  tools?: string[];
  /** Task/message to send */
  task: string;
  /** Working directory */
  cwd?: string;
  /** Model override */
  model?: string;
  /** Thinking level */
  thinking?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Additional pi CLI flags */
  extraFlags?: string[];
  /** Label for logging */
  label?: string;
}

export interface SpawnResult {
  /** Parsed JSON from the final assistant message */
  json: unknown;
  /** Raw final assistant text */
  text: string;
  /** Whether the process completed successfully */
  ok: boolean;
  /** Error message if any */
  error?: string;
  /** Duration in ms */
  durationMs: number;
  /** Process exit code */
  exitCode: number | null;
}

interface PiMessage {
  role: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
    totalTokens?: number;
  };
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

// ── Configuration ───────────────────────────────────────────────────

const PI_BIN = process.env.PI_BIN || "pi";
/** Maximum time to wait for a single expert (ms) */
const DEFAULT_TIMEOUT_MS = 300_000;
/** Agent definitions directory (for extracting metadata) */
const AGENTS_DIR = path.join(process.env.HOME || "/tmp", ".pi/agent/agents");

// ── Pi Invocation Discovery ─────────────────────────────────────────

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: PI_BIN, args };
}

// ── Temp File Helpers ───────────────────────────────────────────────

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-council-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function cleanupTempFile(dir: string | null, filePath: string | null) {
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }
  if (dir) {
    try { fs.rmdirSync(dir); } catch { /* ignore */ }
  }
}

// ── JSON Extraction ─────────────────────────────────────────────────

function extractJsonFromText(text: string): unknown {
  // Try the whole text first
  try { return JSON.parse(text); } catch { /* ignore */ }
  // Try to find a JSON object or array
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* ignore */ }
  }
  return null;
}

function extractAssistantText(msg: PiMessage): string {
  if (!msg.content) return "";
  const texts = msg.content
    .filter((c) => c.type === "text")
    .map((c) => c.text || "")
    .join("\n")
    .trim();
  return texts;
}

// ── Core Spawn Function ─────────────────────────────────────────────

export async function spawnPi(opts: SpawnOptions): Promise<SpawnResult> {
  const startTime = Date.now();
  const args: string[] = [];

  // Base args
  args.push("--mode", "json");
  args.push("-p"); // non-interactive
  args.push("--no-session"); // prevent session-directory contention
  args.push("--no-extensions"); // prevent rogue extensions from interfering

  // Selectively load memory / mempalace so experts can query durable context
  const MEM_EXT = path.join(
    process.env.HOME || "/tmp",
    ".pi/agent/extensions/ppmlx-memory/index.ts",
  );
  const PALACE_EXT = path.join(
    process.env.HOME || "/tmp",
    ".pi/agent/extensions/mempalace/index.ts",
  );
  if (fs.existsSync(MEM_EXT)) args.push("-e", MEM_EXT);
  if (fs.existsSync(PALACE_EXT)) args.push("-e", PALACE_EXT);

  // Tools
  if (opts.tools && opts.tools.length > 0) {
    args.push("--tools", opts.tools.join(","));
  }

  // Model
  if (opts.model) {
    args.push("--model", opts.model);
  }

  // Thinking
  if (opts.thinking) {
    args.push("--thinking", opts.thinking);
  }

  // Extra flags
  if (opts.extraFlags) {
    args.push(...opts.extraFlags);
  }

  const label = opts.label || "expert";
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const cwd = opts.cwd || process.cwd();

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  // System prompt — write to temp file to avoid long CLI args
  if (opts.systemPrompt) {
    const tmp = writePromptToTempFile(label, opts.systemPrompt);
    tmpPromptDir = tmp.dir;
    tmpPromptPath = tmp.filePath;
    if (opts.appendSystem) {
      args.push("--append-system-prompt", tmpPromptPath);
    } else {
      args.push("--system-prompt", tmpPromptPath);
    }
  }

  // Task (positional argument)
  args.push(opts.task);

  let child: ChildProcess | null = null;
  let killedEarly = false;

  try {
    const result = await new Promise<SpawnResult>((resolve) => {
      let completed = false;
      let buffer = "";
      let stderr = "";
      let lastAssistantText = "";
      let lastAssistantJson: unknown = null;
      let lastMessage: PiMessage | null = null;

      const finish = (ok: boolean, error?: string, exitCode?: number | null) => {
        if (completed) return;
        completed = true;
        const durationMs = Date.now() - startTime;

        const text = lastAssistantText;
        const json = lastAssistantJson ?? extractJsonFromText(text);

        resolve({
          json,
          text,
          ok,
          error,
          durationMs,
          exitCode: exitCode ?? child?.exitCode ?? null,
        });
      };

      const tryFinishFromMessage = (msg: PiMessage) => {
        if (msg.role !== "assistant" || !msg.content) return false;
        const text = extractAssistantText(msg);
        if (!text) return false;
        lastAssistantText = text;
        lastAssistantJson = extractJsonFromText(text);
        return true;
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as PiMessage;
          lastMessage = msg;
          if (tryFinishFromMessage(msg)) {
            // Early exit: we have the assistant response
            killedEarly = true;
            finish(true);
            if (child && !child.killed) {
              child.kill("SIGTERM");
              setTimeout(() => {
                if (child && !child.killed) child.kill("SIGKILL");
              }, 5000);
            }
          }
        }
      };

      const timer = setTimeout(() => {
        if (child && !child.killed) {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child && !child.killed) child.kill("SIGKILL");
          }, 5000);
        }
        finish(false, `timeout after ${timeoutMs}ms`);
      }, timeoutMs);

      try {
        const invocation = getPiInvocation(args);
        child = spawn(invocation.command, invocation.args, {
          cwd,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        });

        child.stdout?.on("data", (data: Buffer) => {
          buffer += data.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) processLine(line);
        });

        child.stderr?.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          finish(false, `spawn error: ${err.message}`);
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          if (killedEarly) return; // already resolved
          if (buffer.trim()) processLine(buffer);
          if (!completed) {
            if (code !== 0) {
              finish(false, `exit code ${code}: ${stderr.slice(-500)}`, code);
            } else {
              finish(true, undefined, code);
            }
          }
        });
      } catch (err) {
        clearTimeout(timer);
        finish(false, `failed to spawn: ${String(err)}`);
      }
    });

    return result;
  } finally {
    cleanupTempFile(tmpPromptDir, tmpPromptPath);
  }
}

// ── Expert Runner ────────────────────────────────────────────────────

export interface RunExpertCardOptions {
  /** Expert role definition (system prompt for card generation) */
  rolePrompt: string;
  /** Tools available to this expert */
  tools: string[];
  /** The council question */
  question: string;
  /** Evidence context (files to include) */
  evidence?: string[];
  /** Working directory */
  cwd?: string;
  /** Expert index for tracking */
  index: number;
  /** Expert name for logging */
  name: string;
}

/**
 * Run a single expert for card generation.
 * Expert gets tool access, generates 4-6 atomic cards.
 */
export async function runExpertCards(
  opts: RunExpertCardOptions,
): Promise<SpawnResult> {
  const evidenceBlock =
    opts.evidence && opts.evidence.length > 0
      ? `\n\nEvidence files available (use read tool to examine):\n${opts.evidence.map((f) => `  - ${f}`).join("\n")}`
      : "";

  const task = `Analyze this question from your specific perspective and generate 4-6 atomic argument cards.

## Your Role
${opts.rolePrompt}

## Question
${opts.question}${evidenceBlock}

## Card Format
Return a JSON object with a "cards" array. Each card must have:
- category: one of "proposal", "risk", "insight", "implementation", "question", "constraint"
- claim: short thesis (1 sentence)
- why: justification (1-3 sentences)
- if_ignored: what happens if this argument is ignored
- confidence: "low", "medium", or "high"
- basis: "observed", "inferred", "assumption", or "unknown"
- sources: array of evidence references (tool outputs, file paths, URLs)

Before writing your cards, use the read tool to examine relevant files/facts. Every factual claim must have a basis and sources. If you must infer or assume, mark basis accordingly.

Output ONLY the JSON object, no other text.`;

  return spawnPi({
    task,
    tools: opts.tools,
    appendSystem: true,
    cwd: opts.cwd,
    label: `expert-card-${opts.name}`,
    systemPrompt: opts.rolePrompt,
  });
}

// ── Expert Ranking Runner ────────────────────────────────────────────

export interface RunExpertRankingOptions {
  /** Expert role definition */
  rolePrompt: string;
  /** Anonymous cards to rank, grouped by category */
  cards: Record<string, Array<{ id: string; claim: string; why: string; if_ignored: string; confidence: string; basis: string }>>;
  /** Ranking criteria */
  criteria: string[];
  /** Expert index for tracking */
  index: number;
  /** Expert name for logging */
  name: string;
}

/**
 * Run a single expert for card ranking.
 * Expert gets read-only tools, ranks anonymous cards per category.
 */
export async function runExpertRanking(
  opts: RunExpertRankingOptions,
): Promise<SpawnResult> {
  const cardsBlock = Object.entries(opts.cards)
    .map(([cat, cards]) => {
      const cardText = cards
        .map(
          (c) =>
            `  [${c.id}] (confidence:${c.confidence}, basis:${c.basis})\n    Claim: ${c.claim}\n    Why: ${c.why}\n    If ignored: ${c.if_ignored}`,
        )
        .join("\n\n");
      return `### Category: ${cat}\n${cardText}`;
    })
    .join("\n\n");

  const task = `Rank the following anonymous argument cards from your perspective. These cards were generated by various experts — you do NOT know who wrote which card.

## Your Role
${opts.rolePrompt}

## Ranking Criteria
${opts.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## Cards to Rank
${cardsBlock}

## Instructions
For each category, rank the cards from best (1) to last. A "best" card is one that is:
- Well-grounded in evidence (basis: observed > inferred > assumption > unknown)
- High impact if ignored
- Specific and actionable
- Logically sound

Return a JSON object with a "rankings" array:
[
  {"cardId": "C001", "rank": 1, "category": "risk", "comment": "optional brief reason"},
  ...
]

IMPORTANT: You must rank ALL cards in each category. Do not skip any.
If cards are equally good, still assign different ranks (no ties).
Output ONLY the JSON object.`;

  return spawnPi({
    task,
    tools: ["read", "grep"],
    appendSystem: true,
    label: `expert-rank-${opts.name}`,
  });
}

// ── Synthesis Runner ──────────────────────────────────────────────────

export interface RunSynthesisOptions {
  /** Synthesis prompt */
  prompt: string;
  /** Top cards, rankings, and conflicts to synthesize from */
  context: string;
}

/**
 * Run the synthesizer to produce final recommendation.
 */
export async function runSynthesis(
  opts: RunSynthesisOptions,
): Promise<SpawnResult> {
  const task = `${opts.prompt}\n\n## Input\n${opts.context}\n\n## Critical Rules\n1. Use the ORIGINAL card IDs exactly as shown (e.g. "council-contrarian-k2m8x"). NEVER renumber them to C001, C002 etc.\n2. Reference specific card IDs in your recommendation.\n3. If less than 3 experts contributed, note this in blindSpots.\n4. Output ONLY a JSON object with: recommendation, agreements (array), clashes (array), blindSpots (array), firstStep, confidence, dissentSummary.`;

  return spawnPi({
    task,
    tools: ["read"],
    appendSystem: true,
    label: "synthesizer",
    systemPrompt: opts.prompt,
  });
}

// ── Moderator Runner ──────────────────────────────────────────────────

export interface RunModeratorOptions {
  question: string;
  evidence?: string[];
  cwd?: string;
  expertSummary?: string;
}

/**
 * Run the moderator to produce a brief and evidence assessment.
 */
export async function runModerator(
  opts: RunModeratorOptions,
): Promise<SpawnResult> {
  const evidenceBlock = opts.expertSummary
    ? `\n\nExpert pool: ${opts.expertSummary}`
    : "";

  const task = `You are the Moderator of an AI council. Your job is to prepare a structured brief.

## Question
${opts.question}${evidenceBlock}

## Task
1. Clarify the decision criteria
2. Identify what evidence would be most valuable
3. Note key constraints and non-goals
4. Produce a concise brief (max 200 words) for the expert panel

Return a JSON object with:
- brief: concise summary for experts
- criteria: array of decision criteria
- constraints: array of hard constraints  
- evidenceNeeded: array of what to look for

Output ONLY the JSON object.`;

  return spawnPi({
    task,
    tools: ["read", "grep", "find"],
    appendSystem: true,
    cwd: opts.cwd,
    label: "moderator",
  });
}
