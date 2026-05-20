import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type TodoStatus = "todo" | "inprogress" | "done" | "blocked" | "skipping";

type NotifyLevel = "info" | "warning" | "error" | "success";

interface TodoItem {
  id?: number;
  text: string;
  status: TodoStatus;
}

interface TodoSnapshot {
  items: TodoItem[];
  counts: Record<TodoStatus, number>;
  total: number;
  actionable: number;
  terminal: number;
  updatedAt: number;
  source: string;
}

interface RalphLoopState {
  version: 1;
  enabled: boolean;
  maxLoops: number;
  loopCount: number;
  snapshot?: TodoSnapshot;
}

const STATE_TYPE = "ralph-loop-state";
const HANDOFF_STATE_TYPES = new Set(["handoff-state"]);
const TODO_TOOL_NAMES = new Set(["todo", "todo_sidebar", "todo-sidebar"]);
const DEFAULT_STATE: RalphLoopState = {
  version: 1,
  enabled: false,
  maxLoops: 300,
  loopCount: 0,
};

function emptyCounts(): Record<TodoStatus, number> {
  return {
    todo: 0,
    inprogress: 0,
    done: 0,
    blocked: 0,
    skipping: 0,
  };
}

function normalizeStatus(value: unknown): TodoStatus | undefined {
  if (typeof value === "boolean") return value ? "done" : "todo";
  if (typeof value !== "string") return undefined;

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  switch (normalized) {
    case "todo":
    case "open":
    case "pending":
    case "not_started":
      return "todo";
    case "inprogress":
    case "in_progress":
    case "doing":
    case "active":
    case "working":
      return "inprogress";
    case "done":
    case "complete":
    case "completed":
    case "closed":
      return "done";
    case "blocked":
    case "waiting":
    case "stuck":
      return "blocked";
    case "skipping":
    case "skip":
    case "skipped":
    case "wont_fix":
    case "won_t_fix":
      return "skipping";
    default:
      return undefined;
  }
}

function normalizeItem(input: any, fallbackId: number): TodoItem | null {
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return null;
    return { id: fallbackId, text, status: "todo" };
  }

  if (!input || typeof input !== "object") return null;

  const text = [input.text, input.label, input.title, input.name]
    .find((value) => typeof value === "string" && value.trim().length > 0)
    ?.trim();
  if (!text) return null;

  const status =
    normalizeStatus(input.status) ??
    normalizeStatus(input.state) ??
    normalizeStatus(input.done) ??
    normalizeStatus(input.completed) ??
    "todo";

  const rawId = input.id ?? input.todoId ?? input.index;
  const id =
    typeof rawId === "number" ? rawId : Number.isFinite(Number(rawId)) ? Number(rawId) : fallbackId;

  return { id, text, status };
}

function buildSnapshot(items: TodoItem[], source: string): TodoSnapshot {
  const counts = emptyCounts();
  for (const item of items) counts[item.status] += 1;

  const total = items.length;
  const actionable = counts.todo + counts.inprogress;
  const terminal = counts.done + counts.skipping;

  return {
    items,
    counts,
    total,
    actionable,
    terminal,
    updatedAt: Date.now(),
    source,
  };
}

function parseItemsArray(input: any, source: string): TodoSnapshot | undefined {
  if (!Array.isArray(input)) return undefined;

  const items = input
    .map((item, index) => normalizeItem(item, index + 1))
    .filter((item): item is TodoItem => Boolean(item));

  if (!items.length) return undefined;
  return buildSnapshot(items, source);
}

function parseStructuredSnapshot(input: any, source: string): TodoSnapshot | undefined {
  if (!input || typeof input !== "object") return undefined;

  const direct = parseItemsArray(input, `${source}:direct-array`);
  if (direct) return direct;

  const arrayKeys = ["items", "todos", "tasks", "entries", "list"];
  for (const key of arrayKeys) {
    const parsed = parseItemsArray((input as Record<string, unknown>)[key], `${source}:${key}`);
    if (parsed) return parsed;
  }

  if (input.snapshot && typeof input.snapshot === "object") {
    const parsed = parseStructuredSnapshot(input.snapshot, `${source}:snapshot`);
    if (parsed) return parsed;
  }

  return undefined;
}

function extractTextFromResult(result: any): string {
  if (!result) return "";

  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");

  if (text.trim()) return text;
  if (typeof result.text === "string") return result.text;
  return "";
}

