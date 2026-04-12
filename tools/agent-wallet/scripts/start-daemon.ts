#!/usr/bin/env tsx
/**
 * Starts just the agent-wallet daemon (no browser).
 * Used when browser automation is handled externally (e.g., Chrome DevTools MCP).
 *
 * Outputs the shim code to stdout for injection via initScript.
 */

import { generatePrivateKey } from 'viem/accounts';
import { BridgeDaemon } from '../src/daemon/index.js';
import { getInjectedShimCode } from '../src/shim/injected.js';

const PRIVATE_KEY = (process.env.AGENT_WALLET_PRIVATE_KEY || generatePrivateKey()) as `0x${string}`;
const WS_PORT = parseInt(process.env.AGENT_WALLET_WS_PORT || '18545', 10);
const CHAIN_ID = parseInt(process.env.AGENT_WALLET_CHAIN_ID || '42161', 10);
const RPC_URL = process.env.AGENT_WALLET_RPC_URL || 'https://arb1.arbitrum.io/rpc';
const AUTO_APPROVE = process.env.AGENT_WALLET_AUTO_APPROVE === 'true';

async function main() {
  const daemon = new BridgeDaemon({
    privateKey: PRIVATE_KEY,
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    wsPort: WS_PORT,
    mcpTransport: 'stdio',
    autoApprove: AUTO_APPROVE,
    dbPath: ':memory:',
  });

  await daemon.start();
  const address = daemon.signer.getAddress();

  console.error(`[agent-wallet] Daemon started on ws://127.0.0.1:${WS_PORT}`);
  console.error(`[agent-wallet] Address: ${address}`);
  console.error(`[agent-wallet] Chain ID: ${CHAIN_ID}`);
  console.error(`[agent-wallet] Auto-approve: ${AUTO_APPROVE}`);
  console.error(`[agent-wallet] RPC: ${RPC_URL}`);

  // Output the shim code to stdout for external injection
  const shimCode = getInjectedShimCode(WS_PORT, address, CHAIN_ID);
  console.log(JSON.stringify({ address, wsPort: WS_PORT, chainId: CHAIN_ID, shimCode }));

  // Keep alive
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
