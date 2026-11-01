# Benchmark: Agent Bridge vs Claude in Chrome

Date: 2026-11-01 · Claude Code 2.1.314 · model: `sonnet` · 3 run(s) per task and tool · values are **medians**.

Each run is a fresh headless Claude Code session (`claude -p`) that may use only one browser tool; Bash, WebFetch and file tools are blocked. Numbers are read from Claude Code's own `stream-json` output. Reproduce with `node bench/run.mjs --runs 3 --model sonnet`, then `node bench/report.mjs`.

## Total (all 3 tasks)

|  | Agent Bridge | Claude in Chrome |
| --- | ---: | ---: |
| Tokens (input + output) | 146.5k | 343.2k |
| Browser tool calls | 6 | 22 |
| Tokens returned by browser tools | 5.1k | 11.3k |
| Time (s) | 39.9 | 78.2 |
| Cost (USD) | $0.124 | $0.259 |
| Correct answers | 9/9 | 9/9 |

## Read a list (Hacker News top 3)

> Use the browser. Go to https://news.ycombinator.com and tell me the titles and points of the top 3 stories. Answer briefly.

|  | Tokens | Output tokens | Browser calls | Tokens from tools | Time (s) | Cost | Correct |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Agent Bridge | 33.4k | 292 | 1 | 727 | 8.2 | $0.032 | 3/3 |
| Claude in Chrome | 57.0k | 465 | 3 | 2.5k | 14.3 | $0.066 | 3/3 |

Operations and the tokens each one added (median run):

- **Agent Bridge**: navigate (727)
- **Claude in Chrome**: navigate (340) → get_page_text (2.1k) → tabs_close_mcp (73)

## Fill and submit a form (httpbin)

> Use the browser. Open https://httpbin.org/forms/post and fill it in: customer name "Ada Lovelace", telephone "5551234", e-mail "ada@example.com", pizza size Medium, toppings Bacon and Extra Cheese, preferred delivery time 19:30, delivery instructions "Ring twice". Submit the order, then report the custname and size values the server echoes back. Answer briefly.

|  | Tokens | Output tokens | Browser calls | Tokens from tools | Time (s) | Cost | Correct |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Agent Bridge | 62.9k | 603 | 3 | 1.3k | 18.5 | $0.046 | 3/3 |
| Claude in Chrome | 173.6k | 1.8k | 14 | 4.1k | 37.0 | $0.112 | 3/3 |

Operations and the tokens each one added (median run):

- **Agent Bridge**: navigate (245) → fill (277) → click (769)
- **Claude in Chrome**: navigate (345) → read_page (363) → form_input (250) → form_input (243) → form_input (255) → form_input (191) → form_input (234) → form_input (234) → form_input (231) → form_input (253) → javascript_tool (280) → computer (270) → get_page_text (867) → tabs_close_mcp (74)

## Find facts on a page (GitHub repo)

> Use the browser. Open https://github.com/falconsw/agent-bridge and tell me which license the repository uses and the version of its latest release. Answer briefly.

|  | Tokens | Output tokens | Browser calls | Tokens from tools | Time (s) | Cost | Correct |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Agent Bridge | 50.1k | 371 | 2 | 3.1k | 13.3 | $0.045 | 3/3 |
| Claude in Chrome | 112.6k | 601 | 5 | 4.7k | 26.9 | $0.081 | 3/3 |

Operations and the tokens each one added (median run):

- **Agent Bridge**: navigate (2.5k) → navigate (600)
- **Claude in Chrome**: navigate (365) → get_page_text (3.0k) → navigate (322) → get_page_text (886) → tabs_close_mcp (74)

## Tokens per operation

Median tokens one call adds to the model's context, over all tasks and runs (calls in brackets).

| Tool | Operation | Tokens per call | Calls |
| --- | --- | ---: | ---: |
| Agent Bridge | `navigate` | 720 | 12 |
| Agent Bridge | `ToolSearch` | 698 | 9 |
| Agent Bridge | `fill` | 277 | 3 |
| Agent Bridge | `click` | 769 | 3 |
| Claude in Chrome | `form_input` | 239 | 24 |
| Claude in Chrome | `navigate` | 342 | 12 |
| Claude in Chrome | `get_page_text` | 1.5k | 12 |
| Claude in Chrome | `ToolSearch` | 1.4k | 9 |
| Claude in Chrome | `tabs_close_mcp` | 74 | 6 |
| Claude in Chrome | `computer` | 274 | 4 |
| Claude in Chrome | `read_page` | 363 | 3 |
| Claude in Chrome | `tabs_context_mcp` | 202 | 2 |
| Claude in Chrome | `javascript_tool` | 264 | 2 |

## Notes

- "Tokens" counts everything the model read and wrote in the session, cached or not: system prompt, tool definitions, tool results and the answer. Most of it is cache reads, which are billed at a fraction of the normal price; "Cost" is Claude Code's own `total_cost_usd`.
- "Tokens from tools" / "per operation" is measured from Claude Code's per-request usage: how much the context grew after a tool call, before the next request. It is the part the browser tool itself controls. `ToolSearch` (loading tool schemas) is listed separately in the per-operation table.
- "Correct" checks the final answer for the expected values (see `bench/tasks.json`).
- Fairness: the tasks and this harness were written by the Agent Bridge author, and one task reads this project's own GitHub page. Both tools get the identical prompt, model and settings, and the full per-run data is in `bench/results/`; add your own tasks to `bench/tasks.json` and rerun.
- Live websites change, so absolute numbers move between days; compare the tools within the same run.
