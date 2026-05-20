import { createHash } from "node:crypto";
import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

type MonitMode = "fix" | "backlog";

const MONIT_DIR = join(".pi", "monit");
const RUN_WINDOW = "run";
const LOG_WINDOW = "logs";

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function run(command: string, args: string[], cwd?: string): string {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: process.env,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function hasTmux(): boolean {
	const result = spawnSync("tmux", ["-V"], { encoding: "utf8", env: process.env });
	return !result.error && result.status === 0;
}

function hasTmuxSession(name: string): boolean {
	const result = spawnSync("tmux", ["has-session", "-t", name], {
		encoding: "utf8",
		env: process.env,
	});
	return result.status === 0;
}

function buildSessionName(cwd: string): string {
	const base = slugify(basename(cwd) || "project") || "project";
	const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 6);
	return `pi-monit-${base}-${hash}`;
}

function ensureBacklogFile(backlogFile: string) {
	if (existsSync(backlogFile)) return;
	writeFileSync(
		backlogFile,
		[
			"# Monit backlog",
			"",
			"Wpisy dodawane przez /monit i /monitb.",
			"",
			"Sugerowany format:",
			"",
			"## [open] Tytuł problemu",
			"- źródło: log / test / obserwacja",
			"- objaw: krótki opis",
			"- dowód: stack trace / snippet",
			"- obszar: podejrzany plik lub moduł",
			"- confidence: high | medium | low",
			"- następny krok: co sprawdzić dalej",
			"",
		].join("\n"),
		"utf8",
	);
}

function ensureRunbook(runbookFile: string, meta: MonitWorkspace) {
	writeFileSync(
		runbookFile,
		[
			"# Monit runbook",
			"",
			`- request: ${meta.request}`,
			`- mode: ${meta.mode}`,
			`- cwd: ${meta.cwd}`,
			`- tmux session: ${meta.sessionName}`,
			`- run target: ${meta.runTarget}`,
			`- runtime log: ${meta.runtimeLog}`,
			`- backlog: ${meta.backlogFile}`,
			`- state file: ${meta.stateFile}`,
			`- started at: ${meta.startedAt}`,
			"",
			"Ten plik jest tylko pomocą dla agenta i użytkownika.",
		].join("\n"),
		"utf8",
	);
}

function appendRuntimeHeader(runtimeLog: string, request: string, mode: MonitMode, startedAt: string) {
	appendFileSync(
		runtimeLog,
		`\n\n===== ${startedAt} :: ${mode.toUpperCase()} :: ${request} =====\n`,
		"utf8",
	);
}

function ensureTmux(meta: MonitWorkspace) {
	if (!hasTmuxSession(meta.sessionName)) {
		run("tmux", ["new-session", "-d", "-s", meta.sessionName, "-n", RUN_WINDOW, "-c", meta.cwd]);
	}

	run("tmux", ["set-option", "-t", meta.sessionName, "remain-on-exit", "on"]);
	run("tmux", ["pipe-pane", "-o", "-t", meta.runTarget, `cat >> ${shellQuote(meta.runtimeLog)}`]);

	const windows = run("tmux", ["list-windows", "-t", meta.sessionName, "-F", "#W"])
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	if (!windows.includes(LOG_WINDOW)) {
		run(
			"tmux",
			[
				"new-window",
				"-d",
				"-t",
				meta.sessionName,
				"-n",
				LOG_WINDOW,
				"-c",
				meta.cwd,
				`tail -n 200 -F ${shellQuote(meta.runtimeLog)}`,
			],
			meta.cwd,
		);
	}
}

interface MonitWorkspace {
	mode: MonitMode;
	request: string;
	cwd: string;
	sessionName: string;
	runTarget: string;
	runtimeLog: string;
	backlogFile: string;
	stateFile: string;
	runbookFile: string;
	startedAt: string;
}

function prepareWorkspace(cwd: string, request: string, mode: MonitMode): MonitWorkspace {
	const dir = join(cwd, MONIT_DIR);
	mkdirSync(dir, { recursive: true });

	const sessionName = buildSessionName(cwd);
	const workspace: MonitWorkspace = {
		mode,
		request,
		cwd,
		sessionName,
		runTarget: `${sessionName}:${RUN_WINDOW}.0`,
		runtimeLog: join(dir, "runtime.log"),
		backlogFile: join(dir, "BACKLOG.md"),
		stateFile: join(dir, "current.json"),
		runbookFile: join(dir, "RUNBOOK.md"),
		startedAt: new Date().toISOString(),
	};

	ensureBacklogFile(workspace.backlogFile);
	appendRuntimeHeader(workspace.runtimeLog, request, mode, workspace.startedAt);
	ensureRunbook(workspace.runbookFile, workspace);
	writeFileSync(workspace.stateFile, JSON.stringify(workspace, null, 2), "utf8");
	return workspace;
}

