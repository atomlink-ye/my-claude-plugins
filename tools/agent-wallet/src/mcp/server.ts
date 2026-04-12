import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import type { BridgeConfig, PendingRequest } from '../types/index.js';

type RequestQueue = {
  getPending(): PendingRequest[];
  get(id: string): PendingRequest | undefined;
  approve(id: string): PendingRequest;
  reject(id: string, reason: string): PendingRequest;
};

type Signer = {
  getAddress(): string;
};

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const HEX_REGEX = /^0x[a-fA-F0-9]*$/;

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

function requireRequest(requestQueue: RequestQueue, id: string): PendingRequest {
  const request = requestQueue.get(id);

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

export function createMcpServer(
  requestQueue: RequestQueue,
  signer: Signer,
  config: BridgeConfig,
): McpServer {
  const server = new McpServer({
    name: 'agent-wallet-bridge',
    version: '0.1.0',
  });

  server.tool(
    'get_pending_requests',
    'List all pending wallet requests.',
    async () => {
      const requests = requestQueue.getPending().map(getPendingEntry);
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
      const request = requireRequest(requestQueue, id);

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
      const approved = requestQueue.approve(id);

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
      const rejected = requestQueue.reject(id, reason ?? 'Rejected by MCP client');

      return toToolResult({
        id: rejected.id,
        status: rejected.status,
        reason: rejected.rejectReason ?? reason ?? 'Rejected by MCP client',
      });
    },
  );

  server.tool(
    'list_accounts',
    'Return the bridge-controlled wallet account.',
    async () => {
      return toToolResult({
        accounts: [signer.getAddress()],
      });
    },
  );

  server.tool(
    'get_chain_id',
    'Return the configured chain ID.',
    async () => {
      return toToolResult({
        chainId: config.chainId,
      });
    },
  );

  return server;
}

export async function startMcpServer(
  requestQueue: RequestQueue,
  signer: Signer,
  config: BridgeConfig,
): Promise<McpServer> {
  const server = createMcpServer(requestQueue, signer, config);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  return server;
}
