import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type ExaSearchSettings = {
	apiKey?: string;
	defaultNumResults?: number;
};

type ExaSearchResult = {
	title?: string | null;
	url?: string;
	publishedDate?: string;
	author?: string;
	score?: number;
	highlights?: string[];
	text?: string;
};

type ExaCitation = {
	title?: string | null;
	url?: string;
	publishedDate?: string;
	author?: string;
	text?: string;
};

const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const PROJECT_SETTINGS_PATH = join(process.cwd(), ".pi", "settings.json");
const TOOL_NAME = "exasearch";
const DEFAULT_RESULTS = 5;

function readJsonFile(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function readSettingsFile(path: string): ExaSearchSettings {
	const parsed = readJsonFile(path);
	const exaSettings = parsed.exaSearch ?? parsed.exasearch;
	if (!exaSettings || typeof exaSettings !== "object") return {};
	const typed = exaSettings as Record<string, unknown>;
	return {
		apiKey: typeof typed.apiKey === "string" ? typed.apiKey.trim() : undefined,
		defaultNumResults: typeof typed.defaultNumResults === "number" ? typed.defaultNumResults : undefined,
	};
}

function getSettings(): ExaSearchSettings {
	return {
		...readSettingsFile(GLOBAL_SETTINGS_PATH),
		...readSettingsFile(PROJECT_SETTINGS_PATH),
	};
}

function getApiKey(): string | undefined {
	const envKey = process.env.EXA_API_KEY?.trim();
	if (envKey) return envKey;
	const settingsKey = getSettings().apiKey?.trim();
	return settingsKey || undefined;
}

function normalizeStringArray(values?: string[]) {
	if (!Array.isArray(values)) return undefined;
	const normalized = values.map((value) => value.trim()).filter(Boolean);
	return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function clampResults(value?: number) {
	if (!Number.isFinite(value)) return DEFAULT_RESULTS;
	return Math.max(1, Math.min(10, Math.floor(value!)));
}

function cleanText(value: unknown, maxLength = 400) {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function formatSearchResult(result: ExaSearchResult, index: number) {
	const lines = [`${index + 1}. ${result.title || result.url || "Untitled result"}`];
	if (result.url) lines.push(`   ${result.url}`);
	const meta = [result.publishedDate, result.author].filter(Boolean).join(" • ");
	if (meta) lines.push(`   ${meta}`);
	if (typeof result.score === "number") lines.push(`   score: ${result.score.toFixed(3)}`);
	const highlight = Array.isArray(result.highlights)
		? cleanText(result.highlights.find((entry) => typeof entry === "string" && entry.trim().length > 0), 280)
		: undefined;
	const textPreview = cleanText(result.text, 280);
	if (highlight) lines.push(`   highlight: ${highlight}`);
	else if (textPreview) lines.push(`   text: ${textPreview}`);
	return lines.join("\n");
}

function formatCitation(citation: ExaCitation, index: number) {
	const lines = [`${index + 1}. ${citation.title || citation.url || "Untitled source"}`];
	if (citation.url) lines.push(`   ${citation.url}`);
	const meta = [citation.publishedDate, citation.author].filter(Boolean).join(" • ");
	if (meta) lines.push(`   ${meta}`);
	const preview = cleanText(citation.text, 220);
	if (preview) lines.push(`   text: ${preview}`);
	return lines.join("\n");
}

async function postToExa(path: string, body: Record<string, unknown>, apiKey: string, signal?: AbortSignal) {
	const response = await fetch(`https://api.exa.ai${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey,
			"user-agent": "pi-exasearch/1.0",
		},
		body: JSON.stringify(body),
		signal,
	});

	const raw = await response.text();
	let parsed: unknown = raw;
	try {
		parsed = raw ? JSON.parse(raw) : {};
	} catch {
		// Keep raw text if response is not JSON.
	}

	if (!response.ok) {
		const message =
			typeof parsed === "string"
				? parsed
				: JSON.stringify(parsed, null, 2) || `HTTP ${response.status}`;
		throw new Error(`Exa request failed (${response.status}): ${cleanText(message, 800) || "unknown error"}`);
	}

	if (!parsed || typeof parsed !== "object") {
		throw new Error("Exa returned an unexpected non-JSON response.");
	}

	return parsed as Record<string, unknown>;
}

export default function exaSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Exa Search",
		description: "Search the web with Exa and optionally return a synthesized answer with citations",
		promptSnippet: "Search the web and answer web questions with citations using Exa",
		promptGuidelines: [
			"Use this tool when the user asks for web search, external sources, or up-to-date information.",
			"Prefer this tool over generic bash or curl for web research.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "What to search for" }),
			mode: Type.Optional(
				StringEnum(["search", "answer"] as const, {
					description: "search = list ranked results, answer = synthesized answer with citations",
				}),
			),
			type: Type.Optional(
				StringEnum(["auto", "fast", "deep-lite", "deep", "deep-reasoning"] as const, {
					description: "Search type for mode=search",
				}),
			),
			numResults: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 10, description: "Maximum number of results or citations to return" }),
			),
			includeDomains: Type.Optional(
				Type.Array(Type.String({ description: "Only include results from these domains" })),
			),
			excludeDomains: Type.Optional(
				Type.Array(Type.String({ description: "Exclude results from these domains" })),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const apiKey = getApiKey();
			if (!apiKey) {
				return {
					content: [
						{
							type: "text",
							text: [
								"Exa Search is not configured.",
								"Set EXA_API_KEY or add this to ~/.pi/agent/settings.json:",
								'{\n  "exaSearch": {\n    "apiKey": "your-api-key"\n  }\n}',
							].join("\n"),
						},
					],
					details: { configured: false },
					isError: true,
				};
			}

			const settings = getSettings();
			const mode = params.mode ?? "search";
			const numResults = clampResults(params.numResults ?? settings.defaultNumResults);
			const includeDomains = normalizeStringArray(params.includeDomains);
			const excludeDomains = normalizeStringArray(params.excludeDomains);

			try {
				onUpdate?.({
					content: [{ type: "text", text: mode === "answer" ? "Generating Exa answer..." : "Searching Exa..." }],
					details: { phase: mode },
				});

				if (mode === "answer") {
					const response = await postToExa(
						"/answer",
						{
							query: params.query,
							text: true,
						},
						apiKey,
						signal,
					);

					const answer =
						typeof response.answer === "string"
							? response.answer.trim()
							: JSON.stringify(response.answer, null, 2);
					const citations = Array.isArray(response.citations)
						? (response.citations as ExaCitation[]).slice(0, numResults)
						: [];
					const normalizedCitations = citations.map((citation) => ({
						title: citation.title,
						url: citation.url,
						publishedDate: citation.publishedDate,
						author: citation.author,
						text: cleanText(citation.text, 500),
					}));
					const citationText = normalizedCitations.length > 0
						? normalizedCitations.map(formatCitation).join("\n\n")
						: "No citations returned.";

					return {
						content: [
							{
								type: "text",
								text: [`Answer:\n${answer || "(empty answer)"}`, `Sources:\n${citationText}`].join("\n\n"),
							},
						],
						details: {
							mode,
							requestId: response.requestId,
							citations: normalizedCitations,
						},
					};
				}

				const response = await postToExa(
					"/search",
					{
						query: params.query,
						type: params.type ?? "auto",
						numResults,
						includeDomains,
						excludeDomains,
						contents: {
							highlights: {
								query: params.query,
								maxCharacters: 240,
							},
							text: {
								maxCharacters: 900,
							},
						},
					},
					apiKey,
					signal,
				);

				const results = Array.isArray(response.results) ? (response.results as ExaSearchResult[]) : [];
				const normalizedResults = results.slice(0, numResults).map((result) => ({
					title: result.title,
					url: result.url,
					publishedDate: result.publishedDate,
					author: result.author,
					score: result.score,
					highlights: Array.isArray(result.highlights) ? result.highlights.slice(0, 3) : undefined,
					text: cleanText(result.text, 500),
				}));

				return {
					content: [
						{
							type: "text",
							text:
								normalizedResults.length > 0
									? `Exa results for: ${params.query}\n\n${normalizedResults.map(formatSearchResult).join("\n\n")}`
									: `No Exa results found for: ${params.query}`,
						},
					],
					details: {
						mode,
						requestId: response.requestId,
						resolvedSearchType: response.resolvedSearchType,
						searchTime: response.searchTime,
						results: normalizedResults,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Exa search failed: ${message}` }],
					details: { mode, error: message },
					isError: true,
				};
			}
		},
	});
}
