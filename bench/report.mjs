#!/usr/bin/env node
// Turns the newest bench/results/*.json into bench/RESULTS.md (medians per task and tool).
// Usage: node bench/report.mjs [results.json]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? join(here, "results", readdirSync(join(here, "results")).filter((f) => f.endsWith(".json")).sort().at(-1));
const { date, model, runs, rows } = JSON.parse(readFileSync(file, "utf8"));
const tasks = JSON.parse(readFileSync(join(here, "tasks.json"), "utf8"));
const cliVersion = (() => {
  try {
    return execSync("claude --version", { encoding: "utf8" }).split(" ")[0];
  } catch {
    return "?";
  }
})();
const NAMES = { "agent-bridge": "Agent Bridge", chrome: "Claude in Chrome" };

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const pick = (target, task) => rows.filter((r) => r.target === target && (!task || r.task === task));
const stats = (list) => ({
  ok: list.filter((r) => r.ok).length,
  n: list.length,
  tokens: median(list.map((r) => r.inputTokens + r.outputTokens)),
  output: median(list.map((r) => r.outputTokens)),
  calls: median(list.map((r) => r.browserCalls)),
  chars: median(list.map((r) => r.toolResultChars)),
  toolTokens: median(list.map((r) => r.toolResultTokens)),
  seconds: median(list.map((r) => r.seconds)),
  cost: median(list.map((r) => r.costUsd)),
});
const sum = (target, key) => tasks.reduce((acc, t) => acc + stats(pick(target, t.id))[key], 0);

const targets = Object.keys(NAMES).filter((t) => pick(t).length);
const line = (cells) => `| ${cells.join(" | ")} |`;
const out = [];
out.push(`# Benchmark: Agent Bridge vs Claude in Chrome`, "");
out.push(`Date: ${date} · Claude Code ${cliVersion} · model: \`${model}\` · ${runs} run(s) per task and tool · values are **medians**.`, "");
out.push(`Each run is a fresh headless Claude Code session (\`claude -p\`) that may use only one browser tool; Bash, WebFetch and file tools are blocked. Numbers are read from Claude Code's own \`stream-json\` output. Reproduce with \`node bench/run.mjs --runs ${runs} --model ${model}\`, then \`node bench/report.mjs\`.`, "");

out.push(`## Total (all ${tasks.length} tasks)`, "");
out.push(line(["", ...targets.map((t) => NAMES[t])]), line(["---", ...targets.map(() => "---:")]));
out.push(line(["Tokens (input + output)", ...targets.map((t) => k(sum(t, "tokens")))]));
out.push(line(["Browser tool calls", ...targets.map((t) => String(sum(t, "calls")))]));
out.push(line(["Tokens returned by browser tools", ...targets.map((t) => k(sum(t, "toolTokens")))]));
out.push(line(["Time (s)", ...targets.map((t) => sum(t, "seconds").toFixed(1))]));
out.push(line(["Cost (USD)", ...targets.map((t) => `$${sum(t, "cost").toFixed(3)}`)]));
out.push(line(["Correct answers", ...targets.map((t) => `${stats(pick(t)).ok}/${stats(pick(t)).n}`)]), "");

for (const task of tasks) {
  out.push(`## ${task.title}`, "", `> ${task.prompt}`, "");
  out.push(line(["", "Tokens", "Output tokens", "Browser calls", "Tokens from tools", "Time (s)", "Cost", "Correct"]));
  out.push(line(["---", "---:", "---:", "---:", "---:", "---:", "---:", "---:"]));
  for (const t of targets) {
    const s = stats(pick(t, task.id));
    out.push(line([NAMES[t], k(s.tokens), k(s.output), String(s.calls), k(s.toolTokens), s.seconds.toFixed(1), `$${s.cost.toFixed(3)}`, `${s.ok}/${s.n}`]));
  }
  out.push("", "Operations and the tokens each one added (median run):", "");
  for (const t of targets) {
    const list = pick(t, task.id).filter((r) => r.ops);
    const mid = [...list].sort((a, b) => a.toolResultTokens - b.toolResultTokens)[Math.floor((list.length - 1) / 2)];
    if (!mid) continue;
    const seq = mid.ops.filter((o) => o.name !== "ToolSearch").map((o) => `${o.name} (${o.tokens === null ? "?" : k(o.tokens)}${o.images ? ", image" : ""})`).join(" → ");
    out.push(`- **${NAMES[t]}**: ${seq}`);
  }
  out.push("");
}

// Per-operation table: median tokens one call of each kind added to the context.
out.push(`## Tokens per operation`, "", "Median tokens one call adds to the model's context, over all tasks and runs (calls in brackets).", "");
out.push(line(["Tool", "Operation", "Tokens per call", "Calls"]), line(["---", "---", "---:", "---:"]));
for (const t of targets) {
  const byOp = new Map();
  for (const r of pick(t)) for (const o of r.ops ?? []) if (o.tokens !== null) byOp.set(o.name, [...(byOp.get(o.name) ?? []), o.tokens]);
  for (const [name, list] of [...byOp].sort((a, b) => b[1].length - a[1].length)) out.push(line([NAMES[t], `\`${name}\``, k(median(list)), String(list.length)]));
}
out.push("");

out.push(`## Notes`, "");
out.push(`- "Tokens" counts everything the model read and wrote in the session, cached or not: system prompt, tool definitions, tool results and the answer. Most of it is cache reads, which are billed at a fraction of the normal price; "Cost" is Claude Code's own \`total_cost_usd\`.`);
out.push(`- "Tokens from tools" / "per operation" is measured from Claude Code's per-request usage: how much the context grew after a tool call, before the next request. It is the part the browser tool itself controls. \`ToolSearch\` (loading tool schemas) is listed separately in the per-operation table.`);
out.push(`- "Correct" checks the final answer for the expected values (see \`bench/tasks.json\`).`);
out.push(`- Fairness: the tasks and this harness were written by the Agent Bridge author, and one task reads this project's own GitHub page. Both tools get the identical prompt, model and settings, and the full per-run data is in \`bench/results/\`; add your own tasks to \`bench/tasks.json\` and rerun.`);
out.push(`- Live websites change, so absolute numbers move between days; compare the tools within the same run.`);
writeFileSync(join(here, "RESULTS.md"), out.join("\n") + "\n");
console.log(out.slice(0, 14).join("\n"));
