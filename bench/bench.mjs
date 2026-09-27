#!/usr/bin/env node
// Benchmark Pi with and without Jev routing. See README.md.
//
//   node bench/bench.mjs run --arm off|shadow --prompts <file.jsonl> [options] [-- <extra pi args>]
//   node bench/bench.mjs report <run-dir> [<run-dir> ...]

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const ARMS = ["off", "shadow"];

const READ_ONLY_GUARD = [
	"BENCHMARK RUN. Treat every external system as read-only:",
	"never create, update, delete, post, send, comment, merge, approve, trigger, rerun, or deploy anything.",
	"If the task asks for a change, draft it in your reply instead.",
	"Do not ask clarifying questions; make reasonable assumptions and finish in this turn.",
].join(" ");

function usage(message) {
	if (message) console.error(`error: ${message}\n`);
	console.error(`usage:
  node bench/bench.mjs run --arm off|shadow --prompts <file.jsonl> [options] [-- <extra pi args>]
      --only <id,id>      run only these case ids
      --tag <tag>         run only cases with this tag
      --reps <n>          repetitions per case (default 1)
      --timeout-min <n>   per-case timeout in minutes (default 15)
      --out <dir>         output directory (default ./jev-bench-results/<timestamp>-<arm>)
  node bench/bench.mjs report <run-dir> [<run-dir> ...]`);
	process.exit(1);
}

function expandHome(path) {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function readJsonl(file) {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line, index) => {
			try {
				return JSON.parse(line);
			} catch {
				throw new Error(`${file}:${index + 1}: invalid JSON`);
			}
		});
}

function parseArgs(argv) {
	const separator = argv.indexOf("--");
	const own = separator === -1 ? argv : argv.slice(0, separator);
	const piArgs = separator === -1 ? [] : argv.slice(separator + 1);
	const options = {};
	const positional = [];
	for (let i = 0; i < own.length; i++) {
		if (own[i].startsWith("--")) {
			const value = own[i + 1];
			if (value === undefined || value.startsWith("--")) usage(`${own[i]} needs a value`);
			options[own[i].slice(2)] = value;
			i++;
		} else {
			positional.push(own[i]);
		}
	}
	return { options, positional, piArgs };
}

// ---------------------------------------------------------------- run

function runCase({ testCase, arm, sessionId, outDir, timeoutMs, piArgs }) {
	const args = [
		"--mode", "json",
		"--jev", arm,
		"--session-dir", join(outDir, "sessions"),
		"--session-id", sessionId,
		"--append-system-prompt", READ_ONLY_GUARD,
		...piArgs,
		"--", testCase.prompt,
	];
	const env = { ...process.env, JEV_LOG_FILE: join(outDir, "decisions.jsonl") };
	delete env.JEV_MODE; // the --jev flag decides; subagents stay in observe-only off mode

	return new Promise((resolvePromise) => {
		const started = Date.now();
		const child = spawn(process.env.PI_BIN ?? "pi", args, {
			cwd: expandHome(testCase.cwd ?? "~"),
			env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const result = {
			turns: 0,
			toolCalls: 0,
			mcpDiscoveryCalls: 0,
			subagentCalls: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			finalText: "",
			error: undefined,
		};
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		let stderr = "";

		const handle = (event) => {
			if (event.type === "turn_end") result.turns += 1;
			if (event.type === "tool_execution_start") {
				result.toolCalls += 1;
				if (event.toolName === "subagent") result.subagentCalls += 1;
				if (event.toolName === "mcp" && !event.args?.tool) result.mcpDiscoveryCalls += 1;
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const usage = event.message.usage ?? {};
				result.usage.input += usage.input ?? 0;
				result.usage.output += usage.output ?? 0;
				result.usage.cacheRead += usage.cacheRead ?? 0;
				result.usage.cacheWrite += usage.cacheWrite ?? 0;
				result.usage.cost += usage.cost?.total ?? 0;
				const text = (event.message.content ?? [])
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				if (text) result.finalText = text.slice(0, 4000);
				if (event.message.stopReason === "error") result.error = event.message.errorMessage ?? "assistant error";
			}
		};

		child.stdout.on("data", (chunk) => {
			buffer += decoder.write(chunk);
			let newline;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				try {
					handle(JSON.parse(line));
				} catch {
					// Not a protocol record; ignore.
				}
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr = (stderr + chunk.toString()).slice(-4000);
		});

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {}
		}, timeoutMs);

		let settled = false;
		const finish = (exitCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (exitCode !== 0 && !result.error) result.error = stderr.trim().split("\n").slice(-3).join(" | ") || `exit ${exitCode}`;
			resolvePromise({ ...result, exitCode, timedOut, wallMs: Date.now() - started });
		};
		child.on("error", (error) => {
			result.error = `could not start pi: ${error.message}`;
			finish(null);
		});
		child.on("close", finish);
	});
}

