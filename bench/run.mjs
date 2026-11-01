#!/usr/bin/env node
// Benchmark: the same browser tasks through Agent Bridge and through Claude in Chrome.
// Each run is a fresh headless Claude Code session (`claude -p`) that can use ONE browser tool
// and nothing else (no Bash, WebFetch, file tools). Numbers come from Claude Code's own
// stream-json output: token usage, cost, duration, tool calls and the size of tool results.
//
// Usage: node bench/run.mjs [--runs 3] [--model sonnet] [--only agent-bridge|chrome] [--task id]
// Needs: Chrome open with both extensions installed and connected, `claude` logged in.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const runs = Number(arg("runs", 1));
const model = arg("model", "sonnet");
const only = arg("only");
const onlyTask = arg("task");

const tasks = JSON.parse(readFileSync(join(here, "tasks.json"), "utf8")).filter((t) => !onlyTask || t.id === onlyTask);
const BLOCKED = ["Bash", "WebFetch", "WebSearch", "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit", "Agent", "Task", "TodoWrite"];

const targets = [
  {
    id: "agent-bridge",
    name: "Agent Bridge",
    args: (dir) => {
      const cfg = join(dir, "mcp.json");
      writeFileSync(cfg, JSON.stringify({ mcpServers: { "agent-bridge": { command: "npx", args: ["-y", "chrome-agent-bridge"] } } }));
      return ["--mcp-config", cfg, "--no-chrome", "--allowedTools", "mcp__agent-bridge"];
    },
  },
  {
    id: "chrome",
    name: "Claude in Chrome",
    args: () => ["--chrome", "--allowedTools", "mcp__claude-in-chrome"],
  },
].filter((t) => !only || t.id === only);

function runOnce(target, task) {
  const dir = mkdtempSync(join(tmpdir(), "ab-bench-"));
  const args = [
    "-p", task.prompt,
    "--output-format", "stream-json", "--verbose",
    "--model", model,
    "--strict-mcp-config",
    "--setting-sources", "local",
    "--no-session-persistence",
    "--disallowedTools", ...BLOCKED,
    ...target.args(dir),
  ];
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", () => {});
    const killer = setTimeout(() => child.kill("SIGTERM"), 6 * 60_000);
    child.on("close", () => {
      clearTimeout(killer);
      resolve(out.split("\n").filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      }));
    });
  });
}

// Per-operation tokens: Claude Code logs usage for every model request. What a tool call cost is
// how much the context grew before the next request: (next context) - (this context) - (this output).
// Several calls answered in one turn share that growth in proportion to their result size.
function measure(events, task) {
  const result = events.find((e) => e.type === "result") ?? {};
  const requests = []; // [{ ctx, output, calls: [{ id, name }] }] in order
  const byMessage = new Map();
  const results = new Map(); // tool_use_id -> { chars, images }
  for (const e of events) {
    if (e.type === "assistant" && e.message) {
      let req = byMessage.get(e.message.id);
      if (!req) {
        const u = e.message.usage ?? {};
        req = { ctx: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens ?? 0, calls: [] };
        byMessage.set(e.message.id, req);
        requests.push(req);
      }
      for (const c of e.message.content ?? []) {
        if (c.type === "tool_use") req.calls.push({ id: c.id, name: c.name.replace(/^mcp__.+?__/, "") });
      }
      req.output = Math.max(req.output, e.message.usage?.output_tokens ?? 0);
    }
    if (e.type === "user") {
      for (const c of e.message?.content ?? []) {
        if (c.type !== "tool_result") continue;
        const parts = Array.isArray(c.content) ? c.content : [{ type: "text", text: String(c.content ?? "") }];
        results.set(c.tool_use_id, {
          chars: parts.reduce((n, p) => n + (p.type === "image" ? 0 : (p.text ?? "").length), 0),
          images: parts.filter((p) => p.type === "image").length,
        });
      }
    }
  }
  const ops = [];
  requests.forEach((req, i) => {
    if (!req.calls.length) return;
    const next = requests[i + 1];
    const growth = next ? Math.max(0, next.ctx - req.ctx - req.output) : null;
    const totalChars = req.calls.reduce((n, c) => n + (results.get(c.id)?.chars ?? 0) + 1, 0);
    for (const c of req.calls) {
      const r = results.get(c.id) ?? { chars: 0, images: 0 };
      ops.push({ name: c.name, chars: r.chars, images: r.images, tokens: growth === null ? null : Math.round((growth * (r.chars + 1)) / totalChars) });
    }
  });
  const u = result.usage ?? {};
  const answer = String(result.result ?? "");
  const browserOps = ops.filter((o) => o.name !== "ToolSearch");
  return {
    ok: !result.is_error && task.expect.every((re) => new RegExp(re, "i").test(answer)),
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    costUsd: result.total_cost_usd ?? 0,
    seconds: (result.duration_ms ?? 0) / 1000,
    turns: result.num_turns ?? 0,
    requests: requests.length,
    toolCalls: ops.length,
    browserCalls: browserOps.length,
    calls: ops.map((o) => o.name),
    ops,
    toolResultChars: browserOps.reduce((n, o) => n + o.chars, 0),
    toolResultTokens: browserOps.reduce((n, o) => n + (o.tokens ?? 0), 0),
    images: browserOps.reduce((n, o) => n + o.images, 0),
    answer: answer.slice(0, 400),
  };
}

const rows = [];
for (const task of tasks) {
  for (const target of targets) {
    for (let r = 1; r <= runs; r++) {
      process.stderr.write(`▶ ${target.id} · ${task.id} · run ${r}/${runs} … `);
      const m = measure(await runOnce(target, task), task);
      process.stderr.write(`${m.ok ? "ok" : "FAIL"} · ${m.inputTokens + m.outputTokens} tok · ${m.browserCalls} browser calls (${m.toolResultTokens} tok from tools) · ${m.seconds.toFixed(1)} s\n`);
      rows.push({ target: target.id, task: task.id, run: r, ...m });
    }
  }
}

const stamp = new Date().toISOString().slice(0, 10);
mkdirSync(join(here, "results"), { recursive: true });
const file = join(here, "results", `${stamp}.json`);
writeFileSync(file, JSON.stringify({ date: stamp, model, runs, rows }, null, 2) + "\n");
console.log(`saved ${file}`);
