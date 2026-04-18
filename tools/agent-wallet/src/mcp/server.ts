import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import type { BridgeDaemon } from '../daemon/index.js';
import type { PendingRequest } from '../types/index.js';

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const HEX_REGEX = /^0x[a-fA-F0-9]*$/;
const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;

function toToolResult(data: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data,
  };
}

function requireRequest(daemon: BridgeDaemon, id: string): PendingRequest {
  const request = daemon.requestQueue.get(id);

  if (!request) {
    throw new Error(`Pending request not found: ${id}`);
  }

  return request;
}

function getPendingEntry(request: PendingRequest) {
  return {
    id: request.id,
    method: request.method,
    params: request.params,
    timestamp: request.timestamp,
    summary: request.summary ?? summarizeRequest(request),
  };
}

function summarizeRequest(request: PendingRequest): string {
  switch (request.method) {
    case 'personal_sign': {
      const message = extractPersonalSignMessage(request.params);
      return message.decoded ? `Sign message: ${truncate(message.decoded, 80)}` : 'Sign personal message';
    }
    case 'eth_signTypedData_v4':
      return 'Sign typed data';
    case 'eth_sendTransaction': {
      const tx = extractTransaction(request.params);
      if (tx?.to) {
        return `Send transaction to ${String(tx.to)}`;
      }
      return 'Send transaction';
    }
    default:
      return request.method;
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function extractPersonalSignMessage(params: unknown[]): { raw: unknown; decoded: string | null } {
  const candidate = params.find((param) => !(typeof param === 'string' && ADDRESS_REGEX.test(param))) ?? params[0];

  if (typeof candidate !== 'string') {
    return { raw: candidate, decoded: null };
  }

  if (!HEX_REGEX.test(candidate) || candidate.length % 2 !== 0) {
    return { raw: candidate, decoded: candidate };
  }

  try {
    const decoded = Buffer.from(candidate.slice(2), 'hex').toString('utf8');
    return { raw: candidate, decoded };
  } catch {
    return { raw: candidate, decoded: null };
  }
}

function extractTypedData(params: unknown[]): Record<string, unknown> | null {
  const candidate = params.find((param) => {
    if (typeof param === 'string') {
      return param.trim().startsWith('{');
    }

    return typeof param === 'object' && param !== null;
  });

  if (!candidate) {
    return null;
  }

  if (typeof candidate === 'string') {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  return candidate as Record<string, unknown>;
}

function extractTransaction(params: unknown[]): Record<string, unknown> | null {
  const candidate = params.find((param) => typeof param === 'object' && param !== null);
  return candidate ? (candidate as Record<string, unknown>) : null;
}

function getRequestInspection(request: PendingRequest): Record<string, unknown> {
  switch (request.method) {
    case 'personal_sign': {
      const message = extractPersonalSignMessage(request.params);
      return {
        kind: 'personal_sign',
        message: message.decoded,
        rawMessage: message.raw,
      };
    }
    case 'eth_signTypedData_v4': {
      const typedData = extractTypedData(request.params);
      return {
        kind: 'eth_signTypedData_v4',
        domain: typedData?.domain ?? null,
        message: typedData?.message ?? null,
        primaryType: typedData?.primaryType ?? null,
        types: typedData?.types ?? null,
      };
    }
    case 'eth_sendTransaction': {
      const tx = extractTransaction(request.params);
      return {
        kind: 'eth_sendTransaction',
        to: tx?.to ?? null,
        value: tx?.value ?? null,
        data: tx?.data ?? null,
        from: tx?.from ?? null,
      };
    }
    default:
      return {
        kind: request.method,
        params: request.params,
      };
  }
}

export function createMcpServer(daemon: BridgeDaemon): McpServer {
  const server = new McpServer({
    name: 'agent-wallet-bridge',
    version: '0.2.0',
  });

  server.tool(
    'get_status',
    'Return the current wallet state: address (or null), chainId, rpcUrl.',
    async () => {
      return toToolResult({
        address: daemon.address,
        chainId: daemon.chainId,
        chainIdHex: daemon.chainIdHex,
        rpcUrl: daemon.rpcRouter.getRpcUrl(),
      });
    },
  );

  server.tool(
    'set_private_key',
    'Load a private key into the wallet. Replaces any existing key. Notifies all connected dApps via accountsChanged.',
    {
      privateKey: z.string().regex(PRIVATE_KEY_REGEX, 'Expected 0x-prefixed 32-byte hex').describe('0x-prefixed 32-byte hex private key'),
    },
    async ({ privateKey }) => {
      const address = daemon.setPrivateKey(privateKey as `0x${string}`);
      return toToolResult({ address });
    },
  );

  server.tool(
    'generate_private_key',
    'Generate a new random private key, install it, and return the address. The private key is also returned — handle it carefully.',
    async () => {
      const { privateKey, address } = daemon.generatePrivateKey();
      return toToolResult({ address, privateKey });
    },
  );

  server.tool(
    'clear_private_key',
    'Remove the active private key. Notifies dApps via accountsChanged with an empty list.',
    async () => {
      daemon.clearPrivateKey();
      return toToolResult({ address: null });
    },
  );

  server.tool(
    'set_chain',
    'Switch the chain ID (and optionally the upstream RPC URL). Notifies dApps via chainChanged.',
    {
      chainId: z.number().int().positive().describe('Chain ID as a positive integer (e.g. 1, 42161, 8453)'),
      rpcUrl: z.string().url().optional().describe('Optional upstream RPC URL for read-only proxying'),
    },
    async ({ chainId, rpcUrl }) => {
      daemon.setChain(chainId, rpcUrl);
      return toToolResult({
        chainId: daemon.chainId,
        chainIdHex: daemon.chainIdHex,
        rpcUrl: daemon.rpcRouter.getRpcUrl(),
      });
    },
  );

  server.tool(
    'get_pending_requests',
    'List all pending wallet requests.',
    async () => {
      const requests = daemon.requestQueue.getPending().map(getPendingEntry);
      return toToolResult({ requests });
    },
  );

  server.tool(
    'inspect_request',
    'Inspect a pending wallet request in detail.',
    {
      id: z.string().min(1).describe('Pending request ID'),
    },
    async ({ id }) => {
      const request = requireRequest(daemon, id);

      return toToolResult({
        request: {
          id: request.id,
          method: request.method,
          params: request.params,
          timestamp: request.timestamp,
          summary: request.summary ?? summarizeRequest(request),
          details: getRequestInspection(request),
        },
      });
    },
  );

  server.tool(
    'approve_request',
    'Approve a pending wallet request.',
    {
      id: z.string().min(1).describe('Pending request ID'),
    },
    async ({ id }) => {
      if (!daemon.signer) {
        throw new Error('No wallet account configured. Call set_private_key first.');
      }
      const approved = daemon.requestQueue.approve(id);

      return toToolResult({
        id: approved.id,
        status: approved.status,
        result: approved.result ?? null,
      });
    },
  );

  server.tool(
    'reject_request',
    'Reject a pending wallet request.',
    {
      id: z.string().min(1).describe('Pending request ID'),
      reason: z.string().min(1).optional().describe('Optional rejection reason'),
    },
    async ({ id, reason }) => {
      const rejected = daemon.requestQueue.reject(id, reason ?? 'Rejected by MCP client');

      return toToolResult({
        id: rejected.id,
        status: rejected.status,
        reason: rejected.rejectReason ?? reason ?? 'Rejected by MCP client',
      });
    },
  );

  server.tool(
    'list_accounts',
    'Return the bridge-controlled wallet account, or an empty list if none is set.',
    async () => {
      return toToolResult({
        accounts: daemon.address ? [daemon.address] : [],
      });
    },
  );

  server.tool(
    'get_chain_id',
    'Return the configured chain ID.',
    async () => {
      return toToolResult({
        chainId: daemon.chainId,
      });
    },
  );

  return server;
}

export async function startMcpServer(daemon: BridgeDaemon): Promise<McpServer> {
  const server = createMcpServer(daemon);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  return server;
}
