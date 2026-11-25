# Verification status — what was tested, what was not

This file is the honest record. Nothing in it is marketing copy. If a
line here says something was not verified, the listing says the same.

## What was verified (automated, repeatable)

- **404 Node tests** (400 `node:test` + 4 web vitest) and **14 Python
  tests** pass — `npm test` plus `pytest` in `services/ai-media-worker`.
- **First-try fresh-clone build**: `git clone` → `npm ci` →
  `npm run build` exits 0 on the first attempt (TypeScript project
  references build workspaces in dependency order).
- **All 10 templates run end to end against mock providers** — WhatsApp
  Graph, Shopify Admin, Daraz, Instagram Graph, YouTube Data, ExperGo/TCS
  couriers, WooCommerce, plus a mock AI media worker. Reproduce with
  `npm run verify:templates`.
- **Postgres persistence across restarts** — owner, credentials, workflow,
  run history and RAG documents survive an API restart.
  `npm run verify:persistence` (16 checks).
- **Production dashboard proxy** — the dashboard's `/api` calls reach the
  API through nginx in the production image.
  `npm run verify:dashboard-proxy` (11 checks).
- **AI chat routing** — `POST /api/ai/chat` routes through the HybridRouter
  (Ollama → Gemini → Groq → OpenRouter) against a mock Ollama, and answers
  an honest 503 `no_ai_provider_configured` with no provider configured.
  `npm run verify:ai-chat` (16 checks).
- **Worker runtime** — scheduled triggers fire into the API's execution
  history; the worker re-scans for new/activated workflows every 5
  minutes. `npm run verify:worker` (19 checks).
- **MCP server** — the 11 tools in `apps/mcp-server` were driven over
  stdio against a live test API: initialize, tools/list, health,
  list/import templates (all 10 listed, template-01 imported with merged
  variables), import/run/activate a workflow, list executions, list
  credentials (metadata only), and the honest AI 503.
  `npm run verify:mcp-server` (21 checks).
- **CI is strict**: no `|| true` anywhere; the workflow runs lint, all
  tests, pytest, `docker compose config` and real `docker build` steps for
  the api/web/worker images. CI + Security are green on the latest commit.

## What was NOT verified live

- **No live WhatsApp, Shopify, Daraz, Instagram, YouTube or courier
  account was ever connected during development** — no such credentials
  exist for testing — so no template has ever called a real provider
  endpoint. The connector code targets the real provider APIs (the mocks
  implement the same request/response shapes), but **the buyer must connect
  their own accounts and keys before any template talks to a real
  provider**.
- **No live AI provider call was ever made.** Router, key rotation,
  fallback and cooldown logic are tested; chat routing is verified against
  a mock Ollama only. Bring your own free-tier keys or a local Ollama.
- **The Docker Compose stack was verified by `docker compose config` and
  by building all three images in CI — but a full `docker compose up` was
  never run on the build machine** (no Docker daemon there). The compose
  file renders, the images build, and the same services were run directly
  with Node + local Postgres for every verification above. A buyer on a
  machine with Docker follows `reference/setup.md`.
- **The WhatsApp QR engine is unofficial** (ban risk if sending limits are
  ignored). The official Cloud API is the recommended path for shops.
- **Agensi tools**: Agensi's own tools cover Amazon/Shopify/eBay/Walmart
  product data; **WhatsApp coverage is NOT confirmed by Agensi**, and no
  promises exist on additions. Live WhatsApp/Shopify store connections
  remain a buyer requirement either way.
- **Media worker**: `/transcribe`, `/ocr` and `/tts` return 503 until the
  optional models are installed (documented behaviour, not a defect).

## How to re-verify anything

Every claim above has a script in the repo (`scripts/verify-*.mjs`) or a
test suite (`npm test`). Run them from a fresh clone; a claim that does
not reproduce is a bug — report it instead of working around it.
