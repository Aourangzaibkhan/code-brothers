# Code Brothers

**Free, Open-Source & Secure Visual Automation + AI Assistant Platform**

A self-hosted n8n/Zapier alternative with a built-in free AI assistant and enterprise-grade cybersecurity — built for WhatsApp, Instagram, YouTube, Shopify, Daraz and local websites. 100% free, MIT licensed, zero telemetry, zero paywalls.

## Highlights
- Drag-and-drop visual workflow builder (React Flow) with 11 languages + RTL (Urdu, Arabic)
- Built-in AI Copilot: local Ollama + free cloud AI (Gemini, Groq, OpenRouter) with automatic fallback
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

## Templates
10 ready-to-import workflows live in [`templates/`](templates/README.md) — validate them with `node templates/validate.mjs`.

## Docs
- [Setup guide (English)](docs/setup-guide.md) · [Setup guide (Roman Urdu)](docs/setup-guide.ur.md)
- [Connectors & free credentials](docs/connectors.md)
- [Hardening guide](docs/hardening-guide.md)

The optional Python AI media worker (Whisper/TTS/OCR/FFmpeg) lives in `services/ai-media-worker` and is part of the `docker-compose.full.yml` profile.

## License
MIT — free for personal, agency and commercial use.
