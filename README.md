# pi-extensions

Personal extensions for [pi](https://pi.bot/). Install by symlinking or copying into `~/.pi/agent/extensions/`.

## What's in here

This repo contains two kinds of extensions:

- **Stock-based** — Started from pi's official examples and customized for my workflow.
- **Fully custom** — Built from scratch for specific integrations and workflows.

---

## Fully custom extensions

These are original work, not based on pi's example templates.

| Extension | What it does |
|-----------|-------------|
| `agent-flow-bridge.ts` | Bridges pi sessions to agent-flow, writing session events (messages, tools, status) to a file or relay so external agent-flow processes can consume them. |
| `compact-auto-resume.ts` | Automatically resumes the session after compaction by injecting a continuation prompt, so the LLM keeps going without manual "continue". |
| `council/` | Multi-expert council (`/council`) using a Grounded Blind Atomic Delphi protocol. Experts generate argument cards, rank them blindly, and a synthesizer produces a recommendation with dissents preserved. Outputs to `~/.pi/council-results/`. |
| `exasearch.ts` | Integrates Exa web search as a pi tool (`exasearch`). Supports `search` vs `answer` modes, domain filters, and result ranking. |
| `fast-mode.ts` | Toggles a "fast mode" that changes model or behavior settings. Persists state to `~/.pi/agent/state/codex-fast-mode.json`. Controllable via `/fast-mode on\|off\|toggle\|status`. |
| `figma/` | Fetches structured design context from Figma files/frames/nodes via the Figma API. Summarizes the design tree and optionally attaches rendered preview images for frontend implementation work. |
| `input-spellcheck/` | Real-time spellchecking for user input in the TUI. Uses `node-spellchecker` (or a fallback typo map), marks misspellings, and suggests corrections. Disable with `spellcheck:off`. |
| `martmart-mcp/` | MCP (Model Context Protocol) bridge for the MartMart shopping CLI. Spawns `martmart` as an MCP server and exposes its tools (search, cart, checkout, orders) to pi. |
| `magneto.ts` | Standalone long-running execution supervisor/control plane. Maintains a cross-domain contract as the source of truth, monitors todo/tooluse/subagents/context pressure, scores goal progress/contract fit/quality evidence, recommends skills/extensions, tracks interventions, and supports compact/handoff continuity. |
| `mempalace/` | Full MemPalace integration. Read/write tools: search, list wings/rooms/drawers, add/update/delete drawers, knowledge-graph add/invalidate/query, mine files into the palace, and wake-up context starters. |
| `monit/` | Lightweight file/process monitor (`/monit`). Watches files or runs commands on intervals, logs output to `.pi/monit/`, and can open results in a TUI overlay. Supports `fix` and `backlog` modes. |
| `observability.ts` | Polls platform logs and CDP, deduplicates incidents, and upserts sidebar TODOs. Provides a live observability overlay showing system health and alerts. |
| `platform-clis.ts` | Unified wrapper for platform CLIs: Vercel, Convex, WorkOS, Supabase, Cloudflare Wrangler, Terraform, shadcn, Prisma, GitHub CLI. Accepts args array and cwd, runs the command, streams output. |
| `ppmlx-memory/` | Integrates the ppmlx temporal memory graph into pi. Uses direct CLI calls (fast) with MCP fallback. Auto-records session facts and can inject memory context into prompts. |
| `ralph-loop.ts` | Autonomous loop agent (`/ralph`). Self-directed loop: reads todo state, decides next action, executes tools, verifies results, repeats until done or max loops hit. Integrates with the todo system. |
| `status-bar.ts` | Enhanced status bar showing token usage, model name, and shortened cwd. Updates per-turn with context-window stats. |
| `tps.ts` | Tracks tokens-per-second (TPS) for assistant responses. Measures wall-clock time and estimates throughput. |

### Magneto commands

Magneto is a supervisor/control-plane for very long sessions. It coordinates strategy above todo, keeps the cross-domain contract as the source of truth, monitors execution quality, and tries to keep independent work parallelized up to the default capacity of **8 subagents**.

Daily interface should stay small: usually start with `/magneto start`, check `/magneto status` or `/magneto audit`, and use `/magneto handoff` when the session gets too large. The other commands are operational knobs for unusual cases.

| Command | Value in a long-running session |
|---------|---------------------------------|
| `/magneto start <mission>` | Turns a vague long session into a supervised mission. It creates the strategic contract that everything else is judged against, so 500 todo items do not become disconnected busywork. |
| `/magneto status` | Gives you a control-room view instead of a task list: are we closer to the mission, is quality covered, are subagents underused, are blockers/risk/evidence visible? Use it to decide whether to continue, redirect, or stop. |
| `/magneto audit` | A drift detector. It forces Magneto to compare execution against the contract and surface gaps like missing outcomes, low evidence coverage, repeated tool failures, blocked todos, or unused parallel capacity. |
| `/magneto supervise on\|off` | Lets you switch between passive state tracking and active steering. Use `on` when the model needs guardrails; use `off` when you want Magneto to remember state but not influence prompts. |
| `/magneto mode observe\|supervise\|strict` | Controls how hard Magneto governs. `observe` watches only, `supervise` nudges the worker with contract/policy guidance, `strict` is intended for higher-friction enforcement when mistakes are expensive. |
| `/magneto capacity <N>` | Overrides the default **8** subagent target. Magneto uses this to detect under-parallelized execution and nudge the worker to split independent work instead of grinding serially. |
| `/magneto auto-compact on\|off` | Protects very long sessions from context rot. When enabled, Magneto requests compact before context pressure makes the model forget the contract or repeat stale reasoning. |
| `/magneto threshold <compactTokens> [handoffTokens]` | Tunes context-pressure policy per model/session. Use lower thresholds for fragile work or higher thresholds for large-context models. |
| `/magneto compact` | Creates a focused compaction request that preserves the things normal summaries often lose: mission, contract fit, evidence ledger, open risks/blockers, active subagents, and todo signal. |
| `/magneto handoff` | The clean-session escape hatch. Use when context is polluted or too large: it creates a child session with Magneto/todo/ralph/fast state carried over and a continuation prompt centered on the contract. |
| `/magneto reset` | Clears stale governance when the mission changed enough that old constraints/evidence would mislead execution. |

### Magneto tool

The `magneto` tool is the LLM-facing ledger. Its value is that the worker can continuously report strategic facts back to the supervisor: new outcomes, progress, evidence, risks, blockers, decisions, and subagent job results. That makes Magneto's audits based on durable state rather than whatever happens to fit in the current context window.

---

## Stock-based extensions

These started from pi's built-in examples (`@mariozechner/pi-coding-agent/examples/extensions/`) and were adapted or extended.

| Extension | Notes |
|-----------|-------|
| `auto-commit-on-exit.ts` | Auto-commit changes when exiting pi. |
| `claude-rules.ts` | Claude-specific rules injection. |
| `commands.ts` | Custom command registry. |
| `confirm-destructive.ts` | Confirm before destructive operations. |
| `custom-footer.ts` | Footer status line customization. |
| `dirty-repo-guard.ts` | Warns about uncommitted changes. |
| `dynamic-tools.ts` | Dynamic tool loading at runtime. |
| `handoff.ts` | Clean operational handoff to new sessions (`/handoff`). Customized with carryover state for todos, ralph-loop, fast-mode, and Magneto supervisor state. |
| `interactive-shell.ts` | Interactive shell access. |
| `minimal-mode.ts` | Minimal UI display mode. |
| `notify.ts` | Notification system. |
| `permission-gate.ts` | Permission gating for sensitive operations. |
| `questionnaire.ts` | Structured user questionnaires. |
| `ssh.ts` | SSH connection helpers. |
| `status-line.ts` | Status line indicators. |
| `titlebar-spinner.ts` | Spinner in the title bar. |
| `todo.ts` / `todo-sidebar-store.ts` | Sidebar todo panel + `/todo` tool. Heavily customized with Polish UI, incident links, sidebar modes, and ralph-loop integration. |
| `trigger-compact.ts` | Manual compaction trigger. |
| `plan-mode/` | Planning mode with structured steps. |
| `subagent/` | Subagent delegation. |
| `dynamic-resources/` | Dynamic skill loading. |
