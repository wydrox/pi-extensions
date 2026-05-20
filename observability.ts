import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	matchesKey,
	parseKey,
	truncateToWidth,
	type Component,
	type OverlayHandle,
	type TUI,
	type Theme,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { upsertIncidentTodo, getTodoStoreState, setTodoStatus } from "./todo-sidebar-store";

type SourceName = "vercel" | "convex" | "workos" | "cdp";
type IncidentSeverity = "low" | "medium" | "high" | "critical";
type IncidentStatus = "open" | "resolved";

interface Incident {
	source: SourceName;
	fingerprint: string;
	title: string;
	evidence: string[];
	severity: IncidentSeverity;
	firstSeenAt: string;
	lastSeenAt: string;
	status: IncidentStatus;
	target?: string;
	entryKey?: string;
}

interface CliSourceConfig {
	enabled?: boolean;
	args?: string[];
	cwd?: string;
	timeoutMs?: number;
	format?: "json" | "jsonl" | "text";
	project?: string;
	target?: string;
	maxLines?: number;
}

interface CdpConfig {
	enabled?: boolean;
	url?: string;
	targetTitleIncludes?: string;
}

interface IncidentFilterConfig {
	enabled?: boolean;
	appUrlIncludes?: string[];
	ignorePatterns?: string[];
	ignoreUrlPrefixes?: string[];
}

interface ObservabilityAutoflowConfig {
	enabled?: boolean;
	minSeverity?: IncidentSeverity;
	deliverAs?: "steer" | "followUp";
	useSubagents?: boolean;
	setTodoInProgress?: boolean;
}

interface ObservabilityConfig {
	pollIntervalMs?: number;
	quietWindowMs?: number;
	dedupeWindowMs?: number;
	autoResolve?: boolean;
	configPath?: string;
	sources?: {
		vercel?: CliSourceConfig;
		convex?: CliSourceConfig;
		workos?: CliSourceConfig;
	};
	cdp?: CdpConfig;
	filters?: IncidentFilterConfig;
	autoflow?: ObservabilityAutoflowConfig;
}

interface SourceRuntimeState {
	lastPollAt?: string;
	seenEntryKeys: string[];
}

interface ObservabilityRuntimeState {
	v: 1;
	running: boolean;
	configPath?: string;
	startedAt?: string;
	lastScanAt?: string;
	sources: Record<string, SourceRuntimeState>;
	autoflowStartedFingerprints?: string[];
}

type LogLevel = "info" | "warning" | "error";
type LogTabName = "all" | SourceName;

interface SourceLogEntry {
	source: SourceName;
	level: LogLevel;
	timestamp: string;
	text: string;
	target?: string;
}

interface LogPanelPayload {
	running: boolean;
	tabs: LogTabName[];
	activeTab: LogTabName;
	entries: SourceLogEntry[];
	summary: string;
}

const TOOL_NAME = "observability";
const DEFAULT_CONFIG_PATH = ".pi/observability.json";
const DEFAULT_POLL_INTERVAL_MS = 30000;
const DEFAULT_QUIET_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_DEDUPE_WINDOW_MS = 60 * 1000;
const DEFAULT_AUTOFLOW_MIN_SEVERITY: IncidentSeverity = "high";
const MAX_SEEN_ENTRIES_PER_SOURCE = 500;
const MAX_AUTOFLOW_FINGERPRINTS = 500;
const MAX_LOG_ENTRIES_PER_SOURCE = 120;
const CDP_RECONNECT_MS = 5000;
const LOG_PANEL_MARGIN_BOTTOM = 5;
const LOG_PANEL_WIDTH = "68%";
const LOG_PANEL_MIN_WIDTH = 72;
const LOG_PANEL_MAX_HEIGHT = "48%";
const DEFAULT_IGNORE_URL_PREFIXES = ["chrome-extension://", "moz-extension://", "safari-extension://", "extension://", "devtools://", "chrome://", "edge://", "about:"];
const DEFAULT_IGNORE_PATTERNS = [
	"extension context invalidated",
	"the message port closed before a response was received",
	"a listener indicated an asynchronous response by returning true, but the message channel closed before a response was received",
	"err_blocked_by_client",
	"metaMask",
];
const CLI_BINS: Record<Exclude<SourceName, "cdp">, string> = {
	vercel: "vercel",
	convex: "convex",
	workos: "workos",
};

const ObservabilityParams = Type.Object({
	action: StringEnum(["start", "stop", "status", "scan_now", "clear_seen"] as const),
});

function resolveCwd(baseCwd: string, input?: string): string {
	if (!input?.trim()) return baseCwd;
	return resolve(baseCwd, input.trim().replace(/^@/, ""));
}

function parseJsonSafely<T = unknown>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

function normalizeMessage(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").replace(/[0-9a-f]{8,}/gi, "#").trim();
}

function stackTop(value?: string): string {
	if (!value) return "";
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean) ?? "";
}

function fingerprintForIncident(source: SourceName, message: string, stack?: string, target?: string): string {
	const stable = [source, normalizeMessage(message), normalizeMessage(stackTop(stack)), (target ?? "").toLowerCase()].join("|");
	return createHash("sha1").update(stable).digest("hex");
}

function entryKeyForIncident(source: SourceName, message: string, timestamp?: string, stack?: string, target?: string): string {
	const stable = [source, timestamp ?? "", normalizeMessage(message), normalizeMessage(stackTop(stack)), (target ?? "").toLowerCase()].join("|");
	return createHash("sha1").update(stable).digest("hex");
}

function severityFromText(text: string): IncidentSeverity {
	const value = text.toLowerCase();
	if (/(panic|critical|fatal|uncaught|segmentation|out of memory)/i.test(value)) return "critical";
	if (/(error|exception|failed|failure|crash|assert)/i.test(value)) return "high";
	if (/(warn|warning|degraded|timeout)/i.test(value)) return "medium";
	return "low";
}