function buildPrompt(meta: MonitWorkspace): string {
	const common = [
		`Użytkownik uruchomił /${meta.mode === "fix" ? "monit" : "monitb"} z poleceniem naturalnym: ${meta.request}`,
		"",
		"Kontekst roboczy:",
		`- cwd: ${meta.cwd}`,
		`- sesja tmux: ${meta.sessionName}`,
		`- target do uruchamiania komend: ${meta.runTarget}`,
		`- log runtime: ${meta.runtimeLog}`,
		`- backlog: ${meta.backlogFile}`,
		`- runbook: ${meta.runbookFile}`,
		"",
		"Zasady pracy:",
		"1. Najpierw przeczytaj dokumentację projektu i wskazówki uruchomieniowe: AGENTS.md/CLAUDE.md, README, docs/, package.json, Makefile, docker-compose, pliki testowe i konfiguracyjne.",
		"2. Ustal, która aplikacja/komenda odpowiada żądaniu użytkownika. Jeśli repo zawiera kilka aplikacji, wybierz właściwą na podstawie dokumentacji i nazwy z polecenia naturalnego.",
		"3. Nie uruchamiaj długowiecznych procesów bezpośrednio w foreground przez bash tool. Do dev servera, watchera testów i podobnych procesów używaj wyłącznie tmux.",
		`4. Używaj sesji ${meta.sessionName}. Wysyłaj komendy do ${meta.runTarget}, np. przez tmux send-keys, i obserwuj log ${meta.runtimeLog}.`,
		"5. Zanim odpalisz nowy proces, sprawdź czy w tej sesji już coś działa. Jeśli tak, zdecyduj czy reuse, restart czy cleanup jest bezpieczniejszy.",
		"6. Monitoruj logi oraz wyniki komend walidacyjnych. Iteruj małymi krokami.",
		"7. Na końcu podaj krótkie podsumowanie: co uruchomiłeś, które błędy naprawiłeś / ztriagowałeś, co zostało otwarte.",
	];

	if (meta.mode === "fix") {
		return [
			...common,
			"",
			"Dodatkowe zasady dla /monit:",
			"8. Naprawiaj tylko błędy o wysokiej pewności. Wysoka pewność = masz konkretny sygnał z logu/testu, zawężony obszar kodu i prostą walidację po zmianie.",
			"9. Jeśli pewność jest niska, problem jest rozległy albo nie da się go szybko zweryfikować, nie rób ryzykownej zmiany. Zamiast tego dopisz wpis do BACKLOG.md z krótkim opisem, dowodem, obszarem kodu i następnym krokiem.",
			"10. Po każdej poprawce uruchom ukierunkowaną walidację. Jeśli fix nie pomaga, cofnij założenia i przejdź do kolejnej hipotezy.",
			"11. Kontynuuj, aż nie zostaną żadne oczywiste, wysokoprawdopodobne błędy związane z tym żądaniem.",
		].join("\n");
	}

	return [
		...common,
		"",
		"Dodatkowe zasady dla /monitb:",
		"8. Nie modyfikuj kodu. Twoim celem jest tylko uruchomienie środowiska, zebranie błędów i zapisanie backlogu do triage.",
		"9. Deduplikuj podobne błędy. Każdy wpis backlogu powinien mieć: tytuł, objaw, dowód, prawdopodobny obszar, confidence i następny krok.",
		"10. Jeśli nie da się uruchomić aplikacji, również dodaj backlog entry z opisem blokera i brakującymi informacjami z dokumentacji.",
	].join("\n");
}

function dispatchMonitPrompt(pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string) {
	if (ctx.isIdle()) {
		pi.sendUserMessage(prompt);
		return;
	}

	pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	if (ctx.hasUI) ctx.ui.notify("workflow monit został dodany jako follow-up", "info");
}

async function handleMonit(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string, mode: MonitMode) {
	const request = args.trim() || (mode === "fix" ? "przetestuj aplikację w tym repozytorium" : "zbierz błędy do backlogu dla tej aplikacji");

	if (!hasTmux()) {
		if (ctx.hasUI) ctx.ui.notify("tmux nie jest dostępny w PATH", "error");
		return;
	}

	let meta: MonitWorkspace;
	try {
		meta = prepareWorkspace(ctx.cwd, request, mode);
		ensureTmux(meta);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (ctx.hasUI) ctx.ui.notify(`Nie udało się przygotować monit: ${message}`, "error");
		return;
	}

	if (ctx.hasUI) {
		ctx.ui.notify(`tmux: ${meta.sessionName}`, "info");
		ctx.ui.notify(`log: ${meta.runtimeLog}`, "info");
		ctx.ui.notify(`backlog: ${meta.backlogFile}`, "info");
	}

	dispatchMonitPrompt(pi, ctx, buildPrompt(meta));
}

export default function monitExtension(pi: ExtensionAPI) {
	pi.registerCommand("monit", {
		description: "Uruchom workflow monitorowania i auto-fixów przez tmux na podstawie polecenia naturalnego",
		handler: async (args, ctx) => {
			await handleMonit(pi, ctx, args, "fix");
		},
	});

	pi.registerCommand("monitb", {
		description: "Uruchom workflow triage/backlog przez tmux na podstawie polecenia naturalnego",
		handler: async (args, ctx) => {
			await handleMonit(pi, ctx, args, "backlog");
		},
	});

	pi.registerCommand("monit-status", {
		description: "Pokaż aktualne pliki i sesję tmux przygotowane przez monit",
		handler: async (_args, ctx) => {
			const stateFile = join(ctx.cwd, MONIT_DIR, "current.json");
			if (!existsSync(stateFile)) {
				if (ctx.hasUI) ctx.ui.notify("Brak .pi/monit/current.json w tym projekcie", "warning");
				return;
			}

			try {
				const raw = readFileSync(stateFile, "utf8");
				const state = JSON.parse(raw) as MonitWorkspace;
				if (ctx.hasUI) {
					ctx.ui.notify(`sesja: ${state.sessionName}`, "info");
					ctx.ui.notify(`log: ${state.runtimeLog}`, "info");
					ctx.ui.notify(`backlog: ${state.backlogFile}`, "info");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Nie udało się odczytać statusu monit: ${message}`, "error");
			}
		},
	});
}