function parseSnapshotFromText(text: string, source: string): TodoSnapshot | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsedJson = JSON.parse(trimmed);
      const structured = parseStructuredSnapshot(parsedJson, `${source}:json`);
      if (structured) return structured;
    } catch {
      // Ignore and continue with regex parsing.
    }
  }

  const lines = trimmed.split(/\r?\n/);
  const items: TodoItem[] = [];
  let inferredId = 1;

  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;

    let status: TodoStatus | undefined;
    if (/\[[xX]\]/.test(raw)) status = "done";
    else if (/\[\s*\]/.test(raw)) status = "todo";
    else if (/\b(?:in[ _-]?progress|todo|done|blocked|skipping)\b/i.test(raw)) {
      const match = raw.match(/\b(in[ _-]?progress|todo|done|blocked|skipping)\b/i);
      status = normalizeStatus(match?.[1]);
    }

    if (!status) continue;

    const cleaned = raw
      .replace(/^[-*]\s*/, "")
      .replace(/^\d+[.):]\s*/, "")
      .replace(/^#\d+[.):]?\s*/, "")
      .replace(/\[[xX\s]\]/g, "")
      .replace(/\b(in[ _-]?progress|todo|done|blocked|skipping)\b[:\s-]*/gi, "")
      .trim();

    if (!cleaned) continue;
    items.push({ id: inferredId++, text: cleaned, status });
  }

  if (!items.length) return undefined;
  return buildSnapshot(items, `${source}:text`);
}

function parseSnapshotFromResult(result: any): TodoSnapshot | undefined {
  const structured =
    parseStructuredSnapshot(result?.details, "details") ??
    parseStructuredSnapshot(result, "result");
  if (structured) return structured;

  const text = extractTextFromResult(result);
  return parseSnapshotFromText(text, "content");
}

function getLatestAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;

    if (typeof message.content === "string") {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      return message.content
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n");
    }
  }

  return "";
}

function isLoopBlockedByMessages(messages: any[]): boolean {
  const text = getLatestAssistantText(messages).trim();
  if (!text) return false;

  const explicitBlockerPatterns = [
    /(?:^|\n)\s*(?:BLOCKER|NEEDS_DECISION|WAITING_FOR_USER)\s*:/i,
    /\b(?:cannot proceed|can't proceed|need your decision|need more information|waiting for input|permission denied|requires approval|cannot continue|can't continue|cannot move forward|can't move forward|missing information|needs decision|needs approval)\b/i,
    /\b(?:brakuje informacji|potrzebuję decyzji|potrzebuje decyzji|czekam na decyzj[ęe]|nie mogę kontynuować|nie moge kontynuowac|nie mogę ruszyć dalej|wymaga decyzji|wymaga aprobaty)\b/i,
  ];

  return explicitBlockerPatterns.some((pattern) => pattern.test(text));
}

function formatState(state: RalphLoopState): string {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return `enabled=${state.enabled} loops=${state.loopCount}/${state.maxLoops} snapshot=missing`;
  }

  const counts = snapshot.counts;
  return [
    `enabled=${state.enabled}`,
    `loops=${state.loopCount}/${state.maxLoops}`,
    `total=${snapshot.total}`,
    `todo=${counts.todo}`,
    `inprogress=${counts.inprogress}`,
    `blocked=${counts.blocked}`,
    `done=${counts.done}`,
    `skipping=${counts.skipping}`,
    `source=${snapshot.source}`,
  ].join(" ");
}

