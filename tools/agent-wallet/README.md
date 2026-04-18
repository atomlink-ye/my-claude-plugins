# agent-wallet — MCP usage

Agent Wallet Bridge runs a local EIP-1193 wallet daemon and exposes its approval queue plus wallet/chain controls over **MCP (stdio)**.

It supports two production patterns:

1. **Self-contained** — agent-wallet launches Chromium and its own browser MCP tools drive it.
2. **External browser companion** — you launch Chrome separately with CDP enabled, start agent-wallet in `--no-browser` mode, then call `attach_to_cdp` so agent-wallet installs the shim + CSP stripping into that browser context.

```
┌──────────────┐  stdio   ┌───────────────────┐  ws://127.0.0.1:18545  ┌──────────┐
│ MCP client   │ ───────► │ agent-wallet      │ ─────────────────────► │ Browser  │
│ (Claude)     │ ◄─tools─ │ daemon + MCP      │ ◄────── EIP-1193 ───── │ + dApp   │
└──────────────┘          └───────────────────┘                        └──────────┘
```

## Quickstart (no build step)

```bash
cd tools/agent-wallet
pnpm install
AGENT_WALLET_MCP=true pnpm tsx src/launcher.ts
```

Optional URL:

```bash
AGENT_WALLET_MCP=true pnpm tsx src/launcher.ts https://polymarket.com
```

If no URL is passed, the browser opens `about:blank` and you can navigate later via MCP.

## Register the MCP server

### Claude Code

```bash
claude mcp add agent-wallet \
  --env AGENT_WALLET_MCP=true \
  -- pnpm --dir /absolute/path/to/tools/agent-wallet tsx src/launcher.ts
```

### Claude Desktop / generic stdio config

```json
{
  "mcpServers": {
    "agent-wallet": {
      "command": "pnpm",
      "args": [
        "--dir",
        "/absolute/path/to/tools/agent-wallet",
        "tsx",
        "src/launcher.ts"
      ],
      "env": { "AGENT_WALLET_MCP": "true" }
    }
  }
}
```

## Optional env

| Variable                       | Default                        | Purpose |
| ------------------------------ | ------------------------------ | ------- |
| `AGENT_WALLET_MCP`             | `false`                        | Expose MCP on stdio |
| `AGENT_WALLET_PRIVATE_KEY`     | unset                          | Pre-load a key |
| `AGENT_WALLET_CHAIN_ID`        | `42161`                        | Initial chain |
| `AGENT_WALLET_RPC_URL`         | `https://arb1.arbitrum.io/rpc` | Initial upstream RPC |
| `AGENT_WALLET_WS_PORT`         | `18545`                        | Loopback WS port used by the shim |
| `AGENT_WALLET_AUTO_APPROVE`    | `false`                        | Auto-approve every signing request |
| `AGENT_WALLET_HEADLESS`        | `false`                        | Run Chromium headless |
| `AGENT_WALLET_NO_BROWSER`      | `false`                        | Skip Playwright entirely; browser tools stay disabled until `attach_to_cdp` |
| `AGENT_WALLET_STRIP_CSP`       | auto                           | Force CSP stripping on/off (`false` disables it) |
| `AGENT_WALLET_IDENTITY_NAME`   | `Agent Wallet`                 | EIP-6963 provider name |
| `AGENT_WALLET_IDENTITY_ICON`   | built-in icon                  | EIP-6963 provider icon URL/data URL |
| `AGENT_WALLET_IDENTITY_RDNS`   | `local.agent-wallet.bridge`    | EIP-6963 reverse-DNS id |

## MCP tools

### Wallet & chain control

| Tool                   | Args                      | Effect |
| ---------------------- | ------------------------- | ------ |
| `get_status`           | —                         | `{ address, chainId, chainIdHex, rpcUrl, shimConnected, connectedOrigins }` |
| `set_private_key`      | `privateKey`              | Loads the key and broadcasts `accountsChanged` |
| `generate_private_key` | —                         | Creates a random key and returns `{ address, privateKey }` |
| `clear_private_key`    | —                         | Removes the key and broadcasts empty `accountsChanged` |
| `set_chain`            | `chainId`, `rpcUrl?`      | Switches chain and optionally RPC URL |
| `set_identity`         | `name?`, `icon?`, `rdns?` | Updates EIP-6963 identity and re-announces the provider |
| `list_accounts`        | —                         | `{ accounts: [address] }` or `[]` |
| `get_chain_id`         | —                         | `{ chainId }` |

### Approval queue

| Tool                   | Args            | Returns |
| ---------------------- | --------------- | ------- |
| `get_pending_requests` | —               | `{ requests: [{ id, method, params, timestamp, summary }] }` |
| `wait_for_request`     | `timeoutMs?`    | The next pending request entry, or a timeout error |
| `inspect_request`      | `id`            | Full params plus typed `details` |
| `approve_request`      | `id`            | `{ id, status, result }` |
| `reject_request`       | `id`, `reason?` | `{ id, status, reason }` |

### Browser control

