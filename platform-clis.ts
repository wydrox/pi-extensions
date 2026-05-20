import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { resolve } from "node:path";

const CLI_PARAMS = Type.Object({
	args: Type.Array(Type.String({ description: "One CLI argument" }), {
		description: "Arguments without the executable name, e.g. ['deploy', '--prod']",
	}),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory. Relative paths are resolved from the current project root",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({
			description: "Execution timeout in milliseconds",
			minimum: 1000,
			maximum: 600000,
		}),
	),
});

type CliInput = Static<typeof CLI_PARAMS>;

type CliSpec = {
	toolName: string;
	label: string;
	bin: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
};

const CLI_SPECS: CliSpec[] = [
	{
		toolName: "vercel",
		label: "Vercel CLI",
		bin: "vercel",
		description: "Run the Vercel CLI",
		promptSnippet: "Run the Vercel CLI for deploys, env vars, projects, domains, logs, and aliases.",
		promptGuidelines: [
			"Use this tool instead of generic bash when the task is specifically about Vercel.",
			"Pass arguments as an array without the executable name, for example ['deploy', '--prod'].",
		],
	},
	{
		toolName: "convex",
		label: "Convex CLI",
		bin: "convex",
		description: "Run the Convex CLI",
		promptSnippet: "Run the Convex CLI for dev, deploy, codegen, data, and component workflows.",
		promptGuidelines: [
			"Use this tool instead of generic bash when the task is specifically about Convex.",
			"Use cwd for repo-local Convex projects so commands run in the correct workspace.",
		],
	},
	{
		toolName: "workos",
		label: "WorkOS CLI",
		bin: "workos",
		description: "Run the WorkOS CLI",
		promptSnippet: "Run the WorkOS CLI for AuthKit, org, setup, and WorkOS developer workflows.",
		promptGuidelines: [
			"Use this tool instead of generic bash when the task is specifically about WorkOS.",
			"Prefer this tool for WorkOS setup and auth flows before falling back to bash.",
		],
	},
	{
		toolName: "gcloud",
		label: "Google Cloud CLI",
		bin: "gcloud",
		description: "Run the Google Cloud CLI",
		promptSnippet: "Run the Google Cloud CLI for projects, auth, services, Cloud Run, GKE, IAM, and config.",
		promptGuidelines: [
			"Use this tool instead of generic bash when the task is specifically about Google Cloud or GCP.",
			"Pass complete gcloud subcommands as arguments, for example ['run', 'deploy', 'api'].",
		],
	},
	{
		toolName: "supabase",
		label: "Supabase CLI",
		bin: "supabase",
		description: "Run the Supabase CLI",
		promptSnippet: "Run the Supabase CLI for local dev, linking projects, migrations, types, functions, and db workflows.",
		promptGuidelines: [
			"Use this tool instead of generic bash when the task is specifically about Supabase.",
			"Use cwd for repo-local Supabase projects so commands run against the intended config.",
		],
	},
	{
		toolName: "wrangler",
		label: "Cloudflare Wrangler CLI",
		bin: "wrangler",
		description: "Run the Cloudflare Wrangler CLI",
		promptSnippet: "Run the Cloudflare Wrangler CLI for Workers, Pages, KV, D1, R2, Queues, routes, and secrets.",
		promptGuidelines: [
			"Use this tool instead of generic bash when the task is specifically about Cloudflare Workers, Pages, or Wrangler workflows.",
			"Use cwd for repo-local Wrangler projects so commands run with the intended wrangler.toml or config.",
		],
	},
	{
		toolName: "terraform",
		label: "Terraform CLI",
		bin: "terraform",
		description: "Run the Terraform CLI",
		promptSnippet: "Run the Terraform CLI for init, plan, apply, import, state, and infrastructure-as-code workflows.",
		promptGuidelines: [
			"Use this tool instead of generic bash when the task is specifically about Terraform or infrastructure-as-code workflows.",
			"Use cwd for repo-local Terraform projects so commands run in the correct workspace and module directory.",
		],
	},
	{
		toolName: "shadcn",
		label: "shadcn CLI",
		bin: "shadcn",
		description: "Run the shadcn CLI",
		promptSnippet: "Run the shadcn CLI to initialize shadcn/ui, inspect components, and add UI components to app projects.",
		promptGuidelines: [
			"Use this tool instead of generic bash when the task is specifically about shadcn/ui setup or component generation.",
			"Use cwd for repo-local app projects so shadcn runs against the intended package.json and config files.",
		],
	},
	{
		toolName: "prisma",
		label: "Prisma CLI",
		bin: "prisma",
		description: "Run the Prisma CLI",
		promptSnippet: "Run the Prisma CLI for schema validation, migrations, generate, studio, introspection, and database workflows.",
		promptGuidelines: [
			"Use this tool instead of generic bash when the task is specifically about Prisma ORM, schema, migrations, or studio workflows.",
			"Use cwd for repo-local Prisma projects so commands run against the intended schema.prisma and package.json.",
		],
	},
	{
		toolName: "gh",
		label: "GitHub CLI",
		bin: "gh",
		description: "Run the GitHub CLI",
		promptSnippet: "Run the GitHub CLI for issues, PRs, repos, releases, workflows, and auth.",
		promptGuidelines: [
			"Use this tool instead of generic bash when the task is specifically about GitHub CLI workflows.",
			"Prefer structured gh commands over raw git or curl when interacting with GitHub.",
		],
	},
];

