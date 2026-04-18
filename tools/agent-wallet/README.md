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

The CLI takes the dApp URL as its first argument and starts the MCP server on stdio when `AGENT_WALLET_MCP=true`. **No private key needed at startup** — set or generate one at runtime via MCP tools. Chain defaults to Arbitrum One (`42161`) and can be switched at any time.

### Claude Code

```bash
claude mcp add agent-wallet \
  --env AGENT_WALLET_MCP=true \
  -- node /absolute/path/to/tools/agent-wallet/dist/launcher.js https://app.hyperliquid.xyz
```

### Claude Desktop / generic stdio config

```json
{
  "mcpServers": {
    "agent-wallet": {
      "command": "node",
      "args": [
        "/absolute/path/to/tools/agent-wallet/dist/launcher.js",
        "https://app.hyperliquid.xyz"
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

1. Browser opens to the configured dApp URL with the wallet shim pre-injected.
2. Agent calls `set_private_key` (or `generate_private_key`) and, if needed, `set_chain` for the dApp's network. The shim emits `accountsChanged` / `chainChanged` so the page sees the new state without a reload.
3. The dApp triggers `personal_sign` / `eth_signTypedData_v4` / `eth_sendTransaction`; the daemon enqueues it.
4. Agent calls `get_pending_requests`, `inspect_request`, then `approve_request` or `reject_request`.
5. The shim resolves the original EIP-1193 promise inside the page, and the dApp continues.

`AGENT_WALLET_AUTO_APPROVE=true` short-circuits step 4 by approving everything immediately. Use only for local testing against a throwaway key.

## Notes & limits

- One wallet at a time. Calling `set_private_key` again replaces the previous account and notifies the dApp.
- The daemon binds `127.0.0.1:<wsPort>` only — it is not safe to expose on a LAN.
- Read-only RPC traffic (`eth_call`, `eth_getBalance`, …) is forwarded to the current `rpcUrl` without prompting; only signing/sending requests hit the approval queue.
- Activity log is in-memory by default; nothing persists across restarts.
- Closing the MCP client tears down stdio, which shuts the daemon and the browser via the launcher's `SIGINT`/`SIGTERM` handlers.
