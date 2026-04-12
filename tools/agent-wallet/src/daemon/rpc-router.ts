interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: string;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export class RpcRouter {
  readonly readonlyMethods = [
    'eth_call',
    'eth_getBalance',
    'eth_getTransactionReceipt',
    'eth_blockNumber',
    'eth_gasPrice',
    'eth_estimateGas',
    'eth_getCode',
    'eth_getStorageAt',
    'eth_getTransactionCount',
    'net_version',
    'web3_clientVersion',
    'eth_getBlockByNumber',
    'eth_getBlockByHash',
    'eth_getLogs',
  ] as const;

  private readonly readonlyMethodSet = new Set<string>(this.readonlyMethods);

  constructor(private readonly rpcUrl: string) {}

  isReadOnly(method: string): boolean {
    return this.readonlyMethodSet.has(method);
  }

  async proxyToUpstream(method: string, params: unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `${method}-${Date.now()}`,
          method,
          params,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Upstream RPC request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as JsonRpcResponse;

      if ('error' in payload) {
        const rpcError = new Error(payload.error.message) as Error & { code?: number; data?: unknown };
        rpcError.code = payload.error.code;
        rpcError.data = payload.error.data;
        throw rpcError;
      }

      return payload.result;
    } finally {
      clearTimeout(timeout);
    }
  }
}
