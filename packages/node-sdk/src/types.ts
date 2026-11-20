/**
 * Core type contract for Code Brothers nodes (connectors, triggers, actions).
 *
 * A node is a self-describing plugin: it declares its input/output schemas,
 * the parameters it accepts, the credentials it needs and the permissions it
 * requires, plus an `execute` function that the workflow engine calls.
 */

/** JSON values that can flow through a workflow. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A deliberately small, plain-object JSON-Schema-ish description used for
 * node inputs, outputs and credential fields. It is data, not a validator.
 */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  [key: string]: unknown;
}

/** One user-configurable parameter of a node instance. */
export interface NodeParameterDefinition {
  name: string;
  displayName: string;
  type: 'string' | 'number' | 'boolean' | 'options' | 'json' | 'collection';
  description?: string;
  required?: boolean;
  default?: unknown;
  options?: Array<{ name: string; value: string }>;
}

/** A credential slot a node needs (values live in the encrypted vault). */
export interface CredentialRequirement {
  /** Slot name, e.g. `shopifyApi`. Used with `ctx.getCredentials(name)`. */
  name: string;
  displayName: string;
  required?: boolean;
  /** Expected fields inside the credential object, e.g. `['apiKey', 'shop']`. */
  fields?: string[];
}

/**
 * Permission manifest: what a node is allowed to touch. The platform uses it
 * to sandbox and audit connectors before they ever run.
 */
export interface PermissionManifest {
  network?: {
    /** Allowed outbound hosts. `'*'` means any host (still SSRF-guarded). */
    hosts: string[];
  };
  /** API scopes the node uses, e.g. `['orders:read', 'inventory:write']`. */
  scopes?: string[];
  filesystem?: 'none' | 'read' | 'readwrite';
  description?: string;
}

/** A single data item flowing between nodes. */
export interface NodeItem {
  json: Record<string, unknown>;
  binary?: Record<string, unknown>;
  pairedItem?: number;
}

/** Items arriving on a node's (single, main) input. */
export type NodeInputData = NodeItem[];

/**
 * Items a node returns: an array of output branches, where each branch is an
 * array of items. A plain action returns `[items]`; an IF node returns
 * `[trueItems, falseItems]`.
 */
export type NodeOutputData = NodeItem[][];

/** Structured logger handed to nodes. Entries are redacted before this. */
export interface NodeLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Everything a node may use while executing. The engine builds one context
 * per node execution; nodes must never reach for globals (process, fs, raw
 * network) directly — they go through this context so the platform can
 * redact logs, guard HTTP and inject credentials safely.
 */
export interface NodeContext {
  executionId: string;
  workflowId: string;
  nodeId: string;
  nodeType: string;
  /** Resolved parameters of this node instance (raw, templates unrendered). */
  parameters: Record<string, unknown>;
  /** Logger whose output is passed through the platform secret redactor. */
  logger: NodeLogger;
  /** Workflow-level variables (read-only). */
  variables: Readonly<Record<string, unknown>>;
  /** Fetch a credential object from the vault by slot name. */
  getCredentials(name: string): Promise<Record<string, unknown> | undefined>;
  /** SSRF-guarded fetch. Throws before connecting to forbidden targets. */
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
  /**
   * Evaluate a sandboxed expression (the inside of `{{ ... }}`) against the
   * run data. `itemJson` becomes `$json`; upstream results are `$node`.
   */
  evaluateExpression(
    source: string,
    itemJson?: Record<string, unknown>,
  ): unknown;
  /**
   * Render a template value: a string that is exactly one `{{ ... }}`
   * returns the typed value; embedded expressions are string-interpolated.
   * Non-string values pass through unchanged.
   */
  renderTemplate(
    template: unknown,
    itemJson?: Record<string, unknown>,
  ): unknown;
  /** Engine-provided sleep (injectable so tests never really wait). */
  sleep(ms: number): Promise<void>;
}

/** The full plugin contract every node (built-in or connector) implements. */
export interface NodeDefinition {
  /** Unique type id, e.g. `core.httpRequest` or `shopify.createOrder`. */
  type: string;
  displayName: string;
  description: string;
  version: number;
  /** Palette category, e.g. `Triggers`, `Flow Control`, `HTTP`. */
  category: string;
  icon?: string;
  /** True for trigger nodes that can start a workflow. */
  trigger?: boolean;
  /** Schema of the items this node consumes. */
  inputs: JsonSchema;
  /** Schema of the items this node produces (per branch). */
  outputs: JsonSchema;
  parameters?: NodeParameterDefinition[];
  credentials?: CredentialRequirement[];
  permissions?: PermissionManifest;
  execute(ctx: NodeContext, input: NodeInputData): Promise<NodeOutputData>;
}
