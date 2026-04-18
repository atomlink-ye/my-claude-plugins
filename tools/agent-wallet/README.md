# agent-wallet — MCP usage

Agent Wallet Bridge runs a local EIP-1193 wallet daemon and exposes its approval queue plus wallet/chain controls over **MCP (stdio)**. A Playwright-controlled browser is launched with the wallet shim injected; the MCP client (Claude Code, Claude Desktop, etc.) drives wallet setup, chain selection, and transaction approvals at runtime.

```
┌──────────────┐  stdio   ┌───────────────────┐  ws://127.0.0.1:18545  ┌──────────┐
│ MCP client   │ ───────► │ agent-wallet      │ ─────────────────────► │ Browser  │
│ (Claude)     │ ◄─tools─ │ daemon + MCP      │ ◄────── EIP-1193 ───── │ + dApp   │
└──────────────┘          └───────────────────┘                        └──────────┘
```

## Build

```bash
cd tools/agent-wallet
pnpm install
pnpm build        # outputs dist/launcher.js
```

## Register the MCP server (no env required)

The CLI starts the MCP server on stdio when `AGENT_WALLET_MCP=true`. Passing a URL is optional; if omitted, the browser opens `about:blank` and the agent can navigate anywhere later via MCP. **No private key needed at startup** — set or generate one at runtime via MCP tools. Chain defaults to Arbitrum One (`42161`) and can be switched at any time.

### Claude Code

```bash
claude mcp add agent-wallet \
  --env AGENT_WALLET_MCP=true \
  -- node /absolute/path/to/tools/agent-wallet/dist/launcher.js
```

### Claude Desktop / generic stdio config

```json
{
  "mcpServers": {
    "agent-wallet": {
      "command": "node",
      "args": [
        "/absolute/path/to/tools/agent-wallet/dist/launcher.js"
      ],
      "env": { "AGENT_WALLET_MCP": "true" }
    }
  }
}
```

For development without building, swap `node dist/launcher.js` for `pnpm --silent dev` (uses `tsx`).

### Optional env (all overridable later via MCP)

| Variable                     | Default                          | Purpose                                  |
| ---------------------------- | -------------------------------- | ---------------------------------------- |
| `AGENT_WALLET_MCP`           | `false`                          | Set to `true` to expose MCP on stdio     |
| `AGENT_WALLET_PRIVATE_KEY`   | unset                            | Pre-load a key (otherwise set via MCP)   |
| `AGENT_WALLET_CHAIN_ID`      | `42161`                          | Initial chain (overridable via MCP)      |
| `AGENT_WALLET_RPC_URL`       | `https://arb1.arbitrum.io/rpc`   | Initial upstream RPC                     |
| `AGENT_WALLET_WS_PORT`       | `18545`                          | Loopback WS port the shim talks to       |
| `AGENT_WALLET_AUTO_APPROVE`  | `false`                          | Auto-approve every signing request       |
| `AGENT_WALLET_HEADLESS`      | `false`                          | Run Chromium headless                    |

## MCP tools

### Wallet & chain control

| Tool                    | Args                                        | Effect                                                                 |
| ----------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| `get_status`            | —                                           | `{ address, chainId, chainIdHex, rpcUrl }` — current state             |
| `set_private_key`       | `privateKey` (0x + 64 hex)                  | Loads the key, broadcasts `accountsChanged` to the dApp                |
| `generate_private_key`  | —                                           | Creates a random key, installs it, returns `{ address, privateKey }`   |
| `clear_private_key`     | —                                           | Removes the key, broadcasts empty `accountsChanged`                    |
| `set_chain`             | `chainId` (int), `rpcUrl?` (string)         | Switches chain, broadcasts `chainChanged`; updates RPC if provided     |

### Browser control

| Tool          | Args             | Effect                                                              |
| ------------- | ---------------- | ------------------------------------------------------------------- |
| `navigate`    | `url`, `newTab?` | Navigates the active tab or opens a new tab and navigates there     |
| `list_tabs`   | —                | Returns `{ tabs: [{ index, url, title, active }] }`                 |
| `switch_tab`  | `index`          | Makes the selected tab active                                       |
| `close_tab`   | `index`          | Closes a tab and returns `{ closed, remaining }`                    |
| `screenshot`  | `fullPage?`      | Returns PNG metadata plus an MCP `image` content block              |

### Approval queue

| Tool                   | Args                | Returns                                                       |
| ---------------------- | ------------------- | ------------------------------------------------------------- |
| `get_pending_requests` | —                   | `{ requests: [{ id, method, params, timestamp, summary }] }`  |
| `inspect_request`      | `id`                | Full params plus typed `details` (decoded message, typed-data domain, tx fields) |
| `approve_request`      | `id`                | Signs / broadcasts and returns `{ id, status, result }`       |
| `reject_request`       | `id`, `reason?`     | `{ id, status, reason }`                                      |
| `list_accounts`        | —                   | `{ accounts: [address] }` (empty if no key set)               |
| `get_chain_id`         | —                   | `{ chainId }`                                                 |

`approve_request` errors if no key is loaded; signing requests from the dApp are rejected with EIP-1193 code `4100` until a key exists.

## Typical agent loop

1. Browser opens to `about:blank` (or an optional startup URL) with the wallet shim pre-injected.
2. Agent calls `navigate` to reach the target site.
3. Agent calls `set_private_key` (or `generate_private_key`) and, if needed, `set_chain` for the site's network. The shim emits `accountsChanged` / `chainChanged` so the page sees the new state without a reload.
4. The site triggers `personal_sign` / `eth_signTypedData_v4` / `eth_sendTransaction`; the daemon enqueues it.
5. Agent calls `get_pending_requests`, `inspect_request`, then `approve_request` or `reject_request`.
6. The shim resolves the original EIP-1193 promise inside the page, and the site continues.

## Example: drive Polymarket

Typical MCP call sequence:

1. `set_chain({ chainId: 137, rpcUrl: "https://polygon-rpc.com" })`
2. `set_private_key({ privateKey: "0x..." })`
3. `navigate({ url: "https://polymarket.com" })`

The wallet is single-account at any moment. To use a different wallet for a different site, call `set_private_key` again (and optionally `set_chain`) before or after navigating.

`AGENT_WALLET_AUTO_APPROVE=true` short-circuits step 4 by approving everything immediately. Use only for local testing against a throwaway key.

## Notes & limits

- One wallet at a time. Calling `set_private_key` again replaces the previous account and notifies the current site.
- The daemon binds `127.0.0.1:<wsPort>` only — it is not safe to expose on a LAN.
- Read-only RPC traffic (`eth_call`, `eth_getBalance`, …) is forwarded to the current `rpcUrl` without prompting; only signing/sending requests hit the approval queue.
- Activity log is in-memory by default; nothing persists across restarts.
- Closing the MCP client tears down stdio, which shuts the daemon and the browser via the launcher's `SIGINT`/`SIGTERM` handlers.
