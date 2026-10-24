import { EventEmitter } from 'events';
import { uuidv7 } from './utils/uuid';
import { logger } from './utils/logger';
import {
  MessageEnvelope,
  AckMessage,
  NackMessage,
  ReconnectMessage,
  ProtocolVersion,
  PROTOCOL_VERSION_V1,
  PROTOCOL_VERSION_V2,
} from './validator';
import {
  RingBuffer,
  InMemoryDeliveryStorage,
  DeliveryStorageAdapter,
  ClientDeliveryState,
} from './storage/adapter';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A connected client in a room. */
export interface RoomClient {
  clientId: string;
  roomId: string;
  protocolVersion: ProtocolVersion;
  send: (data: MessageEnvelope) => void;
}

interface RoomState {
  /** Sequence counter — monotonically increasing per room. */
  nextSeq: number;
  /** Ring buffer storing messages for replay and NACK re-sends. */
  ringBuffer: RingBuffer;
  /** Set of messageIds already broadcast — used for dedup. */
  seenMessageIds: Set<string>;
  /** Clients subscribed to this room. */
  clients: Map<string, RoomClient>;
  /** Per-client delivery state for flow control. Map<clientId, state>. */
  deliveryState: Map<string, ClientDeliveryState>;
}

export interface RoomManagerOptions {
  /** Maximum messages in ring buffer per room. Default: 1000. */
  ringBufferSize?: number;
  /** ACK window size — max unacked messages per client before pausing. Default: 100. */
  ackWindowSize?: number;
  /** Storage adapter for ACK persistence. Default: InMemoryDeliveryStorage. */
  storageAdapter?: DeliveryStorageAdapter;
}

// ─── RoomManager ────────────────────────────────────────────────────────────

/**
 * Manages WebSocket rooms with exactly-once delivery semantics.
 *
 * Responsibilities:
 * - Assigns UUID v7 messageId + monotonically increasing seq to each broadcast
 * - Maintains per-room ring buffers for replay and NACK re-sends
 * - Tracks per-client ACK state and enforces ACK window flow control
 * - Handles reconnect with client-reported highestAckedSeq (Option B)
 * - Deduplicates broadcast messages via seenMessageIds set
 */
export class RoomManager extends EventEmitter {
  private rooms = new Map<string, RoomState>();
  private readonly defaultRingBufferSize: number;
  private readonly defaultAckWindowSize: number;
  private readonly storageAdapter: DeliveryStorageAdapter;

  /** Metrics counters. */
  private _totalBroadcasts = 0;
  private _totalAcks = 0;
  private _totalNacks = 0;
  private _totalReconnects = 0;
  private _totalDuplicatesDropped = 0;

  constructor(options: RoomManagerOptions = {}) {
    super();
    this.defaultRingBufferSize = options.ringBufferSize ?? 1000;
    this.defaultAckWindowSize = options.ackWindowSize ?? 100;
    this.storageAdapter = options.storageAdapter ?? new InMemoryDeliveryStorage();
  }

  // ─── Room lifecycle ──────────────────────────────────────────────────────

