---
name: code-brothers
description: Deploy and operate the code-brothers business-automation platform for WhatsApp, Instagram, YouTube, Shopify, Daraz and local stores — Docker setup, owner account, credentials, the 10 ready workflow templates, and the MCP server that lets an agent drive the platform.
version: 1.0.0
---

# Code Brothers — Business Automation Platform

Run a self-hosted automation platform (a free, open-source n8n/Zapier
alternative) that answers WhatsApp customers, verifies payment screenshots,
syncs stock across Shopify/Daraz/a local website, shields COD orders from
fake buyers, turns comments into sales, and sends the owner a nightly CEO
digest on WhatsApp.

## What this skill is — read this first

- **The platform code is free.** It lives on GitHub under the MIT licence
  at `https://github.com/AourangZaibKhan/code-brothers`. You are not paying
  for the code.
- **This skill is the know-how that makes it run:** the deployment steps,
  the credential setup for each provider, the 10 ready workflow templates
  (bundled in this package as JSON), the API reference, the troubleshooting
  guide, and the MCP server that lets an agent operate the platform.
- **No live accounts or API keys are included.** Every connector needs the
  buyer's own accounts and keys (see Requirements). The connectors were
  tested against mock providers only — see
  `reference/verification-status.md` for exactly what was and was not
  proven live.

## When to use this skill

- "Set up code-brothers for my shop" / "deploy the automation platform"
- "Import the WhatsApp sales template" / "run the payment verifier"
- "Why is my workflow failing?" / "check the platform health"
- "Connect my Shopify/Daraz/WhatsApp/Instagram/YouTube account"
- "Run the nightly CEO digest" / "sync my stock across channels"

## Requirements (the buyer needs all of these)

1. **Docker with Compose v2** (Docker Desktop on Windows/Mac, Docker Engine
   on Linux) and **Git**. A machine with ~4 GB free RAM for the lite profile.
2. **Their own accounts and keys** for every provider they want to automate
   (details in `reference/connectors.md`):
   - WhatsApp: a phone number (free QR engine, unofficial) or a Meta
     Business app with the WhatsApp Cloud API (recommended for shops).
   - Instagram: a Business/Creator profile linked to a Facebook Page.
   - YouTube: a Google Cloud project with the YouTube Data API v3 enabled.
   - Shopify: a custom app on their own store.
   - Daraz: a developer account + Seller In-House App.
   - AI: a local Ollama install, or a free-tier Gemini/Groq/OpenRouter key.
     With no AI provider configured the Copilot answers 503 — that is
     honest behaviour, not a bug.
3. **A public HTTPS address for webhooks** (Cloudflare Tunnel is free and
   needs no open ports) if WhatsApp/Shopify/Daraz must reach the platform.
   Without it, manual triggers and scheduled workflows still work.
4. **Agensi tools (optional, no buyer keys needed):** for live product and
   competitor data — Shopify price tracking, the Facebook Ad Library, SERP
   data, web search — use the Agensi tools attached to this skill. They are
   charged per use from the buyer's Agensi balance, separate from the
   skill's price. Agensi tools do **not** cover live WhatsApp or Shopify
   store connections; those always need the buyer's own accounts.

## Quickstart — from zero to a running template

Follow `reference/setup.md` for the full steps. The short version:

1. Clone the repo and copy `.env.example` to `.env`. Generate a real
   `CB_MASTER_KEY` (64 hex chars, e.g. `openssl rand -hex 32`) and long
   random `POSTGRES_PASSWORD` / `REDIS_PASSWORD`. Never commit `.env`.
   Back the master key up outside the folder — the credentials vault is
   encrypted with it, and losing it means saved credentials cannot be
   recovered.
2. `docker compose -f docker/docker-compose.lite.yml up -d` from the repo
   root. Wait for postgres and redis to report `healthy`.
3. Dashboard: `http://localhost:8080`. API: `http://localhost:3000`.
   Both are bound to localhost only.
4. Claim the owner account: read the one-time setup token from
   `docker compose -f docker/docker-compose.lite.yml logs api | grep -i "setup token"`,
   open the dashboard, enter the token + email + a strong password. Setup
   closes permanently afterwards. Then enable TOTP 2FA in Security Center.
5. Add credentials in the dashboard's Credentials Vault (write-only — the
   platform never shows secret values back). See `reference/connectors.md`.
6. Import a template: Workflows → Templates, or via the API/MCP server
   (below). Fill in the template's `settings.variables`, then Activate —
   but only after a manual run has succeeded (step 7).
7. Verify before going live: run the workflow manually once and check the
   execution record. Use `scripts/check-platform.mjs` (needs `CB_API_URL`
   and `CB_API_TOKEN`) for a fast health check. Read
   `reference/troubleshooting.md` for the common failures.
8. Before real customers, work through `docs/hardening-guide.md` in the
   repo (2FA, kill-switch test, backup test, SSRF self-test).

