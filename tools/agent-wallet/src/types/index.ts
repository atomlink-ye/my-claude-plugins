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

export interface BridgeConfig {
  /** Private key hex (0x-prefixed) for the signer vault */
  privateKey: `0x${string}`;
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
  /** SQLite database path for activity log */
  dbPath: string;
}

export const DEFAULT_CONFIG: Omit<BridgeConfig, 'privateKey'> & { privateKey?: `0x${string}` } = {
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
