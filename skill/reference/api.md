# API reference — the endpoints this skill uses

Base URL: `http://127.0.0.1:3000` by default (the `api` service in the
compose stack). Every endpoint below except setup/login requires
`Authorization: Bearer <owner-token>`. Get the token from
`POST /api/auth/login` with the owner email + password.

Error answers are JSON: `{ "error": "<code>", "message": "..." }`.
Common codes: `invalid_credentials` (401), `totp_required` (401),
`workflow_not_found` (404), `platform_halted` (503 — kill switch on),
`no_ai_provider_configured` (503 — no AI provider set up, honest
behaviour), `too_many_attempts` (429 — login throttled).

## Setup & auth

| Method & path | Does what |
|---|---|
| `GET /api/setup/status` | `{ setupRequired, setupClosed }` — true on first boot |
| `POST /api/setup/claim` | Claim the owner account (one-time setup token + email + password) → `{ user, token }` |
| `POST /api/auth/login` | `{ email, password, totpCode? }` → `{ token, user }` |
| `GET /api/auth/me` | The logged-in owner |
| `POST /api/auth/logout` | Invalidate the session |
| `GET /api/auth/sessions` | Active sessions |
| `POST /api/auth/totp/enrol` / `/confirm` / `/disable` | TOTP 2FA |

## Workflows

| Method & path | Does what |
|---|---|
| `POST /api/workflows` | Create a workflow `{ name, description?, nodes?, edges?, settings?, tags? }` → 201 workflow view. New workflows start **inactive**. |
| `GET /api/workflows` | List the owner's workflows |
| `GET /api/workflows/:id` | One workflow in full (nodes, edges, settings) |
| `PUT /api/workflows/:id` | Update meta/graph (saves a version when the graph changes) |
| `DELETE /api/workflows/:id` | Delete |
| `POST /api/workflows/:id/activate` | Activate |
| `POST /api/workflows/:id/deactivate` | Deactivate |
| `POST /api/workflows/:id/run` | Manual run `{ triggerData?, variables? }` → 201 execution `{ id, status, ... }` |
| `GET /api/workflows/:id/versions` | Version history |
| `GET /api/executions?workflowId=&limit=` | Execution records, newest first (limit default 100, max 500) |
| `GET /api/executions/:id` | One execution |

A run whose `status` is `success` means every node finished without an
error. Anything else: read the execution's node results to find the
failing step.

## Credentials (metadata only)

| Method & path | Does what |
|---|---|
| `POST /api/credentials` | Store a credential `{ name, provider?, kind?, value }` → 201 metadata |
| `GET /api/credentials` | List `{ items: [{ id, name, provider, kind, createdAt, updatedAt }] }` — secret values are **never** returned |
| `GET /api/credentials/:id` | One credential's metadata |
| `DELETE /api/credentials/:id` | Delete |

## Business modules

| Method & path | Does what |
|---|---|
| `GET /api/couriers/presets` | Supported couriers (ExperGo, TCS, Leopards, DHL, FedEx) with base URLs |
| `POST /api/couriers/book` | Book a shipment |
| `POST /api/fraud/assess` | Score a buyer/order for fraud (no credentials needed) |
| `POST /api/catalog/sync-sale` | Apply a sale to the SKU catalog |
| `GET /api/catalog/sku-mappings` / `POST /api/catalog/sku-mappings` | Master SKU mappings |
| `POST /api/payments/verify-tid` | Check a payment TID against the ledger |
| `GET /api/payments/tids` | The TID ledger |
| `GET /api/orders` | Orders |
| `GET /api/inbox/conversations` / `/api/inbox/sent` | Unified inbox |
| `POST /api/approvals` / `GET /api/approvals` | Approval queue — customer-facing actions wait here until approved/rejected |

## AI Copilot

| Method & path | Does what |
|---|---|
| `GET /api/ai/status` | `{ configured, providers, coolingDown, message }` |
| `POST /api/ai/chat` | `{ messages: [{ role, content }], model?, temperature?, maxTokens? }` → `{ text, provider, model, usage?, attempts }`, or **503 `no_ai_provider_configured`** when no provider is set up |

## Safety & ops

| Method & path | Does what |
|---|---|
| `GET /api/security/health-score` | Security health score (TOTP off lowers it — correct behaviour) |
| `GET /api/security/audit-logs` | Audit log |
| `POST /api/security/kill-switch` | Halt the platform (runs answer 503 `platform_halted`) |
| `POST /api/security/resume` | Resume after a halt |
| `POST /api/backups/create` / `/restore` | Backup / restore |
| `GET /api/webhooks` / `POST /api/webhooks` | Webhook registrations (HMAC-signed) |
| `POST /api/digest/generate` | Generate the CEO digest (`?format=json`) |
| `GET /api/rag/documents` / `POST /api/rag/documents` / `GET /api/rag/search` | RAG catalog documents |
