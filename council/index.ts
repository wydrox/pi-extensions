/**
 * Council Extension for pi
 *
 * Registers:
 *   1. /council slash command (interactive mode)
 *   2. council tool (works in all modes, incl. -p)
 *
 * Protocol: Grounded Blind Atomic Delphi
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runCouncil, formatCouncilResult } from "./pipeline.js";

const OUTPUT_DIR = path.join(
  process.env.HOME || "/tmp",
  ".pi/council-results",
);

export default function (pi: ExtensionAPI) {
  // ── Slash command ──────────────────────────────────────────────

  pi.registerCommand("council", {
    description:
      "Run a multi-expert AI council. Usage: /council [@file1 @file2] <question> [--deep] [--no-blind]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!args?.trim()) {
        ctx.ui.notify(
          "Usage: /council [@file1 @file2] <question> [--deep] [--no-blind]",
          "warning",
        );
        return;
      }
      await executeCouncil(args, ctx);
    },
  });

  // ── Tool (works in all modes) ──────────────────────────────────

  pi.registerTool({
    name: "council",
    label: "Council",
    description:
      "Run a multi-expert AI council to evaluate a decision. Experts generate argument cards, rank them blindly, and a synthesizer produces a recommendation with dissents and blind spots preserved.",
    parameters: Type.Object({
      question: Type.String({
        description:
          "The question or decision to evaluate. Prefix filenames with @ to include them as evidence (e.g. '@src/auth.ts Should we refactor?'). Add --deep for moderator pre-analysis. Add --no-blind to skip card anonymization.",
      }),
    }),
    execute: async (_id, params, _signal, _onUpdate, _ctx) => {
      const question = params.question as string;
      const output = await executeCouncilRaw(question, (line) => {
        // Stream progress back to parent pi so the native tool spinner shows status
        _onUpdate?.({ content: [{ type: "text", text: line }] });
      }, currentModelPattern(_ctx));
      return {
        content: [{ type: "text", text: output }],
      };
    },
  });

  // ── Implementation ─────────────────────────────────────────────

  const currentModelPattern = (ctx: { model?: { provider: string; id: string } }) =>
    ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

  async function executeCouncilRaw(
    rawArgs: string,
    onStream?: (line: string) => void,
    sessionModel?: string,
  ): Promise<string> {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const t0 = Date.now();
    let lastPhase = "";
    let phaseStart = t0;
    const spinners = ["◐", "◓", "◑", "◒"];
    let spinIdx = 0;

    const result = await runCouncil(rawArgs, (update) => {
      const now = Date.now();
      if (update.phase !== lastPhase) {
        phaseStart = now;
        lastPhase = update.phase;
      }
      const phaseMs = now - phaseStart;
      const totalMs = now - t0;
      const phaseSec = phaseMs < 1000 ? `${phaseMs}ms` : `${(phaseMs / 1000).toFixed(1)}s`;
      const totalSec = totalMs < 1000 ? `${totalMs}ms` : `${(totalMs / 1000).toFixed(1)}s`;
      const detail = update.detail ? ` · ${update.detail.slice(0, 60)}` : "";
      const progress = update.progress
        ? ` [${update.progress.current}/${update.progress.total}]`
        : "";
      const spinner = update.phase === "done" || update.phase === "error" ? "✓" : spinners[spinIdx++ % spinners.length];
      const line = `${spinner} [${totalSec}] council:${update.phase.padEnd(12)} ${update.message}${detail}${progress} (${phaseSec})`;
      process.stderr.write(line + "\n");
      onStream?.(line);
    }, sessionModel);

    const output = formatCouncilResult(result);

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outFile = path.join(OUTPUT_DIR, `council-${ts}.md`);
    fs.writeFileSync(outFile, output);

    return output;
  }

  async function executeCouncil(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const widgetId = "council-result";
    const startedAt = Date.now();
    const phaseOrder = [
      "init",
      "moderator",
      "cards",
      "permute",
      "ranking",
      "aggregate",
      "synthesize",
      "error",
    ] as const;
    type ProgressPhase = (typeof phaseOrder)[number];
    type UpdatePhase = ProgressPhase | "done";
    type PhaseStatus = "active" | "done" | "error";
    type PhaseRow = {
      message: string;
      progress?: { current: number; total: number };
      status: PhaseStatus;
      startedAt: number;
      completedAt?: number;
      durationMs?: number;
    };
    const phaseLabels: Record<ProgressPhase, string> = {
      init: "Init",
      moderator: "Moderator",
      cards: "Cards",
      permute: "Permute",
      ranking: "Ranking",
      aggregate: "Aggregate",
      synthesize: "Synthesize",
      error: "Error",
    };
    const spinnerFrames = ["◐", "◓", "◑", "◒"];
    const phaseRows = new Map<ProgressPhase, PhaseRow>();
    let currentPhase: ProgressPhase | null = null;
    let spinnerIndex = 0;
    let spinnerTimer: ReturnType<typeof setInterval> | undefined;
    let terminalState = false;
    let completionSummary: string | null = null;

    const formatDuration = (ms: number) => {
      const totalSeconds = Math.max(0, Math.floor(ms / 1000));
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    };

    const stopSpinner = () => {
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = undefined;
      }
    };

    const finalizePhase = (phase: ProgressPhase, now: number, status: Exclude<PhaseStatus, "active">) => {
      const row = phaseRows.get(phase);
      if (!row) return;
      if (row.durationMs === undefined) {
        row.durationMs = Math.max(0, now - row.startedAt);
      }
      row.status = status;
      row.completedAt = now;
    };

    const buildWidgetLines = (): string[] => {
      const header = completionSummary ?? `${spinnerFrames[spinnerIndex]} Council assembling experts...`;
      const lines = [header];
      for (const phase of phaseOrder) {
        const row = phaseRows.get(phase);
        if (!row) continue;
        const icon = row.status === "done" ? "✓" : row.status === "error" ? "✗" : phase === currentPhase ? "▶" : "·";
        const progress = row.progress ? ` [${row.progress.current}/${row.progress.total}]` : "";
        const elapsedMs =
          row.durationMs ?? (row.status === "active" ? Math.max(0, Date.now() - row.startedAt) : undefined);
        const duration = elapsedMs !== undefined ? ` (${formatDuration(elapsedMs)})` : "";
        lines.push(`${icon} ${phaseLabels[phase]}${progress} — ${row.message}${duration}`);
      }
      return lines;
    };

    const renderWidget = (force = false) => {
      if (!ctx.hasUI) return;
      if (terminalState && !force) return;
      ctx.ui.setWidget(widgetId, buildWidgetLines(), { placement: "aboveEditor" });
    };

    const updatePhase = (
      phase: UpdatePhase,
      message: string,
      progress?: { current: number; total: number },
    ) => {
      const now = Date.now();

      if (currentPhase && currentPhase !== phase) {
        finalizePhase(currentPhase, now, "done");
        currentPhase = null;
      }

      if (phase === "done") {
        completionSummary = `✓ Council complete · ${formatDuration(now - startedAt)}`;
        terminalState = true;
        stopSpinner();
        renderWidget(true);
        return;
      }

      if (phase === "error") {
        let row = phaseRows.get("error");
        if (!row) {
          row = {
            message,
            progress,
            status: "error",
            startedAt,
            completedAt: now,
            durationMs: now - startedAt,
          };
          phaseRows.set("error", row);
        } else {
          row.message = message;
          row.progress = progress;
          row.status = "error";
          row.completedAt = now;
          row.durationMs = now - startedAt;
        }
        completionSummary = `✗ Council failed · ${formatDuration(now - startedAt)}`;
        terminalState = true;
        stopSpinner();
        renderWidget(true);
        return;
      }

      let row = phaseRows.get(phase);
      if (!row) {
        row = {
          message,
          progress,
          status: "active",
          startedAt: now,
        };
        phaseRows.set(phase, row);
      } else {
        row.message = message;
        row.progress = progress;
        row.status = "active";
      }
      currentPhase = phase;
      renderWidget();
    };

    ctx.ui.setStatus("council", undefined);
    renderWidget();

    if (ctx.hasUI) {
      spinnerTimer = setInterval(() => {
        if (terminalState) return;
        spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
        renderWidget();
      }, 100);
    }

    try {
      const result = await runCouncil(args, (update) => {
        updatePhase(update.phase as UpdatePhase, update.message, update.progress);
      }, currentModelPattern(ctx));

      stopSpinner();

      const output = formatCouncilResult(result);

      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const ts = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      const outFile = path.join(OUTPUT_DIR, `council-${ts}.md`);
      fs.writeFileSync(outFile, output);

      const lines = output.split("\n").filter((l) => l.trim());
      const widgetLines = [
        ...buildWidgetLines(),
        "",
        ...lines,
      ];

      if (ctx.hasUI) {
        ctx.ui.setWidget(widgetId, widgetLines, { placement: "aboveEditor" });
      }

      ctx.ui.setStatus("council", undefined);
      ctx.ui.notify(
        `Council finished in ${formatDuration(result.meta.durationMs)}:\n${result.recommendation.slice(0, 150)}…\nFull: ${outFile}`,
        "success",
      );
    } catch (err) {
      stopSpinner();
      const errorText = String(err);
      const failedLines = [
        ...buildWidgetLines(),
        "",
        `Error: ${errorText}`,
      ];
      if (ctx.hasUI) {
        ctx.ui.setWidget(widgetId, failedLines, { placement: "aboveEditor" });
      }
      ctx.ui.setStatus("council", undefined);
      ctx.ui.notify(
        `Council failed after ${formatDuration(Date.now() - startedAt)}: ${errorText}`,
        "error",
      );
    } finally {
      stopSpinner();
    }
  }
}