async function run({ options, piArgs }) {
	const arm = options.arm;
	if (!ARMS.includes(arm)) usage(`--arm must be one of ${ARMS.join(", ")}`);
	if (!options.prompts) usage("--prompts is required");
	const promptsFile = resolve(options.prompts);
	let cases = readJsonl(promptsFile);
	if (options.only) {
		const ids = new Set(options.only.split(","));
		cases = cases.filter((testCase) => ids.has(testCase.id));
	}
	if (options.tag) cases = cases.filter((testCase) => testCase.tags?.includes(options.tag));
	if (cases.length === 0) usage("no cases selected");

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = resolve(options.out ?? join("jev-bench-results", `${stamp}-${arm}`));
	mkdirSync(join(outDir, "sessions"), { recursive: true });
	copyFileSync(promptsFile, join(outDir, "prompts.jsonl"));
	writeFileSync(
		join(outDir, "meta.json"),
		`${JSON.stringify({ arm, prompts: promptsFile, startedAt: new Date().toISOString(), piArgs }, null, 2)}\n`,
	);

	const reps = Number(options.reps ?? 1);
	const timeoutMs = Number(options["timeout-min"] ?? 15) * 60_000;
	const total = cases.length * reps;
	let index = 0;
	for (const testCase of cases) {
		for (let rep = 1; rep <= reps; rep++) {
			index += 1;
			const sessionId = `jb-${arm}-${testCase.id}-r${rep}-${stamp}`.replace(/[^A-Za-z0-9._-]/g, "-");
			process.stderr.write(`[${index}/${total}] ${arm} ${testCase.id} r${rep} ... `);
			const result = await runCase({ testCase, arm, sessionId, outDir, timeoutMs, piArgs });
			appendFileSync(
				join(outDir, "results.jsonl"),
				`${JSON.stringify({ id: testCase.id, rep, arm, sessionId, ...result })}\n`,
			);
			const status = result.timedOut ? "timeout" : result.error ? `error: ${result.error.slice(0, 80)}` : "ok";
			process.stderr.write(`${status} (${Math.round(result.wallMs / 1000)}s, $${result.usage.cost.toFixed(4)})\n`);
		}
	}
	console.log(outDir);
}

// ---------------------------------------------------------------- report

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined);
const share = (flags) => mean(flags.map((flag) => (flag ? 1 : 0)));

function scoreCase(testCase, result, decision) {
	const expected = testCase.expect ?? {};
	const required = expected.servers ?? [];
	const allowed = new Set([...required, ...(expected.optional ?? [])]);
	const expectedSkills = expected.skills ?? [];
	const allowedSkills = new Set([...expectedSkills, ...(expected.optionalSkills ?? [])]);
	const used = decision?.actual?.servers ?? [];
	const skillsUsed = decision?.actual?.skills ?? [];
	const jev = decision?.jev;

	const score = {
		serverRecall: required.length ? required.filter((server) => used.includes(server)).length / required.length : undefined,
		extraServers: used.filter((server) => !allowed.has(server)).length,
		negativeClean:
			required.length === 0 && allowed.size === 0 && allowedSkills.size === 0
				? used.length === 0 && skillsUsed.length === 0
				: undefined,
		skillHit: expectedSkills.length ? expectedSkills.every((skill) => skillsUsed.includes(skill)) : undefined,
	};
	if (jev && !jev.error) {
		if (jev.needsService !== undefined) {
			score.jevNeedsCorrect = jev.needsService >= 0.5 === required.length > 0;
			score.jevServerTop1 = required.length ? allowed.has(jev.service) : jev.pick === "none";
			if (required.length && jev.probabilities) {
				const ranked = Object.entries(jev.probabilities)
					.sort(([, a], [, b]) => b - a)
					.slice(0, required.length)
					.map(([name]) => name);
				score.jevServerTopK = required.filter((server) => ranked.includes(server)).length / required.length;
			}
		}
		if (jev.skill !== undefined) {
			score.jevSkillCorrect = expectedSkills.length
				? allowedSkills.has(jev.skill)
				: jev.skill === "none" || allowedSkills.has(jev.skill);
		}
	}
	return score;
}

function loadRun(dir) {
	const cases = new Map(readJsonl(join(dir, "prompts.jsonl")).map((testCase) => [testCase.id, testCase]));
	const decisions = new Map();
	for (const record of readJsonl(join(dir, "decisions.jsonl"))) {
		// The first record for a session is the benchmark prompt itself.
		if (!decisions.has(record.sessionId)) decisions.set(record.sessionId, record);
	}
	const meta = existsSync(join(dir, "meta.json")) ? JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) : {};
	const rows = readJsonl(join(dir, "results.jsonl")).map((result) => {
		const testCase = cases.get(result.id) ?? { id: result.id };
		const decision = decisions.get(result.sessionId);
		return { testCase, result, decision, score: scoreCase(testCase, result, decision) };
	});
	return { dir, meta, rows };
}

