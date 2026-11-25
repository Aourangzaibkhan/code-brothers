# Code Brothers — Connectors & Free Credentials Guide

Every integration in Code Brothers starts at **$0**. This guide shows how
to get each free credential (spec Section 12) and where it goes: open the
dashboard **Credentials Vault** and create a credential with the listed
slot name — values are encrypted (AES-256-GCM) and never shown again.

## Verification status — read this first

**What was verified (automated, repeatable):** 420 Node tests + 14
Python tests pass; all 10 templates in `templates/` run end to end
against mock provider servers (WhatsApp Graph, Shopify Admin, Daraz,
Instagram Graph, YouTube Data, ExperGo/TCS couriers, WooCommerce) plus a
mock AI media worker — run `npm run verify:templates` to reproduce it.
First-try fresh-clone build, Postgres persistence across restarts
(`npm run verify:persistence`), the production dashboard proxy
(`npm run verify:dashboard-proxy`), AI chat routing against a mock Ollama
(`npm run verify-ai-chat`), and worker cron firing
(`npm run verify:worker`) are all verified live on this machine.

**What was NOT verified live:** no live WhatsApp, Shopify, Daraz,
Instagram, YouTube or courier account was ever connected during
development — no such credentials exist for testing — so no template has
ever called a real provider endpoint. The connector code targets the real
provider APIs (the mocks implement the same request/response shapes), but
**you must connect your own accounts and keys before any template talks
to a real provider**. The table below tells you how to get each one free.

**AI providers:** the router, key rotation, fallback and cooldown logic
are tested, and chat routing is verified against a mock Ollama server —
but no live Gemini/Groq/OpenRouter call was ever made. Bring your own
free-tier keys (below) or a local Ollama install. With no provider
configured the Copilot answers 503 and the dashboard falls back to its
built-in workflow generator, labelled as such.

**If you bought this as an Agensi skill:** Agensi's own tools cover
Amazon/Shopify/eBay/Walmart product data; WhatsApp coverage is NOT
confirmed by Agensi, and no promises exist on additions. Live
WhatsApp/Shopify store connections remain a buyer requirement either way.

## AI providers (the built-in AI Assistant)

| Provider | How to get it free | Slot / where |
| :--- | :--- | :--- |
| **Ollama (local, recommended)** | Install from ollama.com, then `ollama pull qwen2.5:7b` and `ollama pull bge-m3`. Unlimited, offline, private. | No key needed. Full Docker profile runs it as a service; lite profile expects it on the host (`OLLAMA_HOST`). |
| **Google Gemini** | aistudio.google.com → *Get API key* → create key. Free tier. | `.env`: `GEMINI_API_KEY` |
| **Groq** | console.groq.com → *API Keys* → create key. Free tier. | `.env`: `GROQ_API_KEY` |
| **OpenRouter** | openrouter.ai → *Keys* → create key; use the free models. Free tier. | `.env`: `OPENROUTER_API_KEY` |

The AI router rotates across whatever keys you provide and falls back to
local Ollama when the internet or a free tier is unavailable.

## WhatsApp

Two engines — pick one (or both):

- **Free QR engine (personal/business number):** no credential at all.
  Dashboard → WhatsApp → *Connect with QR* → scan with your phone
  (WhatsApp → Linked devices). Session state is encrypted at rest.
  Unofficial — respect the anti-ban sending limits.
- **Official Cloud API (recommended for shops):**
  1. developers.facebook.com → *My Apps* → create a **Business** app →
     add the **WhatsApp** product.
  2. From *WhatsApp → API Setup* copy the **Phone Number ID** and a
     **temporary/permanent access token**.
  3. Set the webhook URL to your tunnel address (see `setup-guide.md`
     Step 7) and copy the **verify token** you choose.
  - Vault slot: `whatsappApi` — fields: phone number ID + access token.

## Instagram

1. Switch your Instagram account to a **Business/Creator** profile
   (free, in the Instagram app settings).
2. Link it to a **Facebook Page**.
3. In the same Meta developer app as above, add the **Instagram Graph
   API** product and generate a user access token for the linked account.
- Vault slot: `instagramApi` — fields: IG user ID + access token.

## YouTube

1. console.cloud.google.com → create a free **Google Cloud Project**.
2. *APIs & Services → Library* → enable **YouTube Data API v3**.
3. *Credentials* → create **OAuth 2.0 Client ID** (10,000 free quota
   units/day) and complete the consent screen for your own channel.
- Vault slot: `youtubeApi` — fields: OAuth client ID/secret + refresh token.

## Shopify

1. Shopify Admin → **Settings → Apps and sales channels → Develop apps**.
2. Create a **custom app**, select the scopes you need (orders, products,
   inventory), and install it on your store.
3. Copy the **Admin API access token** (shown once — save it straight
   into the vault).
- Vault slot: `shopifyApi` — fields: `shop` (your `.myshopify.com`
  domain) + `accessToken`.
- Also copy the app's **API secret** for webhook HMAC verification.

## Daraz

1. open.daraz.com → register a free **developer account**.
2. Create a **Seller In-House App** for your seller account.
3. Copy the **App Key** and **App Secret**; complete the seller
   authorization flow to get the access/refresh tokens.
- Vault slot: `darazApi` — fields: app key, app secret, access token.

## Local / custom website

Two free options, no credential marketplace needed:

- **Universal webhook:** Code Brothers gives you an HMAC-signed webhook
  URL per workflow — paste it into your website/WooCommerce webhook
  settings and keep the signing secret in the vault.
- **Direct database:** create a **read-only** MySQL/PostgreSQL user on
  your store database and save its connection details in the vault.
  The local DB connector only ever runs parameterized queries.
- WooCommerce: *WooCommerce → Settings → Advanced → REST API* → create a
  key with Read/Write permission for order/stock nodes.

## Hosting (for webhooks)

- **Cloudflare Tunnel** — free, zero open ports, runs on your own PC.
  See `setup-guide.md` Step 7.
- **Oracle Cloud Always Free VPS** — free 24/7 alternative if your PC is
  not always on.
