import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	Text,
	type Component,
	type OverlayHandle,
	type TUI,
	type Theme,
	visibleWidth,
	wrapTextWithAnsi,
	matchesKey,
	parseKey,
} from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import {
	TODO_STATUSES,
	addTodo,
	clearTodos,
	copyTodos,
	createTodoStoreSnapshot,
	getTodoStoreState,
	parseTodoStatus,
	replaceTodos,
	restoreTodoStoreState,
	setTodoStatus,
	setTodoStoreUiState,
	subscribeTodoStore,
	type SidebarMode,
	type Todo,
	type TodoToolStateSnapshot,
} from "./todo-sidebar-store";

const SIDEBAR_MARGIN_TOP = 0;
const SIDEBAR_MARGIN_BOTTOM = 5;
const SIDEBAR_WIDTH_NORMAL = "30%";
const SIDEBAR_WIDTH_WIDE = "52%";
const SIDEBAR_MIN_WIDTH_NORMAL = 36;
const SIDEBAR_MIN_WIDTH_WIDE = 54;

/**
 * Right sidebar extension (Todos + live status)
 *
 * - Keeps a todo list in extension memory + session branch persistence.
 * - Shows a right side overlay panel (non-capturing) in interactive mode.
 * - Updates panel content/status via hook events.
 */

const TOOL_NAME = "todo";
const TODO_TOOL_NAMES = new Set([TOOL_NAME, "todo_sidebar", "todo-sidebar"]);
const TODO_STATE_ENTRY_TYPE = "todo-state";
const LEGACY_TODO_STATE_ENTRY_TYPE = "todo-sidebar-state";

type ActiveTodoId = number | null;
type TodoStatus = (typeof TODO_STATUSES)[number];

const TODO_STATUS_ICONS: Record<TodoStatus, string> = {
	todo: "◻",
	inprogress: "⚒",
	done: "✓",
	blocked: "⛔",
	skipping: "⏭",
};

interface TodoToolDetails {
	action: "list" | "add" | "toggle" | "clear" | "set_status";
	todos: Todo[];
	nextId: number;
	error?: string;
}

interface LegacyTodo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoToolDetailsLegacy {
	action: "list" | "add" | "toggle" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

interface SidePayload {
	todos: Todo[];
	nextId: number;
	statusLabel: string;
	activeTodoId: ActiveTodoId;
	hideDoneAndSkipping: boolean;
	sidebarMode: SidebarMode;
	countsText: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear", "set_status"] as const),
	text: Type.Optional(Type.String()),
	id: Type.Optional(Type.Number()),
	status: Type.Optional(StringEnum(TODO_STATUSES)),
});

function normalizeTodo(input: unknown): Todo | undefined {
	if (!input || typeof input !== "object") return undefined;
	const raw = input as { id?: unknown; text?: unknown; status?: unknown; done?: unknown };

	const id = typeof raw.id === "number" && Number.isSafeInteger(raw.id) ? raw.id : NaN;
	if (!Number.isSafeInteger(id) || id <= 0) return undefined;
	if (typeof raw.text !== "string") return undefined;

	const status = parseTodoStatus(raw.status) ?? (typeof raw.done === "boolean" ? (raw.done ? "done" : "todo") : "todo");
	return { id, text: raw.text, status };
}

function normalizeLegacyTodo(input: unknown): Todo | undefined {
	if (!input || typeof input !== "object") return undefined;
	const raw = input as { id?: unknown; text?: unknown; done?: unknown };

	const id = typeof raw.id === "number" && Number.isSafeInteger(raw.id) ? raw.id : NaN;
	if (!Number.isSafeInteger(id) || id <= 0) return undefined;
	if (typeof raw.text !== "string") return undefined;
	if (typeof raw.done !== "boolean") return undefined;

	return {
		id,
		text: raw.text,
		status: raw.done ? "done" : "todo",
	};
}

function colorTodoTextPrefix(th: Theme, text: string, textStyle: "text" | "dim" | "error" | "muted" | "warning"): string {
	const prefix = "text:";
	if (text.startsWith(prefix)) {
		return `${th.fg("dim", prefix)}${th.fg(textStyle, text.slice(prefix.length))}`;
	}

	const customPrefix = text.match(/^([A-Za-z0-9][A-Za-z0-9._ /\-]{0,40}:)(?=\s|$)/)?.[1];
	if (customPrefix) {
		return `${th.fg("dim", customPrefix)}${th.fg(textStyle, text.slice(customPrefix.length))}`;
	}

	const numberedPrefix = text.match(/^(\d+(?:\.\d+)+)\s/)?.[1];
	if (numberedPrefix) {
		const fullPrefix = `${numberedPrefix} `;
		return `${th.fg("dim", fullPrefix)}${th.fg(textStyle, text.slice(fullPrefix.length))}`;
	}

	return th.fg(textStyle, text);
}

