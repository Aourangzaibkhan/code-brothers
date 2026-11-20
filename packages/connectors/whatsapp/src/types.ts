/** Shared types for the WhatsApp connector (Cloud API + QR socket engine). */

/** Minimal fetch contract so tests can inject stubs. */
export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/** A normalized incoming WhatsApp message, regardless of source engine. */
export interface NormalizedIncomingMessage {
  kind: 'message';
  messageId: string;
  /** Sender phone number in international format (no '+'). */
  from: string;
  /** Sender profile name, when the payload carries it. */
  senderName?: string;
  /** Unix epoch seconds. */
  timestamp: number;
  /** WhatsApp message type: text, image, video, document, audio, location, ... */
  type: string;
  text?: string;
  mediaId?: string;
  caption?: string;
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  /** Business phone number id the message was received on (Cloud API). */
  phoneNumberId?: string;
}

/** A normalized delivery/read status update for a previously sent message. */
export interface NormalizedMessageStatus {
  kind: 'status';
  messageId: string;
  recipientId: string;
  status: string; // sent | delivered | read | failed | ...
  timestamp: number;
  phoneNumberId?: string;
}

export type NormalizedWhatsAppEvent =
  | NormalizedIncomingMessage
  | NormalizedMessageStatus;
