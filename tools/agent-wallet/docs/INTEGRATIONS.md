# Integrations

How to combine **agent-wallet** with the browser tool you actually use to drive pages — `agent-browser`, `chrome-devtools-mcp`, `@playwright/mcp`, or raw Playwright. The wallet stays the same; only the way you click around changes.

---

## TL;DR — pick a pattern

| You want…                                                   | Use this pattern         |
| ----------------------------------------------------------- | ------------------------ |
| Just a wallet, agent-wallet drives the browser too          | **A — Self-contained**   |
| You already use a browser MCP and want it to stay in charge | **B — Shared Chrome**    |
| You write Playwright/Puppeteer scripts directly             | **C — Inject the shim**  |

Pattern A and B are MCP-only. Pattern C is for code-driven automation.

---

## Pattern A — Self-contained

agent-wallet launches its own Chromium, and you call its MCP browser tools (`navigate`, `screenshot`, `list_tabs`, …) directly. Easiest path.

### Register

```bash
claude mcp add agent-wallet -s user \
  --env AGENT_WALLET_MCP=true \
  -- ~/.claude/plugins/marketplaces/my-claude-plugins/tools/agent-wallet/node_modules/.bin/tsx \
     ~/.claude/plugins/marketplaces/my-claude-plugins/tools/agent-wallet/src/launcher.ts
```

Restart Claude Code so the new tool surface loads.

### Use

```
mcp__agent-wallet__set_chain        { chainId: 137, rpcUrl: "https://polygon-rpc.com" }
mcp__agent-wallet__set_private_key  { privateKey: "0x..." }
mcp__agent-wallet__navigate         { url: "https://polymarket.com" }
mcp__agent-wallet__screenshot       { }
mcp__agent-wallet__wait_for_request { timeoutMs: 30000 }
mcp__agent-wallet__approve_request  { id: "<from above>" }
```

### Notes

- A Chromium window pops up at MCP startup. To run invisibly, also pass `-e AGENT_WALLET_HEADLESS=true`.
- CSP stripping is on by default in MCP mode — no extra config for sites with strict `connect-src`.
- `wait_for_request` resolves immediately if a request is already pending, otherwise it blocks up to `timeoutMs`.

---

## Pattern B — Shared Chrome (the multi-MCP recipe)

You run **one Chrome with `--remote-debugging-port`**, both agent-wallet and your browser MCP attach to it over CDP, and they cooperate. agent-wallet contributes the wallet + CSP-strip; the other MCP drives the page.

```
                                              ┌──────────────────────────────────┐
        ┌─────────────────────────┐    CDP    │ Chrome --remote-debugging-port=  │
        │ agent-wallet MCP        │ ◄────────►│   9222                            │
        │   (--no-browser mode)   │           │                                  │
        │   shim + CSP-strip      │           │   pages with window.ethereum     │
        └─────────────────────────┘           │   wired to agent-wallet daemon   │
                                              │                                  │
        ┌─────────────────────────┐    CDP    │                                  │
        │ Browser MCP             │ ◄────────►│                                  │
        │   (chrome-devtools-mcp, │           │                                  │
        │    playwright-mcp,      │           │                                  │
        │    agent-browser, …)    │           │                                  │
        └─────────────────────────┘           └──────────────────────────────────┘
```

### Step 1 — Register agent-wallet in `--no-browser` mode

```bash
claude mcp add agent-wallet -s user \
  --env AGENT_WALLET_MCP=true \
  --env AGENT_WALLET_NO_BROWSER=true \
  -- ~/.claude/plugins/marketplaces/my-claude-plugins/tools/agent-wallet/node_modules/.bin/tsx \
     ~/.claude/plugins/marketplaces/my-claude-plugins/tools/agent-wallet/src/launcher.ts
```

In this mode agent-wallet starts only the daemon + MCP. Browser tools (`navigate`, `screenshot`, …) error with a clear message until you call `attach_to_cdp`.

### Step 2 — Start Chrome with CDP enabled

Pick whichever of these you already have:

```bash
# macOS (real Chrome)
open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-agent

# or any chromium
chromium --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-agent

# or via Playwright (one-liner, headless)
node -e "require('playwright').chromium.launch({headless:true,args:['--remote-debugging-port=9222']}).then(b=>setInterval(()=>{},60000))" &
```

`--user-data-dir` is recommended so this Chrome doesn't fight with your normal profile.

### Step 3 — Attach agent-wallet to that Chrome

From your MCP client (Claude Code, Claude Desktop, …):