function normalizeEvidence(items: string[]): string[] {
	return items.map((item) => item.trim()).filter(Boolean).slice(0, 3);
}

function lowerCaseList(values?: string[]): string[] {
	return (values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function extractUrlCandidates(value: string): string[] {
	return value.match(/(?:[a-z]+:\/\/|about:)[^\s)"']+/gi) ?? [];
}

function incidentBlob(incident: Incident): string {
	return [incident.title, incident.target ?? "", ...incident.evidence].filter(Boolean).join("\n");
}

function shouldIgnoreIncident(incident: Incident, config?: ObservabilityConfig): boolean {
	if (config?.filters?.enabled === false) return false;
	const blob = incidentBlob(incident);
	const lowerBlob = blob.toLowerCase();
	const ignorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...(config?.filters?.ignorePatterns ?? [])]
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
	if (ignorePatterns.some((pattern) => lowerBlob.includes(pattern))) return true;
	const urls = extractUrlCandidates(blob).map((value) => value.toLowerCase());
	const ignoreUrlPrefixes = [...DEFAULT_IGNORE_URL_PREFIXES, ...(config?.filters?.ignoreUrlPrefixes ?? [])]
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
	if (urls.some((url) => ignoreUrlPrefixes.some((prefix) => url.startsWith(prefix)))) return true;
	if (incident.source !== "cdp") return false;
	const appUrlIncludes = lowerCaseList(config?.filters?.appUrlIncludes);
	if (appUrlIncludes.length === 0) return false;
	const hasUrlContext = urls.length > 0 || /(?:localhost|127\.0\.0\.1|https?:\/\/)/i.test(blob);
	return hasUrlContext && !appUrlIncludes.some((needle) => lowerBlob.includes(needle));
}

function incidentText(incident: Incident): string {
	return `${incident.source}: ${incident.title}`;
}

function listEnabledSources(config: ObservabilityConfig): string[] {
	const enabled: string[] = [];
	for (const source of ["vercel", "convex", "workos"] as const) {
		if (config.sources?.[source]?.enabled && (config.sources[source]?.args?.length ?? 0) > 0) enabled.push(source);
	}
	if (config.cdp?.enabled) enabled.push("cdp");
	return enabled;
}

function trimSeenEntryKeys(keys: string[]): string[] {
	return keys.slice(Math.max(0, keys.length - MAX_SEEN_ENTRIES_PER_SOURCE));
}

function trimAutoflowFingerprints(keys: string[]): string[] {
	return keys.slice(Math.max(0, keys.length - MAX_AUTOFLOW_FINGERPRINTS));
}

function severityRank(severity: IncidentSeverity): number {
	switch (severity) {
		case "critical":
			return 4;
		case "high":
			return 3;
		case "medium":
			return 2;
		default:
			return 1;
	}
}

function parseCliTextLines(source: Exclude<SourceName, "cdp">, output: string, cfg: CliSourceConfig): Incident[] {
	const maxLines = cfg.maxLines ?? 200;
	const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-maxLines);
	const incidents: Incident[] = [];
	for (const line of lines) {
		if (!/(error|exception|failed|failure|panic|warn|warning|assert)/i.test(line)) continue;
		const severity = severityFromText(line);
		if (severity === "low") continue;
		const now = new Date().toISOString();
		incidents.push({
			source,
			title: line.slice(0, 180),
			severity,
			status: "open",
			firstSeenAt: now,
			lastSeenAt: now,
			target: cfg.target ?? cfg.project,
			evidence: [line],
			fingerprint: fingerprintForIncident(source, line, undefined, cfg.target ?? cfg.project),
			entryKey: entryKeyForIncident(source, line, now, undefined, cfg.target ?? cfg.project),
		});
	}
	return incidents;
}

function extractStringFields(input: unknown, bucket: string[] = []): string[] {
	if (typeof input === "string") {
		bucket.push(input);
		return bucket;
	}
	if (Array.isArray(input)) {
		for (const item of input) extractStringFields(item, bucket);
		return bucket;
	}
	if (input && typeof input === "object") {
		for (const value of Object.values(input as Record<string, unknown>)) extractStringFields(value, bucket);
	}
	return bucket;
}

function parseJsonEntry(source: Exclude<SourceName, "cdp">, entry: Record<string, unknown>, cfg: CliSourceConfig): Incident | undefined {
	const message = [entry.message, entry.msg, entry.error, entry.text, entry.description]
		.find((value) => typeof value === "string") as string | undefined;
	const strings = extractStringFields(entry);
	const stack = [entry.stack, entry.trace, entry.stacktrace].find((value) => typeof value === "string") as string | undefined;
	const level = [entry.level, entry.severity, entry.status].find((value) => typeof value === "string") as string | undefined;
	const project = [entry.project, entry.projectId, entry.deployment, entry.target, cfg.project, cfg.target].find((value) => typeof value === "string") as string | undefined;
	const timestamp = [entry.timestamp, entry.time, entry.date, entry.createdAt].find((value) => typeof value === "string") as string | undefined;
	const text = (message ?? strings.find((value) => /(error|exception|failed|failure|panic|warn|warning|assert)/i.test(value)) ?? "").trim();
	if (!text) return undefined;
	const severity = severityFromText(`${level ?? ""} ${text}`);
	if (severity === "low") return undefined;
	const now = timestamp ?? new Date().toISOString();
	return {
		source,
		title: text.slice(0, 180),
		severity,
		status: "open",
		firstSeenAt: now,
		lastSeenAt: now,
		target: project,
		evidence: normalizeEvidence([text, stack ?? ""]),
		fingerprint: fingerprintForIncident(source, text, stack, project),
		entryKey: entryKeyForIncident(source, text, timestamp, stack, project),
	};
}

function parseCliOutput(source: Exclude<SourceName, "cdp">, output: string, cfg: CliSourceConfig): Incident[] {
	const format = cfg.format ?? "text";
	if (format === "text") return parseCliTextLines(source, output, cfg);
	if (format === "json") {
		const parsed = parseJsonSafely<unknown>(output);
		if (Array.isArray(parsed)) {
			return parsed
				.map((item) => (item && typeof item === "object" ? parseJsonEntry(source, item as Record<string, unknown>, cfg) : undefined))
				.filter((item): item is Incident => item !== undefined);
		}
		if (parsed && typeof parsed === "object") {
			const incident = parseJsonEntry(source, parsed as Record<string, unknown>, cfg);
			return incident ? [incident] : [];
		}
		return [];
	}
	return output
		.split(/\r?\n/)
		.map((line) => parseJsonSafely<Record<string, unknown>>(line.trim()))
		.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
		.map((item) => parseJsonEntry(source, item, cfg))
		.filter((item): item is Incident => item !== undefined);
}

function loadConfig(cwd: string, configPath?: string): { path: string; config?: ObservabilityConfig; error?: string } {
	const path = resolve(cwd, configPath?.trim() || DEFAULT_CONFIG_PATH);
	if (!existsSync(path)) {
		return { path, error: `Config not found at ${path}` };
	}
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = parseJsonSafely<ObservabilityConfig>(raw);
		if (!parsed || typeof parsed !== "object") {
			return { path, error: `Invalid JSON config at ${path}` };
		}
		parsed.configPath = path;
		return { path, config: parsed };
	} catch (error) {
		return { path, error: error instanceof Error ? error.message : String(error) };
	}
}