| Tool              | Args                        | Effect |
| ----------------- | --------------------------- | ------ |
| `attach_to_cdp`   | `endpoint`, `contextIndex?` | Attach to an existing Chrome/Chromium over CDP and install shim + CSP stripping |
| `detach_from_cdp` | —                           | Release the CDP attachment and restore the launcher-owned context if any |
| `navigate`        | `url`, `newTab?`            | Navigate the active tab or open a new one |
| `list_tabs`       | —                           | List open tabs |
| `switch_tab`      | `index`                     | Make a tab active |
| `close_tab`       | `index`                     | Close a tab |
| `screenshot`      | `fullPage?`                 | Capture a PNG screenshot |

When the launcher is started in `--no-browser` mode, browser tools return a clear error until you call `attach_to_cdp`.

## Integration recipes

> 📖 **Deep-dive guide:** [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) has copy-paste-ready recipes for **agent-browser**, **chrome-devtools-mcp**, **@playwright/mcp**, raw Playwright/Puppeteer/CDP, plus a worked end-to-end Polymarket login and a troubleshooting checklist.

The two patterns at a glance:

### Pattern A — Self-contained

Register agent-wallet normally and use its own browser tools:

```bash
claude mcp add agent-wallet \
  --env AGENT_WALLET_MCP=true \
  -- pnpm --dir /absolute/path/to/tools/agent-wallet tsx src/launcher.ts
```

Typical flow:

1. `navigate({ url: "https://polymarket.com" })`
2. `set_chain({ chainId: 137, rpcUrl: "https://polygon-rpc.com" })`
3. `set_private_key({ privateKey: "0x..." })`
4. Click connect with agent-wallet's own browser tools
5. `wait_for_request()`
6. `approve_request({ id })`

### Pattern B — With external browser MCP

Use this when Chrome is managed elsewhere (`chrome-devtools-mcp`, Playwright-MCP, `agent-browser`, raw CDP, etc.).

Start Chrome yourself:

```bash
google-chrome --remote-debugging-port=9222
```

Start agent-wallet in daemon-only mode:

```bash
cd tools/agent-wallet
AGENT_WALLET_MCP=true AGENT_WALLET_NO_BROWSER=true pnpm tsx src/launcher.ts --no-browser
```

Then call:

1. `attach_to_cdp({ endpoint: "http://127.0.0.1:9222" })`
2. Navigate with either agent-wallet `navigate(...)` or your other browser MCP
3. `set_chain({ chainId: 137, rpcUrl: "https://polygon-rpc.com" })`
4. `set_private_key({ privateKey: "0x..." })`
5. Click the site's connect UI via your other browser MCP
6. `wait_for_request({ timeoutMs: 30000 })`
7. `approve_request({ id })`

Exact Polymarket call sequence:

1. `attach_to_cdp({ endpoint: "http://127.0.0.1:9222" })`
2. `navigate({ url: "https://polymarket.com" })` *(or navigate via the other browser MCP)*
3. `set_chain({ chainId: 137, rpcUrl: "https://polygon-rpc.com" })`
4. `set_private_key({ privateKey: "0x..." })`
5. Click **Connect** via `chrome-devtools-mcp`, `agent-browser`, or Playwright-MCP
6. `wait_for_request()`
7. `approve_request({ id })`

### Fetch shim code and inject it yourself

Programmatic injection:

```ts
import { getInjectedShimCode } from './src/shim/injected.js';

const shimCode = getInjectedShimCode(18545, {
  name: 'My Agent Wallet',
  rdns: 'dev.example.wallet',
});
```

#### Playwright

```ts
await context.addInitScript(getInjectedShimCode(18545));
```

#### Puppeteer

```ts
await page.evaluateOnNewDocument(getInjectedShimCode(18545));
```

#### Chrome DevTools Protocol

```ts
await client.send('Page.addScriptToEvaluateOnNewDocument', {
  source: getInjectedShimCode(18545),
});
```

If you want a daemon-only script that prints the full shim code payload, use:

```bash
pnpm tsx scripts/start-daemon.ts
```

It writes JSON including `shimCode` to stdout.

## Why CSP stripping is on by default

Some dApps block `ws://127.0.0.1:*` in `connect-src`, which prevents the injected shim from reaching the local daemon. In MCP mode this package strips both `content-security-policy` and `content-security-policy-report-only` response headers by default so agent-driven sessions work out of the box.

- Programmatic override: `launch({ mcp: true, config: { stripCSP: false } })`
- CLI/env override: `AGENT_WALLET_STRIP_CSP=false`
- Force it on outside MCP mode: `launch({ config: { stripCSP: true } })`

This is intentionally default-on for agent mode because the agent is the user; there is no separate end-user page session to protect from XSS.

## Typical agent loop

1. Start the launcher on `about:blank` (or an optional URL).
2. Call `navigate` or `attach_to_cdp`.
3. Call `set_private_key` or `generate_private_key`.
4. Call `set_chain` for the site's network if needed.
5. Use `wait_for_request` or `get_pending_requests` to watch the approval queue.
6. Inspect and `approve_request` or `reject_request`.

## Notes & limits

- One wallet at a time. Calling `set_private_key` replaces the previous account.
- The daemon binds `127.0.0.1:<wsPort>` only.
- Read-only RPC traffic is proxied without prompting; signing/sending requests hit the approval queue.
- Activity log is in-memory by default.
- CDP attach installs the shim on future pages via `addInitScript` and also best-effort injects already-open pages.
- Detach closes the CDP client connection, not the underlying Chrome process.
