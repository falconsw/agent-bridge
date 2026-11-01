# Agent Bridge

**English** · [Türkçe](README.tr.md)

Let terminal agents (Claude Code, Cursor, Codex… anything that speaks MCP) work in **your own Chrome**: read pages, click, type, fill forms, upload files, take screenshots. They do it **with your logged-in sessions**, so YouTube Studio, Search Console, TikTok, Business Suite and the rest stay signed in.

That's the difference from Playwright / DevTools MCP, which start an empty browser with no sessions. Agent Bridge connects to the browser you already use.

## How it works

```
agent (MCP client)  ⇄ stdio ⇄  agent-bridge  ⇄ WebSocket (127.0.0.1) ⇄  Chrome extension  ⇄  pages
                                              (token-protected)          (chrome.debugger)
```

- The **extension** uses the `chrome.debugger` API, so there is no remote debugging port (9222) to open.
- The **bridge** listens on `127.0.0.1` only. The extension sends a token when it connects, and a wrong token is rejected.
- Nothing leaves your machine, screenshots included.

## Installation

> The extension is not on the Chrome Web Store yet; for now it is loaded from this repository ("unpacked").

**Requirements:** Node.js 18+, Chrome 116+ (or another Chromium browser: Edge, Brave, Arc).

### 1. Get the code

```bash
git clone https://github.com/falconsw/agent-bridge.git
cd agent-bridge
npm install
```

### 2. Load the extension into Chrome (once)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder of this repository.
4. Click the puzzle icon in the toolbar and **pin** Agent Bridge so you can see it.

> Do not move or delete the folder afterwards: Chrome loads the extension straight from it.

### 3. Add it to your agent as an MCP server

Use **absolute paths**. GUI apps (Claude Desktop, Cursor…) don't see your shell `PATH`, so give the full path to `node` too: `which node` prints it (e.g. `/opt/homebrew/bin/node`). Replace `/path/to/agent-bridge` below with where you cloned the repo (`pwd` inside it).

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add --scope user agent-bridge -- node /path/to/agent-bridge/bin/agent-bridge.mjs
```
</details>

<details>
<summary><b>Claude Desktop</b>: <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></summary>

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/agent-bridge/bin/agent-bridge.mjs"]
    }
  }
}
```
</details>

<details>
<summary><b>Cursor</b>: <code>~/.cursor/mcp.json</code></summary>

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/agent-bridge/bin/agent-bridge.mjs"]
    }
  }
}
```
</details>

<details>
<summary><b>Codex CLI</b>: <code>~/.codex/config.toml</code></summary>

```toml
[mcp_servers.agent-bridge]
command = "/opt/homebrew/bin/node"
args = ["/path/to/agent-bridge/bin/agent-bridge.mjs"]
```
</details>

<details>
<summary><b>VS Code (Copilot)</b>: <code>.vscode/mcp.json</code> or the user <code>mcp.json</code></summary>

```json
{
  "servers": {
    "agent-bridge": {
      "type": "stdio",
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/agent-bridge/bin/agent-bridge.mjs"]
    }
  }
}
```
</details>

Any other MCP client works the same way: a **stdio** server with command `node` and argument `/path/to/agent-bridge/bin/agent-bridge.mjs`. Restart the agent after adding it.

### 4. Pair (one switch)

Open the Agent Bridge popup and turn on **Agent access**. The first connection pairs automatically (trust on first use), and the pairing is saved to `~/.agent-bridge/token.json`. The status turns green ("Connected").

Then just ask your agent something like *"open search console and tell me which pages lost clicks this week"*.

To pair again (for example after reinstalling the extension), start the bridge once with `--fresh`.

### Updating

```bash
git pull && npm install
```

Then click **Reload** on Agent Bridge in `chrome://extensions` and restart your agent.

## The popup

