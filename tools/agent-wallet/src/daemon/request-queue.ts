import { EventEmitter } from 'node:events';

import type { PendingRequest } from '../types/index.js';

type RequestQueueEventMap = {
  added: [PendingRequest];
  approved: [PendingRequest];
  rejected: [PendingRequest];
};

export class RequestQueue extends EventEmitter {
  private readonly requests = new Map<string, PendingRequest>();

  override on<K extends keyof RequestQueueEventMap>(
    eventName: K,
    listener: (...args: RequestQueueEventMap[K]) => void,
  ): this;
  override on(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(eventName, listener);
  }

  override once<K extends keyof RequestQueueEventMap>(
    eventName: K,
    listener: (...args: RequestQueueEventMap[K]) => void,
  ): this;
  override once(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.once(eventName, listener);
  }

  override emit<K extends keyof RequestQueueEventMap>(
    eventName: K,
    ...args: RequestQueueEventMap[K]
  ): boolean;
  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    return super.emit(eventName, ...args);
  }

  add(request: PendingRequest): PendingRequest {
    const pendingRequest: PendingRequest = {
      ...request,
      params: [...request.params],
      status: 'pending',
      timestamp: request.timestamp,
    };

    this.requests.set(pendingRequest.id, pendingRequest);
    this.emit('added', pendingRequest);
    return pendingRequest;
  }

  get(id: string): PendingRequest | undefined {
    return this.requests.get(id);
  }

  getAll(): PendingRequest[] {
    return Array.from(this.requests.values());
  }

  getPending(): PendingRequest[] {
    return this.getAll().filter((request) => request.status === 'pending');
  }

  approve(id: string): PendingRequest {
    const request = this.requireRequest(id);
    if (request.status !== 'pending') {
      throw new Error(`Request ${id} is already ${request.status}, cannot approve`);
    }
    const approvedRequest: PendingRequest = {
      ...request,
      status: 'approved',
      result: request.result,
      rejectReason: undefined,
    };

    this.requests.set(id, approvedRequest);
    this.emit('approved', approvedRequest);
    return approvedRequest;
  }

  reject(id: string, reason = 'User rejected the request.'): PendingRequest {
    const request = this.requireRequest(id);
    if (request.status !== 'pending') {
      throw new Error(`Request ${id} is already ${request.status}, cannot reject`);
    }
    const rejectedRequest: PendingRequest = {
      ...request,
      status: 'rejected',
      rejectReason: reason,
      result: undefined,
    };

    this.requests.set(id, rejectedRequest);
    this.emit('rejected', rejectedRequest);
    return rejectedRequest;
  }

  remove(id: string): PendingRequest | undefined {
    const request = this.requests.get(id);
    this.requests.delete(id);
    return request;
  }

  private requireRequest(id: string): PendingRequest {
    const request = this.requests.get(id);

    if (!request) {
      throw new Error(`Pending request not found: ${id}`);
    }

    return request;
  }
}
