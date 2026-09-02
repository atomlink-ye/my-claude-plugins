/** Actor channel seam.
 *
 * Two adapter families exist and must not be confused. A `RuntimeHostAdapter`
 * (PaseoAdapter) creates and observes Runtimes that ARCP manages. An
 * `ActorChannelAdapter` wakes an Actor conversation that already exists
 * OUTSIDE the Workspace — the Owner Deputy is the motivating case.
 *
 * A channel adapter owns wire delivery and nothing else. It never owns a Task,
 * a Result, a decision, a retry policy, a budget, or an escalation, and it can
 * never report that something was handled. It reports only that a transport
 * accepted an envelope.
 */

/** What an adapter is allowed to receive. Deliberately bounded: no raw prompt,
 * no credential, no private host path, no provider transcript. The recipient is
 * an opaque ref the adapter resolves privately, so ARCP never learns a chat id. */
export interface ActorDeliveryEnvelope {
  /** Stable de-duplication key. Re-delivering the same key must not wake twice. */
  idempotencyKey: string;
  /** Opaque to ARCP; only the owning adapter interprets it. */
  recipientRef: string;
  kind: string;
  urgency: 'normal' | 'urgent';
  /** One short human line. Never a prompt or transcript. */
  summary: string;
  /** Correlation ids only; never absolute paths. */
  refs: string[];
}

/** A transport receipt states what the wire did, never what a human did. */
export interface TransportReceipt {
  adapterId: string;
  idempotencyKey: string;
  state: 'accepted' | 'duplicate' | 'refused';
  observedAt: string;
  /** Sanitized; must not carry config, credentials, or identity. */
  detail?: string;
}

export interface ChannelCapabilities {
  adapterId: string;
  /** Adapter can wake a conversation that is not a managed Runtime. */
  outboundWake: boolean;
  /** Adapter can report back inbound receipts. */
  inboundReceipts: boolean;
}

export interface BindingObservation {
  bindingId: string;
  generation: number;
  state: 'current' | 'superseded' | 'unknown';
}

/** The binding facts an adapter needs. Identity is the Actor; the binding is
 * replaceable, so a send names an exact binding generation and never scans. */
export interface ChannelBindingRef {
  actorId: string;
  bindingId: string;
  generation: number;
  adapterId: string;
  recipientRef: string;
}

export interface ActorChannelAdapter {
  readonly id: string;
  capabilities(): ChannelCapabilities;
  validate(binding: ChannelBindingRef): Promise<BindingObservation>;
  deliver(binding: ChannelBindingRef, envelope: ActorDeliveryEnvelope): Promise<TransportReceipt>;
  dispose?(): Promise<void>;
}

const at = () => new Date().toISOString();

/** Second implementation of the seam, so the seam is proven by two adapters
 * rather than asserted by one. Tests assert against what was recorded. */
export class RecordingChannelAdapter implements ActorChannelAdapter {
  readonly id: string;
  readonly wakes: Array<{ binding: ChannelBindingRef; envelope: ActorDeliveryEnvelope }> = [];
  private readonly seen = new Set<string>();
  private readonly supersededBindings: Set<string>;

  constructor(id = 'recording', options: { supersededBindings?: string[] } = {}) {
    this.id = id;
    this.supersededBindings = new Set(options.supersededBindings ?? []);
  }

  capabilities(): ChannelCapabilities { return { adapterId: this.id, outboundWake: true, inboundReceipts: false }; }

  async validate(binding: ChannelBindingRef): Promise<BindingObservation> {
    return { bindingId: binding.bindingId, generation: binding.generation, state: this.supersededBindings.has(binding.bindingId) ? 'superseded' : 'current' };
  }

  async deliver(binding: ChannelBindingRef, envelope: ActorDeliveryEnvelope): Promise<TransportReceipt> {
    if (this.supersededBindings.has(binding.bindingId)) return { adapterId: this.id, idempotencyKey: envelope.idempotencyKey, state: 'refused', observedAt: at(), detail: 'binding generation is superseded' };
    // Idempotency lives in the adapter as well as the caller: a retried wake
    // must be observable as a duplicate rather than waking a human twice.
    if (this.seen.has(envelope.idempotencyKey)) return { adapterId: this.id, idempotencyKey: envelope.idempotencyKey, state: 'duplicate', observedAt: at() };
    this.seen.add(envelope.idempotencyKey);
    this.wakes.push({ binding, envelope });
    return { adapterId: this.id, idempotencyKey: envelope.idempotencyKey, state: 'accepted', observedAt: at() };
  }
}

/** Production Hermes adapter. Core ships exactly one production channel; other
 * channels are user modules loaded through the same registry. The Hermes wire
 * itself is injected so this module stays free of transport specifics and the
 * deterministic suite never touches a live conversation. */
export class HermesChannelAdapter implements ActorChannelAdapter {
  readonly id = 'hermes';
  private readonly send: (binding: ChannelBindingRef, envelope: ActorDeliveryEnvelope) => Promise<'accepted' | 'duplicate' | 'refused'>;

  constructor(send: (binding: ChannelBindingRef, envelope: ActorDeliveryEnvelope) => Promise<'accepted' | 'duplicate' | 'refused'>) { this.send = send; }

  capabilities(): ChannelCapabilities { return { adapterId: this.id, outboundWake: true, inboundReceipts: false }; }

  async validate(binding: ChannelBindingRef): Promise<BindingObservation> {
    return { bindingId: binding.bindingId, generation: binding.generation, state: binding.recipientRef ? 'current' : 'unknown' };
  }

  async deliver(binding: ChannelBindingRef, envelope: ActorDeliveryEnvelope): Promise<TransportReceipt> {
    if (!binding.recipientRef) return { adapterId: this.id, idempotencyKey: envelope.idempotencyKey, state: 'refused', observedAt: at(), detail: 'binding has no conversation reference' };
    try {
      const state = await this.send(binding, envelope);
      return { adapterId: this.id, idempotencyKey: envelope.idempotencyKey, state, observedAt: at() };
    } catch {
      // The failure detail is deliberately generic: adapter errors routinely
      // carry configuration and identity that must not reach a durable record.
      return { adapterId: this.id, idempotencyKey: envelope.idempotencyKey, state: 'refused', observedAt: at(), detail: 'channel transport refused the envelope' };
    }
  }
}

/** Startup-only registry. A caller can never name a module at request time, so
 * an HTTP request cannot load code. Duplicate ids fail closed rather than
 * silently overriding, because a shadowed channel would send a wake somewhere
 * the operator did not intend. */
export class ActorChannelRegistry {
  private readonly adapters = new Map<string, ActorChannelAdapter>();

  register(adapter: ActorChannelAdapter): () => void {
    if (this.adapters.has(adapter.id)) throw new Error(`actor channel adapter ${adapter.id} is already registered`);
    this.adapters.set(adapter.id, adapter);
    return () => { void this.adapters.get(adapter.id)?.dispose?.(); this.adapters.delete(adapter.id); };
  }

  get(adapterId: string): ActorChannelAdapter | undefined { return this.adapters.get(adapterId); }
  has(adapterId: string): boolean { return this.adapters.has(adapterId); }
  ids(): string[] { return [...this.adapters.keys()].sort(); }

  /** Sanitized discovery view: configured ids and capabilities only. */
  discovery(): Array<ChannelCapabilities & { configured: true }> {
    return this.ids().map((id) => ({ ...this.adapters.get(id)!.capabilities(), configured: true as const }));
  }
}
