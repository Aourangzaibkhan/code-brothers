import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Transport-options object accepted by `nodemailer.createTransport`
 * (SMTP / SMTP pool / sendmail / stream / JSON / SES option bags).
 *
 * Spelled out structurally: `Parameters<typeof createTransport>[0]` only
 * captures the factory's last (generic) overload, and nodemailer's per-
 * transport option types live on unexported `lib/*` subpaths that NodeNext
 * resolution cannot reach — while the factory itself dispatches on these
 * option keys at runtime.
 */
export interface EmailTransportOptions {
  host?: string;
  port?: number;
  secure?: boolean;
  auth?: { user: string; pass: string };
  jsonTransport?: boolean;
  streamTransport?: boolean;
  sendmail?: boolean;
  [key: string]: unknown;
}

/**
 * Email sending over nodemailer with an injectable transport.
 *
 * Tests (and offline development) can pass nodemailer's `jsonTransport`:
 * `send` then resolves with the parsed JSON message surfaced as `raw`,
 * alongside the generated `messageId` — no SMTP server involved.
 */

export interface SendEmailInput {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

export interface SendEmailResult {
  messageId: string;
  /** The raw message (JSON string) when the transport produces one. */
  raw?: string;
}

export interface EmailSender {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

export interface CreateEmailSenderOptions {
  /** A ready-made nodemailer transporter (wins over `transport`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transporter?: Transporter<any, any>;
  /** Transport options passed to `nodemailer.createTransport`. */
  transport?: EmailTransportOptions | string;
}

// The overloaded factory, narrowed once to the call shape used here.
const createTransport = nodemailer.createTransport as unknown as (
  transport: EmailTransportOptions | string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Transporter<any, any>;

export function createEmailSender(
  options: CreateEmailSenderOptions = {},
): EmailSender {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transporter: Transporter<any, any> =
    options.transporter ??
    (options.transport
      ? createTransport(options.transport)
      : createTransport({ jsonTransport: true }));

  return {
    async send(input: SendEmailInput): Promise<SendEmailResult> {
      const info = (await transporter.sendMail({
        from: input.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
      })) as {
        messageId?: string;
        message?: unknown;
      };
      let raw: string | undefined;
      if (typeof info.message === 'string') {
        raw = info.message;
      } else if (Buffer.isBuffer(info.message)) {
        raw = info.message.toString('utf8');
      }
      let messageId = info.messageId ?? '';
      if (!messageId && raw) {
        // jsonTransport embeds the full message JSON; its headers carry the id.
        try {
          const parsed = JSON.parse(raw) as { messageId?: string };
          if (typeof parsed.messageId === 'string') messageId = parsed.messageId;
        } catch {
          // raw was not JSON — keep the transport-provided id (possibly '').
        }
      }
      return { messageId, raw };
    },
  };
}
