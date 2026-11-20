/**
 * Table names owned by @code-brothers/database (spec §9, migrations
 * 0001–0005 and 0012). The API's repositories are written against these
 * names so the in-memory implementations used in tests/local runs and the
 * PostgreSQL implementations used in production share one vocabulary.
 */
export const TABLES = {
  users: 'users',
  sessions: 'sessions',
  credentials: 'credentials',
  workflows: 'workflows',
  workflowVersions: 'workflow_versions',
  executions: 'executions',
  executionSteps: 'execution_steps',
  webhooks: 'webhooks',
  webhookReplayNonces: 'webhook_replay_nonces',
  securityAuditLogs: 'security_audit_logs',
  pollingState: 'polling_state',
} as const;

export type TableName = (typeof TABLES)[keyof typeof TABLES];