- **Agent access:** the master switch. When it's off, the agent can't touch the browser.
- **Motion cursor:** shows a pointer and click ripple on the page wherever the agent clicks or types.
- **Recent actions:** a plain-language log ("Opened instagram.com", "Clicked ×3"), with a badge for the app it came from (Claude Code, Cursor, Codex…).
- **Advanced:** port, pairing token, and blocked URL patterns.

## Tools

| Tool | What it does |
| --- | --- |
| `navigate` | Goes to a URL (or `back`/`forward`/`reload`), **waits for the load and returns the page snapshot** |
| `read` | Page snapshot: `role "label" rN [state]` lines, tables as `row "cell | cell"`. `mode: "all"` adds the full text; narrow it with `ref`/`selector`/`viewport` |
| `find` | Searches labels and text, returns matching lines with refs and link targets (much cheaper than `read`) |
| `click` / `hover` | **Real mouse events** on `rN`, a CSS selector or a label; waits for the page to settle and returns **only what changed** |
| `type` / `fill` | Real keyboard input; `fill` completes a whole form in one call: text, `<select>`, checkbox/radio (`true`/`false`) |
| `select` | Picks a native `<select>` option |
| `key` | Keys and shortcuts: `Enter`, `Escape`, `Tab Tab Enter`, `cmd+a` |
| `scroll` | Scrolls and returns what is now visible |
| `upload` | Gives a local file to an `<input type=file>` (photos/videos for posts) |
| `wait` | Waits until text/a selector appears (or disappears with `gone`) |
| `console` / `network` | The tab's console messages and network requests |
| `screenshot` | JPEG of the visible area (up to 1280 px); expensive, only for visual questions. Saved under `~/.agent-bridge/shots` |
| `eval` | Runs JavaScript in the page (last resort) |
| `tabs` | The agent's tabs; `switchTo`, `close` |
| `done` | Closes the agent's tabs when the whole task is finished |

**Token-efficient:** `navigate` already returns the snapshot, actions report only new elements (or the new page), repeated lines are merged, and hidden/`aria-hidden` elements are skipped. Dialogs (alert/confirm) are accepted and reported, and new tabs opened by an agent tab are handed to the agent. Shadow DOM and same-origin iframes are read too.

**Several agents at once:** the first bridge process takes the port, and later sessions (Claude Code, Cursor, Codex…) join it as drivers. When the first one exits, another takes over the port.

## Security

- **Tab isolation:** the agent only works in **tabs it opened itself**. It cannot list, navigate or click your own tabs.
- **Privacy filter:** password, hidden and autofill-sensitive fields (credit cards, OTP) **never appear** in snapshots, so the model cannot see them.
- **Blocked URL patterns:** add them in popup → Advanced, comma separated (e.g. `bank.example.com/*, *.gov/*`). `navigate` refuses those addresses.
- **Idle mode:** when the agent calls `done`, or after 10 minutes without a command, all agent tabs close and the debugger detaches.
- The bridge listens on `127.0.0.1` only and pairs by token. Any local process that knows the token can drive the browser; on a single-user machine that is the boundary, as with any local dev tool.
- Because it uses `chrome.debugger`, Chrome shows a "**… started debugging this browser**" bar on agent tabs. That is intentional: it shows when it's active.
- **Prompt injection:** a malicious page's text can try to steer the agent. The popup log shows what was done; still, keep an eye on it when the agent works in important accounts.

## Development

The tests need no Chrome; they run end to end against a fake extension:

```bash
node test/fake-extension.mjs 8799 TEST-TOKEN &   # side 1
npm test                                          # side 2: two bridges + takeover test
```

Bridge options: `node bin/agent-bridge.mjs --help` (`--port`, `--token`, `--shots`, `--lang tr|en`, `--fresh`).

## Roadmap

- [ ] Chrome Web Store release
- [ ] Site allowlist (act only on listed domains)
- [ ] Confirm mode (notification + approval before side-effecting actions)
- [ ] npm package (`npx`)

## License

MIT