```
mcp__agent-wallet__attach_to_cdp { endpoint: "http://127.0.0.1:9222" }
```

agent-wallet now has the shim + CSP-strip installed on the attached context.

### Step 4 — Drive the page with your other tool

Now register/use one of the following. They all attach to the same Chrome via CDP and share it with agent-wallet.

#### Option B1 — `agent-browser` (CLI)

```bash
agent-browser --cdp 9222 open https://polymarket.com
agent-browser --cdp 9222 wait --load networkidle
agent-browser --cdp 9222 find text "Log In" click
agent-browser --cdp 9222 snapshot -i        # find the wallet button
agent-browser --cdp 9222 click @e3          # click "Agent Wallet" entry
agent-browser --cdp 9222 screenshot polymarket.png
```

Then in Claude Code:

```
mcp__agent-wallet__wait_for_request { timeoutMs: 30000 }
mcp__agent-wallet__approve_request  { id: "<id from above>" }
```

#### Option B2 — `chrome-devtools-mcp`

Register chrome-devtools-mcp pointing at the same browser:

```bash
claude mcp add chrome-devtools -s user -- npx -y chrome-devtools-mcp@latest \
  --browserUrl http://127.0.0.1:9222
```

Restart Claude. Then:

```
mcp__chrome-devtools__navigate_page  { url: "https://polymarket.com" }
mcp__chrome-devtools__take_snapshot
mcp__chrome-devtools__click          { uid: "<wallet button uid>" }
mcp__agent-wallet__wait_for_request  { timeoutMs: 30000 }
mcp__agent-wallet__approve_request   { id: "..." }
```

#### Option B3 — `@playwright/mcp`

```bash
claude mcp add playwright -s user -- npx -y @playwright/mcp@latest \
  --browser-url http://127.0.0.1:9222
```

```
mcp__playwright__browser_navigate    { url: "https://polymarket.com" }
mcp__playwright__browser_snapshot
mcp__playwright__browser_click       { ref: "..." }
mcp__agent-wallet__wait_for_request  { }
mcp__agent-wallet__approve_request   { id: "..." }
```

### Step 5 — Detach when done

```
mcp__agent-wallet__detach_from_cdp { }
```

This releases the CDP client; the Chrome you started in Step 2 stays running until you close it.

---

## Pattern C — Programmatic Playwright / Puppeteer / CDP

You're writing a script and want the wallet without an MCP layer. agent-wallet exports the building blocks.

### Option C1 — Use Playwright with the shim init-script

```ts
import { chromium } from 'playwright';
import { BridgeDaemon } from 'agent-wallet-bridge/src/daemon/index.js';
import { getInjectedShimCode } from 'agent-wallet-bridge/src/shim/injected.js';
import { installCspStripRoute } from 'agent-wallet-bridge/src/browser/csp.js';

const daemon = new BridgeDaemon({
  privateKey: '0x...',
  chainId: 137,
  rpcUrl: 'https://polygon-rpc.com',
  wsPort: 18548,
  mcpTransport: 'stdio',
  autoApprove: true,           // skip approval queue for fully scripted runs
  dbPath: ':memory:',
});
await daemon.start();

const browser = await chromium.launch();
const context = await browser.newContext();
await installCspStripRoute(context);
await context.addInitScript(getInjectedShimCode(daemon.config.wsPort, daemon.identity));

const page = await context.newPage();
await page.goto('https://polymarket.com');
// window.ethereum is wired to daemon's address+chain
```

### Option C2 — Connect over CDP (attach to an external Chrome)

Same as the `attach_to_cdp` MCP tool, but in your own code:

```ts
const cdpBrowser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = cdpBrowser.contexts()[0];
await installCspStripRoute(context);
await context.addInitScript(getInjectedShimCode(daemon.config.wsPort));
```

### Option C3 — Puppeteer or raw CDP

```ts
// Puppeteer
await page.evaluateOnNewDocument(getInjectedShimCode(daemon.config.wsPort));

// raw CDP
await client.send('Page.addScriptToEvaluateOnNewDocument', {
  source: getInjectedShimCode(daemon.config.wsPort),
});
```

For CSP stripping over raw CDP, use `Fetch.enable` + `Fetch.continueResponse` and remove the `content-security-policy` header. Playwright's `context.route` does this for you in C1/C2.

---

## Worked example: Polymarket end-to-end

The exact sequence the maintainers verified live (Pattern B + agent-browser):

