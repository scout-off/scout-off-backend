import { EventEmitter } from 'events';
import { RoomManager, RoomManagerOptions } from '../room-manager';
import {
  validateClientMessage,
  isAckMessage,
  isNackMessage,
  isReconnectMessage,
  ClientMessage,
  MessageEnvelope,
  ProtocolVersion,
  PROTOCOL_VERSION_V1,
} from '../validator';
import { logger } from '../utils/logger';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DeliveryManagerOptions extends RoomManagerOptions {
  /** Enable debug logging for every processed message. Default: false. */
  debugLogging?: boolean;
}

interface ClientInfo {
  clientId: string;
  protocolVersion: number;
  connectedAt: number;
}

// ─── DeliveryManager ────────────────────────────────────────────────────────

/**
 * High-level orchestrator for the exactly-once delivery protocol.
 *
 * Integrates with RoomManager and provides:
 * - WebSocket message handling (parse, validate, dispatch)
 * - Client connection/disconnection lifecycle
 * - Broadcast API with geofence event support
 * - Metrics and observability
 *
 * Usage:
 *   const dm = new DeliveryManager();
 *   // On WS connection:
 *   dm.handleClientConnect(clientId, ws);
 *   // On WS message:
 *   dm.handleMessage(clientId, rawData);
 *   // On WS close:
 *   dm.handleClientDisconnect(clientId);
 *   // Broadcast to a room:
 *   dm.broadcast(roomId, { event: 'geofence_entry', ... });
 */
export class DeliveryManager extends EventEmitter {
  private roomManager: RoomManager;
  private clients = new Map<string, ClientInfo>();
  private readonly debugLogging: boolean;

  constructor(options: DeliveryManagerOptions = {}) {
    super();
    this.debugLogging = options.debugLogging ?? false;
    this.roomManager = new RoomManager(options);

    // Forward room manager events
    this.roomManager.on('broadcast', (envelope: MessageEnvelope) => {
      this.emit('broadcast', envelope);
    });
    this.roomManager.on('ack', (data: { clientId: string; roomId: string; seq: number }) => {
      this.emit('ack', data);
    });
    this.roomManager.on('nack', (data: { clientId: string; roomId: string; seq: number; reason: string }) => {
      this.emit('nack', data);
    });
  }

  // ─── Client lifecycle ────────────────────────────────────────────────────

  /** Register a new WebSocket client connection. */
  handleClientConnect(clientId: string, sendFn: (data: MessageEnvelope) => void, protocolVersion = 1): void {
    this.clients.set(clientId, {
      clientId,
      protocolVersion,
      connectedAt: Date.now(),
    });

    if (this.debugLogging) {
      logger.debug(`[deliveryManager] client connected: ${clientId}`);
    }
    this.emit('client:connected', clientId);
  }

  /** Handle client disconnection — clean up all room state. */
  handleClientDisconnect(clientId: string): void {
    this.roomManager.removeClient(clientId);
    this.clients.delete(clientId);

    if (this.debugLogging) {
      logger.debug(`[deliveryManager] client disconnected: ${clientId}`);
    }
    this.emit('client:disconnected', clientId);
  }

  // ─── Message handling ────────────────────────────────────────────────────

  /**
   * Process a raw WebSocket message from a client.
   * Validates, parses, and dispatches to the appropriate handler.
   * Returns a human-readable error string if validation fails, null on success.
   */
  handleMessage(clientId: string, raw: unknown, sendFn: (data: MessageEnvelope) => void): string | null {
    const result = validateClientMessage(raw);
    if (!result.success) {
      const errMsg = `Invalid message: ${result.error}`;
      if (this.debugLogging) {
        logger.debug(`[deliveryManager] ${errMsg} from client=${clientId}`);
      }
      return errMsg;
    }

    const msg = result.data!;

    if (isAckMessage(msg)) {
      this.roomManager.processAck(clientId, msg);
      return null;
    }

    if (isNackMessage(msg)) {
      this.roomManager.processNack(clientId, msg);
      return null;
    }

    if (isReconnectMessage(msg)) {
      // Update protocol version if provided
      const client = this.clients.get(clientId);
      if (client && msg.protocolVersion) {
        client.protocolVersion = msg.protocolVersion;
      }
      this.roomManager.processReconnect(clientId, msg, sendFn);
      return null;
    }

    if (msg.type === 'join') {
      const protocolVersion = (msg.protocolVersion ?? PROTOCOL_VERSION_V1) as ProtocolVersion;
      const client: RoomClient = {
        clientId,
        roomId: msg.roomId,
        protocolVersion,
        send: sendFn,
      };
      this.roomManager.joinRoom(client);
      return null;
    }

    if (msg.type === 'leave') {
      this.roomManager.leaveRoom(clientId, msg.roomId);
      return null;
    }

    // Exhaustive check — TypeScript will error if a case is missing
    const _exhaustive: never = msg;
    return `Unhandled message type: ${JSON.stringify(_exhaustive)}`;
  }

  // ─── Broadcast ───────────────────────────────────────────────────────────

  /**
   * Broadcast a payload to all clients in a room.
   * Returns the MessageEnvelope with assigned seq and messageId, or null if duplicate.
   */
  broadcast(roomId: string, payload: Record<string, unknown>): MessageEnvelope | null {
    return this.roomManager.broadcast(roomId, payload);
  }

  // ─── Query helpers ───────────────────────────────────────────────────────

  /** Get the RoomManager instance. */
  getRoomManager(): RoomManager {
    return this.roomManager;
  }

  /** Get info about a connected client. */
  getClientInfo(clientId: string): ClientInfo | undefined {
    return this.clients.get(clientId);
  }

  /** Number of connected clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Aggregate metrics from the room manager + local counters. */
  get metrics() {
    return {
      ...this.roomManager.metrics,
      connectedClients: this.clients.size,
    };
  }

  /** Reset all state (for tests). */
  reset(): void {
    this.roomManager.reset();
    this.clients.clear();
  }
}

// Re-export RoomClient for consumers
import { RoomClient } from '../room-manager';
export { RoomClient };