function buildStatus(runtime: ObservabilityRuntimeState, config?: ObservabilityConfig): string {
	const enabled = config ? listEnabledSources(config).join(", ") || "none" : "none";
	const scans = Object.entries(runtime.sources)
		.map(([source, info]) => `${source}: seen=${info.seenEntryKeys.length}${info.lastPollAt ? ` last=${info.lastPollAt}` : ""}`)
		.join("; ");
	const appUrlIncludes = lowerCaseList(config?.filters?.appUrlIncludes);
	const autoflow = config?.autoflow;
	const autoflowLabel = autoflow?.enabled === false
		? "off"
		: `on (min=${autoflow?.minSeverity ?? DEFAULT_AUTOFLOW_MIN_SEVERITY}${autoflow?.useSubagents === false ? "" : ", subagents"})`;
	return [
		`running: ${runtime.running ? "yes" : "no"}`,
		`config: ${runtime.configPath ?? DEFAULT_CONFIG_PATH}`,
		`enabled sources: ${enabled}`,
		`filters: ${config?.filters?.enabled === false ? "off" : `on${appUrlIncludes.length ? ` (app urls: ${appUrlIncludes.join(", ")})` : ""}`}`,
		`autoflow: ${autoflowLabel}`,
		`last scan: ${runtime.lastScanAt ?? "never"}`,
		scans ? `state: ${scans}` : "state: none",
		`ux: status line + Ctrl+= logs + Tab switch`,
	].join("\n");
}

function sourceDisplayName(source: LogTabName): string {
	switch (source) {
		case "all":
			return "Wszystkie";
		case "cdp":
			return "Helium";
		case "convex":
			return "Convex";
		case "vercel":
			return "Vercel";
		case "workos":
			return "WorkOS";
	}
}

function logLevelFromSeverity(severity: IncidentSeverity): LogLevel {
	if (severity === "critical" || severity === "high") return "error";
	if (severity === "medium") return "warning";
	return "info";
}

function pluralizeServices(count: number): string {
	const mod10 = count % 10;
	const mod100 = count % 100;
	if (count === 1) return "usługę";
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "usługi";
	return "usług";
}

function formatLogTime(timestamp: string): string {
	const parsed = Date.parse(timestamp);
	if (!Number.isFinite(parsed)) return timestamp.slice(11, 19) || timestamp.slice(0, 8) || timestamp;
	return new Date(parsed).toISOString().slice(11, 19);
}

function sortLogEntries(entries: SourceLogEntry[]): SourceLogEntry[] {
	return [...entries].sort((a, b) => {
		const left = Date.parse(a.timestamp);
		const right = Date.parse(b.timestamp);
		if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
		return a.timestamp.localeCompare(b.timestamp);
	});
}

class ObservabilityLogPanel implements Component {
	private cachedWidth?: number;
	private cachedHeight?: number;
	private cachedLines: string[] = [];

	constructor(
		private readonly tui: TUI,
		private readonly getPayload: () => LogPanelPayload,
		private readonly theme: Theme,
		private readonly onHide: () => void,
		private readonly getTerminalHeight: () => number,
	) {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
	}

	private widthLine(width: number, text: string): string {
		return truncateToWidth(text, Math.max(0, width), "...", true);
	}

	private wrapEntry(width: number, prefix: string, text: string): string[] {
		const prefixWidth = visibleWidth(prefix);
		const availableWidth = Math.max(1, width - prefixWidth);
		const bodyLines = wrapTextWithAnsi(text, availableWidth);
		if (bodyLines.length === 0) return [this.widthLine(width, prefix)];
		const continuation = " ".repeat(prefixWidth);
		return bodyLines.map((line, index) => this.widthLine(width, `${index === 0 ? prefix : continuation}${line}`));
	}

