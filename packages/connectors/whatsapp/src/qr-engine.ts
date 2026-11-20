import type { NormalizedIncomingMessage } from './types.js';

/**
 * QR socket engine contract (WhatsApp "Mode A" — free, no Meta app needed).
 *
 * State machine: disconnected -> qr -> connecting -> connected, and back to
 * disconnected on logout/close. When a stored session exists, connect()
 * skips the QR step: disconnected -> connecting -> connected.
 *
 * Sessions are ALWAYS stored encrypted at rest: engines hand the
 * SessionStore an opaque blob produced by the injected cipher, never raw
 * credentials.
 */
export type QrSessionState = 'disconnected' | 'qr' | 'connecting' | 'connected';

export interface QrSessionEventMap {
  qr: (qrPayload: string) => void;
  state: (state: QrSessionState) => void;
  message: (message: NormalizedIncomingMessage) => void;
  error: (error: Error) => void;
}

export interface SessionStore {
  save(sessionId: string, encryptedBlob: string): Promise<void>;
  load(sessionId: string): Promise<string | undefined>;
  delete(sessionId: string): Promise<void>;
}

/** In-memory SessionStore for tests and ephemeral runs. */
export class MemorySessionStore implements SessionStore {
  private readonly blobs = new Map<string, string>();
  async save(sessionId: string, encryptedBlob: string): Promise<void> {
    this.blobs.set(sessionId, encryptedBlob);
  }
  async load(sessionId: string): Promise<string | undefined> {
    return this.blobs.get(sessionId);
  }
  async delete(sessionId: string): Promise<void> {
    this.blobs.delete(sessionId);
  }
  /** Test/inspection helper: is a blob stored for this session? */
  has(sessionId: string): boolean {
    return this.blobs.has(sessionId);
  }
}

/** Encrypt/decrypt pair injected by the platform vault. */
export interface SessionCipher {
  encrypt(plaintext: string): Promise<string> | string;
  decrypt(blob: string): Promise<string> | string;
}

export interface QrSessionEngine {
  readonly sessionId: string;
  readonly state: QrSessionState;
  on<E extends keyof QrSessionEventMap>(
    event: E,
    handler: QrSessionEventMap[E],
  ): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Drop the stored session (phone must scan a fresh QR next time). */
  logout(): Promise<void>;
  sendText(to: string, text: string): Promise<{ messageId: string }>;
}

/** Tiny typed event emitter shared by the engine implementations. */
export class QrEventEmitter {
  private readonly handlers = new Map<string, Set<(arg: never) => void>>();

  on<E extends keyof QrSessionEventMap>(event: E, handler: QrSessionEventMap[E]): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (arg: never) => void);
  }

  emit<E extends keyof QrSessionEventMap>(
    event: E,
    arg: Parameters<QrSessionEventMap[E]>[0],
  ): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as (a: unknown) => void)(arg);
    }
  }
}

export interface SimulatedQrEngineOptions {
  sessionId: string;
  store: SessionStore;
  cipher: SessionCipher;
  /** Phone number the simulated account "has" once connected. */
  phoneNumber?: string;
  sleep?: (ms: number) => Promise<void>;
}

interface SimulatedCreds {
  phoneNumber: string;
  registeredAt: number;
}

/**
 * Simulated QR engine implementing the exact same state machine and
 * encrypted-session lifecycle as the real Baileys engine. Used for tests,
 * demos and CI — no phone and no WhatsApp network involved. A "scan" is
 * triggered by calling simulateScan() while in the `qr` state.
 */
export class SimulatedQrEngine implements QrSessionEngine {
  readonly sessionId: string;
  private readonly store: SessionStore;
  private readonly cipher: SessionCipher;
  private readonly phoneNumber: string;
  private readonly emitter = new QrEventEmitter();
  private readonly sleep: (ms: number) => Promise<void>;
  private currentState: QrSessionState = 'disconnected';
  private creds: SimulatedCreds | undefined;
  private messageCounter = 0;

  constructor(options: SimulatedQrEngineOptions) {
    this.sessionId = options.sessionId;
    this.store = options.store;
    this.cipher = options.cipher;
    this.phoneNumber = options.phoneNumber ?? '15551234567';
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get state(): QrSessionState {
    return this.currentState;
  }

  on<E extends keyof QrSessionEventMap>(event: E, handler: QrSessionEventMap[E]): void {
    this.emitter.on(event, handler);
  }

  private setState(state: QrSessionState): void {
    this.currentState = state;
    this.emitter.emit('state', state);
  }

  async connect(): Promise<void> {
    if (this.currentState === 'connected' || this.currentState === 'connecting') {
      return;
    }
    const blob = await this.store.load(this.sessionId);
    if (blob) {
      // Existing session: restore without a QR scan.
      this.setState('connecting');
      try {
        const plain = await this.cipher.decrypt(blob);
        this.creds = JSON.parse(plain) as SimulatedCreds;
      } catch {
        await this.store.delete(this.sessionId);
        this.emitter.emit(
          'error',
          new Error(`Stored session for "${this.sessionId}" could not be decrypted`),
        );
        this.setState('disconnected');
        throw new Error(`Stored session for "${this.sessionId}" is unreadable`);
      }
      await this.sleep(0);
      this.setState('connected');
      return;
    }
    this.setState('qr');
    this.emitter.emit(
      'qr',
      `cb-sim-qr:${this.sessionId}:${Date.now().toString(36)}`,
    );
  }

  /** Simulate the user scanning the QR code with their phone. */
  async simulateScan(): Promise<void> {
    if (this.currentState !== 'qr') {
      throw new Error(
        `simulateScan() requires the "qr" state, currently "${this.currentState}"`,
      );
    }
    this.setState('connecting');
    this.creds = { phoneNumber: this.phoneNumber, registeredAt: Date.now() };
    const encrypted = await this.cipher.encrypt(JSON.stringify(this.creds));
    await this.store.save(this.sessionId, encrypted);
    await this.sleep(0);
    this.setState('connected');
  }

  async disconnect(): Promise<void> {
    if (this.currentState !== 'disconnected') this.setState('disconnected');
  }

  async logout(): Promise<void> {
    await this.store.delete(this.sessionId);
    this.creds = undefined;
    await this.disconnect();
  }

  async sendText(to: string, text: string): Promise<{ messageId: string }> {
    if (this.currentState !== 'connected' || !this.creds) {
      throw new Error(
        `Cannot send while session "${this.sessionId}" is "${this.currentState}"`,
      );
    }
    void to;
    void text;
    this.messageCounter += 1;
    return { messageId: `sim-${this.sessionId}-${this.messageCounter}` };
  }

  /** The connected account's phone number, once known. */
  get connectedPhoneNumber(): string | undefined {
    return this.creds?.phoneNumber;
  }
}
