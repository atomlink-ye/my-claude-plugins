export interface PendingRequest {
  id: string;
  method: string;
  params: unknown[];
  timestamp: number;
  status: 'pending' | 'approved' | 'rejected';
  /** Decoded human-readable summary, if available */
  summary?: string;
  /** Result after approval (tx hash, signature, etc.) */
  result?: unknown;
  /** Rejection reason */
  rejectReason?: string;
}

export interface BridgeIdentity {
  name: string;
  icon: string;
  rdns: string;
}

export interface ShimMessage {
  type: 'rpc_request';
  id: string;
  method: string;
  params: unknown[];
}

export interface DaemonResponse {
  type: 'rpc_response';
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

export type DaemonEvent =
  | { type: 'event'; event: 'state'; address: string | null; chainIdHex: string }
  | { type: 'event'; event: 'accountsChanged'; accounts: string[] }
  | { type: 'event'; event: 'chainChanged'; chainIdHex: string }
  | { type: 'event'; event: 'identityChanged'; identity: BridgeIdentity };

export interface BridgeConfig {
  /** Private key hex (0x-prefixed) for the signer vault. Optional — can be set later via MCP. */
  privateKey?: `0x${string}`;
  /** Chain ID to present to the Dapp (default: 42161 Arbitrum One) */
  chainId: number;
  /** Upstream RPC URL for read-only requests */
  rpcUrl: string;
  /** WebSocket port for shim <-> daemon communication */
  wsPort: number;
  /** MCP server transport: 'stdio' */
  mcpTransport: 'stdio';
  /** Auto-approve all requests (for testing only) */
  autoApprove: boolean;
  /** Strip CSP response headers in the launched browser context */
  stripCSP?: boolean;
  /** EIP-6963 identity announced by the injected shim */
  identity?: Partial<BridgeIdentity>;
  /** SQLite database path for activity log */
  dbPath: string;
}

export const DEFAULT_IDENTITY: BridgeIdentity = {
  name: 'Agent Wallet',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNiIgZmlsbD0iIzExMTgyNyIvPjxwYXRoIGQ9Ik0xOSAyMWgyNmE1IDUgMCAwIDEgNSA1djEyYTUgNSAwIDAgMS01IDVIMTlhNSA1IDAgMCAxLTUtNVYyNmE1IDUgMCAwIDEgNS01em0yIDEyaDE0IiBzdHJva2U9IiM2MEE1RkEiIHN0cm9rZS13aWR0aD0iNCIgZmlsbD0ibm9uZSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PGNpcmNsZSBjeD0iNDUiIGN5PSIzMiIgcj0iMyIgZmlsbD0iIzYwQTVGQSIvPjwvc3ZnPg==',
  rdns: 'local.agent-wallet.bridge',
};

export const DEFAULT_CONFIG: BridgeConfig = {
  chainId: 42161,
  rpcUrl: 'https://arb1.arbitrum.io/rpc',
  wsPort: 18545,
  mcpTransport: 'stdio',
  autoApprove: false,
  dbPath: ':memory:',
};

export type ActivityEvent =
  | 'wallet.connected'
  | 'signature.requested'
  | 'signature.approved'
  | 'signature.rejected'
  | 'transaction.requested'
  | 'transaction.sent'
  | 'transaction.confirmed'
  | 'transaction.failed';

export interface ActivityLogEntry {
  id: number;
  event: ActivityEvent;
  requestId?: string;
  data?: string;
  timestamp: number;
}
