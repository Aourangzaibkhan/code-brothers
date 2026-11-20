import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import type { Execution, Workflow, WorkflowEdge, WorkflowNodeInstance, WorkflowVersion } from '../api/types';
import { Button, ErrorBanner, Field, Input, PageHeader, Select, StatusPill, Textarea } from '../components/ui';
import { NODE_CATALOG, NODE_TYPE_MAP, defaultParameters, newNodeId, type NodeTypeDef, type ParamDef } from './nodeCatalog';
import { copilotBus } from './copilotBus';
import type { GeneratedWorkflow } from './copilot';

// ---------------------------------------------------------------------------
// Graph <-> React Flow conversion.
// API edges are { from, output, to }; React Flow edges are { source, target,
// sourceHandle }. Node positions persist on the node objects (see types.ts).
// ---------------------------------------------------------------------------

interface CbNodeData extends Record<string, unknown> {
  label: string;
  type: string;
  name: string;
  parameters: Record<string, unknown>;
  disabled?: boolean;
}

type CbNode = Node<CbNodeData>;

function toFlowNodes(nodes: WorkflowNodeInstance[]): CbNode[] {
  return nodes.map((node, i) => {
    const def = NODE_TYPE_MAP.get(node.type);
    return {
      id: node.id,
      type: 'cb',
      position: node.position ?? { x: 80 + i * 230, y: 140 },
      data: {
        label: def?.label ?? node.type,
        type: node.type,
        name: node.name ?? def?.label ?? node.type,
        parameters: node.parameters ?? {},
        disabled: node.disabled,
      },
    };
  });
}

function toFlowEdges(edges: WorkflowEdge[]): Edge[] {
  return edges.map((edge) => ({
    id: `${edge.from}->${edge.to}:${edge.output ?? 0}`,
    source: edge.from,
    target: edge.to,
    sourceHandle: `out-${edge.output ?? 0}`,
    animated: true,
  }));
}

function fromFlowNodes(nodes: CbNode[]): WorkflowNodeInstance[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.data.type,
    name: node.data.name,
    parameters: node.data.parameters,
    disabled: node.data.disabled || undefined,
    position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
  }));
}

function fromFlowEdges(edges: Edge[]): WorkflowEdge[] {
  return edges.map((edge) => ({
    from: edge.source,
    to: edge.target,
    output: edge.sourceHandle ? Number(edge.sourceHandle.replace('out-', '')) || 0 : 0,
  }));
}

// ---------------------------------------------------------------------------
// Custom node renderer: one input handle, one source handle per output branch.
// ---------------------------------------------------------------------------

function CbNodeView({ data, selected }: NodeProps<CbNode>) {
  const def = NODE_TYPE_MAP.get(data.type);
  const outputs = def?.outputs ?? 1;
  const isTrigger = def?.category === 'trigger';
  return (
    <div
      className={`min-w-[150px] rounded-lg border-2 bg-white px-3 py-2 shadow-sm ${
        selected ? 'border-brand-600' : 'border-slate-300'
      } ${data.disabled ? 'opacity-50' : ''}`}
    >
      {!isTrigger && <Handle type="target" position={Position.Left} className="!bg-slate-500" />}
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{data.type}</div>
      <div className="text-xs font-bold text-slate-800">{data.name}</div>
      {Array.from({ length: outputs }, (_, i) => (
        <Handle
          key={i}
          id={`out-${i}`}
          type="source"
          position={Position.Right}
          style={outputs > 1 ? { top: `${((i + 1) * 100) / (outputs + 1)}%` } : undefined}
          className="!bg-brand-600"
        />
      ))}
    </div>
  );
}

const nodeTypes = { cb: CbNodeView };

// ---------------------------------------------------------------------------

