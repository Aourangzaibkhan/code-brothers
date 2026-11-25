import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WorkflowDefinition } from '@code-brothers/core';
import { InMemoryExecutionSink, MapWorkflowProvider } from './types.js';
import { startWorker } from './worker.js';

const instantSleep = async (): Promise<void> => {};

const WORKFLOW: WorkflowDefinition = {
  id: 'wf-1',
  name: 'Greeting flow',
  nodes: [
    { id: 'trigger', type: 'core.manualTrigger', name: 'Start', parameters: {} },
    {
      id: 'set',
      type: 'core.setData',
      name: 'Set',
      parameters: {
        assignments: [{ name: 'fullName', value: '{{ $json.first }} {{ $json.last }}' }],
      },
    },
    { id: 'log', type: 'core.log', name: 'Log', parameters: {} },
  ],
  edges: [
    { from: 'trigger', to: 'set' },
    { from: 'set', to: 'log' },
  ],
};

describe('WorkflowWorker', () => {
  it('processes an enqueued run job and records the execution', async () => {
    const executions = new InMemoryExecutionSink();
    const { worker } = startWorker({
      workflows: new MapWorkflowProvider([WORKFLOW]),
      executions,
      queueSleep: instantSleep,
    });

    await worker.enqueueRun(
      { workflowId: 'wf-1', triggerData: { first: 'Ada', last: 'Lovelace' } },
      { maxAttempts: 1 },
    );
    await worker.waitForIdle();

    assert.equal(executions.size, 1);
    const [execution] = executions.all();
    assert.equal(execution.workflowId, 'wf-1');
    assert.equal(execution.status, 'success');
    assert.equal(execution.triggerType, 'manual');
    assert.equal(execution.steps.length, 3);
    assert.ok(execution.steps.every((s) => s.status === 'success'));
    assert.ok(JSON.stringify(execution.steps[1].output).includes('Ada Lovelace'));
    assert.equal(worker.deadLetters().length, 0);
  });

  it('dead-letters a run job whose workflow does not exist', async () => {
    const executions = new InMemoryExecutionSink();
    const { worker } = startWorker({
      workflows: new MapWorkflowProvider(),
      executions,
      queueSleep: instantSleep,
    });

    await worker.enqueueRun({ workflowId: 'missing' }, { maxAttempts: 1, backoffMs: 0 });
    await worker.waitForIdle();

    assert.equal(executions.size, 0);
    assert.equal(worker.deadLetters().length, 1);
    assert.match(worker.deadLetters()[0].error, /Workflow not found/);
  });

  it('refuses to run while the kill switch is engaged', async () => {
    const executions = new InMemoryExecutionSink();
    const { worker } = startWorker({
      workflows: new MapWorkflowProvider([WORKFLOW]),
      executions,
      queueSleep: instantSleep,
      isHalted: () => true,
    });

    await worker.enqueueRun({ workflowId: 'wf-1' }, { maxAttempts: 1, backoffMs: 0 });
    await worker.waitForIdle();

    assert.equal(executions.size, 0);
    assert.equal(worker.deadLetters().length, 1);
    assert.match(worker.deadLetters()[0].error, /halted/);
  });

  it('refuses to run while an async kill-switch probe reports halted', async () => {
    const executions = new InMemoryExecutionSink();
    const { worker } = startWorker({
      workflows: new MapWorkflowProvider([WORKFLOW]),
      executions,
      queueSleep: instantSleep,
      isHalted: async () => true,
    });

    await worker.enqueueRun({ workflowId: 'wf-1' }, { maxAttempts: 1, backoffMs: 0 });
    await worker.waitForIdle();

    assert.equal(executions.size, 0);
    assert.equal(worker.deadLetters().length, 1);
    assert.match(worker.deadLetters()[0].error, /halted/);
  });

  it('threads the owner id through $vars.userId and the per-owner credentials factory', async () => {
    const executions = new InMemoryExecutionSink();
    const provider = new MapWorkflowProvider();
    provider.set(
      {
        id: 'wf-owner',
        name: 'Owner flow',
        nodes: [
          { id: 'trigger', type: 'core.manualTrigger', name: 'Start', parameters: {} },
          {
            id: 'set',
            type: 'core.setData',
            name: 'Set',
            parameters: {
              assignments: [{ name: 'ownerId', value: '{{ $vars.userId }}' }],
            },
          },
        ],
        edges: [{ from: 'trigger', to: 'set' }],
      },
      'owner-1',
      3,
    );
    const factoryCalls: string[] = [];
    const { worker } = startWorker({
      workflows: provider,
      executions,
      queueSleep: instantSleep,
      credentialsProviderFor: (userId: string) => {
        factoryCalls.push(userId);
        return async () => ({ token: 'stub' });
      },
    });

    await worker.enqueueRun({ workflowId: 'wf-owner' }, { maxAttempts: 1 });
    await worker.waitForIdle();

    assert.deepEqual(factoryCalls, ['owner-1']);
    assert.equal(executions.size, 1);
    const [execution] = executions.all();
    assert.equal(execution.status, 'success');
    assert.equal(execution.workflowVersion, 3);
    assert.ok(JSON.stringify(execution.steps[1].output).includes('owner-1'));
  });
});
