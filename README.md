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
| `mempalace/` | Full MemPalace integration. Read/write tools: search, list wings/rooms/drawers, add/update/delete drawers, knowledge-graph add/invalidate/query, mine files into the palace, and wake-up context starters. |
| `monit/` | Lightweight file/process monitor (`/monit`). Watches files or runs commands on intervals, logs output to `.pi/monit/`, and can open results in a TUI overlay. Supports `fix` and `backlog` modes. |
| `observability.ts` | Polls platform logs and CDP, deduplicates incidents, and upserts sidebar TODOs. Provides a live observability overlay showing system health and alerts. |
| `platform-clis.ts` | Unified wrapper for platform CLIs: Vercel, Convex, WorkOS, Supabase, Cloudflare Wrangler, Terraform, shadcn, Prisma, GitHub CLI. Accepts args array and cwd, runs the command, streams output. |
| `ppmlx-memory/` | Integrates the ppmlx temporal memory graph into pi. Uses direct CLI calls (fast) with MCP fallback. Auto-records session facts and can inject memory context into prompts. |
| `ralph-loop.ts` | Autonomous loop agent (`/ralph`). Self-directed loop: reads todo state, decides next action, executes tools, verifies results, repeats until done or max loops hit. Integrates with the todo system. |
| `status-bar.ts` | Enhanced status bar showing token usage, model name, and shortened cwd. Updates per-turn with context-window stats. |
| `tps.ts` | Tracks tokens-per-second (TPS) for assistant responses. Measures wall-clock time and estimates throughput. |

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
| `handoff.ts` | Clean operational handoff to new sessions (`/handoff`). Customized with carryover state for todos, ralph-loop, and fast-mode. |
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
