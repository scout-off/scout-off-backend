import { MessageEnvelope } from '../validator';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Per-client, per-room delivery state tracked by the server.
 * Used for ACK window flow control and exactly-once replay.
 */
export interface ClientDeliveryState {
  /** Highest sequence number this client has acknowledged (Option B: client-reported). */
  highestAckedSeq: number;
  /** Highest sequence number actually sent to this client. Used by deliverPendingMessages to avoid re-sending. */
  highestDeliveredSeq: number;
  /** Number of unacknowledged messages sent to this client in this room. */
  unackedCount: number;
  /** Whether delivery to this client is paused (ACK window full). */
  paused: boolean;
}

/**
 * Storage adapter interface for exactly-once delivery persistence.
 *
 * Option B (client-reported): On reconnect, the client sends highestAckedSeq
 * and the server trusts it. The adapter is optional for ACK persistence — it
 * mainly supports Option A (server-side ACK table) if needed later.
 *
 * The ring buffer storage and in-memory maps are the primary persistence
 * mechanisms for the delivery protocol.
 */
export interface DeliveryStorageAdapter {
  /**
   * Persist an ACK record (Option A — server-side).
   * If using Option B (client-reported), this is a no-op.
   */
  ackMessage(clientId: string, roomId: string, seq: number): Promise<void>;

  /**
   * Retrieve the highest ACKed sequence for a client in a room.
   * Returns 0 if no ACK has been recorded.
   */
  getHighestAckedSeq(clientId: string, roomId: string): Promise<number>;

  /**
   * Clean up all delivery state for a disconnected client.
   */
  cleanupClient(clientId: string): Promise<void>;
}

// ─── In-Memory Implementation ────────────────────────────────────────────────

/**
 * In-memory storage adapter — sufficient for single-instance deployments
 * where ACK state is re-established on reconnect (Option B).
 *
 * For multi-instance deployments, a Redis-backed adapter would be needed
 * (future: issue 11).
 */
export class InMemoryDeliveryStorage implements DeliveryStorageAdapter {
  /** Map<clientId, Map<roomId, number>> — highest ACKed seq per client per room. */
  private ackState = new Map<string, Map<string, number>>();

  async ackMessage(clientId: string, roomId: string, seq: number): Promise<void> {
    let roomMap = this.ackState.get(clientId);
    if (!roomMap) {
      roomMap = new Map();
      this.ackState.set(clientId, roomMap);
    }
    const current = roomMap.get(roomId) ?? 0;
    if (seq > current) {
      roomMap.set(roomId, seq);
    }
  }

  async getHighestAckedSeq(clientId: string, roomId: string): Promise<number> {
    return this.ackState.get(clientId)?.get(roomId) ?? 0;
  }

  async cleanupClient(clientId: string): Promise<void> {
    this.ackState.delete(clientId);
  }

  /** Expose size for memory metrics. */
  get clientCount(): number {
    return this.ackState.size;
  }
}

// ─── Ring Buffer ─────────────────────────────────────────────────────────────

/**
 * Fixed-size ring buffer for a single room.
 * Stores messages with seq, messageId, payload, and timestamp.
 * Used for replay on reconnect and NACK re-sends.
 */
export class RingBuffer {
  private buffer: MessageEnvelope[];
  private head = 0;
  private count = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  /** Append a message to the ring buffer, overwriting the oldest entry if full. */
  push(entry: MessageEnvelope): void {
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /**
   * Return all messages with seq > fromSeq, up to the given limit.
   * Used for replay on reconnect.
   */
  getSince(fromSeq: number, limit?: number): MessageEnvelope[] {
    const results: MessageEnvelope[] = [];
    const startIdx = this.count < this.capacity
      ? 0
      : this.head; // oldest entry position

    for (let i = 0; i < this.count; i++) {
      const idx = (startIdx + i) % this.capacity;
      const entry = this.buffer[idx];
      if (entry && entry.seq > fromSeq) {
        results.push(entry);
        if (limit !== undefined && results.length >= limit) break;
      }
    }
    return results;
  }

  /**
   * Find a specific message by sequence number.
   * Used for NACK re-sends.
   */
  findBySeq(seq: number): MessageEnvelope | undefined {
    const startIdx = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const idx = (startIdx + i) % this.capacity;
      const entry = this.buffer[idx];
      if (entry && entry.seq === seq) {
        return entry;
      }
    }
    return undefined;
  }

  /** Return the highest sequence number in the buffer, or -1 if empty. */
  get highestSeq(): number {
    if (this.count === 0) return -1;
    let max = -1;
    const startIdx = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const idx = (startIdx + i) % this.capacity;
      const entry = this.buffer[idx];
      if (entry && entry.seq > max) {
        max = entry.seq;
      }
    }
    return max;
  }

  /** Return all entries in the buffer (for getRingBuffer()). */
  getAll(): MessageEnvelope[] {
    const results: MessageEnvelope[] = [];
    const startIdx = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const idx = (startIdx + i) % this.capacity;
      const entry = this.buffer[idx];
      if (entry) results.push(entry);
    }
    return results;
  }

  /** Current number of entries in the buffer. */
  get size(): number {
    return this.count;
  }
}
