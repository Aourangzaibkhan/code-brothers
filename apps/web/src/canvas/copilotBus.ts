import type { GeneratedWorkflow } from './copilot';

/**
 * Tiny pub/sub hand-off between the Copilot drawer and the Workflow Canvas:
 * the drawer publishes a generated graph; the canvas subscribes and loads it.
 */
type Listener = (graph: GeneratedWorkflow) => void;

const listeners = new Set<Listener>();
let pending: GeneratedWorkflow | null = null;

export const copilotBus = {
  publish(graph: GeneratedWorkflow): void {
    pending = graph;
    listeners.forEach((fn) => fn(graph));
  },
  /** Returns and clears a graph published while the canvas was unmounted. */
  takePending(): GeneratedWorkflow | null {
    const graph = pending;
    pending = null;
    return graph;
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