	render(width: number): string[] {
		const payload = this.getPayload();
		const terminalHeight = this.getTerminalHeight();
		if (this.cachedWidth === width && this.cachedHeight === terminalHeight && this.cachedLines.length > 0) {
			return this.cachedLines;
		}

		const th = this.theme;
		const effectiveWidth = Math.max(1, width);
		const lines: string[] = [];
		const title = th.fg("accent", payload.running ? "MONITORING LOGÓW" : "LOGI OBSERVABILITY");
		const summary = th.fg("dim", payload.summary);
		const tabs = payload.tabs
			.map((tab) => tab === payload.activeTab ? th.fg("warning", `[${sourceDisplayName(tab)}]`) : th.fg("muted", sourceDisplayName(tab)))
			.join(th.fg("dim", " • "));
		lines.push(this.widthLine(effectiveWidth, th.fg("border", "─".repeat(effectiveWidth))));
		lines.push(this.widthLine(effectiveWidth, `${title}${summary ? ` ${summary}` : ""}`));
		lines.push(this.widthLine(effectiveWidth, tabs));
		lines.push(this.widthLine(effectiveWidth, th.fg("border", "─".repeat(effectiveWidth))));

		const footerLines = 2;
		const fixedLines = lines.length + footerLines;
		const panelHeight = Math.max(8, Math.min(terminalHeight - LOG_PANEL_MARGIN_BOTTOM, terminalHeight));
		const contentBudget = Math.max(1, panelHeight - fixedLines);
		const entryLines = payload.entries.flatMap((entry) => {
			const color = entry.level === "error" ? "error" : entry.level === "warning" ? "warning" : "muted";
			const prefix = `${th.fg(color, `[${formatLogTime(entry.timestamp)}]`)} ${th.fg("accent", sourceDisplayName(entry.source))} `;
			const suffix = entry.target ? th.fg("dim", ` (${entry.target})`) : "";
			return this.wrapEntry(effectiveWidth, prefix, `${th.fg("text", entry.text)}${suffix}`);
		});
		const visibleEntries = entryLines.length > contentBudget ? entryLines.slice(entryLines.length - contentBudget) : entryLines;
		if (visibleEntries.length === 0) {
			lines.push(this.widthLine(effectiveWidth, th.fg("dim", "Brak ostatnich wpisów logów dla tego widoku.")));
		} else {
			lines.push(...visibleEntries);
		}
		lines.push(this.widthLine(effectiveWidth, th.fg("border", "─".repeat(effectiveWidth))));
		lines.push(this.widthLine(effectiveWidth, th.fg("dim", "Ctrl+= zamknij • Tab / Shift+Tab przełącz widok")));
		this.cachedWidth = width;
		this.cachedHeight = terminalHeight;
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

export default function observabilityExtension(pi: ExtensionAPI): void {
	let runtime: ObservabilityRuntimeState = { v: 1, running: false, sources: {}, autoflowStartedFingerprints: [] };
	let activeConfig: ObservabilityConfig | undefined;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let cdpSocket: any = null;
	let cdpReconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let cdpRequestId = 0;
	let currentCwd = process.cwd();
	let lastCtx: ExtensionContext | ExtensionCommandContext | null = null;
	let scanInFlight = false;
	let logPanel: ObservabilityLogPanel | null = null;
	let logPanelHandle: OverlayHandle | null = null;
	let logPanelRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	let terminalInputUnsubscribe: (() => void) | null = null;
	let activeLogTab: LogTabName = "all";
	const logBuffers: Record<SourceName, SourceLogEntry[]> = {
		vercel: [],
		convex: [],
		workos: [],
		cdp: [],
	};

	function persistRuntime(): void {
		pi.appendEntry("observability-state", runtime);
	}

	function ensureSourceRuntime(source: string): SourceRuntimeState {
		if (!runtime.sources[source]) {
			runtime.sources[source] = { seenEntryKeys: [] };
		}
		return runtime.sources[source];
	}

	function hasAutoflowStarted(fingerprint: string): boolean {
		return (runtime.autoflowStartedFingerprints ?? []).includes(fingerprint);
	}

	function markAutoflowStarted(fingerprint: string): void {
		runtime.autoflowStartedFingerprints = trimAutoflowFingerprints([
			...(runtime.autoflowStartedFingerprints ?? []),
			fingerprint,
		]);
	}

	function addSeenEntry(source: string, key?: string): boolean {
		if (!key) return true;
		const state = ensureSourceRuntime(source);
		if (state.seenEntryKeys.includes(key)) {
			return false;
		}
		state.seenEntryKeys = trimSeenEntryKeys([...state.seenEntryKeys, key]);
		return true;
	}

	function notify(ctx: ExtensionContext | ExtensionCommandContext | null, message: string, level: "info" | "warning" | "error" = "info") {
		if (ctx?.hasUI) ctx.ui.notify(message, level);
	}

	function listLogTabs(config?: ObservabilityConfig): LogTabName[] {
		const tabs: LogTabName[] = ["all"];
		const enabled = new Set<SourceName>();
		for (const source of listEnabledSources(config ?? {}).filter((item): item is SourceName => ["vercel", "convex", "workos", "cdp"].includes(item))) {
			enabled.add(source);
		}
		for (const source of ["vercel", "convex", "workos", "cdp"] as const) {
			if (enabled.has(source) || logBuffers[source].length > 0) tabs.push(source);
		}
		return tabs;
	}

	function ensureActiveLogTab(): void {
		const tabs = listLogTabs(activeConfig);
		if (!tabs.includes(activeLogTab)) activeLogTab = tabs[0] ?? "all";
	}

	function getOpenIncidentCount(): number {
		const enabled = new Set(listEnabledSources(activeConfig ?? {}));
		return Object.values(getTodoStoreState().incidentLinks).filter((link) => link.status !== "resolved" && (enabled.size === 0 || enabled.has(link.source))).length;
	}

	function buildMonitoringSummary(): string {
		if (!runtime.running) return "";
		const enabled = listEnabledSources(activeConfig ?? {});
		const serviceCount = enabled.filter((source) => source !== "cdp").length;
		const browserEnabled = enabled.includes("cdp");
		const openIncidents = getOpenIncidentCount();
		let base = serviceCount > 0 ? `monitoruje ${serviceCount} ${pluralizeServices(serviceCount)}` : "monitoring aktywny";
		if (browserEnabled) base += serviceCount > 0 ? " + browser" : " (browser)";
		return `${base}${openIncidents > 0 ? ` • ${openIncidents} inc.` : ""} • Ctrl+= logi`;
	}

	function setFooterStatus(ctx?: ExtensionContext | ExtensionCommandContext | null): void {
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus("observability", buildMonitoringSummary());
	}

	function refreshLogPanel(forceRender = false): void {
		logPanel?.refresh(forceRender);
	}

	function refreshLogPanelSoon(): void {
		if (logPanelRefreshTimer) return;
		logPanelRefreshTimer = setTimeout(() => {
			logPanelRefreshTimer = null;
			refreshLogPanel();
		}, 50);
	}

	function appendLogEntry(entry: SourceLogEntry): void {
		logBuffers[entry.source] = [...logBuffers[entry.source], entry].slice(-MAX_LOG_ENTRIES_PER_SOURCE);
		ensureActiveLogTab();
		refreshLogPanelSoon();
		setFooterStatus(lastCtx);
	}

	function appendIncidentLog(incident: Incident): void {
		if (incident.status !== "open") return;
		appendLogEntry({
			source: incident.source,
			level: logLevelFromSeverity(incident.severity),
			timestamp: incident.lastSeenAt,
			text: incident.title,
			target: incident.target,
		});
	}

	function shouldAutoflowIncident(incident: Incident): boolean {
		if (incident.status !== "open") return false;
		const autoflow = activeConfig?.autoflow;
		if (autoflow?.enabled === false) return false;
		const minSeverity = autoflow?.minSeverity ?? DEFAULT_AUTOFLOW_MIN_SEVERITY;
		return severityRank(incident.severity) >= severityRank(minSeverity);
	}

	function queueIncidentAutoflow(incident: Incident, todoId: number): void {
		if (!shouldAutoflowIncident(incident)) return;
		if (hasAutoflowStarted(incident.fingerprint)) return;
		markAutoflowStarted(incident.fingerprint);
		persistRuntime();
		const autoflow = activeConfig?.autoflow;
		if (autoflow?.setTodoInProgress !== false) {
			setTodoStatus(todoId, "inprogress", true);
		}
		const evidence = incident.evidence.filter(Boolean).slice(0, 3).map((item) => `- ${item}`).join("\n");
		const subagentInstruction = autoflow?.useSubagents === false
			? "Start triage and begin working on the fix."
			: "Use the subagent tool first for quick triage, then start working on the fix.";
		const prompt = [
			`New observability incident opened as TODO #${todoId}.`,
			`Source: ${incident.source}`,
			`Severity: ${incident.severity}`,
			incident.target ? `Target: ${incident.target}` : undefined,
			`Title: ${incident.title}`,
			evidence ? `Evidence:\n${evidence}` : undefined,
			subagentInstruction,
			"Please update the todo status as you work and keep the response concise.",
		].filter(Boolean).join("\n\n");
		if (lastCtx?.isIdle()) {
			pi.sendUserMessage(prompt);
		} else {
			pi.sendUserMessage(prompt, { deliverAs: autoflow?.deliverAs ?? "followUp" });
		}
		appendLogEntry({
			source: incident.source,
			level: "info",
			timestamp: new Date().toISOString(),
			text: `autoflow queued for todo #${todoId}`,
			target: incident.target,
		});
	}

	function getVisibleLogEntries(): SourceLogEntry[] {
		ensureActiveLogTab();
		if (activeLogTab === "all") {
			return sortLogEntries(Object.values(logBuffers).flat()).slice(-200);
		}
		return sortLogEntries(logBuffers[activeLogTab]).slice(-120);
	}

	function getLogPanelPayload(): LogPanelPayload {
		return {
			running: runtime.running,
			tabs: listLogTabs(activeConfig),
			activeTab: activeLogTab,
			entries: getVisibleLogEntries(),
			summary: buildMonitoringSummary(),
		};
	}

	function getTerminalHeight(): number {
		const rows = typeof process.stdout?.rows === "number" ? process.stdout.rows : undefined;
		return rows && rows > 0 ? rows : 24;
	}

	function ensureLogPanel(ctx: ExtensionContext): boolean {
		if (!ctx.hasUI) return false;
		if (logPanelHandle === null) {
			void ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					logPanel = new ObservabilityLogPanel(tui, () => getLogPanelPayload(), theme, () => {
						logPanel = null;
						done();
					}, () => getTerminalHeight());
					return logPanel;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "bottom-right",
						width: LOG_PANEL_WIDTH,
						minWidth: LOG_PANEL_MIN_WIDTH,
						maxHeight: LOG_PANEL_MAX_HEIGHT,
						margin: { right: 1, bottom: LOG_PANEL_MARGIN_BOTTOM, top: 1 },
						nonCapturing: true,
						visible: (termWidth, termHeight) => termWidth >= 100 && termHeight >= 20,
					},
					onHandle: (handle) => {
						logPanelHandle = handle;
					},
				},
			);
		}
		if (logPanelHandle) {
			logPanelHandle.setHidden(false);
			refreshLogPanel(true);
		}
		return true;
	}

	function toggleLogPanel(ctx: ExtensionContext): boolean {
		if (!ctx.hasUI) return false;
		if (logPanelHandle && !logPanelHandle.isHidden()) {
			logPanelHandle.setHidden(true);
			return true;
		}
		return ensureLogPanel(ctx);
	}

	function cycleLogTab(direction: 1 | -1): boolean {
		const tabs = listLogTabs(activeConfig);
		if (tabs.length <= 1) return false;
		const index = tabs.indexOf(activeLogTab);
		const nextIndex = index === -1 ? 0 : (index + direction + tabs.length) % tabs.length;
		activeLogTab = tabs[nextIndex] ?? "all";
		refreshLogPanel(true);
		return true;
	}

	function isCtrlEqualsShortcut(data: string): boolean {
		const parsed = parseKey(data)?.toLowerCase();
		return parsed === "ctrl+=" || parsed === "ctrl++" || matchesKey(data, "ctrl+=") || matchesKey(data, "ctrl++");
	}

	function handleLogShortcut(data: string, ctx?: ExtensionContext): boolean {
		if (ctx && isCtrlEqualsShortcut(data)) {
			return toggleLogPanel(ctx);
		}
		if (!logPanelHandle || logPanelHandle.isHidden()) return false;
		if (matchesKey(data, "tab") || matchesKey(data, "right")) return cycleLogTab(1);
		if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) return cycleLogTab(-1);
		if (ctx && isCtrlEqualsShortcut(data)) return toggleLogPanel(ctx);
		return false;
	}

	async function recordIncident(incident: Incident): Promise<void> {
		const link = getTodoStoreState().incidentLinks[incident.fingerprint];
		const dedupeWindowMs = activeConfig?.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
		if (link && incident.status === "open") {
			const elapsed = Date.parse(incident.lastSeenAt) - Date.parse(link.lastSeenAt);
			if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < dedupeWindowMs && !incident.entryKey) {
				return;
			}
		}
		appendIncidentLog(incident);
		const { todo } = upsertIncidentTodo(
			{
				fingerprint: incident.fingerprint,
				source: incident.source,
				title: incident.title,
				severity: incident.severity,
				status: incident.status,
				firstSeenAt: incident.firstSeenAt,
				lastSeenAt: incident.lastSeenAt,
				evidence: incident.evidence,
				text: incidentText(incident),
			},
			true,
		);
		if (incident.status === "open") {
			pi.events.emit("observability:incident_open", { incident, todoId: todo.id });
			queueIncidentAutoflow(incident, todo.id);
		}
		setFooterStatus(lastCtx);
	}

	async function resolveQuietIncidents(nowIso: string): Promise<void> {
		if (!activeConfig?.autoResolve) return;
		const quietWindowMs = activeConfig.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS;
		const now = Date.parse(nowIso);
		const links = Object.values(getTodoStoreState().incidentLinks);
		for (const link of links) {
			if (link.status === "resolved") continue;
			if (!listEnabledSources(activeConfig).includes(link.source)) continue;
			const age = now - Date.parse(link.lastSeenAt);
			if (!Number.isFinite(age) || age < quietWindowMs) continue;
			await recordIncident({
				source: (link.source === "cdp" ? "cdp" : link.source) as SourceName,
				fingerprint: link.fingerprint,
				title: link.title,
				evidence: link.lastEvidence ? [link.lastEvidence] : [],
				severity: (link.severity as IncidentSeverity) ?? "medium",
				firstSeenAt: link.firstSeenAt,
				lastSeenAt: nowIso,
				status: "resolved",
			});
		}
	}

	async function pollCliSource(source: Exclude<SourceName, "cdp">, cfg: CliSourceConfig): Promise<Incident[]> {
		const args = Array.isArray(cfg.args) ? cfg.args : [];
		if (args.length === 0) return [];
		const cwd = resolveCwd(currentCwd, cfg.cwd);
		const bin = CLI_BINS[source];
		const result = await pi.exec(bin, args, { cwd, timeout: cfg.timeoutMs ?? 30000 });
		const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
		if (!output) return [];
		return parseCliOutput(source, output, cfg);
	}

	async function scanCliSources(): Promise<{ count: number; errors: string[] }> {
		if (!activeConfig) return { count: 0, errors: [] };
		const errors: string[] = [];
		let count = 0;
		for (const source of ["vercel", "convex", "workos"] as const) {
			const cfg = activeConfig.sources?.[source];
			if (!cfg?.enabled) continue;
			try {
				const incidents = await pollCliSource(source, cfg);
				const sourceRuntime = ensureSourceRuntime(source);
				sourceRuntime.lastPollAt = new Date().toISOString();
				for (const incident of incidents) {
					if (shouldIgnoreIncident(incident, activeConfig)) continue;
					if (!addSeenEntry(source, incident.entryKey)) continue;
					await recordIncident(incident);
					count += 1;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				errors.push(`${source}: ${message}`);
				appendLogEntry({
					source,
					level: "error",
					timestamp: new Date().toISOString(),
					text: `poll failed: ${message}`,
					target: cfg.target ?? cfg.project,
				});
			}
		}
		return { count, errors };
	}

	async function fetchJson(url: string): Promise<unknown> {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`${url} -> ${response.status}`);
		return response.json();
	}

	function sendCdp(method: string, params?: Record<string, unknown>) {
		if (!cdpSocket) return;
		cdpRequestId += 1;
		cdpSocket.send(JSON.stringify({ id: cdpRequestId, method, params }));
	}

	async function selectCdpTarget(url: string, targetTitleIncludes?: string): Promise<string | undefined> {
		await fetchJson(`${url.replace(/\/$/, "")}/json/version`);
		const list = (await fetchJson(`${url.replace(/\/$/, "")}/json/list`)) as Array<Record<string, unknown>>;
		const matches = (list ?? []).filter((item) => typeof item.webSocketDebuggerUrl === "string");
		const preferred = matches.find((item) => item.type === "page" && (!targetTitleIncludes || String(item.title ?? "").includes(targetTitleIncludes)));
		const fallback = matches.find((item) => item.type === "page") ?? matches[0];
		return typeof fallback?.webSocketDebuggerUrl === "string" ? String(fallback.webSocketDebuggerUrl) : undefined;
	}

	function scheduleCdpReconnect() {
		if (!runtime.running || !activeConfig?.cdp?.enabled || cdpReconnectTimer) return;
		cdpReconnectTimer = setTimeout(() => {
			cdpReconnectTimer = null;
			void connectCdp();
		}, CDP_RECONNECT_MS);
	}

	async function handleCdpPayload(payload: Record<string, any>) {
		const method = payload.method as string | undefined;
		const params = payload.params as Record<string, any> | undefined;
		if (!method || !params) return;
		const now = new Date().toISOString();
		let message = "";
		let stack = "";
		if (method === "Runtime.exceptionThrown") {
			message = String(params.exceptionDetails?.text ?? params.exceptionDetails?.exception?.description ?? "Runtime exception");
			stack = String(params.exceptionDetails?.stackTrace?.callFrames?.[0]?.url ?? "");
		}
		if (method === "Runtime.consoleAPICalled") {
			const type = String(params.type ?? "");
			if (type !== "error" && type !== "assert") return;
			message = (params.args ?? []).map((arg: any) => String(arg?.value ?? arg?.description ?? "")).filter(Boolean).join(" ") || `console.${type}`;
			stack = String(params.stackTrace?.callFrames?.[0]?.url ?? "");
		}
		if (method === "Log.entryAdded") {
			const level = String(params.entry?.level ?? "");
			if (!["error", "warning"].includes(level)) return;
			message = String(params.entry?.text ?? "Log entry");
			stack = String(params.entry?.url ?? "");
		}
		if (!message) return;
		const target = stack || activeConfig?.cdp?.targetTitleIncludes || "browser";
		const incident: Incident = {
			source: "cdp",
			fingerprint: fingerprintForIncident("cdp", message, stack, target),
			title: message.slice(0, 180),
			evidence: normalizeEvidence([message, stack]),
			severity: severityFromText(message),
			firstSeenAt: now,
			lastSeenAt: now,
			status: "open",
			target,
			entryKey: entryKeyForIncident("cdp", message, now, stack, target),
		};
		if (shouldIgnoreIncident(incident, activeConfig)) return;
		if (!addSeenEntry("cdp", incident.entryKey)) return;
		await recordIncident(incident);
		persistRuntime();
	}

	async function connectCdp(): Promise<void> {
		if (!runtime.running || !activeConfig?.cdp?.enabled) return;
		try {
			const wsUrl = await selectCdpTarget(activeConfig.cdp.url ?? "http://127.0.0.1:9222", activeConfig.cdp.targetTitleIncludes);
			if (!wsUrl) throw new Error("No CDP target with webSocketDebuggerUrl found");
			const WsCtor = (globalThis as any).WebSocket;
			if (!WsCtor) throw new Error("WebSocket is not available in this runtime");
			cdpSocket = new WsCtor(wsUrl);
			cdpSocket.addEventListener("open", () => {
				sendCdp("Runtime.enable");
				sendCdp("Log.enable");
			});
			cdpSocket.addEventListener("message", (event: any) => {
				const payload = parseJsonSafely<Record<string, any>>(typeof event.data === "string" ? event.data : "");
				if (payload) void handleCdpPayload(payload);
			});
			cdpSocket.addEventListener("close", () => {
				cdpSocket = null;
				scheduleCdpReconnect();
			});
			cdpSocket.addEventListener("error", () => {
				if (cdpSocket) {
					try {
						cdpSocket.close();
					} catch {}
				}
			});
		} catch (error) {
			notify(lastCtx, `observability cdp: ${error instanceof Error ? error.message : String(error)}`, "warning");
			scheduleCdpReconnect();
		}
	}

	function stopCdp(): void {
		if (cdpReconnectTimer) {
			clearTimeout(cdpReconnectTimer);
			cdpReconnectTimer = null;
		}
		if (cdpSocket) {
			try {
				cdpSocket.close();
			} catch {}
			cdpSocket = null;
		}
	}

	async function scanOnce(): Promise<{ count: number; errors: string[] }> {
		if (!runtime.running || scanInFlight) return { count: 0, errors: [] };
		scanInFlight = true;
		try {
			runtime.lastScanAt = new Date().toISOString();
			const cli = await scanCliSources();
			await resolveQuietIncidents(runtime.lastScanAt);
			persistRuntime();
			setFooterStatus(lastCtx);
			refreshLogPanelSoon();
			return cli;
		} finally {
			scanInFlight = false;
		}
	}

	function stopPolling(persist = true): void {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		stopCdp();
		runtime.running = false;
		setFooterStatus(lastCtx);
		if (persist) persistRuntime();
	}

	async function startPolling(ctx: ExtensionContext | ExtensionCommandContext): Promise<{ ok: boolean; message: string }> {
		currentCwd = ctx.cwd;
		lastCtx = ctx;
		const loaded = loadConfig(ctx.cwd, runtime.configPath);
		if (!loaded.config) {
			return { ok: false, message: loaded.error ?? "Unable to load observability config" };
		}
		activeConfig = loaded.config;
		runtime.configPath = loaded.path;
		runtime.running = true;
		runtime.startedAt = runtime.startedAt ?? new Date().toISOString();
		if (pollTimer) clearInterval(pollTimer);
		const intervalMs = activeConfig.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		pollTimer = setInterval(() => {
			void scanOnce();
		}, intervalMs);
		if (activeConfig.cdp?.enabled) {
			void connectCdp();
		}
		persistRuntime();
		setFooterStatus(ctx);
		ensureActiveLogTab();
		refreshLogPanelSoon();
		void scanOnce();
		return { ok: true, message: `Observability started (${listEnabledSources(activeConfig).join(", ") || "no sources enabled"})` };
	}

	function restoreRuntimeFromBranch(ctx: ExtensionContext): void {
		currentCwd = ctx.cwd;
		lastCtx = ctx;
		runtime = { v: 1, running: false, sources: {}, autoflowStartedFingerprints: [] };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "observability-state") {
				const data = entry.data as Partial<ObservabilityRuntimeState> | undefined;
				if (!data || data.v !== 1 || !data.sources || typeof data.sources !== "object") continue;
				runtime = {
					v: 1,
					running: data.running === true,
					configPath: typeof data.configPath === "string" ? data.configPath : undefined,
					startedAt: typeof data.startedAt === "string" ? data.startedAt : undefined,
					lastScanAt: typeof data.lastScanAt === "string" ? data.lastScanAt : undefined,
					sources: Object.fromEntries(
						Object.entries(data.sources).map(([source, info]) => [
							source,
							{
								lastPollAt: typeof info?.lastPollAt === "string" ? info.lastPollAt : undefined,
								seenEntryKeys: Array.isArray(info?.seenEntryKeys) ? trimSeenEntryKeys(info.seenEntryKeys.filter((item): item is string => typeof item === "string")) : [],
							},
						]),
					),
					autoflowStartedFingerprints: Array.isArray(data.autoflowStartedFingerprints)
						? trimAutoflowFingerprints(data.autoflowStartedFingerprints.filter((item): item is string => typeof item === "string"))
						: [],
				};
			}
		}
	}

	async function handleAction(action: string, ctx: ExtensionContext | ExtensionCommandContext): Promise<{ text: string; isError?: boolean }> {
		lastCtx = ctx;
		currentCwd = ctx.cwd;
		switch (action) {
			case "start": {
				const result = await startPolling(ctx);
				notify(ctx, result.message, result.ok ? "info" : "error");
				return { text: result.message, isError: !result.ok };
			}
			case "stop":
				stopPolling(true);
				notify(ctx, "Observability stopped", "info");
				return { text: "Observability stopped" };
			case "status": {
				if (!activeConfig && runtime.configPath) {
					activeConfig = loadConfig(ctx.cwd, runtime.configPath).config;
				}
				const text = buildStatus(runtime, activeConfig);
				notify(ctx, text, "info");
				return { text };
			}
			case "scan_now": {
				if (!runtime.running) {
					const started = await startPolling(ctx);
					if (!started.ok) return { text: started.message, isError: true };
				}
				const result = await scanOnce();
				const text = `Scan complete: ${result.count} new incidents${result.errors.length ? `; errors: ${result.errors.join(" | ")}` : ""}`;
				notify(ctx, text, result.errors.length ? "warning" : "info");
				return { text, isError: result.errors.length > 0 };
			}
			case "clear_seen":
				runtime.sources = {};
				runtime.autoflowStartedFingerprints = [];
				persistRuntime();
				notify(ctx, "Observability seen-entry cache cleared", "info");
				return { text: "Observability seen-entry cache cleared" };
			default:
				return { text: `Unknown action: ${action}`, isError: true };
		}
	}

	pi.registerTool({
		name: TOOL_NAME,
		label: "Observability",
		description: "Poll platform logs and CDP, dedupe incidents, and upsert sidebar TODOs.",
		promptSnippet: "Use this tool to start, stop, or inspect the Pi-native observability monitor.",
		promptGuidelines: [
			"Use the observability tool to manage background polling for Convex, Vercel, WorkOS, and CDP.",
			"Prefer start, stop, status, scan_now, and clear_seen actions.",
		],
		parameters: ObservabilityParams,
		async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
			const result = await handleAction(args.action, ctx);
			return {
				content: [{ type: "text", text: result.text }],
				details: { action: args.action, runtime, enabledSources: activeConfig ? listEnabledSources(activeConfig) : [] },
				isError: result.isError === true,
			};
		},
	});

	pi.registerCommand("observability", {
		description: "Manage background observability polling and incident TODO upserts",
		handler: async (args, ctx) => {
			const [action = "status"] = args.trim().split(/\s+/).filter(Boolean);
			await handleAction(action, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		stopPolling(false);
		restoreRuntimeFromBranch(ctx);
		ensureActiveLogTab();
		if (ctx.hasUI && !terminalInputUnsubscribe) {
			terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
				if (handleLogShortcut(data, ctx)) return { consume: true };
				return undefined;
			});
		}
		if (runtime.running) {
			const result = await startPolling(ctx);
			if (!result.ok) notify(ctx, result.message, "warning");
		} else {
			setFooterStatus(ctx);
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		stopPolling(false);
		restoreRuntimeFromBranch(ctx);
		ensureActiveLogTab();
		if (ctx.hasUI && !terminalInputUnsubscribe) {
			terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
				if (handleLogShortcut(data, ctx)) return { consume: true };
				return undefined;
			});
		}
		if (runtime.running) {
			const result = await startPolling(ctx);
			if (!result.ok) notify(ctx, result.message, "warning");
		} else {
			setFooterStatus(ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		persistRuntime();
		stopPolling(false);
		if (terminalInputUnsubscribe) {
			terminalInputUnsubscribe();
			terminalInputUnsubscribe = null;
		}
		if (logPanelRefreshTimer) {
			clearTimeout(logPanelRefreshTimer);
			logPanelRefreshTimer = null;
		}
		if (logPanelHandle) {
			logPanelHandle.hide();
			logPanelHandle = null;
		}
		logPanel = null;
	});
}
