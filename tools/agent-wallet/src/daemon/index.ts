import type { BridgeConfig } from '../types/index.js';

import { Logger } from './logger.js';
import { RequestQueue } from './request-queue.js';
import { RpcRouter } from './rpc-router.js';
import { Signer } from './signer.js';
import { WsServer } from './ws-server.js';

export class BridgeDaemon {
  readonly signer: Signer;

  readonly requestQueue: RequestQueue;

  readonly rpcRouter: RpcRouter;

  readonly logger: Logger;

  readonly wsServer: WsServer;

  constructor(readonly config: BridgeConfig) {
    this.signer = new Signer(config.privateKey);
    this.requestQueue = new RequestQueue();
    this.rpcRouter = new RpcRouter(config.rpcUrl);
    this.logger = new Logger(config.dbPath);
    this.wsServer = new WsServer(config, this.requestQueue, this.signer, this.rpcRouter, this.logger);
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