function compactStatusTextForHeader(text: string, maxLength: number): string {
	let status = text.trim();
	if (!status) {
		return status;
	}

	status = status
		.replace(/^Wykonuję:\s*/u, "◉ ")
		.replace(/^Narzędzie\s+/u, "narz. ")
		.replace(/^Narzędzie\//u, "narz./")
		.replace(/^Agent zakończył$/u, "gotowe")
		.replace(/^Błąd narzędzia\s*\/todo$/u, "błąd /todo")
		.replace(/^Błąd narzędzia$/u, "błąd")
		.replace(/^Narzędzie zakończone\s*\/todo$/u, "zakończono /todo");

	status = status.replace(/\s*•\s*pracuję nad\s+.*$/u, "");

	if (status.length <= maxLength) {
		return status;
	}
	if (maxLength <= 1) {
		return status.slice(0, Math.max(0, maxLength));
	}
	return `${status.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

class RightSidebarPanel implements Component {
	private cachedWidth?: number;
	private cachedViewportHeight?: number;
	private cachedLines: string[] = [];
	private scrollOffset = 0;
	private visibleTodoLines = 0;
	private totalTodoLines = 0;

	constructor(
		private readonly tui: TUI,
		private readonly getPayload: () => SidePayload,
		private readonly theme: Theme,
		private readonly onHide: () => void,
		private readonly getTerminalHeight: () => number,
	) {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedViewportHeight = undefined;
	}

	private getPanelLineBudget(): number {
		const terminalHeight = Math.max(1, this.getTerminalHeight());
		const budget = terminalHeight - SIDEBAR_MARGIN_TOP - SIDEBAR_MARGIN_BOTTOM;
		return Math.max(1, budget);
	}

	private setScrollOffset(nextOffset: number): boolean {
		if (this.totalTodoLines <= 0) {
			return false;
		}
		const window = Math.max(1, this.visibleTodoLines);
		const maxOffset = Math.max(0, this.totalTodoLines - window);
		const clamped = Math.max(0, Math.min(maxOffset, nextOffset));
		if (clamped === this.scrollOffset) {
			return false;
		}

		this.scrollOffset = clamped;
		this.invalidate();
		// Force re-render when scrolling so overlay position and cursor are recalculated immediately.
		this.tui.requestRender(true);
		return true;
	}

	scrollTodosLine(lineStep: number): boolean {
		return this.setScrollOffset(this.scrollOffset + lineStep);
	}

	private widthLine(width: number, text: string): string {
		return truncateToWidth(text, Math.max(0, width), "...", true);
	}

	private wrapTodoLine(width: number, prefix: string, text: string): string[] {
		const basePrefixWidth = visibleWidth(prefix);
		const availableWidth = Math.max(1, width - basePrefixWidth);
		const bodyLines = wrapTextWithAnsi(text, availableWidth);
		if (bodyLines.length === 0) {
			return [this.widthLine(width, prefix)];
		}

		const continuationPrefix = " ".repeat(basePrefixWidth);
		const result: string[] = [];
		for (let i = 0; i < bodyLines.length; i++) {
			result.push(this.widthLine(width, i === 0 ? `${prefix}${bodyLines[i]}` : `${continuationPrefix}${bodyLines[i]}`));
		}
		return result;
	}

	render(width: number): string[] {
		const payload = this.getPayload();
		const terminalHeight = this.getTerminalHeight();
		if (this.cachedWidth === width && this.cachedViewportHeight === terminalHeight && this.cachedLines.length > 0) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;
		const effectiveWidth = Math.max(1, width);

		const doneOrSkippingCount = payload.todos.filter((t) => t.status === "done" || t.status === "skipping").length;
		const totalCount = payload.todos.length;
		const isCollapsed = payload.sidebarMode === "collapsed";
		const todoCounterText = `${doneOrSkippingCount}/${totalCount}`;
		const headerText = isCollapsed ? todoCounterText : `DONE(${todoCounterText})`;
		const isWide = payload.sidebarMode === "wide";
		const countsText = isWide ? payload.countsText : "";
		const todoHeaderLeft = th.fg("accent", headerText);
		const todoHeaderRight = countsText ? th.fg("muted", countsText) : "";
		const canShowCountsInHeader = isWide && countsText && visibleWidth(todoHeaderLeft) + visibleWidth(todoHeaderRight) + 1 <= effectiveWidth;
		const todoHeaderPadding = canShowCountsInHeader
			? Math.max(0, effectiveWidth - visibleWidth(todoHeaderLeft) - visibleWidth(todoHeaderRight) - 1)
			: 0;
		const todoHeader = canShowCountsInHeader ? `${todoHeaderLeft}${" ".repeat(todoHeaderPadding)} ${todoHeaderRight}` : todoHeaderLeft;

		const statusText = payload.statusLabel || "Gotowe";
		const statusPrefix = th.fg("toolTitle", "STATUS: ");
		const statusTextWidth = Math.max(1, effectiveWidth - visibleWidth("STATUS: "));
		const compactStatusText = compactStatusTextForHeader(statusText, statusTextWidth);

		lines.push(this.widthLine(effectiveWidth, th.fg("border", "─".repeat(effectiveWidth))));
		lines.push(this.widthLine(effectiveWidth, todoHeader));
		if (!isCollapsed) {
			lines.push(this.widthLine(effectiveWidth, `${statusPrefix}${th.fg("warning", compactStatusText)}`));
			lines.push(this.widthLine(effectiveWidth, th.fg("border", "─".repeat(effectiveWidth))));
			lines.push(this.widthLine(effectiveWidth, ""));
		} else {
			lines.push(this.widthLine(effectiveWidth, th.fg("border", "─".repeat(effectiveWidth))));
		}

		const filteredTodos = payload.hideDoneAndSkipping
			? payload.todos.filter((todo) => todo.status !== "done" && todo.status !== "skipping")
			: payload.todos;

		const todoLines: string[] = [];
		if (filteredTodos.length === 0) {
			todoLines.push(this.widthLine(effectiveWidth, th.fg("dim", payload.hideDoneAndSkipping ? "  Brak widocznych zadań" : "  Brak zadań")));
		} else {
			for (const todo of filteredTodos) {
				const isActive = payload.activeTodoId === todo.id;
				const icon = TODO_STATUS_ICONS[todo.status];
				const iconColor = todo.status === "done" ? "success" : todo.status === "blocked" ? "error" : todo.status === "inprogress" ? "warning" : "muted";
				const prefix = `${th.fg(iconColor, icon)} ${th.fg("accent", `#${todo.id}`)} `;

				if (isCollapsed) {
					todoLines.push(this.widthLine(effectiveWidth, prefix));
					continue;
				}

				let todoTextStyle = "text" as "text" | "dim" | "error" | "muted" | "warning";
				if (todo.status === "done") {
					todoTextStyle = "dim";
				} else if (todo.status === "blocked") {
					todoTextStyle = "error";
				} else if (todo.status === "skipping") {
					todoTextStyle = "muted";
				} else if (todo.status === "inprogress") {
					todoTextStyle = "warning";
				}

				const todoTextStyleWithActive = isActive ? "warning" : todoTextStyle;
				const todoText = colorTodoTextPrefix(th, todo.text, todoTextStyleWithActive);
				const fullLine = `${prefix}${todoText}`;

				todoLines.push(this.widthLine(effectiveWidth, fullLine));
			}
		}

		this.totalTodoLines = todoLines.length;
		const panelBudget = this.getPanelLineBudget();
		const fixedLines = lines.length;
		const availableForContent = Math.max(0, panelBudget - fixedLines);

		this.visibleTodoLines = Math.max(0, Math.min(this.totalTodoLines, availableForContent));

		const maxOffset = Math.max(0, this.totalTodoLines - Math.max(1, this.visibleTodoLines));
		const clampedOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset));
		if (clampedOffset !== this.scrollOffset) {
			this.scrollOffset = clampedOffset;
		}

		if (this.visibleTodoLines > 0) {
			const start = this.scrollOffset;
			const end = Math.min(start + this.visibleTodoLines, todoLines.length);
			lines.push(...todoLines.slice(start, end));
		}

		if (this.totalTodoLines > availableForContent && this.visibleTodoLines > 0) {
			lines.push(this.widthLine(effectiveWidth, th.fg("dim", `Ctrl+[ / Ctrl+] / Ctrl+\\ / Ctrl+'`)));
		}

		this.cachedWidth = width;
		this.cachedViewportHeight = terminalHeight;
		this.cachedLines = lines;
		return lines;
	}

	refresh(forceRender = false): void {
		this.invalidate();
		this.tui.requestRender(forceRender);
	}

	dispose(): void {
		this.onHide();
	}
}

