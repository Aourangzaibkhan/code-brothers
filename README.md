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
cp .env.example .env   # set CB_MASTER_KEY and passwords
docker compose -f docker/docker-compose.lite.yml up -d
```

## License
MIT — free for personal, agency and commercial use.
