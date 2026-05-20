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
import { Text } from "@earendil-works/pi-tui";
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
      const output = await executeCouncilRaw(question);
      return {
        content: [{ type: "text", text: output }],
      };
    },
  });

  // ── Implementation ─────────────────────────────────────────────

  const status = (msg: string) => {
    // Best-effort status — may not be available in tool mode
  };

  async function executeCouncilRaw(rawArgs: string): Promise<string> {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const result = await runCouncil(rawArgs, (update) => {
      const detail = update.detail ? ` · ${update.detail.slice(0, 80)}` : "";
      const progress = update.progress
        ? ` [${update.progress.current}/${update.progress.total}]`
        : "";
      // In tool mode, we can't update UI. Just log to stderr.
      process.stderr.write(
        `[council:${update.phase}] ${update.message}${detail}${progress}\n`,
      );
    });

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
    ctx.ui.notify("Council assembling experts...", "info");
    ctx.ui.setStatus("council", "Starting...");

    try {
      let lastCards = 0;
      const result = await runCouncil(args, (update) => {
        switch (update.phase) {
          case "moderator":
            ctx.ui.setStatus("council", "Moderator analyzing…");
            break;
          case "cards":
            if (update.progress) {
              lastCards = update.progress.current;
              ctx.ui.setStatus(
                "council",
                `Cards [${update.progress.current}/${update.progress.total}]…`,
              );
            }
            break;
          case "ranking":
            if (update.progress) {
              ctx.ui.setStatus(
                "council",
                `Ranking [${update.progress.current}/${update.progress.total}]…`,
              );
            }
            break;
          case "aggregate":
            ctx.ui.setStatus("council", "Aggregating (Borda)…");
            break;
          case "synthesize":
            ctx.ui.setStatus("council", "Synthesizing…");
            break;
          case "done":
            ctx.ui.setStatus(
              "council",
              `Done · ${result.meta.cardsGenerated}C · ${(result.meta.durationMs / 1000).toFixed(1)}s`,
            );
            break;
          case "error":
            ctx.ui.notify(update.message, "error");
            break;
          default:
            ctx.ui.setStatus("council", update.message);
        }
      });

      const output = formatCouncilResult(result);

      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const ts = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      const outFile = path.join(OUTPUT_DIR, `council-${ts}.md`);
      fs.writeFileSync(outFile, output);

      const lines = output.split("\n").filter((l) => l.trim());
      const widgetLines = lines.slice(0, 15);

      if (ctx.hasUI) {
        ctx.ui.setWidget(
          "council-result",
          widgetLines.map((l) => Text.styled(l)),
        );
      }

      ctx.ui.setStatus(
        "council",
        `Done · ${result.meta.expertsUsed.length}E · ${result.meta.cardsGenerated}C · ${(result.meta.durationMs / 1000).toFixed(1)}s`,
      );
      ctx.ui.notify(
        `Council: ${result.recommendation.slice(0, 150)}…\nFull: ${outFile}`,
        "success",
      );
    } catch (err) {
      ctx.ui.notify(`Council failed: ${String(err)}`, "error");
      ctx.ui.setStatus("council", "Failed");
    }
  }
}
