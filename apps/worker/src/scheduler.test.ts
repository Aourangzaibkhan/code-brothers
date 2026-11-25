import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WorkflowDefinition } from '@code-brothers/core';
import { Scheduler, type ScheduleFireEvent } from './scheduler.js';
import { InMemoryExecutionSink, MapWorkflowProvider } from './types.js';
import { startWorker } from './worker.js';

const instantSleep = async (): Promise<void> => {};

const CRON_WORKFLOW: WorkflowDefinition = {
  id: 'wf-cron',
  name: 'Every minute',
  nodes: [
    {
      id: 'cron',
      type: 'core.cronTrigger',
      name: 'Cron',
      parameters: { expression: '* * * * *' },
    },
    { id: 'log', type: 'core.log', name: 'Log', parameters: {} },
  ],
  edges: [{ from: 'cron', to: 'log' }],
};

describe('Scheduler', () => {
  it('fires a due cron workflow exactly once per slot', async () => {
    const fired: ScheduleFireEvent[] = [];
    const scheduler = new Scheduler({
      onFire: (event) => {
        fired.push(event);
      },
    });

    const armed = scheduler.register(CRON_WORKFLOW, new Date('2026-11-20T10:00:30.000Z'));
    assert.equal(armed, 1);
    const [entry] = scheduler.list();
    assert.equal(entry.expression, '* * * * *');
    assert.equal(entry.nextRun.toISOString(), '2026-11-20T10:01:00.000Z');

    // Not yet due.
    assert.equal(await scheduler.tick(new Date('2026-11-20T10:00:45.000Z')), 0);
    assert.equal(fired.length, 0);

    // Due — fires once for the 10:01 slot.
    assert.equal(await scheduler.tick(new Date('2026-11-20T10:01:00.000Z')), 1);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].workflow.id, 'wf-cron');
    assert.equal(fired[0].node.id, 'cron');
    assert.equal(fired[0].scheduledFor.toISOString(), '2026-11-20T10:01:00.000Z');

    // Re-ticking the same instant (or later in the same minute) must NOT refire.
    assert.equal(await scheduler.tick(new Date('2026-11-20T10:01:00.000Z')), 0);
    assert.equal(await scheduler.tick(new Date('2026-11-20T10:01:59.000Z')), 0);
    assert.equal(fired.length, 1);

    // The next slot fires normally.
    assert.equal(await scheduler.tick(new Date('2026-11-20T10:02:00.000Z')), 1);
    assert.equal(fired.length, 2);
    assert.equal(fired[1].scheduledFor.toISOString(), '2026-11-20T10:02:00.000Z');
  });

  it('registerIfMissing never resets an already-armed next run', async () => {
    const scheduler = new Scheduler({ onFire: () => {} });
    const from = new Date('2026-11-20T10:00:30.000Z');
    assert.equal(scheduler.register(CRON_WORKFLOW, from), 1);
    assert.equal(scheduler.list()[0].nextRun.toISOString(), '2026-11-20T10:01:00.000Z');

    // A refresh later must not touch the armed entry…
    assert.equal(scheduler.registerIfMissing(CRON_WORKFLOW, new Date('2026-11-20T10:00:50.000Z')), 0);
    assert.equal(scheduler.list()[0].nextRun.toISOString(), '2026-11-20T10:01:00.000Z');

    // …but a workflow with a second, unarmed cron node gets only that one armed.
    const twoCron: WorkflowDefinition = {
      ...CRON_WORKFLOW,
      nodes: [
        ...CRON_WORKFLOW.nodes,
        {
          id: 'cron2',
          type: 'core.cronTrigger',
          name: 'Cron 2',
          parameters: { expression: '*/5 * * * *' },
        },
      ],
    };
    assert.equal(scheduler.registerIfMissing(twoCron, from), 1);
    assert.equal(scheduler.list().length, 2);
    assert.equal(
      scheduler.list().find((e) => e.nodeId === 'cron')?.nextRun.toISOString(),
      '2026-11-20T10:01:00.000Z',
    );
  });

  it('start() with keepAlive keeps the process alive; without it the timer is unref’d', () => {
    // Regression test for the worker exiting ~10s after boot: every timer
    // was unref'd and the pg pool idles out, so the event loop emptied.
    const timerOf = (s: Scheduler): NodeJS.Timeout | undefined =>
      (s as unknown as { timer?: NodeJS.Timeout }).timer;

    const unrefed = new Scheduler({ onFire: () => {} });
    unrefed.start(60_000);
    assert.equal(timerOf(unrefed)?.hasRef(), false);
    unrefed.stop();

    const kept = new Scheduler({ onFire: () => {} });
    kept.start(60_000, true);
    assert.equal(timerOf(kept)?.hasRef(), true);
    kept.stop();
  });

  it('drives the worker: a due cron enqueues a run that is executed and recorded', async () => {
    const executions = new InMemoryExecutionSink();
    const { worker } = startWorker({
      workflows: new MapWorkflowProvider([CRON_WORKFLOW]),
      executions,
      queueSleep: instantSleep,
    });
    const scheduler = new Scheduler({
      onFire: async (event) => {
        await worker.enqueueRun(
          { workflowId: event.workflow.id, triggerType: 'cron', triggerNodeId: event.node.id },
          { maxAttempts: 1 },
        );
      },
    });

    scheduler.register(CRON_WORKFLOW, new Date('2026-11-20T10:00:30.000Z'));
    assert.equal(await scheduler.tick(new Date('2026-11-20T10:01:00.000Z')), 1);
    await worker.waitForIdle();

    assert.equal(executions.size, 1);
    const [execution] = executions.all();
    assert.equal(execution.triggerType, 'cron');
    assert.equal(execution.status, 'success');
    assert.equal(execution.workflowId, 'wf-cron');
  });
});