export function CanvasPage({
  workflowId: initialWorkflowId,
  onOpenWorkflow,
}: {
  workflowId?: string;
  onOpenWorkflow?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [workflowId, setWorkflowId] = useState<string | undefined>(initialWorkflowId);
  const [name, setName] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [version, setVersion] = useState<number | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<CbNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<Execution | null>(null);
  const [versions, setVersions] = useState<WorkflowVersion[] | null>(null);
  const [busy, setBusy] = useState(false);

  const loadWorkflow = useCallback((workflow: Workflow) => {
    setWorkflowId(workflow.id);
    setName(workflow.name);
    setIsActive(workflow.isActive);
    setVersion(workflow.currentVersion);
    setNodes(toFlowNodes(workflow.nodes));
    setEdges(toFlowEdges(workflow.edges));
    setSelectedId(null);
    setRunResult(null);
  }, [setNodes, setEdges]);

  const loadGraph = useCallback((graph: GeneratedWorkflow) => {
    setWorkflowId(undefined);
    setName(graph.name);
    setIsActive(false);
    setVersion(null);
    setNodes(toFlowNodes(graph.nodes));
    setEdges(toFlowEdges(graph.edges));
    setSelectedId(null);
    setRunResult(null);
    setNotice(null);
  }, [setNodes, setEdges]);

  // Load an existing workflow when opened from the list.
  useEffect(() => {
    if (!initialWorkflowId) return;
    let cancelled = false;
    api.getWorkflow(initialWorkflowId)
      .then((wf) => { if (!cancelled) loadWorkflow(wf); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : t('common.error')); });
    return () => { cancelled = true; };
  }, [initialWorkflowId, loadWorkflow, t]);

  // Copilot hand-off: apply a generated graph (now, or one queued earlier).
  useEffect(() => {
    const pending = copilotBus.takePending();
    if (pending) loadGraph(pending);
    return copilotBus.subscribe(loadGraph);
  }, [loadGraph]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) =>
        addEdge({ ...connection, sourceHandle: connection.sourceHandle ?? 'out-0', animated: true }, eds),
      );
    },
    [setEdges],
  );

  const addNode = useCallback(
    (def: NodeTypeDef) => {
      const id = newNodeId(def.type);
      const node: CbNode = {
        id,
        type: 'cb',
        position: { x: 100 + (nodes.length % 5) * 60, y: 100 + (nodes.length % 4) * 70 },
        data: {
          label: def.label,
          type: def.type,
          name: def.label,
          parameters: defaultParameters(def),
        },
      };
      setNodes((nds) => [...nds, node]);
      setSelectedId(id);
    },
    [nodes.length, setNodes],
  );

  const updateSelected = useCallback(
    (patch: Partial<CbNodeData>) => {
      if (!selectedId) return;
      setNodes((nds) =>
        nds.map((node) => (node.id === selectedId ? { ...node, data: { ...node.data, ...patch } } : node)),
      );
    },
    [selectedId, setNodes],
  );

  const setParam = useCallback(
    (paramName: string, value: unknown) => {
      if (!selectedNode) return;
      updateSelected({ parameters: { ...selectedNode.data.parameters, [paramName]: value } });
    },
    [selectedNode, updateSelected],
  );

  const graphPayload = useCallback(
    () => ({ nodes: fromFlowNodes(nodes), edges: fromFlowEdges(edges) }),
    [nodes, edges],
  );

  const save = useCallback(async (): Promise<Workflow> => {
    const payload = { name: name.trim() || t('canvas.untitled'), ...graphPayload() };
    const saved = workflowId
      ? await api.updateWorkflow(workflowId, payload)
      : await api.createWorkflow(payload);
    setWorkflowId(saved.id);
    setVersion(saved.currentVersion);
    setIsActive(saved.isActive);
    setNotice(t('canvas.saved', { version: saved.currentVersion }));
    onOpenWorkflow?.(saved.id);
    return saved;
  }, [name, graphPayload, workflowId, t, onOpenWorkflow]);

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      await save();
    } catch (err) {
      setError(err instanceof ApiError ? err.message || err.code : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const handleRun = async () => {
    setBusy(true);
    setError(null);
    setRunResult(null);
    try {
      const saved = await save();
      const execution = await api.runWorkflow(saved.id);
      setRunResult(execution);
      setNotice(t('canvas.runFinished', { status: execution.status }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message || err.code : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const handleToggleActive = async () => {
    if (!workflowId) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.setWorkflowActive(workflowId, !isActive);
      setIsActive(updated.isActive);
    } catch (err) {
      setError(err instanceof ApiError ? err.message || err.code : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const handleShowVersions = async () => {
    if (!workflowId) return;
    try {
      setVersions(await api.listWorkflowVersions(workflowId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message || err.code : t('common.error'));
    }
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setNodes((nds) => nds.filter((node) => node.id !== selectedId));
    setEdges((eds) => eds.filter((edge) => edge.source !== selectedId && edge.target !== selectedId));
    setSelectedId(null);
  };

  const paletteGroups: Array<{ key: string; title: string; defs: NodeTypeDef[] }> = [
    { key: 'trigger', title: t('canvas.palette'), defs: NODE_CATALOG.filter((d) => d.category === 'trigger') },
    { key: 'core', title: t('canvas.coreNodes'), defs: NODE_CATALOG.filter((d) => d.category === 'core') },
    { key: 'connector', title: t('canvas.connectorNodes'), defs: NODE_CATALOG.filter((d) => d.category === 'connector') },
  ];

  return (
    <div>
      <PageHeader title={t('canvas.title')}>
        <span className="text-sm text-slate-500">
          {version !== null ? `${t('common.version')} ${version}` : ''}
        </span>
        <Button variant="secondary" onClick={() => void handleSave()} disabled={busy}>
          {t('canvas.save')}
        </Button>
        <Button onClick={() => void handleRun()} disabled={busy}>
          {t('canvas.run')}
        </Button>
        {workflowId ? (
          <Button variant={isActive ? 'danger' : 'secondary'} onClick={() => void handleToggleActive()} disabled={busy}>
            {isActive ? t('canvas.deactivate') : t('canvas.activate')}
          </Button>
        ) : null}
        {workflowId ? (
          <Button variant="ghost" onClick={() => void handleShowVersions()}>
            {t('canvas.versions')}
          </Button>
        ) : null}
      </PageHeader>

      <ErrorBanner message={error} />
      {notice ? <div className="mb-2 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</div> : null}

      <div className="mb-3 max-w-md">
        <Field label={t('canvas.workflowName')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('canvas.untitled')} />
        </Field>
      </div>

      <div className="flex gap-3">
        {/* Palette */}
        <div className="w-52 shrink-0 space-y-4 overflow-y-auto" style={{ maxHeight: '70vh' }}>
          {paletteGroups.map((group) => (
            <div key={group.key}>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{group.title}</h3>
              <div className="space-y-1">
                {group.defs.map((def) => (
                  <button
                    key={def.type}
                    type="button"
                    onClick={() => addNode(def)}
                    className="block w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-start text-xs font-medium hover:border-brand-500"
                  >
                    {def.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <p className="text-xs text-slate-400">{t('canvas.addHint')}</p>
        </div>

        {/* Canvas */}
        <div className="h-[70vh] flex-1 rounded-lg border border-slate-200" data-testid="workflow-canvas">
          <ReactFlow
            className="cb-flow"
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        {/* Properties panel */}
        <div className="w-72 shrink-0 overflow-y-auto rounded-lg border border-slate-200 bg-white p-3" style={{ maxHeight: '70vh' }}>
          <h3 className="mb-2 text-sm font-semibold">{t('canvas.properties')}</h3>
          {selectedNode ? (
            <div className="space-y-3">
              <div className="text-xs text-slate-400">{selectedNode.data.type}</div>
              <Field label={t('canvas.nodeName')}>
                <Input
                  value={selectedNode.data.name}
                  onChange={(e) => updateSelected({ name: e.target.value })}
                  aria-label={t('canvas.nodeName')}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={Boolean(selectedNode.data.disabled)}
                  onChange={(e) => updateSelected({ disabled: e.target.checked })}
                />
                {t('canvas.disabled')}
              </label>
              {(NODE_TYPE_MAP.get(selectedNode.data.type)?.params ?? []).map((param) => (
                <ParamField
                  key={param.name}
                  param={param}
                  value={selectedNode.data.parameters[param.name]}
                  onChange={(value) => setParam(param.name, value)}
                />
              ))}
              <Button variant="danger" onClick={deleteSelected}>
                {t('common.delete')}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-slate-500">{t('canvas.selectNode')}</p>
          )}
        </div>
      </div>

      {versions ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
          <h3 className="mb-2 text-sm font-semibold">{t('canvas.versions')}</h3>
          <ul className="space-y-1 text-sm">
            {versions.map((v) => (
              <li key={v.version} className="flex justify-between border-b border-slate-100 py-1">
                <span>
                  {t('common.version')} {v.version} — {v.nodes.length} {t('workflows.nodes')}
                  {v.comment ? ` · ${v.comment}` : ''}
                </span>
                <span className="text-slate-400">{new Date(v.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {runResult ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3" data-testid="run-result">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-sm font-semibold">{t('executions.steps')}</h3>
            <StatusPill status={runResult.status} />
            <span className="text-xs text-slate-400">
              {runResult.durationMs} ms · {runResult.triggerType}
            </span>
          </div>
          <ul className="space-y-1 text-sm">
            {runResult.steps.map((step) => (
              <li key={step.nodeId} className="flex items-center justify-between border-b border-slate-100 py-1">
                <span>
                  {step.nodeName} <span className="text-slate-400">({step.nodeType})</span>
                </span>
                <span className="flex items-center gap-2">
                  {step.error ? <span className="text-xs text-red-600">{step.error}</span> : null}
                  <StatusPill status={step.status} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ParamField({
  param,
  value,
  onChange,
}: {
  param: ParamDef;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation();
  const [jsonError, setJsonError] = useState(false);

  if (param.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={Boolean(value ?? param.default ?? false)}
          onChange={(e) => onChange(e.target.checked)}
        />
        {param.label}
      </label>
    );
  }
  if (param.type === 'options') {
    return (
      <Field label={param.label}>
        <Select
          value={String(value ?? param.default ?? '')}
          onChange={(e) => onChange(e.target.value)}
          aria-label={param.label}
        >
          {(param.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  if (param.type === 'number') {
    return (
      <Field label={param.label}>
        <Input
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          aria-label={param.label}
        />
      </Field>
    );
  }
  if (param.type === 'json') {
    const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2);
    return (
      <Field label={param.label} hint={jsonError ? t('canvas.invalidJson') : undefined}>
        <Textarea
          rows={3}
          value={text}
          placeholder={param.placeholder}
          aria-label={param.label}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw.trim() === '') {
              setJsonError(false);
              onChange(undefined);
              return;
            }
            try {
              onChange(JSON.parse(raw));
              setJsonError(false);
            } catch {
              onChange(raw);
              setJsonError(true);
            }
          }}
        />
      </Field>
    );
  }
  return (
    <Field label={param.label}>
      <Input
        value={typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)}
        placeholder={param.placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-label={param.label}
      />
    </Field>
  );
}
