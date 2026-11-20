import {
  QrEventEmitter,
  type QrSessionEngine,
  type QrSessionEventMap,
  type QrSessionState,
  type SessionCipher,
  type SessionStore,
} from './qr-engine.js';
import type { NormalizedIncomingMessage } from './types.js';

/**
 * Real QR engine backed by @whiskeysockets/baileys (WhatsApp Web protocol).
 *
 * The library is loaded with a dynamic import inside connect() so merely
 * importing this module never opens sockets or pulls the heavy dependency
 * into test runs. Auth state is NOT stored on disk by Baileys here: creds
 * and signal keys live in a single JSON blob (BufferJSON-serialized) that
 * is encrypted with the injected platform cipher before it touches the
 * SessionStore — sessions stay encrypted at rest, per the platform rules.
 */

interface BaileysSocketLike {
  ev: {
    on(event: string, handler: (arg: never) => void): void;
  };
  sendMessage(
    jid: string,
    content: { text: string },
  ): Promise<{ key?: { id?: string | null } } | undefined>;
  end(error?: Error): void;
  logout(msg?: string): Promise<void>;
}

interface StoredAuthBlob {
  creds: unknown;
  keys: Record<string, Record<string, unknown>>;
}

export interface BaileysQrEngineOptions {
  sessionId: string;
  store: SessionStore;
  cipher: SessionCipher;
}

type BaileysModule = typeof import('@whiskeysockets/baileys');

export class BaileysQrEngine implements QrSessionEngine {
  readonly sessionId: string;
  private readonly store: SessionStore;
  private readonly cipher: SessionCipher;
  private readonly emitter = new QrEventEmitter();
  private currentState: QrSessionState = 'disconnected';
  private socket: BaileysSocketLike | undefined;

  constructor(options: BaileysQrEngineOptions) {
    this.sessionId = options.sessionId;
    this.store = options.store;
    this.cipher = options.cipher;
  }

  get state(): QrSessionState {
    return this.currentState;
  }

  on<E extends keyof QrSessionEventMap>(
    event: E,
    handler: QrSessionEventMap[E],
  ): void {
    this.emitter.on(event, handler);
  }

  private setState(state: QrSessionState): void {
    this.currentState = state;
    this.emitter.emit('state', state);
  }

  async connect(): Promise<void> {
    if (this.socket) return;
    const baileys: BaileysModule = await import('@whiskeysockets/baileys');
    const { BufferJSON, initAuthCreds } = baileys;
    const makeWASocket = baileys.default;

    // ---- Load (or create) the encrypted-at-rest auth state. ----
    let stored: StoredAuthBlob = { creds: undefined, keys: {} };
    const blob = await this.store.load(this.sessionId);
    if (blob) {
      const plain = await this.cipher.decrypt(blob);
      stored = JSON.parse(plain, BufferJSON.reviver) as StoredAuthBlob;
    }
    const creds = (stored.creds as object | undefined) ?? initAuthCreds();
    const keyData: Record<string, Record<string, unknown>> = stored.keys ?? {};

    const persist = async (): Promise<void> => {
      const serialized = JSON.stringify(
        { creds: authState.creds, keys: keyData },
        BufferJSON.replacer,
      );
      await this.store.save(this.sessionId, await this.cipher.encrypt(serialized));
    };

    const authState = {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const bucket = keyData[type] ?? {};
          const out: Record<string, unknown> = {};
          for (const id of ids) {
            if (bucket[id] !== undefined) out[id] = bucket[id];
          }
          return out;
        },
        set: async (data: Record<string, Record<string, unknown>>) => {
          for (const [type, values] of Object.entries(data)) {
            const bucket = (keyData[type] ??= {});
            for (const [id, value] of Object.entries(values)) {
              if (value === null || value === undefined) delete bucket[id];
              else bucket[id] = value;
            }
          }
          await persist();
        },
      },
    };

    const sock = makeWASocket({
      auth: authState as never,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
    }) as unknown as BaileysSocketLike;
    this.socket = sock;

    sock.ev.on('creds.update', () => {
      void persist();
    });

    sock.ev.on(
      'connection.update',
      (update: {
        connection?: string;
        qr?: string;
        lastDisconnect?: { error?: { output?: { statusCode?: number } } };
      }) => {
        if (update.qr) {
          this.setState('qr');
          this.emitter.emit('qr', update.qr);
        }
        if (update.connection === 'connecting') this.setState('connecting');
        if (update.connection === 'open') this.setState('connected');
        if (update.connection === 'close') {
          const statusCode = update.lastDisconnect?.error?.output?.statusCode;
          const loggedOut = statusCode === baileys.DisconnectReason.loggedOut;
          this.socket = undefined;
          this.setState('disconnected');
          if (loggedOut) {
            void this.store.delete(this.sessionId);
            this.emitter.emit(
              'error',
              new Error(
                `WhatsApp session "${this.sessionId}" was logged out; stored session deleted`,
              ),
            );
          }
        }
      },
    );

    sock.ev.on(
      'messages.upsert',
      (event: { messages?: Array<Record<string, unknown>>; type?: string }) => {
        if (event.type !== 'notify') return;
        for (const raw of event.messages ?? []) {
          const normalized = normalizeBaileysMessage(raw);
          if (normalized) this.emitter.emit('message', normalized);
        }
      },
    );
  }

  async disconnect(): Promise<void> {
    this.socket?.end(undefined);
    this.socket = undefined;
    if (this.currentState !== 'disconnected') this.setState('disconnected');
  }

  async logout(): Promise<void> {
    try {
      await this.socket?.logout();
    } catch {
      // Socket may already be gone; local cleanup below is what matters.
    }
    this.socket = undefined;
    await this.store.delete(this.sessionId);
    if (this.currentState !== 'disconnected') this.setState('disconnected');
  }

  async sendText(to: string, text: string): Promise<{ messageId: string }> {
    if (!this.socket || this.currentState !== 'connected') {
      throw new Error(
        `Cannot send while session "${this.sessionId}" is "${this.currentState}"`,
      );
    }
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    const result = await this.socket.sendMessage(jid, { text });
    return { messageId: result?.key?.id ?? '' };
  }
}

function normalizeBaileysMessage(
  raw: Record<string, unknown>,
): NormalizedIncomingMessage | undefined {
  const key = raw['key'] as
    | { remoteJid?: string; fromMe?: boolean; id?: string }
    | undefined;
  if (!key || key.fromMe) return undefined;
  const message = (raw['message'] ?? {}) as Record<string, unknown>;
  let type = 'unknown';
  let text: string | undefined;
  let caption: string | undefined;
  if (typeof message['conversation'] === 'string') {
    type = 'text';
    text = message['conversation'];
  } else if (message['extendedTextMessage']) {
    type = 'text';
    text = (message['extendedTextMessage'] as { text?: string }).text;
  } else if (message['imageMessage']) {
    type = 'image';
    caption = (message['imageMessage'] as { caption?: string }).caption;
  } else if (message['videoMessage']) {
    type = 'video';
    caption = (message['videoMessage'] as { caption?: string }).caption;
  } else if (message['documentMessage']) {
    type = 'document';
    caption = (message['documentMessage'] as { caption?: string }).caption;
  } else if (message['audioMessage']) {
    type = 'audio';
  } else if (message['locationMessage']) {
    type = 'location';
  }
  const from = (key.remoteJid ?? '').split('@')[0] ?? '';
  return {
    kind: 'message',
    messageId: key.id ?? '',
    from,
    senderName: raw['pushName'] as string | undefined,
    timestamp: Number(raw['messageTimestamp'] ?? 0),
    type,
    text,
    caption,
  };
}
