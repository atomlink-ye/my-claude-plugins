import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Hex } from 'viem';

import type { BridgeConfig, DaemonResponse, PendingRequest, ShimMessage } from '../types/index.js';
import { Logger } from './logger.js';
import { RequestQueue } from './request-queue.js';
import { RpcRouter } from './rpc-router.js';
import { Signer, type TypedDataParameter } from './signer.js';

interface PendingSocketContext {
  socket: WebSocket;
}

interface TransactionParams {
  from?: string;
  to?: string;
  data?: string;
  value?: string;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: string;
  chainId?: string | number;
}

export class WsServer {
  private server?: WebSocketServer;

  private readonly pendingSockets = new Map<string, PendingSocketContext>();

  private readonly chainIdHex: Hex;

  constructor(
    private readonly config: BridgeConfig,
    private readonly requestQueue: RequestQueue,
    private readonly signer: Signer,
    private readonly rpcRouter: RpcRouter,
    private readonly logger: Logger,
  ) {
    this.chainIdHex = `0x${config.chainId.toString(16)}`;
    this.requestQueue.on('approved', (request) => {
      void this.handleApprovedRequest(request);
    });
    this.requestQueue.on('rejected', (request) => {
      this.handleRejectedRequest(request);
    });
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = new WebSocketServer({ host: '127.0.0.1', port: this.config.wsPort });

    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        void this.handleSocketMessage(socket, data);
      });

      socket.on('close', () => {
        this.dropSocketReferences(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });

    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;

    if (!server) {
      return;
    }

    for (const client of server.clients) {
      client.close();
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.server = undefined;
    this.pendingSockets.clear();
  }

  private async handleSocketMessage(socket: WebSocket, rawData: RawData): Promise<void> {
    let message: unknown;

    try {
      message = JSON.parse(this.toMessageString(rawData));
    } catch {
      return;
    }

    if (!this.isShimMessage(message)) {
      return;
    }

    try {
      if (message.method === 'eth_requestAccounts' || message.method === 'eth_accounts') {
        this.sendResponse(socket, { type: 'rpc_response', id: message.id, result: [this.signer.getAddress()] });
        return;
      }

      if (message.method === 'eth_chainId') {
        this.sendResponse(socket, { type: 'rpc_response', id: message.id, result: this.chainIdHex });
        return;
      }

      if (message.method === 'wallet_switchEthereumChain') {
        // Only allow switching to the configured chain; reject others
        const requestedChain = (message.params[0] as { chainId?: string })?.chainId;
        if (requestedChain && requestedChain.toLowerCase() !== this.chainIdHex.toLowerCase()) {
          this.sendError(socket, message.id, 4902, `Unrecognized chain ID "${requestedChain}". Only chain ${this.chainIdHex} is supported.`);
          return;
        }
        this.sendResponse(socket, { type: 'rpc_response', id: message.id, result: null });
        return;
      }

      if (message.method === 'personal_sign' || message.method === 'eth_signTypedData_v4' || message.method === 'eth_sendTransaction') {
        this.enqueueApprovalRequest(socket, message);
        return;
      }

      if (this.rpcRouter.isReadOnly(message.method)) {
        const result = await this.rpcRouter.proxyToUpstream(message.method, message.params);
        this.sendResponse(socket, { type: 'rpc_response', id: message.id, result });
        return;
      }

      this.sendError(socket, message.id, -32601, `Unsupported RPC method: ${message.method}`);
    } catch (error) {
      const code = (error as { code?: number }).code ?? -32603;
      this.sendError(socket, message.id, code, this.getErrorMessage(error));
    }
  }

  private enqueueApprovalRequest(socket: WebSocket, message: ShimMessage): void {
    const request = this.requestQueue.add({
      id: message.id,
      method: message.method,
      params: message.params,
      timestamp: Date.now(),
      status: 'pending',
      summary: this.summarizeRequest(message),
    });

    this.pendingSockets.set(request.id, { socket });
    this.logger.log(this.getRequestedEvent(request.method), request.id, JSON.stringify({ method: request.method, params: request.params }));

    if (this.config.autoApprove) {
      this.requestQueue.approve(request.id);
    }
  }

  private async handleApprovedRequest(request: PendingRequest): Promise<void> {
    const socket = this.pendingSockets.get(request.id)?.socket;

    try {
      const result = await this.fulfillApprovedRequest(request);
      request.result = result;
      this.logger.log(this.getApprovedEvent(request.method), request.id, JSON.stringify({ result }));

      if (socket) {
        this.sendResponse(socket, { type: 'rpc_response', id: request.id, result });
      }
    } catch (error) {
      this.logger.log(this.getFailureEvent(request.method), request.id, this.getErrorMessage(error));

      if (socket) {
        this.sendError(socket, request.id, -32603, this.getErrorMessage(error));
      }
    } finally {
      this.pendingSockets.delete(request.id);
    }
  }

  private handleRejectedRequest(request: PendingRequest): void {
    const socket = this.pendingSockets.get(request.id)?.socket;

    this.logger.log('signature.rejected', request.id, request.rejectReason);

    if (socket) {
      this.sendError(socket, request.id, 4001, request.rejectReason ?? 'User rejected the request.');
    }

    this.pendingSockets.delete(request.id);
  }

  private async fulfillApprovedRequest(request: PendingRequest): Promise<unknown> {
    switch (request.method) {
      case 'personal_sign':
        return this.signer.signMessage(this.getPersonalSignPayload(request.params));
      case 'eth_signTypedData_v4':
        return this.signer.signTypedData(this.getTypedDataPayload(request.params));
      case 'eth_sendTransaction':
        return this.signer.sendTransaction(this.getTransactionPayload(request.params), this.config.rpcUrl);
      default:
        throw new Error(`Unsupported approval method: ${request.method}`);
    }
  }

  private getPersonalSignPayload(params: unknown[]): string | { raw: Hex } {
    const candidate = params.find((param) => typeof param === 'string' && !this.isAddress(param)) ?? params[0];

    if (typeof candidate !== 'string') {
      throw new Error('personal_sign requires a string payload');
    }

    if (candidate.startsWith('0x')) {
      return { raw: candidate as Hex };
    }

    return candidate;
  }

  private getTypedDataPayload(params: unknown[]): TypedDataParameter {
    const candidate = params.find((param) => typeof param === 'object' && param !== null)
      ?? params.find((param) => typeof param === 'string' && param.trim().startsWith('{'));

    const parsedCandidate = typeof candidate === 'string' ? JSON.parse(candidate) as unknown : candidate;

    if (!parsedCandidate || typeof parsedCandidate !== 'object') {
      throw new Error('eth_signTypedData_v4 requires typed data payload');
    }

    const typedData = parsedCandidate as Record<string, unknown>;
    const { domain, message, primaryType, types } = typedData;

    if (typeof primaryType !== 'string' || !types || typeof types !== 'object' || !message || typeof message !== 'object') {
      throw new Error('Invalid typed data payload');
    }

    return {
      domain: domain && typeof domain === 'object' ? (domain as Record<string, unknown>) : undefined,
      message: message as Record<string, unknown>,
      primaryType,
      types: types as TypedDataParameter['types'],
    };
  }

  private getTransactionPayload(params: unknown[]): Record<string, unknown> {
    const candidate = params.find((param) => typeof param === 'object' && param !== null);

    if (!candidate) {
      throw new Error('eth_sendTransaction requires transaction parameters');
    }

    const transaction = { ...(candidate as TransactionParams) };

    if (!transaction.from) {
      transaction.from = this.signer.getAddress();
    }

    return transaction;
  }

  private summarizeRequest(message: ShimMessage): string {
    switch (message.method) {
      case 'personal_sign':
        return 'Sign personal message';
      case 'eth_signTypedData_v4':
        return 'Sign typed data';
      case 'eth_sendTransaction': {
        const transaction = message.params.find((param) => typeof param === 'object' && param !== null) as TransactionParams | undefined;
        return transaction?.to ? `Send transaction to ${transaction.to}` : 'Send transaction';
      }
      default:
        return message.method;
    }
  }

  private getRequestedEvent(method: string): 'signature.requested' | 'transaction.requested' {
    return method === 'eth_sendTransaction' ? 'transaction.requested' : 'signature.requested';
  }

  private getApprovedEvent(method: string): 'signature.approved' | 'transaction.sent' {
    return method === 'eth_sendTransaction' ? 'transaction.sent' : 'signature.approved';
  }

  private getFailureEvent(method: string): 'transaction.failed' | 'signature.rejected' {
    return method === 'eth_sendTransaction' ? 'transaction.failed' : 'signature.rejected';
  }

  private sendResponse(socket: WebSocket, response: DaemonResponse): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify(response));
  }

  private sendError(socket: WebSocket, id: string, code: number, message: string): void {
    this.sendResponse(socket, {
      type: 'rpc_response',
      id,
      error: { code, message },
    });
  }

  private dropSocketReferences(socket: WebSocket): void {
    for (const [requestId, context] of this.pendingSockets.entries()) {
      if (context.socket === socket) {
        this.pendingSockets.delete(requestId);
        // Reject orphaned pending requests so they don't linger approvable
        const request = this.requestQueue.get(requestId);
        if (request && request.status === 'pending') {
          try {
            this.requestQueue.reject(requestId, 'Client disconnected');
          } catch {
            // Already settled — safe to ignore
          }
        }
      }
    }
  }

  private toMessageString(data: RawData): string {
    if (typeof data === 'string') {
      return data;
    }

    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString('utf8');
    }

    if (Array.isArray(data)) {
      return Buffer.concat(data).toString('utf8');
    }

    return data.toString('utf8');
  }

  private isShimMessage(value: unknown): value is ShimMessage {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as Partial<ShimMessage>;
    return candidate.type === 'rpc_request'
      && typeof candidate.id === 'string'
      && typeof candidate.method === 'string'
      && Array.isArray(candidate.params);
  }

  private isAddress(value: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(value);
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown daemon error';
  }
}
