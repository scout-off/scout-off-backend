import { z } from 'zod';

// ─── Protocol version ────────────────────────────────────────────────────────
// v1: legacy (no ACKs, no messageId, at-least-once)
// v2: exactly-once delivery (ACKs, messageId, flow control)
export const PROTOCOL_VERSION_V1 = 1 as const;
export const PROTOCOL_VERSION_V2 = 2 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION_V1 | typeof PROTOCOL_VERSION_V2;

// ─── Server → Client: Message envelope ───────────────────────────────────────

/** Ring buffer entry / broadcast envelope delivered to clients. */
export const MessageEnvelopeSchema = z.object({
  seq: z.number().int().min(0),
  messageId: z.string().uuid(),
  payload: z.record(z.unknown()),
  timestamp: z.number().int().min(0),
});
export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;

// ─── Client → Server: Acknowledgment ────────────────────────────────────────

export const AckMessageSchema = z.object({
  type: z.literal('ack'),
  roomId: z.string().min(1),
  seq: z.number().int().min(0),
});
export type AckMessage = z.infer<typeof AckMessageSchema>;

// ─── Client → Server: Negative acknowledgment ───────────────────────────────

export const NackMessageSchema = z.object({
  type: z.literal('nack'),
  roomId: z.string().min(1),
  seq: z.number().int().min(0),
  reason: z.string().min(1).max(500),
});
export type NackMessage = z.infer<typeof NackMessageSchema>;

// ─── Client → Server: Reconnect request ─────────────────────────────────────

export const ReconnectMessageSchema = z.object({
  type: z.literal('reconnect'),
  roomId: z.string().min(1),
  lastSeq: z.number().int().min(0),
  /** Highest sequence number the client successfully processed and persisted. */
  highestAckedSeq: z.number().int().min(0),
  /** Client protocol version — v1 clients omit this field. */
  protocolVersion: z.number().int().min(1).max(2).optional(),
});
export type ReconnectMessage = z.infer<typeof ReconnectMessageSchema>;

// ─── Client → Server: Join room ─────────────────────────────────────────────

export const JoinMessageSchema = z.object({
  type: z.literal('join'),
  roomId: z.string().min(1),
  /** Client protocol version — v1 clients omit this field. */
  protocolVersion: z.number().int().min(1).max(2).optional(),
});
export type JoinMessage = z.infer<typeof JoinMessageSchema>;

// ─── Client → Server: Leave room ────────────────────────────────────────────

export const LeaveMessageSchema = z.object({
  type: z.literal('leave'),
  roomId: z.string().min(1),
});
export type LeaveMessage = z.infer<typeof LeaveMessageSchema>;

// ─── Discriminated union of all client → server messages ─────────────────────

export const ClientMessageSchema = z.discriminatedUnion('type', [
  AckMessageSchema,
  NackMessageSchema,
  ReconnectMessageSchema,
  JoinMessageSchema,
  LeaveMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ─── Validation helpers ──────────────────────────────────────────────────────

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Validate an incoming raw WebSocket message against the client message schema.
 * Returns a typed result or a human-readable error string.
 */
export function validateClientMessage(raw: unknown): ValidationResult<ClientMessage> {
  const result = ClientMessageSchema.safeParse(raw);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
  return { success: false, error: issues };
}

/**
 * Validate a server-side message envelope before sending to a client.
 */
export function validateMessageEnvelope(raw: unknown): ValidationResult<MessageEnvelope> {
  const result = MessageEnvelopeSchema.safeParse(raw);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
  return { success: false, error: issues };
}

/**
 * Type guard: does this message represent an ACK?
 */
export function isAckMessage(msg: ClientMessage): msg is AckMessage {
  return msg.type === 'ack';
}

/**
 * Type guard: does this message represent a NACK?
 */
export function isNackMessage(msg: ClientMessage): msg is NackMessage {
  return msg.type === 'nack';
}

/**
 * Type guard: does this message represent a reconnect request?
 */
export function isReconnectMessage(msg: ClientMessage): msg is ReconnectMessage {
  return msg.type === 'reconnect';
}
