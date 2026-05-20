import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Spell = {
	spellSync(word: string): boolean;
	suggestSync(word: string): string[];
	addSync(word: string): void;
};

type Correction = {
	from: string;
	to: string;
};

const DISABLE_MARKERS = ["nocheck", "spellcheck:off", "spellcheck off", "pi-spellcheck:off"];
const MAX_CORRECTIONS_PER_MESSAGE = 12;
const MAX_WORDS_PER_MESSAGE = 240;

const COMMON_TYPOS = new Map<string, string>([
	["teh", "the"],
	["taht", "that"],
	["adn", "and"],
	["helo", "hello"],
	["thier", "their"],
	["recieve", "receive"],
	["seperate", "separate"],
	["occured", "occurred"],
	["wierd", "weird"],
	["corect", "correct"],
	["mesage", "message"],
	["plese", "please"],
	["begining", "beginning"],
	["definately", "definitely"],
	["accomodate", "accommodate"],
	["wiadomosc", "wiadomość"],
	["wiadomosci", "wiadomości"],
	["bledem", "błędem"],
	["literowke", "literówkę"],
	["sprawdz", "sprawdź"],
	["musze", "muszę"],
	["robie", "robię"],
	["dziekuje", "dziękuję"],
	["prosze", "proszę"],
]);

const BUILTIN_ALLOW = new Set(
	[
		"api",
		"apis",
		"args",
		"async",
		"autocorrect",
		"backend",
		"bash",
		"boolean",
		"build",
		"builtin",
		"cache",
		"camelcase",
		"cli",
		"codebase",
		"config",
		"cwd",
		"dev",
		"diff",
		"docs",
		"eslint",
		"frontend",
		"github",
		"heuristic",
		"heuristics",
		"hotkey",
		"inline",
		"json",
		"lint",
		"llm",
		"markdown",
		"monorepo",
		"nocheck",
		"npm",
		"openai",
		"pi",
		"plugin",
		"plugins",
		"repo",
		"repos",
		"rpc",
		"runtime",
		"sdk",
		"spellcheck",
		"spellchecker",
		"stdin",
		"stdout",
		"stderr",
		"symspell",
		"tsx",
		"typescript",
		"ui",
		"url",
		"urls",
		"uuid",
		"yaml",
	].map((word) => word.toLowerCase()),
);

let spellPromise: Promise<Spell[]> | undefined;
let allowCache: { key: string; words: Set<string> } | undefined;
const suggestionCache = new Map<string, string | undefined>();

function loadAllowWords(cwd: string): Set<string> {
	const files = [
		path.join(os.homedir(), ".pi", "spellcheck-allow"),
		path.join(os.homedir(), ".pi", "agent", "spellcheck-allow"),
		path.join(cwd, ".pi", "spellcheck-allow"),
	];
	const key = files
		.map((file) => {
			try {
				const stat = fs.statSync(file);
				return `${file}:${stat.mtimeMs}`;
			} catch {
				return `${file}:missing`;
			}
		})
		.join("|");

	if (allowCache?.key === key) return allowCache.words;

	const words = new Set(BUILTIN_ALLOW);
	for (const file of files) {
		try {
			const text = fs.readFileSync(file, "utf8");
			for (const line of text.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				words.add(trimmed.toLowerCase());
			}
		} catch {
			// Optional allow files are intentionally ignored when absent/unreadable.
		}
	}

	allowCache = { key, words };
	return words;
}

async function getSpellers(): Promise<Spell[]> {
	// The native nodehun module is optional and may not load in the agent's TS/ESM
	// runtime. Keep the extension non-blocking for subagents; common typo fixes
	// still run without dictionary-backed suggestions.
	spellPromise ??= Promise.resolve([]);
	return spellPromise;
}

function hasDisableMarker(text: string): boolean {
	const lower = text.toLowerCase();
	return DISABLE_MARKERS.some((marker) => lower.includes(marker));
}

