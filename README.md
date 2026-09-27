# jev-plugin

A [Pi](https://pi.dev) package that tests whether [Jev](https://openrouter.ai/typesafe), TypeSafe's decision model, can predict which MCP server and skill a prompt needs. It includes a benchmark that compares Pi with and without it.

**Shadow mode only:** Jev observes and logs. It never changes Pi's tools, prompts, or behaviour.

## Requirements

- Pi (tested with 0.87.1) and Node.js 22.19 or later.
- OpenRouter access: log in to the `openrouter` provider in Pi, or set `OPENROUTER_API_KEY`.
- For MCP routing: [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter). Server names and descriptions come from its metadata cache (`<agent-dir>/mcp-cache.json`), so use each MCP server at least once before relying on the routing.

## Install

```bash
pi install git:github.com/ccrawford4/jev-plugin
```

To try it for one run without installing:

```bash
pi -e git:github.com/ccrawford4/jev-plugin --jev shadow
```

## Use

| Goal | Command |
|---|---|
| Off (default) | `pi` |
| Shadow for one run | `pi --jev shadow` |
| Shadow by default, including subagents | `export JEV_MODE=shadow` |
| Switch within a session | `/jev shadow`, `/jev off` |
| Session summary | `/jev status` |

`/jev` lasts only for the current session. `/new`, `/resume`, `/fork` and `/reload` reset the mode to the `--jev` flag or `JEV_MODE`.

In shadow mode, each prompt makes one background Jev call; the agent doesn't wait for it. Jev answers three questions:

1. Does the prompt need an external service?
2. Which MCP server fits best? The choices come from your MCP servers.
3. Which skill fits best? The choices come from the skills Pi advertises.

When the agent finishes the prompt, one line is appended to `~/.pi/agent/jev/decisions.jsonl` (set `JEV_LOG_FILE` to change the path). It records:

- **Jev's picks:** its choices, probabilities, latency and cost.
- **What the agent used:** MCP servers, including direct MCP tools and subagents named `<role>-<server>` such as `investigate-linear`; skills whose `SKILL.md` it read; and its tool-call count.
- **Agreement** between the two.

### Privacy

Jev receives up to 4,000 characters of each prompt plus the project folder name. The log stores prompt length, not prompt text. Don't use shadow mode for prompts you can't send to OpenRouter.

`JEV_MODEL` overrides the model; the default is `typesafe/jev-1.13`.

## Benchmark

`bench/bench.mjs` runs a labelled prompt set through `pi --mode json` and reports how accurately the agent and Jev chose servers and skills. It also reports efficiency: tool calls, MCP discovery calls, turns, tokens, cost and wall time.

### 1. Write a prompt set

Start from `bench/prompts.example.jsonl` and change the expected names to match your MCP servers and skills. Each line is one case:

```json
{"id":"multi-issue-chat","tags":["multi"],"cwd":"~/code/app","prompt":"...","expect":{"servers":["linear","slack"],"optional":[],"skills":[],"optionalSkills":["linear-ticket-pr"]}}
```

| Field | Meaning |
|---|---|
| `expect.servers` | Servers the task requires |
| `expect.optional` | Servers that are acceptable but not required |
| `expect.skills` | Skills the task requires |
| `expect.optionalSkills` | Skills that are acceptable but not required |
| `cwd` | Directory to run in (default `~`) |
| `tags` | Labels for `--tag` filtering |

A case with no required or optional servers or skills is a **negative control**: the agent should use none.

Include:

- Single-server cases.
- Multi-server cases.
- Skill cases.
- Negative controls, including adversarial ones that mention a service by name but don't need it.

Keep company-specific prompt sets out of this public repository.

### 2. Run both arms

```bash
node bench/bench.mjs run --arm off    --prompts my-prompts.jsonl --reps 3
node bench/bench.mjs run --arm shadow --prompts my-prompts.jsonl --reps 3
```

| Option | Meaning |
|---|---|
| `--only a,b` | Run only these case IDs |
| `--tag multi` | Run only cases with this tag |
| `--reps n` | Repetitions per case |
| `--timeout-min n` | Per-case timeout in minutes (default 15) |
| `--out dir` | Output directory |

Arguments after `--` are passed to Pi. For example, `-- --model sonnet --thinking low`.

Each run writes the following to `./jev-bench-results/<timestamp>-<arm>/`:

- `results.jsonl`: one line per case with events, usage and final text.
- `decisions.jsonl`: what the agent used, plus Jev's picks in the shadow arm.
- The Pi sessions.
- A copy of the prompt set, so later edits don't change old reports.

### 3. Compare

```bash
node bench/bench.mjs report jev-bench-results/<off-run> jev-bench-results/<shadow-run>
```

The report prints a side-by-side summary table and a per-case table. The metrics are:

- **Agent:** server recall, extra servers per case, skill hit rate, and how often negative controls stayed clean.
- **Efficiency:** tool calls, MCP discovery calls, turns, tokens, parent-session cost, and wall time.
- **Jev (shadow arm only):**
  - Accuracy on whether a service is needed.
  - Top-1 server accuracy.
  - Top-k server coverage: whether all required servers are among Jev's *k* most probable, where *k* is the number required.
  - Skill accuracy, latency and cost.

### How to read the results

- **The two arms show the same agent behaviour**, because shadow mode doesn't change it. Compare the arms to measure overhead and run-to-run noise. Use the shadow arm to see whether Jev's picks beat the agent's unaided choices; that tells you whether an active routing mode is worth building.
- **Runs are noisy.** Use `--reps 3` or more before drawing conclusions.
- **Cost and tokens cover the parent session only.** Subagent usage isn't included.
- **The read-only guard is only an instruction** appended to the system prompt. For safety, also add `deny` rules for write tools in your permission extension, or run against test accounts.
- **Benchmark runs use real MCP servers,** so they cost model tokens and can reach real data.

## Development

```bash
pi -e ./ --jev shadow       # run Pi with the local checkout
node --check bench/bench.mjs
```

If the extension is also installed, don't load a local copy at the same time: both register the `--jev` flag and `/jev` command.