function resolveToolCwd(baseCwd: string, input?: string): string {
	if (!input?.trim()) return baseCwd;
	return resolve(baseCwd, input.trim().replace(/^@/, ""));
}

function quoteArg(arg: string): string {
	return /^[a-zA-Z0-9_./:@%+=,-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function formatCommand(bin: string, args: string[]): string {
	return `$ ${[bin, ...args].map(quoteArg).join(" ")}`;
}

function truncate(text: string, maxChars = 12000): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n...[truncated ${text.length - maxChars} chars]`;
}

async function runCli(pi: ExtensionAPI, spec: CliSpec, params: CliInput, signal: AbortSignal | undefined, cwdBase: string) {
	const args = Array.isArray(params.args) ? params.args : [];
	const cwd = resolveToolCwd(cwdBase, params.cwd);
	const commandPreview = formatCommand(spec.bin, args);

	try {
		const result = await pi.exec(spec.bin, args, {
			cwd,
			signal,
			timeout: params.timeoutMs ?? 120000,
		});

		const stdout = (result.stdout ?? "").trim();
		const stderr = (result.stderr ?? "").trim();
		const sections = [commandPreview, `cwd: ${cwd}`];

		if (stdout) sections.push(stdout);
		if (stderr) sections.push(`[stderr]\n${stderr}`);
		if (!stdout && !stderr) sections.push("(no output)");

		return {
			content: [{ type: "text", text: truncate(sections.join("\n\n")) }],
			details: {
				bin: spec.bin,
				args,
				cwd,
				exitCode: result.code,
				killed: result.killed,
				stdout,
				stderr,
			},
			isError: result.code !== 0 || result.killed,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const missingBinary = /ENOENT|not found/i.test(message);
		const suffix = missingBinary ? `\n\n${spec.bin} is not installed or not on PATH.` : "";

		return {
			content: [{ type: "text", text: `${commandPreview}\n\ncwd: ${cwd}\n\n${message}${suffix}` }],
			details: {
				bin: spec.bin,
				args,
				cwd,
				error: message,
			},
			isError: true,
		};
	}
}

async function getCliStatus(pi: ExtensionAPI) {
	const lines: string[] = [];

	for (const spec of CLI_SPECS) {
		try {
			const result = await pi.exec(spec.bin, ["--version"], { timeout: 15000 });
			const versionLine = (result.stdout || result.stderr || "available").trim().split(/\r?\n/)[0] || "available";
			lines.push(`${spec.toolName}: ${versionLine}`);
		} catch {
			lines.push(`${spec.toolName}: missing`);
		}
	}

	return lines;
}

export default function platformClisExtension(pi: ExtensionAPI) {
	for (const spec of CLI_SPECS) {
		pi.registerTool({
			name: spec.toolName,
			label: spec.label,
			description: spec.description,
			promptSnippet: spec.promptSnippet,
			promptGuidelines: spec.promptGuidelines,
			parameters: CLI_PARAMS,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				return runCli(pi, spec, params, signal, ctx.cwd);
			},
		});
	}

	pi.registerCommand("platform-cli-status", {
		description: "Check availability of platform CLI extension tools",
		handler: async (_args, ctx) => {
			const lines = await getCliStatus(pi);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