## The 10 ready templates

Full detail — purpose, trigger, variables, credentials — is in
`reference/templates.md`. The JSON files are in `templates/` in this
package (fresh copies of the repo's `templates/`).

| # | Template | Does what |
|---|----------|-----------|
| 1 | WhatsApp Sales Assistant | Answers customer text/voice in their language, checks stock, creates a Shopify draft order |
| 2 | Payment Screenshot Verifier | OCRs JazzCash/EasyPaisa/UPI/bank receipts, checks the TID ledger, confirms or flags the order |
| 3 | Stock Sync, 3-Channel | A Shopify sale deducts the mapped Master SKU on Daraz and the local website |
| 4 | COD Fake-Order Shield | Risk-scores COD buyers by phone; high-risk buyers are asked for a partial advance |
| 5 | Instagram Comment-to-Sale | A keyword comment on a Reel gets a public reply + a DM with the product link |
| 6 | Reels/Shorts Factory | One long video → one Short/Reel per transcription segment, uploaded to YouTube + Instagram |
| 7 | YouTube Upload Auto-Promoter | A new video is announced to the WhatsApp broadcast list and Instagram |
| 8 | Comment Growth & Spam Shield | Every 15 min: classify YouTube comments (spam/lead/question), hide spam, answer the rest |
| 9 | Abandoned Cart Recovery | 2 h after an abandoned checkout, a polite WhatsApp reminder with the checkout link |
| 10 | CEO Digest | Nightly 22:00: orders, revenue, returns, top SKUs as a PDF on the owner's WhatsApp |

Rules for templates: never run one against a live provider until its
credentials and variables are filled in; validate any template file first
with `node templates/validate.mjs` in the repo; a template that needs the
AI media worker expects it at `http://ai-media-worker:8000` (the
`docker-compose.full.yml` service name).

## Operating the platform with the MCP server

The repo ships an MCP server (`apps/mcp-server`) that exposes the platform
as 11 tools over stdio. Build it once (`npm run build`), then launch it
from the repo root with the owner's API token:

```bash
CB_API_URL=http://127.0.0.1:3000 CB_API_TOKEN=<owner-token> npm start --workspace=@code-brothers/mcp-server
```

Get the token from `POST /api/auth/login` with the owner email + password.
The token is sent as an `Authorization: Bearer` header and is never printed
by the server. Point the server at the templates with `CB_TEMPLATES_DIR`
(default: `<repo>/templates`).

Tools: `codebrothers_health`, `codebrothers_list_templates`,
`codebrothers_import_template`, `codebrothers_list_workflows`,
`codebrothers_get_workflow`, `codebrothers_import_workflow`,
`codebrothers_run_workflow`, `codebrothers_set_workflow_active`,
`codebrothers_list_runs`, `codebrothers_list_credentials` (metadata only),
`codebrothers_ai_chat`. The full API reference is in `reference/api.md`.

Use the MCP server (or the API) for these flows: import a template, run it
manually, read the execution, activate it only after a successful run.

## Operating rules

- **Verify before activating.** A workflow goes live only after a manual
  run returns `success` and the execution record shows the expected steps.
- **Customer-facing actions need the user's approval first.** Use the
  platform's approvals queue (`POST /api/approvals`, approve/reject) for
  anything that messages a customer, books a courier, or moves money.
  Never silently send, book, or charge.
- **Never invent credentials.** If a credential is missing, stop and say
  exactly which one is missing and where to get it (see
  `reference/connectors.md`). Never paste a secret into chat, logs, or a
  file — read secrets only from the vault or the buyer's environment.
- **If the platform is halted, say so.** The kill switch (`/api/security/kill-switch`)
  stops all runs with `platform_halted`; resume only when the user says so.
- **WhatsApp QR engine is unofficial.** Respect the anti-ban sending
  limits in `reference/connectors.md`; for a real shop, use the official
  Cloud API.
- **Media worker 503s are expected without models.** `/transcribe`, `/ocr`
  and `/tts` answer 503 until the optional models are installed — templates
  that need them cannot run until then.

## How to prove it works

- `node scripts/check-platform.mjs` — health, setup state, workflows,
  credentials (metadata only). Needs `CB_API_URL` + `CB_API_TOKEN`.
- In the repo: `npm run verify:templates` (all 10 templates end to end
  against mock providers), `npm run verify:mcp-server` (this MCP server
  against a live test API), `npm run verify:persistence`,
  `npm run verify:worker`, `npm run verify:ai-chat`, `npm test`.
- What was verified and what was not is written down, without exceptions,
  in `reference/verification-status.md`. If a check fails, do not claim the
  platform works — report the failing check and the fix.

## Troubleshooting

Start with `reference/troubleshooting.md`: weak/missing `CB_MASTER_KEY`
(the API refuses to boot), lost setup token, dashboard not opening, AI
503s, media-worker 503s, worker schedules not firing, and the Postgres
persistence checks.