  /** Get or create a room. */
  private getOrCreateRoom(roomId: string): RoomState {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        nextSeq: 0,
        ringBuffer: new RingBuffer(this.defaultRingBufferSize),
        seenMessageIds: new Set(),
        clients: new Map(),
        deliveryState: new Map(),
      };
      this.rooms.set(roomId, room);
      logger.debug(`[roomManager] created room=${roomId}`);
    }
    return room;
  }

  /** Remove a room if it has no clients AND no buffered messages. */
  private maybeEvictRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room && room.clients.size === 0 && room.ringBuffer.size === 0) {
      this.rooms.delete(roomId);
      logger.debug(`[roomManager] evicted empty room=${roomId}`);
    }
  }

  // ─── Client management ───────────────────────────────────────────────────

  /** Add a client to a room. */
  joinRoom(client: RoomClient): void {
    const room = this.getOrCreateRoom(client.roomId);
    room.clients.set(client.clientId, client);

    // Initialize delivery state if not present
    if (!room.deliveryState.has(client.clientId)) {
      room.deliveryState.set(client.clientId, {
        highestAckedSeq: 0,
        highestDeliveredSeq: -1,
        unackedCount: 0,
        paused: false,
      });
    }

    logger.debug(
      `[roomManager] client=${client.clientId} joined room=${client.roomId} ` +
      `clients=${room.clients.size}`,
    );
    this.emit('client:joined', client);
  }

  /** Remove a client from a room. Cleans up delivery state. */
  leaveRoom(clientId: string, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.clients.delete(clientId);
    room.deliveryState.delete(clientId);
    this.maybeEvictRoom(roomId);

    logger.debug(
      `[roomManager] client=${clientId} left room=${roomId} ` +
      `clients=${room.clients.size}`,
    );
    this.emit('client:left', { clientId, roomId });
  }

  /** Remove a client from all rooms (disconnect). */
  removeClient(clientId: string): void {
    for (const [roomId, room] of this.rooms) {
      if (room.clients.has(clientId)) {
        room.clients.delete(clientId);
        room.deliveryState.delete(clientId);
        this.maybeEvictRoom(roomId);
      }
    }
    // Also clean up storage adapter state
    this.storageAdapter.cleanupClient(clientId).catch(err => {
      logger.warn(`[roomManager] error cleaning up storage for client=${clientId}: ${err}`);
    });

    logger.debug(`[roomManager] removed client=${clientId} from all rooms`);
  }

  // ─── Broadcast ───────────────────────────────────────────────────────────

  /**
   * Broadcast a payload to all clients in a room.
   *
   * Assigns:
   * - UUID v7 messageId for idempotent dedup
   * - Monotonically increasing seq for ordering
   * - Timestamp
   *
   * Respects ACK window: skips clients where unackedCount >= ackWindowSize.
   * Deduplicates: if messageId was already broadcast to this room, drops silently.
   *
   * Returns the assigned MessageEnvelope, or null if dropped (duplicate).
   */
  broadcast(roomId: string, payload: Record<string, unknown>): MessageEnvelope | null {
    const room = this.getOrCreateRoom(roomId);

    const messageId = uuidv7();

    // Dedup check
    if (room.seenMessageIds.has(messageId)) {
      this._totalDuplicatesDropped++;
      logger.debug(`[roomManager] duplicate messageId=${messageId} in room=${roomId}, dropping`);
      return null;
    }

    const seq = room.nextSeq++;
    const timestamp = Date.now();

    const envelope: MessageEnvelope = {
      seq,
      messageId,
      payload,
      timestamp,
    };

    // Store in ring buffer
    room.ringBuffer.push(envelope);
    room.seenMessageIds.add(messageId);

    // Evict old seenMessageIds to bound memory (keep last 10K)
    if (room.seenMessageIds.size > 10_000) {
      const ids = Array.from(room.seenMessageIds);
      for (let i = 0; i < ids.length - 10_000; i++) {
        room.seenMessageIds.delete(ids[i]);
      }
    }

    // Deliver to clients, respecting ACK window
    for (const [_clientId, client] of room.clients) {
      if (client.roomId !== roomId) continue;

      const state = room.deliveryState.get(client.clientId);
      if (state && state.paused) {
        // Client is paused — skip delivery, will be resumed on ACK
        continue;
      }

      try {
        client.send(envelope);
        if (state) {
          state.unackedCount++;
          state.highestDeliveredSeq = seq;
          // Check if window is now full
          if (state.unackedCount >= this.defaultAckWindowSize) {
            state.paused = true;
            logger.debug(
              `[roomManager] paused client=${client.clientId} in room=${roomId} ` +
              `unackedCount=${state.unackedCount} >= window=${this.defaultAckWindowSize}`,
            );
          }
        }
      } catch (err) {
        logger.warn(
          `[roomManager] error sending to client=${client.clientId}: ${err}`,
        );
      }
    }

    this._totalBroadcasts++;
    this.emit('broadcast', envelope);
    return envelope;
  }

  // ─── ACK processing ──────────────────────────────────────────────────────

  /**
   * Process an ACK message from a client.
   * Updates highestAckedSeq, decrements unackedCount, resumes delivery if paused.
   */
  processAck(clientId: string, ack: AckMessage): void {
    const room = this.rooms.get(ack.roomId);
    if (!room) {
      logger.debug(`[roomManager] ACK for unknown room=${ack.roomId}, ignoring`);
      return;
    }

    const state = room.deliveryState.get(clientId);
    if (!state) {
      logger.debug(`[roomManager] ACK from unknown client=${clientId} in room=${ack.roomId}`);
      return;
    }

    const wasPaused = state.paused;

    // Update highest ACKed seq (only advance, never go back)
    if (ack.seq > state.highestAckedSeq) {
      state.highestAckedSeq = ack.seq;
    }

    // Decrement unackedCount (at least 1, since we're acknowledging one message)
    if (state.unackedCount > 0) {
      state.unackedCount--;
    }

    // Persist ACK to storage adapter (Option A — optional, no-op for InMemory)
    this.storageAdapter.ackMessage(clientId, ack.roomId, ack.seq).catch(err => {
      logger.warn(`[roomManager] error persisting ACK: ${err}`);
    });

    // Resume delivery if was paused and window has room
    if (wasPaused && state.unackedCount < this.defaultAckWindowSize) {
      state.paused = false;
      logger.debug(
        `[roomManager] resumed client=${clientId} in room=${ack.roomId} ` +
        `unackedCount=${state.unackedCount}`,
      );
      // Deliver any buffered messages that were skipped
      this.deliverPendingMessages(clientId, ack.roomId);
    }

    this._totalAcks++;
    this.emit('ack', { clientId, roomId: ack.roomId, seq: ack.seq });

    logger.debug(
      `[roomManager] ACK client=${clientId} room=${ack.roomId} seq=${ack.seq} ` +
      `highestAckedSeq=${state.highestAckedSeq} unackedCount=${state.unackedCount}`,
    );
  }

  /**
   * After a client is unpaused, deliver any pending messages it missed.
   * Uses highestDeliveredSeq to avoid re-sending messages the client already received.
   */
  private deliverPendingMessages(clientId: string, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const client = room.clients.get(clientId);
    const state = room.deliveryState.get(clientId);
    if (!client || !state) return;

    // Find messages the client hasn't received yet (seq > highestDeliveredSeq)
    const pending = room.ringBuffer.getSince(state.highestDeliveredSeq);
    for (const envelope of pending) {
      if (state.paused) break; // Window full again
      try {
        client.send(envelope);
        state.unackedCount++;
        state.highestDeliveredSeq = envelope.seq;
        if (state.unackedCount >= this.defaultAckWindowSize) {
          state.paused = true;
        }
      } catch (err) {
        logger.warn(`[roomManager] error sending pending to client=${clientId}: ${err}`);
      }
    }
  }

  // ─── NACK processing ─────────────────────────────────────────────────────

  /**
   * Process a NACK message from a client.
   * Re-sends the specific message (bypasses ACK window).
   */
  processNack(clientId: string, nack: NackMessage): void {
    const room = this.rooms.get(nack.roomId);
    if (!room) {
      logger.debug(`[roomManager] NACK for unknown room=${nack.roomId}, ignoring`);
      return;
    }

    const client = room.clients.get(clientId);
    if (!client) {
      logger.debug(`[roomManager] NACK from unknown client=${clientId} in room=${nack.roomId}`);
      return;
    }

    // Find the message in the ring buffer
    const envelope = room.ringBuffer.findBySeq(nack.seq);
    if (!envelope) {
      logger.warn(
        `[roomManager] NACK seq=${nack.seq} not found in ring buffer for room=${nack.roomId}`,
      );
      return;
    }

    // Re-send immediately (bypasses ACK window)
    try {
      client.send(envelope);
      logger.info(
        `[roomManager] re-sent seq=${nack.seq} to client=${clientId} ` +
        `in room=${nack.roomId} reason=${nack.reason}`,
      );
    } catch (err) {
      logger.warn(`[roomManager] error re-sending to client=${clientId}: ${err}`);
    }

    this._totalNacks++;
    this.emit('nack', { clientId, roomId: nack.roomId, seq: nack.seq, reason: nack.reason });
  }

  // ─── Reconnect ───────────────────────────────────────────────────────────

  /**
   * Handle a client reconnect with lastSeq and highestAckedSeq.
   *
   * Replays messages with seq > max(lastSeq, highestAckedSeq).
   * Uses highestAckedSeq from client as source of truth (Option B).
   */
  processReconnect(clientId: string, reconnect: ReconnectMessage, sendFn: (data: MessageEnvelope) => void): void {
    const room = this.rooms.get(reconnect.roomId);
    if (!room) {
      logger.debug(`[roomManager] reconnect to unknown room=${reconnect.roomId}`);
      return;
    }

    const protocolVersion = (reconnect.protocolVersion ?? PROTOCOL_VERSION_V1) as ProtocolVersion;

    // Register the client with the new send function
    const client: RoomClient = {
      clientId,
      roomId: reconnect.roomId,
      protocolVersion,
      send: sendFn,
    };

    // Remove old client entry if exists
    room.clients.delete(clientId);
    room.clients.set(clientId, client);

    // Determine the replay start point: highestAckedSeq
    // Per issue #226: "Server replays messages with seq > highestAckedSeq — not seq > lastSeq"
    // The client's highestAckedSeq is the source of truth (Option B).
    // Messages the client already acknowledged should never be re-sent.
    const replayFrom = reconnect.highestAckedSeq;

    // Update delivery state — client reports highestAckedSeq as truth
    room.deliveryState.set(clientId, {
      highestAckedSeq: reconnect.highestAckedSeq,
      highestDeliveredSeq: -1,
      unackedCount: 0,
      paused: false,
    });

    // Replay messages from the ring buffer
    const replayMessages = room.ringBuffer.getSince(replayFrom);

    logger.info(
      `[roomManager] reconnect client=${clientId} room=${reconnect.roomId} ` +
      `replayFrom=${replayFrom} replayCount=${replayMessages.length}`,
    );

    for (const envelope of replayMessages) {
      try {
        sendFn(envelope);
        const state = room.deliveryState.get(clientId);
        if (state) {
          state.unackedCount++;
          state.highestDeliveredSeq = envelope.seq;
          if (state.unackedCount >= this.defaultAckWindowSize) {
            state.paused = true;
          }
        }
      } catch (err) {
        logger.warn(`[roomManager] error replaying to client=${clientId}: ${err}`);
      }
    }

    this._totalReconnects++;
    this.emit('reconnect', { clientId, roomId: reconnect.roomId, replayFrom, replayCount: replayMessages.length });
  }

  // ─── Query helpers ───────────────────────────────────────────────────────

  /** Get the current sequence number for a room (next seq to be assigned). */
  getCurrentSeq(roomId: string): number {
    return this.rooms.get(roomId)?.nextSeq ?? 0;
  }

  /** Get the ring buffer contents for a room. */
  getRingBuffer(roomId: string): MessageEnvelope[] {
    return this.rooms.get(roomId)?.ringBuffer.getAll() ?? [];
  }

  /** Get delivery state for a client in a room. */
  getDeliveryState(clientId: string, roomId: string): ClientDeliveryState | undefined {
    return this.rooms.get(roomId)?.deliveryState.get(clientId);
  }

  /** Get the list of client IDs in a room. */
  getRoomClients(roomId: string): string[] {
    return Array.from(this.rooms.get(roomId)?.clients.keys() ?? []);
  }

  /** Number of active rooms. */
  get roomCount(): number {
    return this.rooms.size;
  }

  /** Aggregate metrics. */
  get metrics() {
    return {
      totalBroadcasts: this._totalBroadcasts,
      totalAcks: this._totalAcks,
      totalNacks: this._totalNacks,
      totalReconnects: this._totalReconnects,
      totalDuplicatesDropped: this._totalDuplicatesDropped,
      activeRooms: this.rooms.size,
    };
  }

  /** Reset metrics (for tests). */
  resetMetrics(): void {
    this._totalBroadcasts = 0;
    this._totalAcks = 0;
    this._totalNacks = 0;
    this._totalReconnects = 0;
    this._totalDuplicatesDropped = 0;
  }

  /** Reset singleton state (for tests). */
  reset(): void {
    this.rooms.clear();
    this.resetMetrics();
  }
}

/** Convenience singleton accessor. */
let _instance: RoomManager | null = null;

export function getRoomManager(options?: RoomManagerOptions): RoomManager {
  if (!_instance) {
    _instance = new RoomManager(options);
  }
  return _instance;
}

export function resetRoomManager(): void {
  if (_instance) {
    _instance.reset();
    _instance = null;
  }
}