function summarize({ rows }) {
	const pick = (key) => rows.map((row) => row.score[key]).filter((value) => value !== undefined);
	const results = rows.map((row) => row.result);
	const jevRows = rows.filter((row) => row.decision?.jev && !row.decision.jev.error);
	return {
		"cases run": rows.length,
		"errors / timeouts": `${results.filter((r) => r.error && !r.timedOut).length} / ${results.filter((r) => r.timedOut).length}`,
		"missing usage records": rows.filter((row) => !row.decision).length,
		"agent: server recall": mean(pick("serverRecall")),
		"agent: extra servers per case": mean(pick("extraServers")),
		"agent: skill hit rate": share(pick("skillHit")),
		"agent: negative controls clean": share(pick("negativeClean")),
		"tool calls per case": mean(results.map((r) => r.toolCalls)),
		"MCP discovery calls per case": mean(results.map((r) => r.mcpDiscoveryCalls)),
		"turns per case": mean(results.map((r) => r.turns)),
		"input tokens per case": mean(results.map((r) => r.usage.input + r.usage.cacheRead)),
		"output tokens per case": mean(results.map((r) => r.usage.output)),
		"parent cost per case ($)": mean(results.map((r) => r.usage.cost)),
		"wall time per case (s)": mean(results.map((r) => r.wallMs / 1000)),
		"jev: needs-service accuracy": share(pick("jevNeedsCorrect")),
		"jev: server top-1 accuracy": share(pick("jevServerTop1")),
		"jev: server top-k coverage": mean(pick("jevServerTopK")),
		"jev: skill accuracy": share(pick("jevSkillCorrect")),
		"jev: latency (ms)": mean(jevRows.map((row) => row.decision.jev.latencyMs)),
		"jev: total cost ($)": jevRows.length ? jevRows.reduce((sum, row) => sum + (row.decision.jev.cost ?? 0), 0) : undefined,
	};
}

function format(value) {
	if (value === undefined) return "–";
	if (typeof value !== "number") return String(value);
	if (Number.isInteger(value)) return String(value);
	if (Math.abs(value) < 0.01) return value.toFixed(6);
	return Math.abs(value) < 1 ? value.toFixed(3) : value.toFixed(1);
}

function report({ positional }) {
	if (positional.length === 0) usage("report needs at least one run directory");
	const runs = positional.map((dir) => loadRun(resolve(dir)));
	const summaries = runs.map(summarize);
	const header = runs.map((r, i) => `${r.meta.arm ?? "?"} (${i + 1})`);

	console.log("## Summary\n");
	runs.forEach((r, i) => console.log(`${i + 1}. ${r.dir}`));
	console.log(`\n| metric | ${header.join(" | ")} |`);
	console.log(`|---|${header.map(() => "---").join("|")}|`);
	for (const metric of Object.keys(summaries[0])) {
		console.log(`| ${metric} | ${summaries.map((s) => format(s[metric])).join(" | ")} |`);
	}

	for (const r of runs) {
		console.log(`\n## Cases: ${r.meta.arm ?? "?"} — ${r.dir}\n`);
		console.log("| case | expected servers | agent servers | jev server (conf) | expected skills | agent skills | jev skill (conf) | tools | cost $ | wall s |");
		console.log("|---|---|---|---|---|---|---|---|---|---|");
		for (const { testCase, result, decision } of r.rows) {
			const jev = decision?.jev;
			const list = (values) => (values?.length ? values.join(", ") : "none");
			const jevServer = jev?.error ? "error" : jev?.pick ? `${jev.pick} (${format(jev.confidence)})` : "–";
			const jevSkill = jev?.error ? "error" : jev?.skill ? `${jev.skill} (${format(jev.skillConfidence)})` : "–";
			console.log(
				`| ${testCase.id} r${result.rep} | ${list(testCase.expect?.servers)} | ${decision ? list(decision.actual.servers) : "?"} | ${jevServer} | ${list(testCase.expect?.skills)} | ${decision ? list(decision.actual.skills) : "?"} | ${jevSkill} | ${result.toolCalls} | ${result.usage.cost.toFixed(4)} | ${Math.round(result.wallMs / 1000)}${result.timedOut ? " (timeout)" : result.error ? " (error)" : ""} |`,
			);
		}
	}
}

// ---------------------------------------------------------------- main

const [command, ...rest] = process.argv.slice(2);
const parsed = parseArgs(rest);
if (command === "run") await run(parsed);
else if (command === "report") report(parsed);
else usage();