```bash
# 1. Spawn Chrome
node -e "require('playwright').chromium.launch({headless:true,args:['--remote-debugging-port=9223']}).then(b=>setInterval(()=>{},60000))" &
sleep 1

# 2. agent-wallet attaches via Claude
#    mcp__agent-wallet__attach_to_cdp { endpoint: "http://127.0.0.1:9223" }
#    mcp__agent-wallet__set_chain      { chainId: 137, rpcUrl: "https://polygon-rpc.com" }
#    mcp__agent-wallet__set_private_key { privateKey: "0x..." }

# 3. Drive Polymarket via agent-browser (against the same Chrome)
agent-browser --cdp 9223 open https://polymarket.com
agent-browser --cdp 9223 find text "Log In" click

# Click the "Agent Wallet" icon in the login modal
agent-browser --cdp 9223 eval --stdin <<'JS'
(() => {
  const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
  const btns = dialog.querySelectorAll('button, [role="button"]');
  for (const b of btns) {
    const alt = b.querySelector('img')?.alt || '';
    if (/agent\s*wallet/i.test(alt)) { b.click(); return 'clicked'; }
  }
  return 'not-found';
})()
JS

# 4. Confirm + screenshot
agent-browser --cdp 9223 eval 'JSON.stringify({ sel: window.ethereum.selectedAddress, chain: window.ethereum.chainId })'
agent-browser --cdp 9223 screenshot polymarket-loggedin.png
```

After step 4 the Polymarket header shows `Portfolio $0.00 / Cash $0.00 / 🔔 / avatar` — the page is logged in with the wallet's address. No signature flow needed for Polymarket; for sites that DO ask for a signature, the call sequence becomes:

```
mcp__agent-wallet__wait_for_request { timeoutMs: 30000 }
mcp__agent-wallet__inspect_request  { id: "<id>" }   # see what's being signed
mcp__agent-wallet__approve_request  { id: "<id>" }
```

---

## Gotchas

### "MCP shows 'Failed to connect'"

The launcher must keep stdout clean — only the MCP protocol stream goes there. If you see this after a code change, check that no `console.log` was added; status messages should always go to stderr (current code already does this).

### "shim never connected" / `window.ethereum` missing

Run `mcp__agent-wallet__get_status`. If `shimConnected: false` after a navigation, one of these is wrong:

1. The page isn't actually using the attached browser context. With Pattern B, every browser MCP must point at the **same** `--remote-debugging-port`.
2. The page navigated before the shim was installed. `addInitScript` only applies to *future* navigations; for the current page either `navigate(...)` again or call `attach_to_cdp` *before* the first goto.
3. CSP is blocking the WS. With `AGENT_WALLET_MCP=true` the strip-CSP route is on by default; if you set `AGENT_WALLET_STRIP_CSP=false` you'll see this on sites like Polymarket / Hyperliquid.

### "Pages list is empty"

`agent-browser --cdp` and most browser MCPs need at least one open page to attach to. If you launch Chrome via `chromium.launch({args:['--remote-debugging-port=...']})` it may start with zero pages. The `attach_to_cdp` tool opens an `about:blank` for this reason; if you spawn Chrome a different way, open a tab first.

### "Wallet appears in modal but click does nothing"

The shim announces as `name: "Agent Wallet"` (default). If a dApp filters by `rdns`, set a different one via `set_identity({ rdns: "io.metamask" })` to masquerade as MetaMask — agent-wallet already sets `isMetaMask: true` on the provider object, so this works for most wagmi/Privy-based sites.

### Chrome profile collisions

Use `--user-data-dir=/tmp/chrome-agent` (or any unused dir) when spawning Chrome for agent use. Otherwise it shares state with your normal browser, which can cause locking errors.

### Detach doesn't kill Chrome

`detach_from_cdp` only closes the CDP client connection. The Chrome process you started in Pattern B stays alive — kill it yourself when done.

---

## Choosing between MCP browser tools

Ranked by friction for agent-wallet integration:

| Tool                  | Setup   | Strengths                                                  |
| --------------------- | ------- | ---------------------------------------------------------- |
| **`agent-browser`**   | trivial | CLI = scriptable; `--cdp <port>` flag; great for demos     |
| **`chrome-devtools-mcp`** | one flag | Rich DOM/network/perf tooling; `--browserUrl` to attach |
| **`@playwright/mcp`** | one flag | Playwright semantics; accessibility snapshots; `--browser-url` |
| **agent-wallet's own browser tools** | none | Zero coordination needed (Pattern A) |

For raw demo speed: agent-wallet alone (Pattern A).
For real agent workflows on production dApps: agent-wallet + one of the others (Pattern B).
For headless CI: Pattern C with Playwright directly.