export default function (pi: ExtensionAPI) {
  let state: RalphLoopState = { ...DEFAULT_STATE };

  const notify = (ctx: ExtensionContext, message: string, level: NotifyLevel = "info") => {
    try {
      ctx.ui.notify(message, level);
    } catch {
      // No-op outside interactive contexts.
    }
  };

  const persist = () => {
    pi.appendEntry(STATE_TYPE, state);
  };

  const hydrate = (ctx: ExtensionContext): boolean => {
    state = { ...DEFAULT_STATE };
    let hasHandoffCarryover = false;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && HANDOFF_STATE_TYPES.has(entry.customType)) {
        hasHandoffCarryover = true;
      }

      if (
        entry.type === "custom" &&
        entry.customType === STATE_TYPE &&
        entry.data &&
        typeof entry.data === "object"
      ) {
        state = {
          ...state,
          ...(entry.data as Partial<RalphLoopState>),
        };
      }

      if (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        TODO_TOOL_NAMES.has(entry.message.toolName)
      ) {
        const snapshot = parseSnapshotFromResult(entry.message);
        if (snapshot) state.snapshot = snapshot;
      }
    }

    return hasHandoffCarryover;
  };

  const maybeContinue = (ctx: ExtensionContext, reason: string) => {
    if (!state.enabled) return;
    if (!state.snapshot) return;
    if (ctx.hasPendingMessages?.()) return;

    const { counts, actionable, total } = state.snapshot;

    if (total === 0) {
      notify(ctx, "Ralph loop: todo is empty, stopping.");
      return;
    }

    if (actionable === 0) {
      if (counts.blocked > 0) {
        notify(ctx, "Ralph loop: only blocked/skipping items remain, waiting for user.", "warning");
      } else {
        notify(ctx, "Ralph loop: all todo items are complete.", "success");
      }
      return;
    }

    if (state.loopCount >= state.maxLoops) {
      notify(ctx, `Ralph loop: reached limit of ${state.maxLoops} loops.`, "warning");
      return;
    }

    state.loopCount += 1;
    persist();

    const message = [
      `Continue autonomously (${reason}).`,
      "Do not ask whether to continue.",
      "Use todo as source of truth.",
      "First list todo, then pick the next actionable task (todo/inprogress).",
      "After completing a task, update its status in todo and move to the next one.",
      "Stop only for a real blocker, missing data, or a business decision.",
    ].join(" ");

    if (ctx.isIdle()) pi.sendUserMessage(message);
    else pi.sendUserMessage(message, { deliverAs: "followUp" });
  };

  pi.on("session_start", async (event, ctx) => {
    const hasHandoffCarryover = hydrate(ctx);

    if ((event.reason === "new" || event.reason === "fork") && !hasHandoffCarryover) {
      state.enabled = false;
      state.loopCount = 0;
      persist();
    }

    notify(ctx, `Ralph loop loaded: ${formatState(state)}`);
  });

  pi.on("session_tree", async (_event, ctx) => {
    hydrate(ctx);
    notify(ctx, `Ralph loop restored: ${formatState(state)}`);
  });

  pi.on("tool_execution_end", async (event, _ctx) => {
    if (!TODO_TOOL_NAMES.has(event.toolName) || event.isError) return;

    const snapshot = parseSnapshotFromResult(event.result);
    if (!snapshot) return;

    state.snapshot = snapshot;
    persist();
  });

  pi.on("before_agent_start", async (event) => {
    if (!state.enabled) return;

    const snapshotLine = state.snapshot
      ? `Current todo snapshot: total=${state.snapshot.total}, todo=${state.snapshot.counts.todo}, inprogress=${state.snapshot.counts.inprogress}, blocked=${state.snapshot.counts.blocked}, done=${state.snapshot.counts.done}, skipping=${state.snapshot.counts.skipping}.`
      : "Current todo snapshot: unknown. Use todo list early in the turn.";

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\nRalph loop instructions:\n- Use todo as the authoritative backlog.\n- Do not stop after 2-3 tasks just to ask whether to continue.\n- When work remains, continue to the next actionable task automatically.\n- Update todo statuses as you work.\n- If the state is unclear, call todo with action=list.\n- Stop only for a real blocker, missing information, risky destructive action, or a business decision.\n- ${snapshotLine}`,
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!state.enabled) return;
    if (!state.snapshot) return;
    if (isLoopBlockedByMessages(event.messages)) {
      notify(
        ctx,
        "Ralph loop: agent reported a blocker / needs decision, not queuing further work.",
        "warning",
      );
      return;
    }

    maybeContinue(ctx, "ralph-loop");
  });

  pi.registerCommand("ralph", {
    description: "Control the auto-continue loop backed by todo",
    handler: async (args, ctx) => {
      const [command, value] = args.trim().split(/\s+/, 2);
      const cmd = (command || "status").toLowerCase();

      switch (cmd) {
        case "on":
        case "true":
          state.enabled = true;
          persist();
          notify(ctx, `Ralph loop enabled. ${formatState(state)}`, "success");
          return;
        case "off":
        case "false":
          state.enabled = false;
          persist();
          notify(ctx, "Ralph loop disabled.", "warning");
          return;
        case "reset":
          state.loopCount = 0;
          persist();
          notify(ctx, `Ralph loop reset. ${formatState(state)}`, "info");
          return;
        case "max": {
          const next = Number(value);
          if (!Number.isFinite(next) || next < 1) {
            notify(ctx, "Usage: /ralph max <positive-number>", "error");
            return;
          }
          state.maxLoops = Math.floor(next);
          persist();
          notify(ctx, `Ralph loop max set to ${state.maxLoops}.`, "success");
          return;
        }
        case "kick":
          maybeContinue(ctx, "manual-kick");
          return;
        case "status":
        default:
          notify(ctx, `Ralph loop: ${formatState(state)}`);
      }
    },
  });
}
