/**
 * Jev routing experiment for Pi (shadow mode only).
 *
 * off    — never calls Jev (default).
 * shadow — asks Jev which MCP server and skill a prompt needs, without changing
 *          Pi's behaviour, then logs Jev's picks next to what the agent used.
 *
 * Toggle: `pi --jev shadow`, `JEV_MODE=shadow`, or `/jev off|shadow|status`.
 * Log: <agent-dir>/jev/decisions.jsonl, or JEV_LOG_FILE (no prompt text is stored).
 *      When JEV_LOG_FILE is set, off mode still logs what the agent used (without
 *      calling Jev), so the benchmark can compare both modes from one log format.
 * Auth: OPENROUTER_API_KEY, or an `openrouter` login saved in Pi.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type Mode = "off" | "shadow";
const MODES: Mode[] = ["off", "shadow"];
const NONE = "none";
const JEV_MODEL = process.env.JEV_MODEL ?? "typesafe/jev-1.13";
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const MAX_PROMPT_CHARS = 4000;
const TIMEOUT_MS = 10_000;

interface JevResult {
	id?: string;
	model?: string;
	needsService?: number;
	service?: string;
	confidence?: number;
	probabilities?: Record<string, number>;
	skill?: string;
	skillConfidence?: number;
	skillTop?: Record<string, number>;
	cost?: number;
	latencyMs: number;
	error?: string;
}

interface Run {
	mode: Mode;
	startedAt: number;
	promptChars: number;
	jev: Promise<JevResult>;
	serversUsed: Set<string>;
	skillsUsed: Set<string>;
	skillPaths: Map<string, string>;
	toolCalls: number;
}

interface Stats {
	runs: number;
	decided: number;
	agreed: number;
	latencyMs: number;
	cost: number;
}

function parseMode(value: unknown): Mode | undefined {
	return typeof value === "string" && (MODES as string[]).includes(value) ? (value as Mode) : undefined;
}

function normalize(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Describes each MCP server from pi-mcp-adapter's metadata cache, which covers
 * every config source the adapter reads. Servers disabled in the agent-dir
 * mcp.json are skipped. Returns {} when no MCP servers are known.
 */
async function loadServerCriteria(agentDir: string): Promise<Record<string, string>> {
	const readJson = async (file: string) => {
		try {
			return JSON.parse(await readFile(join(agentDir, file), "utf8"));
		} catch {
			return {};
		}
	};
	const [config, cache] = await Promise.all([readJson("mcp.json"), readJson("mcp-cache.json")]);
	const names = new Set([...Object.keys(cache.servers ?? {}), ...Object.keys(config.mcpServers ?? {})]);
	const criteria: Record<string, string> = {};
	for (const name of names) {
		if (config.mcpServers?.[name]?.disabled === true) continue;
		const cached = cache.servers?.[name] ?? {};
		const tools = (cached.tools ?? [])
			.map((tool: any) => String(tool.name))
			.filter((tool: string) => !tool.startsWith("_"))
			.slice(0, 15);
		const instructions = typeof cached.instructions === "string" ? ` ${cached.instructions.slice(0, 300)}` : "";
		criteria[name] = `The ${name} service.${instructions} Tools include: ${tools.join(", ") || "unknown"}.`;
	}
	if (Object.keys(criteria).length === 0) return {};
	criteria[NONE] =
		"No external work service; local files, shell commands, web search, or general knowledge are enough.";
	return criteria;
}

/** Top entries of a probability map, highest first. */
function top(probabilities: Record<string, number> | undefined, count: number): Record<string, number> | undefined {
	if (!probabilities) return undefined;
	return Object.fromEntries(Object.entries(probabilities).sort(([, a], [, b]) => b - a).slice(0, count));
}