function parseTodoDetails(input: unknown): TodoToolDetails | undefined {
	if (!input || typeof input !== "object") return undefined;
	const details = input as Partial<TodoToolDetails> & { todos?: unknown; action?: unknown; nextId?: unknown; error?: unknown };
	if (!Array.isArray(details.todos) || typeof details.nextId !== "number") return undefined;
	const action = details.action as TodoToolDetails["action"] | undefined;
	if (!action || !["list", "add", "toggle", "clear", "set_status"].includes(action)) return undefined;
	const todos = details.todos.map((item) => normalizeTodo(item)).filter((item): item is Todo => item !== undefined);
	return {
		action,
		nextId: details.nextId,
		todos,
		error: typeof details.error === "string" ? details.error : undefined,
	};
}

function parseTodoDetailsLegacy(input: unknown): TodoToolDetailsLegacy | undefined {
	if (!input || typeof input !== "object") return undefined;
	const details = input as Partial<TodoToolDetailsLegacy> & { todos?: unknown; action?: unknown; nextId?: unknown; error?: unknown };
	if (!Array.isArray(details.todos) || typeof details.nextId !== "number") return undefined;
	const action = details.action as TodoToolDetailsLegacy["action"] | undefined;
	if (!action || !["list", "add", "toggle", "clear"].includes(action)) return undefined;
	const todos = details.todos.map((item) => normalizeLegacyTodo(item)).filter((item): item is Todo => item !== undefined);
	return {
		action,
		nextId: details.nextId,
		todos,
		error: typeof details.error === "string" ? details.error : undefined,
	};
}

