import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasPage } from '../canvas/CanvasPage';
import { mockFetch } from './mockFetch';

describe('workflow canvas', () => {
  let calls: Array<{ method: string; url: string; body: unknown }>;

  beforeEach(() => {
    window.localStorage.clear();
    const mock = mockFetch({
      'POST /api/workflows': (body: unknown) => {
        const b = body as { name: string; nodes: unknown[]; edges: unknown[] };
        return {
          id: 'wf-1',
          name: b.name,
          nodes: b.nodes,
          edges: b.edges,
          settings: {},
          isActive: false,
          currentVersion: 1,
          tags: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
      },
    });
    calls = mock.calls;
    vi.stubGlobal('fetch', mock.fn);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds a node from the palette and Save posts a valid workflow graph', async () => {
    render(<CanvasPage />);

    // Add a Manual Trigger node from the palette.
    fireEvent.click(screen.getByRole('button', { name: 'Manual Trigger' }));
    // Add a Log node too, so the graph has more than the trigger.
    fireEvent.click(screen.getByRole('button', { name: 'Log' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/workflows')).toBe(true);
    });

    const saveCall = calls.find((c) => c.method === 'POST' && c.url === '/api/workflows');
    const body = saveCall?.body as {
      name: string;
      nodes: Array<{ id: string; type: string; parameters?: Record<string, unknown>; position?: { x: number; y: number } }>;
      edges: unknown[];
    };
    expect(body.nodes).toHaveLength(2);
    expect(body.nodes.map((n) => n.type)).toEqual(['core.manualTrigger', 'core.log']);
    expect(body.nodes[0].position).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
    expect(Array.isArray(body.edges)).toBe(true);

    // The API answered with version 1 — the UI reports it.
    expect(await screen.findByText(/Saved as version 1/)).toBeInTheDocument();
  });
});
