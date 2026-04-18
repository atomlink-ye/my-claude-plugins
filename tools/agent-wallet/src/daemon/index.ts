import { generatePrivateKey } from 'viem/accounts';

import type { BridgeConfig, BridgeIdentity, DaemonEvent } from '../types/index.js';
import { DEFAULT_IDENTITY } from '../types/index.js';

import { Logger } from './logger.js';
import { RequestQueue } from './request-queue.js';
import { RpcRouter } from './rpc-router.js';
import { Signer } from './signer.js';
import { WsServer } from './ws-server.js';

export type BroadcastFn = (event: DaemonEvent) => void;

export class BridgeDaemon {
  private currentSigner: Signer | null;

  private currentChainId: number;

  private currentIdentity: BridgeIdentity;

  readonly requestQueue: RequestQueue;

  readonly rpcRouter: RpcRouter;

  readonly logger: Logger;

  readonly wsServer: WsServer;

  constructor(readonly config: BridgeConfig) {
    this.currentSigner = config.privateKey ? new Signer(config.privateKey) : null;
    this.currentChainId = config.chainId;
    this.currentIdentity = {
      ...DEFAULT_IDENTITY,
      ...(config.identity ?? {}),
    };
    this.requestQueue = new RequestQueue();
    this.rpcRouter = new RpcRouter(config.rpcUrl);
    this.logger = new Logger(config.dbPath);
    this.wsServer = new WsServer(
      config,
      this.requestQueue,
      this.rpcRouter,
      this.logger,
      {
        getSigner: () => this.currentSigner,
        getChainId: () => this.currentChainId,
        getRpcUrl: () => this.rpcRouter.getRpcUrl(),
      },
    );
  }

  /** Current signer or null if no key is set. */
  get signer(): Signer | null {
    return this.currentSigner;
  }

  get chainId(): number {
    return this.currentChainId;
  }

  get chainIdHex(): string {
    return `0x${this.currentChainId.toString(16)}`;
  }

  get address(): string | null {
    return this.currentSigner?.getAddress() ?? null;
  }

  get identity(): BridgeIdentity {
    return { ...this.currentIdentity };
  }

  get connectedOrigins(): string[] {
    return this.wsServer.getConnectedOrigins();
  }

  get isShimConnected(): boolean {
    return this.wsServer.isAnyShimConnected();
  }

  setPrivateKey(privateKey: `0x${string}`): string {
    if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
      throw new Error('Invalid private key: expected 32-byte hex string with 0x prefix');
    }

    this.currentSigner = new Signer(privateKey);
    const address = this.currentSigner.getAddress();
    this.wsServer.broadcast({ type: 'event', event: 'accountsChanged', accounts: [address] });
    this.logger.log('wallet.connected', undefined, JSON.stringify({ address }));
    return address;
  }

  generatePrivateKey(): { privateKey: `0x${string}`; address: string } {
    const privateKey = generatePrivateKey();
    const address = this.setPrivateKey(privateKey);
    return { privateKey, address };
  }

  clearPrivateKey(): void {
    this.currentSigner = null;
    this.wsServer.broadcast({ type: 'event', event: 'accountsChanged', accounts: [] });
  }

  setChain(chainId: number, rpcUrl?: string): void {
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new Error('Invalid chainId: expected positive integer');
    }

    this.currentChainId = chainId;
    if (rpcUrl) {
      this.rpcRouter.setRpcUrl(rpcUrl);
    }
    this.wsServer.broadcast({ type: 'event', event: 'chainChanged', chainIdHex: this.chainIdHex });
  }

  setIdentity(identity: Partial<BridgeIdentity>): BridgeIdentity {
    this.currentIdentity = {
      ...this.currentIdentity,
      ...identity,
    };
    const nextIdentity = this.identity;
    this.wsServer.broadcast({ type: 'event', event: 'identityChanged', identity: nextIdentity });
    return nextIdentity;
  }

  async start(): Promise<void> {
    await this.wsServer.start();
  }

  async stop(): Promise<void> {
    try {
      await this.wsServer.stop();
    } finally {
      this.logger.close();
    }
  }
}

export { Logger } from './logger.js';
export { RequestQueue } from './request-queue.js';
export { RpcRouter } from './rpc-router.js';
export { Signer } from './signer.js';
export { WsServer } from './ws-server.js';