function protectSpans(text: string): boolean[] {
	const protectedChars = Array.from({ length: text.length }, () => false);
	const mark = (start: number, end: number) => {
		for (let i = start; i < end; i++) protectedChars[i] = true;
	};

	for (const pattern of [/```[\s\S]*?```/g, /~~~[\s\S]*?~~~/g, /`[^`\n]+`/g, /https?:\/\/\S+/gi, /\b\S+@\S+\.\S+\b/g]) {
		for (const match of text.matchAll(pattern)) {
			if (match.index !== undefined) mark(match.index, match.index + match[0].length);
		}
	}

	// If the user submits an unfinished fence, treat the rest as code too.
	for (const fence of ["```", "~~~"]) {
		const pattern = new RegExp(`^${fence}`, "gm");
		const matches = [...text.matchAll(pattern)];
		if (matches.length % 2 === 1) {
			const last = matches[matches.length - 1];
			if (last?.index !== undefined) mark(last.index, text.length);
		}
	}

	let offset = 0;
	for (const line of text.split(/(\r?\n)/)) {
		const isNewline = /^\r?\n$/.test(line);
		if (!isNewline) {
			const trimmed = line.trimStart();
			const leading = line.length - trimmed.length;
			if (/^(?:[$#>]\s|(?:npm|pnpm|yarn|bun|git|gh|curl|node|python|pip|cd|ls|cat|grep|rg|fd|sed|awk|docker|kubectl)\b)/.test(trimmed)) {
				mark(offset + leading, offset + line.length);
			}
		}
		offset += line.length;
	}

	return protectedChars;
}

function isProtected(protectedChars: boolean[], start: number, end: number): boolean {
	for (let i = start; i < end; i++) if (protectedChars[i]) return true;
	return false;
}

function isProbablyPathOrIdentifier(word: string, fullText: string, start: number, end: number): boolean {
	const before = fullText[start - 1] ?? "";
	const after = fullText[end] ?? "";
	const charBeforeBefore = fullText[start - 2] ?? "";
	const charAfterAfter = fullText[end + 1] ?? "";
	const dotLooksLikeFilename =
		(before === "." && /[\p{L}\d]/u.test(charBeforeBefore)) ||
		(after === "." && /[\p{L}\d]/u.test(charAfterAfter));
	return (
		/[\\/@._~-]/.test(word) ||
		/[\\/_~-]/.test(before) ||
		/[\\/_~-]/.test(after) ||
		dotLooksLikeFilename ||
		/\d/.test(word) ||
		/_/.test(word) ||
		/[a-z][A-Z]/.test(word) ||
		/^[A-Z0-9]{2,}$/.test(word) ||
		/^--?[a-z]/i.test(word)
	);
}

function matchCase(original: string, suggestion: string): string {
	if (original.toLocaleUpperCase() === original) return suggestion.toLocaleUpperCase();
	const first = original[0];
	if (first && first.toLocaleUpperCase() === first && original.slice(1).toLocaleLowerCase() === original.slice(1)) {
		return suggestion.charAt(0).toLocaleUpperCase() + suggestion.slice(1);
	}
	return suggestion;
}

function stripPolishDiacritics(value: string): string {
	return value
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/ł/g, "l")
		.replace(/Ł/g, "L");
}

function levenshtein(a: string, b: string): number {
	const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	const current = Array.from({ length: b.length + 1 }, () => 0);
	for (let i = 1; i <= a.length; i++) {
		current[0] = i;
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(
				previous[j] + 1,
				current[j - 1] + 1,
				previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		for (let j = 0; j <= b.length; j++) previous[j] = current[j];
	}
	return previous[b.length];
}

function chooseSuggestion(word: string, suggestions: string[]): string | undefined {
	const lower = word.toLocaleLowerCase();
	const unique = [...new Set(suggestions.map((s) => s.toLocaleLowerCase()))].filter((s) => s && s !== lower);

	// Very high confidence for Polish messages typed without diacritics: same base letters, richer accents.
	const stripped = stripPolishDiacritics(lower);
	const diacriticOnly = unique.find((suggestion) => stripPolishDiacritics(suggestion) === stripped);
	if (diacriticOnly) return diacriticOnly;

	// Pick the suggestion with the lowest edit distance, not just the first one that passes.
	// Stricter threshold for shorter words where a single-char change matters more.
	let bestSuggestion: string | undefined;
	let bestDistance = Infinity;

	for (const suggestion of unique) {
		const distance = levenshtein(lower, suggestion);
		const maxDistance = word.length <= 4 ? 1 : 2;
		if (distance > 0 && distance <= maxDistance && Math.abs(suggestion.length - lower.length) <= maxDistance) {
			if (distance < bestDistance) {
				bestDistance = distance;
				bestSuggestion = suggestion;
			}
		}
	}
	return bestSuggestion;
}

async function correctInput(text: string, cwd: string): Promise<{ text: string; corrections: Correction[] }> {
	if (hasDisableMarker(text)) return { text, corrections: [] };
	const trimmed = text.trimStart();
	if (trimmed.startsWith("/") || trimmed.startsWith("!")) return { text, corrections: [] };

	const allow = loadAllowWords(cwd);
	const protectedChars = protectSpans(text);
	const spellers = await getSpellers();
	const corrections: Correction[] = [];
	let wordCount = 0;

	const corrected = text.replace(/[\p{L}][\p{L}'’-]*/gu, (word, offset) => {
		const start = Number(offset);
		const end = start + word.length;
		wordCount++;
		if (wordCount > MAX_WORDS_PER_MESSAGE) return word;
		if (corrections.length >= MAX_CORRECTIONS_PER_MESSAGE) return word;
		if (isProtected(protectedChars, start, end)) return word;
		if (isProbablyPathOrIdentifier(word, text, start, end)) return word;

		const normalized = word.toLocaleLowerCase().replace(/[’]/g, "'");
		const typoOverride = COMMON_TYPOS.get(normalized);
		if (typoOverride) {
			const replacement = matchCase(word, typoOverride);
			corrections.push({ from: word, to: replacement });
			return replacement;
		}

		if (word.length < 4) return word;
		if (allow.has(normalized)) return word;
		if (spellers.some((spell) => spell.spellSync(normalized))) return word;

		const cacheKey = normalized;
		let suggestion = suggestionCache.get(cacheKey);
		if (!suggestionCache.has(cacheKey)) {
			suggestion = chooseSuggestion(
				normalized,
				spellers.flatMap((spell) => (spell.suggestSync(normalized) ?? []).slice(0, 5)),
			);
			suggestionCache.set(cacheKey, suggestion);
		}
		if (!suggestion) return word;

		const replacement = matchCase(word, suggestion);
		if (replacement === word) return word;
		corrections.push({ from: word, to: replacement });
		return replacement;
	});

	return { text: corrected, corrections };
}

function formatCorrections(corrections: Correction[]): string {
	const shown = corrections.slice(0, 6).map(({ from, to }) => `${from} → ${to}`);
	const suffix = corrections.length > shown.length ? `, +${corrections.length - shown.length} more` : "";
	return `spellcheck: ${shown.join(", ")}${suffix}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		const result = await correctInput(event.text, ctx.cwd);
		if (result.corrections.length === 0 || result.text === event.text) return { action: "continue" };
		ctx.ui.notify(formatCorrections(result.corrections), "info");
		return { action: "transform", text: result.text, images: event.images };
	});
}

export const __test = { correctInput, formatCorrections };
