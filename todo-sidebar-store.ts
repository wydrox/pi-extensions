import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Helper store module used by other extensions. We also export a no-op default
// factory so Pi can safely auto-discover this file without treating it as an
// invalid extension entrypoint.

type ActiveTodoId = number | null;
export type SidebarMode = "normal" | "wide" | "collapsed";
export const TODO_STATUSES = ["todo", "inprogress", "done", "blocked", "skipping"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface Todo {
	id: number;
	text: string;
	status: TodoStatus;
}

export interface IncidentTodoLink {
	fingerprint: string;
	todoId: number;
	source: string;
	title: string;
	severity: string;
	status: "open" | "resolved";
	firstSeenAt: string;
	lastSeenAt: string;
	lastEvidence?: string;
	occurrences: number;
	resolvedAt?: string;
}

export interface TodoStoreState {
	todos: Todo[];
	nextId: number;
	activeTodoId: ActiveTodoId;
	hideDoneAndSkipping: boolean;
	sidebarMode: SidebarMode;
	incidentLinks: Record<string, IncidentTodoLink>;
}

export interface TodoToolStateSnapshotV1 {
	v: 1;
	todos: Array<{ id: number; text: string; done: boolean }>;
	nextId: number;
}

export interface TodoToolStateSnapshotV2 {
	v: 2;
	todos: Todo[];
	nextId: number;
	activeTodoId?: ActiveTodoId;
	hideDoneAndSkipping?: boolean;
	sidebarMode?: SidebarMode;
	wideMode?: boolean;
}

export interface TodoToolStateSnapshotV3 {
	v: 3;
	todos: Todo[];
	nextId: number;
	activeTodoId?: ActiveTodoId;
	hideDoneAndSkipping?: boolean;
	sidebarMode?: SidebarMode;
	wideMode?: boolean;
	incidentLinks?: Record<string, IncidentTodoLink>;
}

export type TodoToolStateSnapshot = TodoToolStateSnapshotV1 | TodoToolStateSnapshotV2 | TodoToolStateSnapshotV3;

export interface UpsertIncidentTodoInput {
	fingerprint: string;
	source: string;
	title: string;
	severity?: string;
	status?: "open" | "resolved";
	firstSeenAt?: string;
	lastSeenAt?: string;
	evidence?: string[];
	text?: string;
}

interface StoreChangeMeta {
	reason: string;
	persist: boolean;
}

type StoreListener = (state: TodoStoreState, meta: StoreChangeMeta) => void;

const DEFAULT_STATE: TodoStoreState = {
	todos: [],
	nextId: 1,
	activeTodoId: null,
	hideDoneAndSkipping: false,
	sidebarMode: "collapsed",
	incidentLinks: {},
};

let state: TodoStoreState = cloneState(DEFAULT_STATE);
const listeners = new Set<StoreListener>();

export function parseTodoStatus(input: unknown): TodoStatus | undefined {
	if (typeof input !== "string") return undefined;
	return TODO_STATUSES.includes(input as TodoStatus) ? (input as TodoStatus) : undefined;
}

export function parseSidebarMode(input: unknown): SidebarMode | undefined {
	return input === "normal" || input === "wide" || input === "collapsed" ? input : undefined;
}

export function normalizeTodo(input: unknown): Todo | undefined {
	if (!input || typeof input !== "object") return undefined;
	const raw = input as { id?: unknown; text?: unknown; status?: unknown; done?: unknown };
	const id = typeof raw.id === "number" && Number.isSafeInteger(raw.id) ? raw.id : NaN;
	if (!Number.isSafeInteger(id) || id <= 0 || typeof raw.text !== "string") return undefined;
	return {
		id,
		text: raw.text,
		status: parseTodoStatus(raw.status) ?? (typeof raw.done === "boolean" ? (raw.done ? "done" : "todo") : "todo"),
	};
}

export function copyTodos(input: Todo[]): Todo[] {
	return input.map((todo) => ({ ...todo }));
}

function cloneIncidentLinks(input: Record<string, IncidentTodoLink>): Record<string, IncidentTodoLink> {
	return Object.fromEntries(Object.entries(input).map(([fingerprint, link]) => [fingerprint, { ...link }]));
}

export function cloneState(input: TodoStoreState): TodoStoreState {
	return {
		todos: copyTodos(input.todos),
		nextId: input.nextId,
		activeTodoId: input.activeTodoId,
		hideDoneAndSkipping: input.hideDoneAndSkipping,
		sidebarMode: input.sidebarMode,
		incidentLinks: cloneIncidentLinks(input.incidentLinks),
	};
}

function sanitizeState(input: TodoStoreState): TodoStoreState {
	const todos = copyTodos(input.todos);
	const nextId = Math.max(1, input.nextId, ...todos.map((todo) => todo.id + 1));
	const active = input.activeTodoId !== null ? todos.find((todo) => todo.id === input.activeTodoId && todo.status === "inprogress") : undefined;
	const fallbackActive = [...todos].reverse().find((todo) => todo.status === "inprogress");
	const activeTodoId = active?.id ?? fallbackActive?.id ?? null;
	const incidentLinks = cloneIncidentLinks(input.incidentLinks);

	for (const [fingerprint, link] of Object.entries(incidentLinks)) {
		if (!todos.some((todo) => todo.id === link.todoId)) {
			delete incidentLinks[fingerprint];
		}
	}

	return {
		todos,
		nextId,
		activeTodoId,
		hideDoneAndSkipping: input.hideDoneAndSkipping,
		sidebarMode: input.sidebarMode,
		incidentLinks,
	};
}

function setState(next: TodoStoreState, meta: StoreChangeMeta): TodoStoreState {
	state = sanitizeState(next);
	const snapshot = cloneState(state);
	for (const listener of listeners) listener(snapshot, meta);
	return snapshot;
}

export function getTodoStoreState(): TodoStoreState {
	return cloneState(state);
}

export function subscribeTodoStore(listener: StoreListener): () => void {
	listeners.add(listener);
	listener(getTodoStoreState(), { reason: "subscribe", persist: false });
	return () => listeners.delete(listener);
}

export function restoreTodoStoreState(snapshot: TodoToolStateSnapshot | TodoStoreState, persist = false): TodoStoreState {
	if ((snapshot as TodoStoreState).incidentLinks !== undefined && (snapshot as TodoStoreState).todos !== undefined && (snapshot as TodoStoreState).hideDoneAndSkipping !== undefined) {
		return setState(cloneState(snapshot as TodoStoreState), { reason: "restore_state", persist });
	}

	const data = snapshot as TodoToolStateSnapshot;
	let todos: Todo[] = [];
	let nextId = 1;
	let activeTodoId: ActiveTodoId = null;
	let hideDoneAndSkipping = false;
	let sidebarMode: SidebarMode = "collapsed";
	let incidentLinks: Record<string, IncidentTodoLink> = {};

	if (data.v === 1 || data.v === 2 || data.v === 3) {
		todos = (data.todos ?? []).map((todo) => normalizeTodo(todo)).filter((todo): todo is Todo => todo !== undefined);
		nextId = typeof data.nextId === "number" ? data.nextId : 1;
		if (data.v >= 2) {
			const modernData = data as TodoToolStateSnapshotV2 | TodoToolStateSnapshotV3;
			activeTodoId = modernData.activeTodoId ?? null;
			hideDoneAndSkipping = modernData.hideDoneAndSkipping === true;
			sidebarMode = parseSidebarMode(modernData.sidebarMode) ?? (modernData.wideMode === true ? "wide" : "collapsed");
		}
		if (data.v === 3 && data.incidentLinks && typeof data.incidentLinks === "object") {
			incidentLinks = cloneIncidentLinks(data.incidentLinks);
		}
	}

	return setState({ todos, nextId, activeTodoId, hideDoneAndSkipping, sidebarMode, incidentLinks }, { reason: "restore_snapshot", persist });
}

export function createTodoStoreSnapshot(): TodoToolStateSnapshotV3 {
	const snapshot = getTodoStoreState();
	return {
		v: 3,
		todos: snapshot.todos,
		nextId: snapshot.nextId,
		activeTodoId: snapshot.activeTodoId,
		hideDoneAndSkipping: snapshot.hideDoneAndSkipping,
		sidebarMode: snapshot.sidebarMode,
		wideMode: snapshot.sidebarMode === "wide",
		incidentLinks: snapshot.incidentLinks,
	};
}

export function replaceTodos(todos: Todo[], nextId?: number, persist = true): TodoStoreState {
	const current = getTodoStoreState();
	return setState({ ...current, todos: copyTodos(todos), nextId: nextId ?? current.nextId }, { reason: "replace_todos", persist });
}

export function addTodo(text: string, status: TodoStatus = "todo", persist = true): TodoStoreState {
	const current = getTodoStoreState();
	const next = copyTodos(current.todos);
	next.push({ id: current.nextId, text: text.trim(), status });
	return setState({ ...current, todos: next, nextId: current.nextId + 1 }, { reason: "add_todo", persist });
}

export function toggleTodo(id: number, persist = true): TodoStoreState | undefined {
	const current = getTodoStoreState();
	const todos = copyTodos(current.todos);
	const target = todos.find((todo) => todo.id === id);
	if (!target) return undefined;
	target.status = target.status === "done" ? "todo" : "done";
	return setState({ ...current, todos }, { reason: "toggle_todo", persist });
}

export function setTodoStatus(id: number, status: TodoStatus, persist = true): TodoStoreState | undefined {
	const current = getTodoStoreState();
	const todos = copyTodos(current.todos);
	const target = todos.find((todo) => todo.id === id);
	if (!target) return undefined;
	target.status = status;
	return setState(
		{
			...current,
			todos,
			activeTodoId: status === "inprogress" ? id : current.activeTodoId === id ? null : current.activeTodoId,
		},
		{ reason: "set_todo_status", persist },
	);
}

export function clearTodos(persist = true): TodoStoreState {
	return setState({ ...getTodoStoreState(), todos: [], nextId: 1, activeTodoId: null, incidentLinks: {} }, { reason: "clear_todos", persist });
}

export function setTodoStoreUiState(partial: Partial<Pick<TodoStoreState, "hideDoneAndSkipping" | "sidebarMode" | "activeTodoId">>, persist = true): TodoStoreState {
	const current = getTodoStoreState();
	return setState({ ...current, ...partial }, { reason: "set_ui_state", persist });
}

function getSeverityStatus(severity?: string, status?: "open" | "resolved"): TodoStatus {
	if (status === "resolved") return "done";
	return severity === "critical" || severity === "high" ? "blocked" : "todo";
}

export function upsertIncidentTodo(input: UpsertIncidentTodoInput, persist = true): { state: TodoStoreState; todo: Todo; link: IncidentTodoLink } {
	const current = getTodoStoreState();
	const todos = copyTodos(current.todos);
	const incidentLinks = cloneIncidentLinks(current.incidentLinks);
	const now = input.lastSeenAt ?? new Date().toISOString();
	const source = input.source.trim();
	const title = input.title.trim() || "incident";
	const nextStatus = getSeverityStatus(input.severity, input.status ?? "open");
	const nextText = (input.text?.trim() || `${source}: ${title}`).trim();
	const evidence = (input.evidence ?? []).filter(Boolean);
	let link = incidentLinks[input.fingerprint];
	let todo: Todo | undefined = link ? todos.find((item) => item.id === link.todoId) : undefined;

	if (!link || !todo) {
		todo = { id: current.nextId, text: nextText, status: nextStatus };
		todos.push(todo);
		link = {
			fingerprint: input.fingerprint,
			todoId: todo.id,
			source,
			title,
			severity: input.severity ?? "medium",
			status: input.status ?? "open",
			firstSeenAt: input.firstSeenAt ?? now,
			lastSeenAt: now,
			lastEvidence: evidence[0],
			occurrences: 1,
			resolvedAt: input.status === "resolved" ? now : undefined,
		};
		incidentLinks[input.fingerprint] = link;
		const nextState = setState({ ...current, todos, nextId: current.nextId + 1, incidentLinks }, { reason: "upsert_incident_new", persist });
		return { state: nextState, todo, link: { ...link } };
	}

	todo.text = nextText;
	todo.status = nextStatus;
	link.title = title;
	link.source = source;
	link.severity = input.severity ?? link.severity;
	link.status = input.status ?? link.status;
	link.firstSeenAt = input.firstSeenAt ?? link.firstSeenAt;
	link.lastSeenAt = now;
	link.lastEvidence = evidence[0] ?? link.lastEvidence;
	link.occurrences += input.status === "resolved" ? 0 : 1;
	link.resolvedAt = input.status === "resolved" ? now : undefined;
	incidentLinks[input.fingerprint] = link;
	const nextState = setState({ ...current, todos, incidentLinks }, { reason: "upsert_incident_update", persist });
	return { state: nextState, todo, link: { ...link } };
}

export function getIncidentTodoLink(fingerprint: string): IncidentTodoLink | undefined {
	const link = state.incidentLinks[fingerprint];
	return link ? { ...link } : undefined;
}

export function clearIncidentTodoLinks(persist = true): TodoStoreState {
	const current = getTodoStoreState();
	return setState({ ...current, incidentLinks: {} }, { reason: "clear_incident_links", persist });
}

export default function todoSidebarStoreHelper(_pi: ExtensionAPI) {
	// Intentionally empty. This file is primarily a shared helper module.
}