async function askJev(
	apiKey: string,
	prompt: string,
	project: string,
	serverCriteria: Record<string, string>,
	skillCriteria: Record<string, string>,
): Promise<JevResult> {
	const started = Date.now();
	const questions: Record<string, unknown> = {};
	if (Object.keys(serverCriteria).length > 1) {
		questions.needs_service = {
			type: "noul",
			instructions:
				"Does `request` need data or actions from an external work service such as monitoring, issue tracking, team chat, documentation, a data warehouse, CI, or infrastructure, rather than only local files, shell commands, web search, or general knowledge?",
		};
		questions.service = {
			type: "choice",
			instructions: "Which service best serves `request`?",
			criteria: serverCriteria,
		};
	}
	if (Object.keys(skillCriteria).length > 1) {
		questions.skill = {
			type: "choice",
			instructions: "Which specialised instruction set (skill) best serves `request`?",
			criteria: skillCriteria,
		};
	}
	if (Object.keys(questions).length === 0) {
		return { latencyMs: 0, error: "no MCP servers or skills to route between" };
	}

	try {
		const response = await fetch(DECISIONS_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
			body: JSON.stringify({
				model: JEV_MODEL,
				state: { request: prompt.slice(0, MAX_PROMPT_CHARS), project },
				questions,
			}),
		});
		const body: any = await response.json().catch(() => ({}));
		if (!response.ok) {
			return {
				latencyMs: Date.now() - started,
				error: `HTTP ${response.status}: ${body?.error?.message ?? "request failed"}`,
			};
		}
		const service = body.answers?.service;
		const skill = body.answers?.skill;
		return {
			id: body.id,
			model: body.model,
			needsService: body.answers?.needs_service?.noul,
			service: service?.choice,
			confidence: service?.confidence,
			probabilities: service?.probabilities,
			skill: skill?.choice,
			skillConfidence: skill?.confidence,
			skillTop: top(skill?.probabilities, 3),
			cost: body.usage?.cost,
			latencyMs: Date.now() - started,
		};
	} catch (error) {
		return { latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Maps an MCP proxy or direct-tool call to the server it targets. */
function serverForCall(toolName: string, args: any, servers: string[]): string | undefined {
	const byPrefix = (name: unknown) => {
		if (typeof name !== "string") return undefined;
		const normalized = normalize(name);
		return servers
			.filter((server) => normalized === normalize(server) || normalized.startsWith(`${normalize(server)}_`))
			.sort((a, b) => b.length - a.length)[0];
	};
	if (toolName === "mcp") {
		return (
			servers.find((server) => server === args?.server || server === args?.connect) ??
			byPrefix(args?.tool) ??
			byPrefix(args?.describe)
		);
	}
	return byPrefix(toolName);
}

/** Servers credited to a subagent call, by the `<role>-<server>` agent-name convention (e.g. investigate-linear). */
function serversForSubagent(args: unknown, servers: string[]): string[] {
	const text = JSON.stringify(args ?? {});
	return servers.filter((server) => new RegExp(`[a-z0-9]-${escapeRegExp(server)}\\b`, "i").test(text));
}

/** Jev's server pick when it thinks a service is needed; NONE otherwise. */
function jevPick(jev: JevResult): string | undefined {
	if (jev.error || jev.needsService === undefined) return undefined;
	return jev.needsService >= 0.5 && jev.service ? jev.service : NONE;
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const logFile = process.env.JEV_LOG_FILE ?? join(agentDir, "jev", "decisions.jsonl");
	let mode: Mode = "off";
	let serverCriteria: Record<string, string> | undefined;
	let run: Run | undefined;
	let warnedMissingKey = false;
	const stats: Stats = { runs: 0, decided: 0, agreed: 0, latencyMs: 0, cost: 0 };

	pi.registerFlag("jev", { type: "string", description: "Jev routing experiment: off or shadow" });

	const setMode = (ctx: ExtensionContext, next: Mode) => {
		mode = next;
		ctx.ui.setStatus("jev", mode === "off" ? undefined : `jev:${mode}`);
	};

	const flush = async (ctx: ExtensionContext) => {
		const finished = run;
		run = undefined;
		if (!finished) return;
		const jev = await finished.jev;
		const servers = [...finished.serversUsed];
		const skills = [...finished.skillsUsed];
		const pick = jevPick(jev);
		const agreed = pick === undefined ? undefined : pick === NONE ? servers.length === 0 : servers.includes(pick);
		const skillAgreed =
			jev.skill === undefined ? undefined : jev.skill === NONE ? skills.length === 0 : skills.includes(jev.skill);

		if (finished.mode === "shadow") {
			stats.runs += 1;
			stats.latencyMs += jev.latencyMs;
			stats.cost += jev.cost ?? 0;
			if (agreed !== undefined) {
				stats.decided += 1;
				if (agreed) stats.agreed += 1;
			}
		}

		const record = {
			ts: new Date().toISOString(),
			sessionId: ctx.sessionManager.getSessionId(),
			project: basename(ctx.cwd),
			mode: finished.mode,
			promptChars: finished.promptChars,
			jev: finished.mode === "shadow" ? { ...jev, pick: pick ?? null } : null,
			actual: { servers, skills, toolCalls: finished.toolCalls, durationMs: Date.now() - finished.startedAt },
			agreed: agreed ?? null,
			skillAgreed: skillAgreed ?? null,
		};
		try {
			await mkdir(dirname(logFile), { recursive: true });
			await appendFile(logFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		} catch (error) {
			ctx.ui.notify(`jev: could not write log: ${error instanceof Error ? error.message : error}`, "warning");
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		const requested = pi.getFlag("jev") ?? process.env.JEV_MODE;
		const parsed = parseMode(requested);
		if (requested !== undefined && parsed === undefined) {
			ctx.ui.notify(`jev: unknown mode "${requested}"; use off or shadow`, "warning");
		}
		setMode(ctx, parsed ?? "off");
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await flush(ctx);
		if (mode === "off" && !process.env.JEV_LOG_FILE) return;

		let apiKey: string | undefined;
		if (mode === "shadow") {
			apiKey = process.env.OPENROUTER_API_KEY ?? (await ctx.modelRegistry.getApiKeyForProvider("openrouter"));
			if (!apiKey) {
				if (!warnedMissingKey) ctx.ui.notify("jev: set OPENROUTER_API_KEY or log in to openrouter in Pi", "warning");
				warnedMissingKey = true;
				return;
			}
		}
		serverCriteria ??= await loadServerCriteria(agentDir);
		const skills = (event.systemPromptOptions.skills ?? []).filter((skill) => !skill.disableModelInvocation);
		const skillCriteria: Record<string, string> = Object.fromEntries(
			skills.map((skill) => [skill.name, `${skill.name}: ${skill.description.slice(0, 400)}`]),
		);
		if (skills.length > 0) skillCriteria[NONE] = "No specialised skill; general coding, shell, and tool use are enough.";

		// Not awaited: shadow mode must not delay the agent.
		run = {
			mode,
			startedAt: Date.now(),
			promptChars: event.prompt.length,
			jev: apiKey
				? askJev(apiKey, event.prompt, basename(ctx.cwd), serverCriteria, skillCriteria)
				: Promise.resolve({ latencyMs: 0 }),
			serversUsed: new Set(),
			skillsUsed: new Set(),
			skillPaths: new Map(skills.map((skill) => [skill.filePath, skill.name])),
			toolCalls: 0,
		};
	});

	pi.on("tool_execution_start", async (event) => {
		if (!run) return;
		run.toolCalls += 1;
		const servers = Object.keys(serverCriteria ?? {}).filter((server) => server !== NONE);
		const server = serverForCall(event.toolName, event.args, servers);
		if (server) run.serversUsed.add(server);
		if (event.toolName === "read" && typeof event.args?.path === "string") {
			const skill = run.skillPaths.get(event.args.path);
			if (skill) run.skillsUsed.add(skill);
		}
		if (event.toolName === "subagent") {
			for (const delegated of serversForSubagent(event.args, servers)) run.serversUsed.add(delegated);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		await flush(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await flush(ctx);
	});

	pi.registerCommand("jev", {
		description: "Jev routing experiment: /jev off|shadow|status",
		getArgumentCompletions: (prefix) =>
			[...MODES, "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const arg = args.trim();
			const next = parseMode(arg);
			if (next) {
				setMode(ctx, next);
				ctx.ui.notify(`jev: ${next}`, "info");
				return;
			}
			if (arg && arg !== "status") {
				ctx.ui.notify("jev: use /jev off, /jev shadow, or /jev status", "warning");
				return;
			}
			const agreement = stats.decided ? `${Math.round((100 * stats.agreed) / stats.decided)}%` : "n/a";
			const latency = stats.runs ? `${Math.round(stats.latencyMs / stats.runs)}ms` : "n/a";
			ctx.ui.notify(
				`jev: ${mode} | runs ${stats.runs} | server agreement ${agreement} (${stats.agreed}/${stats.decided}) | avg latency ${latency} | cost $${stats.cost.toFixed(6)} | log ${logFile}`,
				"info",
			);
		},
	});
}
