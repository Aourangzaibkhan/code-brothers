import type { NodeDefinition } from './types.js';

export class NodeRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeRegistryError';
  }
}

export class DuplicateNodeTypeError extends NodeRegistryError {
  constructor(type: string) {
    super(`A node with type "${type}" is already registered`);
    this.name = 'DuplicateNodeTypeError';
  }
}

export class UnknownNodeTypeError extends NodeRegistryError {
  constructor(type: string) {
    super(`No node registered with type "${type}"`);
    this.name = 'UnknownNodeTypeError';
  }
}

/**
 * Registry of all node definitions available to the workflow engine.
 * Connector packages register their nodes here at startup; the engine
 * resolves workflow node instances by `type` through this registry.
 */
export class NodeRegistry {
  private readonly nodes = new Map<string, NodeDefinition>();

  register(definition: NodeDefinition): this {
    if (!definition || typeof definition.type !== 'string' || !definition.type) {
      throw new NodeRegistryError('Cannot register a node without a type id');
    }
    if (this.nodes.has(definition.type)) {
      throw new DuplicateNodeTypeError(definition.type);
    }
    this.nodes.set(definition.type, definition);
    return this;
  }

  registerAll(definitions: Iterable<NodeDefinition>): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  get(type: string): NodeDefinition | undefined {
    return this.nodes.get(type);
  }

  getOrThrow(type: string): NodeDefinition {
    const definition = this.nodes.get(type);
    if (!definition) throw new UnknownNodeTypeError(type);
    return definition;
  }

  has(type: string): boolean {
    return this.nodes.has(type);
  }

  list(): NodeDefinition[] {
    return [...this.nodes.values()];
  }

  types(): string[] {
    return [...this.nodes.keys()];
  }

  unregister(type: string): boolean {
    return this.nodes.delete(type);
  }

  clear(): void {
    this.nodes.clear();
  }

  get size(): number {
    return this.nodes.size;
  }
}
