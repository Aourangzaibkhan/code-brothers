# Code Brothers

**Free, Open-Source & Secure Visual Automation + AI Assistant Platform**

A self-hosted n8n/Zapier alternative with a built-in free AI assistant and enterprise-grade cybersecurity — built for WhatsApp, Instagram, YouTube, Shopify, Daraz and local websites. 100% free, MIT licensed, zero telemetry, zero paywalls.

## Highlights
- Drag-and-drop visual workflow builder (React Flow) with 11 languages + RTL (Urdu, Arabic)
- Built-in AI Copilot: local Ollama + free cloud AI (Gemini, Groq, OpenRouter) with automatic fallback — bring your own Ollama install or free-tier API keys (set `OLLAMA_HOST` / `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` in `.env`); with no provider configured the Copilot answers 503 and the dashboard falls back to its built-in workflow generator, labelled as such
- WhatsApp dual engine (Free QR + Official Cloud API) with anti-ban queue
- Master SKU sync across Shopify, Daraz and local stores + COD Fraud Shield
- Zero-trust security: AES-256-GCM envelope vault, SSRF firewall, V8 sandbox, TOTP 2FA, kill switch
- 10 ready-to-import automation templates

## Quick Start
```bash
git clone https://github.com/AourangZaibKhan/code-brothers.git
cd code-brothers
cp .env.example .env
# Fill in real secrets (the example values are placeholders — the API
# refuses to boot on a weak/missing CB_MASTER_KEY):
node -e "const c=require('crypto'),fs=require('fs');let e=fs.readFileSync('.env','utf8');e=e.replace(/^CB_MASTER_KEY=.*$/m,'CB_MASTER_KEY='+c.randomBytes(32).toString('hex'));e=e.replace(/^POSTGRES_PASSWORD=.*$/m,'POSTGRES_PASSWORD='+c.randomBytes(16).toString('hex'));e=e.replace(/^REDIS_PASSWORD=.*$/m,'REDIS_PASSWORD='+c.randomBytes(16).toString('hex'));fs.writeFileSync('.env',e);console.log('secrets written to .env')"
docker compose -f docker/docker-compose.lite.yml up -d --wait
curl http://localhost:3000/api/setup/status
# {"setupRequired":true,"setupClosed":false} — claim the owner account
# (the one-time setup token is printed in the api container logs).
```

Local development without Docker: `npm ci && npm run build` (first-try
build works — TypeScript project references build workspaces in
dependency order), then `npm start --workspace=@code-brothers/api` and
`npm run dev --workspace=@code-brothers/web`.

## Verification status

Verified live, repeatable with the `npm run verify:*` scripts: 420 Node
tests + 14 Python tests; all 10 templates run end to end against mock
providers; Postgres persistence across restarts; production dashboard
proxy; AI chat routing (mock Ollama) with an honest 503 when no provider
is configured; worker cron firing into the API's execution history.
**Not verified live:** no real WhatsApp/Shopify/Daraz/Instagram/YouTube
account was ever connected — connectors were tested against mocks only,
and live AI providers were never called. Buyers must connect their own
accounts and free-tier keys; see
[docs/connectors.md](docs/connectors.md#verification-status--read-this-first)
for exactly what is and isn't proven.

## Templates
10 ready-to-import workflows live in [`templates/`](templates/README.md) — validate them with `node templates/validate.mjs`.

## Docs
- [Setup guide (English)](docs/setup-guide.md) · [Setup guide (Roman Urdu)](docs/setup-guide.ur.md)
- [Connectors & free credentials](docs/connectors.md)
- [Hardening guide](docs/hardening-guide.md)

The workflow worker (`apps/worker`, `worker` service in both compose files) runs scheduled triggers: it loads active workflows from Postgres, arms their `core.cronTrigger` schedules (re-scanning every 5 minutes for workflows created or activated after boot), executes due runs with vault-backed credentials per owner, and records them in the same execution history the API serves. It needs the same `DATABASE_URL` and `CB_MASTER_KEY` as the API, and refuses to start without them. Verify it with `npm run verify:worker`.

The optional Python AI media worker (Whisper/TTS/OCR/FFmpeg) lives in `services/ai-media-worker` and is part of the `docker-compose.full.yml` profile.

## License
MIT — free for personal, agency and commercial use.