export default function todoRightSidebarExtension(pi: ExtensionAPI): void {
	let { todos, nextId, activeTodoId, hideDoneAndSkipping, sidebarMode } = getTodoStoreState();
	let statusLabel = "Gotowe";

	let panel: RightSidebarPanel | null = null;
	let panelHandle: OverlayHandle | null = null;
	let terminalInputUnsubscribe: (() => void) | null = null;
	let todoStoreUnsubscribe: (() => void) | null = null;
	let livePanelRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	const LIVE_PANEL_REFRESH_MS = 100;
	let hasTodoSource = false;

	function getActiveTodo(): Todo | undefined {
		return todos.find((todo) => todo.id === activeTodoId);
	}

	const getPayload = (): SidePayload => ({
		todos: copyTodos(todos),
		nextId,
		statusLabel,
		activeTodoId,
		hideDoneAndSkipping,
		sidebarMode,
		countsText: getTodoCountsText(),
	});

	syncLocalStoreState();
	todoStoreUnsubscribe = subscribeTodoStore((_state, meta) => {
		syncLocalStoreState();
		if (meta.persist) {
			persistState();
		}
		refreshPanel();
	});

	function getCollapsedProgressText(): string {
		const doneOrSkippingCount = todos.filter((todo) => todo.status === "done" || todo.status === "skipping").length;
		const totalCount = todos.length;
		return `${doneOrSkippingCount}/${totalCount}`;
	}

	function getCollapsedPanelWidth(): number {
		const maxLineLength = visibleWidth(getCollapsedProgressText());
		const filteredTodos = hideDoneAndSkipping
			? todos.filter((todo) => todo.status !== "done" && todo.status !== "skipping")
			: todos;

		if (filteredTodos.length === 0) {
			const message = hideDoneAndSkipping ? "  Brak widocznych zadań" : "  Brak zadań";
			return Math.max(1, visibleWidth(message) + 1, maxLineLength + 1);
		}

		let longestTodoLine = 0;
		for (const todo of filteredTodos) {
			const icon = TODO_STATUS_ICONS[todo.status];
			const line = `${icon} #${todo.id} `;
			longestTodoLine = Math.max(longestTodoLine, visibleWidth(line));
		}

		return Math.max(1, longestTodoLine, maxLineLength) + 1;
	}

	function todoSummaryText(): string {
		const totalCount = todos.length;
		const doneOrSkippingCount = todos.filter((todo) => todo.status === "done" || todo.status === "skipping").length;
		const completionPercent = totalCount > 0 ? Math.round((doneOrSkippingCount / totalCount) * 100) : 0;
		return `DONE:${completionPercent}%`;
	}

	function getTodoCountsText(): string {
		const counts = {
			todo: todos.filter((todo) => todo.status === "todo").length,
			inprogress: todos.filter((todo) => todo.status === "inprogress").length,
			done: todos.filter((todo) => todo.status === "done").length,
			blocked: todos.filter((todo) => todo.status === "blocked").length,
			skipping: todos.filter((todo) => todo.status === "skipping").length,
		};
		return `[t:${counts.todo} p:${counts.inprogress} d:${counts.done} b:${counts.blocked} s:${counts.skipping}]`;
	}

	function setFooterStatus(ctx: ExtensionContext, extra?: string): void {
		if (!ctx.hasUI) return;
		if (!panelHandle || panelHandle.isHidden()) {
			ctx.ui.setStatus("todo", "");
			return;
		}
		ctx.ui.setStatus("todo", `${todoSummaryText()}${extra ? ` • ${extra}` : ""}`);
	}

	function setStatus(value: string) {
		const active = getActiveTodo();
		if (!active) {
			statusLabel = value;
			refreshPanel();
			return;
		}

		const normalized = value.trim().toLowerCase();
		if (normalized === "w toku" || normalized.startsWith("pracuje nad") || normalized.startsWith("pracuję nad") || normalized.startsWith("pracujesz nad")) {
			statusLabel = `Pracuję nad ${active.text}`;
		} else {
			statusLabel = `${value} • pracuję nad ${active.text}`;
		}
		refreshPanel();
	}

	function refreshPanel(forceRender = false): void {
		panel?.refresh(forceRender);
	}

	function refreshPanelSoon(): void {
		if (livePanelRefreshTimer) {
			return;
		}
		livePanelRefreshTimer = setTimeout(() => {
			livePanelRefreshTimer = null;
			refreshPanel();
		}, LIVE_PANEL_REFRESH_MS);
	}

	function getSidebarDimensions() {
		switch (sidebarMode) {
			case "wide":
				return {
					width: SIDEBAR_WIDTH_WIDE,
					minWidth: SIDEBAR_MIN_WIDTH_WIDE,
				};
			case "collapsed": {
				const width = getCollapsedPanelWidth();
				return {
					width,
					minWidth: width,
				};
			}
			default:
				return {
					width: SIDEBAR_WIDTH_NORMAL,
					minWidth: SIDEBAR_MIN_WIDTH_NORMAL,
				};
		}
	}

	function reopenPanelForLayoutChange(ctx?: ExtensionContext): void {
		if (!ctx || !ctx.hasUI || !panelHandle) {
			return;
		}

		if (!panelHandle.isHidden()) {
			panelHandle.hide();
			panel = null;
			panelHandle = null;
			ensureHasUIAndOpen(ctx);
		}
	}

	function cycleSidebarMode(ctx?: ExtensionContext): void {
		const nextMode: SidebarMode = sidebarMode === "normal" ? "wide" : sidebarMode === "wide" ? "collapsed" : "normal";
		setTodoStoreUiState({ sidebarMode: nextMode }, true);
		reopenPanelForLayoutChange(ctx);
		refreshPanel(true);
		if (ctx?.hasUI) {
			setFooterStatus(ctx);
		}
	}

	function getTerminalHeight(): number {
		const rows = typeof process.stdout?.rows === "number" ? process.stdout.rows : undefined;
		return rows && rows > 0 ? rows : 24;
	}

	function isCtrlShortcut(data: string, key: "[" | "]" | "\\" | "'"): boolean {
		const parsed = parseKey(data)?.toLowerCase();
		if (parsed === `ctrl+${key}`) {
			return true;
		}
		return matchesKey(data, `ctrl+${key}`);
	}

	function handlePanelShortcut(data: string, ctx?: ExtensionContext): boolean {
		if (!panelHandle || panelHandle.isHidden() || !panel) {
			return false;
		}

		if (isCtrlShortcut(data, "[")) {
			return panel.scrollTodosLine(-1);
		}

		if (isCtrlShortcut(data, "]")) {
			return panel.scrollTodosLine(1);
		}

		if (isCtrlShortcut(data, "\\")) {
			setTodoStoreUiState({ hideDoneAndSkipping: !hideDoneAndSkipping }, true);
			refreshPanel();
			return true;
		}

		if (isCtrlShortcut(data, "'")) {
			cycleSidebarMode(ctx);
			return true;
		}

		return false;
	}

	function syncLocalStoreState(): void {
		const snapshot = getTodoStoreState();
		todos = snapshot.todos;
		nextId = snapshot.nextId;
		activeTodoId = snapshot.activeTodoId;
		hideDoneAndSkipping = snapshot.hideDoneAndSkipping;
		sidebarMode = snapshot.sidebarMode;
	}

	function applyLegacyTodoState(legacyTodos: Todo[], legacyNextId: number, persist: boolean): boolean {
		if (hasTodoSource) {
			return false;
		}
		replaceTodos(copyTodos(legacyTodos), legacyNextId, persist);
		refreshPanel();
		return true;
	}

	function setTodoStatusById(id: number, status: TodoStatus): boolean {
		const updated = setTodoStatus(id, status, true);
		if (!updated) return false;
		refreshPanel();
		return true;
	}

	function persistState(): void {
		pi.appendEntry(TODO_STATE_ENTRY_TYPE, createTodoStoreSnapshot());
	}

	function applyTodoStateFromToolResult(toolName: string, details: unknown, saveLegacyAction: boolean): boolean {
		if (toolName === TOOL_NAME) {
			const parsed = parseTodoDetails(details);
			if (!parsed) {
				return false;
			}
			restoreTodoStoreState({
				v: 3,
				todos: parsed.todos,
				nextId: Number.isSafeInteger(parsed.nextId) ? parsed.nextId : nextId,
				activeTodoId,
				hideDoneAndSkipping,
				sidebarMode,
				incidentLinks: getTodoStoreState().incidentLinks,
			}, true);
			hasTodoSource = true;
			refreshPanel();
			return true;
		}

		if (toolName === "todo_sidebar" || toolName === "todo-sidebar") {
			const legacy = parseTodoDetailsLegacy(details);
			if (!legacy || legacy.action === "list") {
				return false;
			}
			return applyLegacyTodoState(legacy.todos, legacy.nextId, saveLegacyAction);
		}

		return false;
	}

	function restoreFromBranch(ctx: ExtensionContext): void {
		hasTodoSource = false;
		hideDoneAndSkipping = false;
		sidebarMode = "collapsed";
		const branchEntries = ctx.sessionManager.getBranch();
		let restored = false;
		let legacyFallbackTodos: Todo[] | null = null;
		let legacyFallbackNextId: number | null = null;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && (entry.customType === TODO_STATE_ENTRY_TYPE || entry.customType === LEGACY_TODO_STATE_ENTRY_TYPE)) {
				const data = entry.data as TodoToolStateSnapshot | undefined;
				if (!data || typeof data.nextId !== "number" || !Array.isArray(data.todos)) {
					continue;
				}
				if (data.v === 1 || data.v === 2 || data.v === 3) {
					restoreTodoStoreState(data, false);
					hasTodoSource = true;
					restored = true;
				}
				continue;
			}

			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult") continue;

			if (message.toolName === TOOL_NAME) {
				const details = parseTodoDetails(message.details);
				if (!details) continue;

				restoreTodoStoreState({
					v: 3,
					todos: details.todos,
					nextId: Number.isSafeInteger(details.nextId) ? details.nextId : nextId,
					activeTodoId: getTodoStoreState().activeTodoId,
					hideDoneAndSkipping: getTodoStoreState().hideDoneAndSkipping,
					sidebarMode: getTodoStoreState().sidebarMode,
					incidentLinks: getTodoStoreState().incidentLinks,
				}, false);
				hasTodoSource = true;
				restored = true;
				continue;
			}

			if (message.toolName === "todo_sidebar" || message.toolName === "todo-sidebar") {
				const legacy = parseTodoDetailsLegacy(message.details);
				if (!legacy || legacy.action === "list") {
					continue;
				}

				legacyFallbackTodos = copyTodos(legacy.todos);
				legacyFallbackNextId = legacy.nextId;
			}
		}

		if (!hasTodoSource && legacyFallbackTodos && legacyFallbackNextId !== null) {
			applyLegacyTodoState(legacyFallbackTodos, legacyFallbackNextId, true);
			restored = true;
		}

		if (!restored) {
			restoreTodoStoreState({
				v: 3,
				todos: [],
				nextId: 1,
				activeTodoId: null,
				hideDoneAndSkipping: false,
				sidebarMode: "collapsed",
				incidentLinks: {},
			}, false);
		}

		syncLocalStoreState();
		refreshPanel();
		setStatus("Gotowe");
		if (ctx.hasUI) {
			setFooterStatus(ctx);
		}
	}

	function ensureHasUIAndOpen(ctx: ExtensionContext): boolean {
		if (!ctx.hasUI) {
			ctx.ui.notify("todo działa tylko w trybie interaktywnym", "warning");
			return false;
		}

		if (panelHandle === null) {
			void ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					panel = new RightSidebarPanel(
						tui,
						() => getPayload(),
						theme,
						() => {
							panel = null;
							done();
						},
						() => getTerminalHeight(),
					);
					return panel;
				},
				{
					overlay: true,
					overlayOptions: () => {
						const dimensions = getSidebarDimensions();
						return {
							anchor: "bottom-right",
							width: dimensions.width,
							minWidth: dimensions.minWidth,
							// Align from bottom: keep footer/input visible.
							maxHeight: "100%",
							margin: { right: 1, top: SIDEBAR_MARGIN_TOP, bottom: SIDEBAR_MARGIN_BOTTOM },
							nonCapturing: true,
							visible: (termWidth, termHeight) => termWidth >= 80 && termHeight >= 22,
						};
					},
					onHandle: (handle) => {
						panelHandle = handle;
					},
				},
			);
		}

		if (panelHandle) {
			panelHandle.setHidden(false);
		}

		return true;
	}

	// Register todo tool
	pi.registerTool({
		name: TOOL_NAME,
		label: "Todo",
		description: "Manage a todo list with add/list/toggle/clear/status actions.",
		promptSnippet: "Use this tool to keep a task list while the agent works.",
		promptGuidelines: [
			"Use the todo tool whenever the user asks to track tasks, subtasks or action items.",
			"Prefer explicit action: add/text, set_status/id/status, toggle/id (done<->todo), clear, list.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, args, _signal, _onUpdate, _ctx) {
			switch (args.action) {
				case "list":
					return {
						content: [
							{
								type: "text",
								text:
									todos.length > 0
										? todos
											.map((todo) => ` [${todo.status}] #${todo.id}: ${todo.text}`)
											.join("\n")
										: "Brak todo",
							},
						],
						details: { action: "list", todos: copyTodos(todos), nextId } as TodoToolDetails,
				};

				case "add": {
					if (!args.text || !args.text.trim()) {
						return {
							content: [{ type: "text", text: "❌ add: wymagany parametr text" }],
							details: { action: "add", todos: copyTodos(todos), nextId, error: "text is required" } as TodoToolDetails,
						};
					}

					const createdId = nextId;
					addTodo(args.text.trim(), parseTodoStatus(args.status) ?? "todo", true);
					setStatus(`Dodano #${createdId}`);

					return {
						content: [{ type: "text", text: `Dodano #${createdId}` }],
						details: { action: "add", todos: copyTodos(todos), nextId } as TodoToolDetails,
					};
				}

				case "toggle": {
					if (typeof args.id !== "number") {
						return {
							content: [{ type: "text", text: "❌ toggle: wymagany parametr id" }],
							details: { action: "toggle", todos: copyTodos(todos), nextId, error: "id is required" } as TodoToolDetails,
						};
					}

					const id = Math.trunc(args.id);
					const todo = todos.find((item) => item.id === id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `❌ Nie ma TODO #${id}` }],
							details: {
								action: "toggle",
								todos: copyTodos(todos),
								nextId,
								error: `todo #${id} not found`,
							} as TodoToolDetails,
						};
					}

					const nextStatus = todo.status === "done" ? "todo" : "done";
					if (!setTodoStatusById(id, nextStatus)) {
						return {
							content: [{ type: "text", text: `❌ Nie można zmienić statusu dla #${id}` }],
							details: {
								action: "toggle",
								todos: copyTodos(todos),
								nextId,
								error: `cannot change status for todo #${id}`,
							} as TodoToolDetails,
						};
					}
					const updated = todos.find((item) => item.id === id);
					setStatus(`TODO #${id} ustawione na ${updated ? updated.status : nextStatus}`);
					return {
						content: [{ type: "text", text: `${updated?.status === "done" ? "✅" : "↩️"} TODO #${id}` }],
						details: { action: "toggle", todos: copyTodos(todos), nextId } as TodoToolDetails,
					};
				}

				case "set_status": {
					if (typeof args.id !== "number") {
						return {
							content: [{ type: "text", text: "❌ set_status: wymagany parametr id" }],
							details: { action: "set_status", todos: copyTodos(todos), nextId, error: "id is required" } as TodoToolDetails,
						};
					}
					const status = parseTodoStatus(args.status);
					if (!status) {
						return {
							content: [
								{
									type: "text",
									text: "❌ set_status: wymagany poprawny status: todo | inprogress | done | blocked | skipping",
								},
							],
							details: { action: "set_status", todos: copyTodos(todos), nextId, error: "invalid status" } as TodoToolDetails,
						};
					}

					const id = Math.trunc(args.id);
					if (!setTodoStatusById(id, status)) {
						return {
							content: [{ type: "text", text: `❌ Nie ma TODO #${id}` }],
							details: {
								action: "set_status",
								todos: copyTodos(todos),
								nextId,
								error: `todo #${id} not found`,
							} as TodoToolDetails,
						};
					}

					setStatus(`TODO #${id} ustawione jako ${status}`);
					return {
						content: [{ type: "text", text: `✅ TODO #${id} → ${status}` }],
						details: { action: "set_status", todos: copyTodos(todos), nextId } as TodoToolDetails,
					};
				}

				case "clear": {
					clearTodos(true);
					setStatus("Wyczyszczono listę");
					return {
						content: [{ type: "text", text: `🗑️ Usunięto wszystkie pozycje` }],
						details: { action: "clear", todos: [], nextId } as TodoToolDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `❓ Nieznana akcja: ${args.action}` }],
						details: { action: "list", todos: copyTodos(todos), nextId, error: `unknown action: ${args.action}` } as TodoToolDetails,
					};
		}
		},

		renderCall(args, theme) {
			let summary = `todo.${args.action}`;
			if (args.action === "add" && args.text) {
				summary += ` (+ ${args.text.slice(0, 24)})`;
			}
			if (args.action === "toggle" && typeof args.id === "number") {
				summary += ` #${args.id}`;
			}
			if ((args.action === "set_status" || args.action === "status") && typeof args.id === "number" && args.status) {
				summary += ` #${args.id}=>${args.status}`;
			}
			return new Text(`${theme.fg("accent", "Todo")}: ${theme.fg("muted", summary)}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = parseTodoDetails(result.details) as TodoToolDetails | undefined;
			const todosToRender = details ? details.todos : [];
			if (!todosToRender || todosToRender.length === 0) {
				return new Text(theme.fg("dim", "Brak zadań"), 0, 0);
			}
			const status = details?.error
				? theme.fg("error", `Błąd: ${details.error}`)
				: theme.fg("success", `Zapisano ${todosToRender.length} pozycji`);
			return new Text(status, 0, 0);
		},
	});

	pi.registerCommand("todo", {
		description: "Toggle the todo panel",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}
			if (!panelHandle) {
				if (!ensureHasUIAndOpen(ctx)) return;
				ctx.ui.notify("Panel pokazany", "info");
			} else if (panelHandle.isHidden()) {
				panelHandle.setHidden(false);
				ctx.ui.notify("Panel pokazany", "info");
			} else {
				panelHandle.setHidden(true);
				ctx.ui.notify("Panel ukryty", "info");
				setFooterStatus(ctx);
			}
			if (panelHandle?.isHidden() === false) {
				setFooterStatus(ctx);
				if (todos.length === 0) {
					ctx.ui.notify("Brak zadań.", "info");
				}
			}
		},
	});

	pi.registerCommand("todo-app", {
		description: "Show, hide, or clear the todo panel",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}

			const [command] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			if (!command) {
				ctx.ui.notify("Brak argumentu", "info");
				return;
			}

			if (command === "hide") {
				if (panelHandle) {
					panelHandle.setHidden(true);
					ctx.ui.notify("Panel ukryty (użyj /todo-app show)", "info");
					setFooterStatus(ctx);
				}
				return;
			}

			if (command === "show") {
				if (!ensureHasUIAndOpen(ctx)) return;
				ctx.ui.notify("Panel pokazany", "info");
				setFooterStatus(ctx);
				if (todos.length === 0) {
					ctx.ui.notify("Brak zadań.", "info");
				}
				return;
			}

			if (command === "clear") {
				clearTodos(true);
				setStatus("Wyczyszczono TODO");
				if (!ensureHasUIAndOpen(ctx)) return;
				setFooterStatus(ctx, "wyczyszczono");
				ctx.ui.notify("Wyczyszczono TODO", "info");
				return;
			}

			ctx.ui.notify("Użycie: /todo-app [show|hide|clear] (Ctrl+' zmienia tryb: normalny / szeroki / zwinięty)", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
		setStatus("Gotowe");
		if (ctx.hasUI) {
			if (!terminalInputUnsubscribe) {
				terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
					if (handlePanelShortcut(data, ctx)) {
						return { consume: true };
					}
					return undefined;
				});
			}
			ensureHasUIAndOpen(ctx);
			setFooterStatus(ctx);
		}
	});
	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
		if (ctx.hasUI) {
			if (!terminalInputUnsubscribe) {
				terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
					if (handlePanelShortcut(data, ctx)) {
						return { consume: true };
					}
					return undefined;
				});
			}
			ensureHasUIAndOpen(ctx);
			setFooterStatus(ctx);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		setStatus("Agent zakończył");
		if (ctx.hasUI) {
			setFooterStatus(ctx);
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		setStatus("W toku");
		if (ctx.hasUI) {
			setFooterStatus(ctx);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		setStatus("Gotowe");
		if (ctx.hasUI) {
			setFooterStatus(ctx);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		const displayToolName = TODO_TOOL_NAMES.has(event.toolName) ? TOOL_NAME : event.toolName;
		setStatus(`Wykonuję: ${displayToolName}`);
		if (TODO_TOOL_NAMES.has(event.toolName) && ctx.hasUI) {
			setFooterStatus(ctx, `narzędzie ${displayToolName} (aktywny)`);
		}
	});


	pi.on("tool_result", async (event, ctx) => {
		if (TODO_TOOL_NAMES.has(event.toolName)) {
			const updated = applyTodoStateFromToolResult(
				event.toolName,
				event.details,
				event.toolName !== TOOL_NAME,
			);
			setStatus(event.isError ? "Błąd narzędzia /todo" : "Narzędzie zakończone /todo");
			if (!updated) {
				refreshPanelSoon();
			}
		}

		if (ctx.hasUI) {
			setFooterStatus(ctx);
		}
	});


	pi.on("tool_execution_end", async (event, ctx) => {
		if (!TODO_TOOL_NAMES.has(event.toolName)) {
			return;
		}

		const result: Record<string, unknown> = event.result as Record<string, unknown>;
		if (result) {
			const details = (result as Record<string, unknown>)?.details;
			const updated = applyTodoStateFromToolResult(
				event.toolName,
				details ?? result,
				event.toolName !== TOOL_NAME,
			);
			if (!updated) {
				refreshPanel();
			}
		}

		if (ctx.hasUI) {
			setFooterStatus(ctx);
		}
	});


	pi.on("tool_execution_update", async (event, ctx) => {
		if (!TODO_TOOL_NAMES.has(event.toolName)) {
			return;
		}
		if (event.partialResult && typeof event.partialResult === "object") {
			const partial = event.partialResult as Record<string, unknown>;
			const details = (partial as { details?: unknown }).details;
			if (details) {
				applyTodoStateFromToolResult(event.toolName, details, false);
			} else {
				refreshPanelSoon();
			}
		}
		if (ctx.hasUI) {
			setFooterStatus(ctx);
		}
	});


	pi.on("message_update", async (_event, _ctx) => {
		refreshPanelSoon();
	});

	pi.on("session_shutdown", async () => {
		if (terminalInputUnsubscribe) {
			terminalInputUnsubscribe();
			terminalInputUnsubscribe = null;
		}
		if (todoStoreUnsubscribe) {
			todoStoreUnsubscribe();
			todoStoreUnsubscribe = null;
		}
		if (livePanelRefreshTimer) {
			clearTimeout(livePanelRefreshTimer);
			livePanelRefreshTimer = null;
		}
		if (panelHandle) {
			panelHandle.hide();
			panelHandle = null;
		}
		panel = null;
	});
}

