#!/usr/bin/env tsx
/**
 * Starts just the agent-wallet daemon (no browser).
 * Used when browser automation is handled externally (e.g., Chrome DevTools MCP).
 *
 * No env vars required. Without AGENT_WALLET_PRIVATE_KEY, the daemon starts
 * with no signer; set one via the MCP set_private_key tool (or ask this script
 * to generate one with AGENT_WALLET_GENERATE_KEY=true).
 *
 * Outputs the shim code (and optionally the generated key) on stdout for
 * external injection.
 */

import { generatePrivateKey } from 'viem/accounts';

import { BridgeDaemon } from '../src/daemon/index.js';
import { getInjectedShimCode } from '../src/shim/injected.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';

const ENV_KEY = process.env.AGENT_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
const SHOULD_GENERATE = process.env.AGENT_WALLET_GENERATE_KEY === 'true';
const PRIVATE_KEY = ENV_KEY ?? (SHOULD_GENERATE ? generatePrivateKey() : undefined);
const WS_PORT = parseInt(process.env.AGENT_WALLET_WS_PORT ?? String(DEFAULT_CONFIG.wsPort), 10);
const CHAIN_ID = parseInt(process.env.AGENT_WALLET_CHAIN_ID ?? String(DEFAULT_CONFIG.chainId), 10);
const RPC_URL = process.env.AGENT_WALLET_RPC_URL ?? DEFAULT_CONFIG.rpcUrl;
const AUTO_APPROVE = process.env.AGENT_WALLET_AUTO_APPROVE === 'true';

async function main() {
  const daemon = new BridgeDaemon({
    ...DEFAULT_CONFIG,
    ...(PRIVATE_KEY ? { privateKey: PRIVATE_KEY } : {}),
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    wsPort: WS_PORT,
    autoApprove: AUTO_APPROVE,
  });

  await daemon.start();
  const address = daemon.address;

  console.error(`[agent-wallet] Daemon started on ws://127.0.0.1:${WS_PORT}`);
  console.error(`[agent-wallet] Address: ${address ?? '(unset — set via MCP)'}`);
  console.error(`[agent-wallet] Chain ID: ${CHAIN_ID}`);
  console.error(`[agent-wallet] Auto-approve: ${AUTO_APPROVE}`);
  console.error(`[agent-wallet] RPC: ${RPC_URL}`);

  const shimCode = getInjectedShimCode(WS_PORT);
  console.log(JSON.stringify({ address, wsPort: WS_PORT, chainId: CHAIN_ID, shimCode }));

  const shutdown = async () => {
    console.error('\n[agent-wallet] Shutting down...');
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error('[agent-wallet] Fatal:', error);
  process.exit(1);
});
