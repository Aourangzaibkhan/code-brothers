# Connectors — what each one needs (buyer accounts)

Every connector is free to set up. **None of the accounts or keys below
are included with this skill** — the buyer connects their own. The
connector code targets the real provider APIs, but **no live provider
account was ever connected during development** (no such credentials
exist for testing). Templates were verified against mock providers only —
see `reference/verification-status.md`.

## AI providers (the built-in AI Copilot)

| Provider | How to get it free | Where it goes |
| :--- | :--- | :--- |
| **Ollama (local, recommended)** | Install from ollama.com, then `ollama pull qwen2.5:7b` and `ollama pull bge-m3`. Unlimited, offline, private. | No key. Full Docker profile runs it as a service; lite expects it on the host (`OLLAMA_HOST`). |
| **Google Gemini** | aistudio.google.com → *Get API key*. Free tier. | `.env`: `GEMINI_API_KEY` |
| **Groq** | console.groq.com → *API Keys*. Free tier. | `.env`: `GROQ_API_KEY` |
| **OpenRouter** | openrouter.ai → *Keys*; use the free models. | `.env`: `OPENROUTER_API_KEY` |

The router rotates across the keys provided and falls back to local
Ollama. With **no provider configured the Copilot answers 503** and the
dashboard falls back to its built-in workflow generator, labelled as such.
That is honest behaviour, not a failure.

## WhatsApp

Two engines — pick one (or both):

- **Free QR engine (personal/business number):** no credential at all.
  Dashboard → WhatsApp → *Connect with QR* → scan with your phone
  (WhatsApp → Linked devices). Session state is encrypted at rest.
  **Unofficial — respect the anti-ban sending limits.** For a real shop,
  use the official Cloud API instead.
- **Official Cloud API (recommended for shops):**
  1. developers.facebook.com → *My Apps* → create a **Business** app →
     add the **WhatsApp** product.
  2. From *WhatsApp → API Setup* copy the **Phone Number ID** and a
     temporary/permanent access token.
  3. Set the webhook URL to your tunnel address and copy the **verify
     token** you choose.
  - Vault slot: `whatsappApi` — fields: phone number ID + access token.

Agensi tools do **not** cover WhatsApp (not confirmed by Agensi). A live
WhatsApp connection always needs the buyer's own number/app.

## Instagram

1. Switch the Instagram account to a **Business/Creator** profile (free,
   in the Instagram app settings).
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
2. Create a **custom app**, select the scopes needed (orders, products,
   inventory), and install it on the store.
3. Copy the **Admin API access token** (shown once — save it straight
   into the vault).
- Vault slot: `shopifyApi` — fields: `shop` (the `.myshopify.com`
  domain) + `accessToken`.
- Also copy the app's **API secret** for webhook HMAC verification.

Agensi tools **do** cover Shopify *product data* (catalogue/price
tracking) with no buyer keys — but a live connection to the buyer's own
store (orders, inventory writes, webhooks) always needs their own custom
app token above.

## Daraz

1. open.daraz.com → register a free **developer account**.
2. Create a **Seller In-House App** for the seller account.
3. Copy the **App Key** and **App Secret**; complete the seller
   authorization flow to get the access/refresh tokens.
- Vault slot: `darazApi` — fields: app key, app secret, access token.

## Local / custom website

Two free options, no credential marketplace needed:

- **Universal webhook:** the platform gives you an HMAC-signed webhook URL
  per workflow — paste it into your website/WooCommerce webhook settings
  and keep the signing secret in the vault.
- **Direct database:** create a **read-only** MySQL/PostgreSQL user on the
  store database and save its connection details in the vault. The local
  DB connector only ever runs parameterized queries.
- WooCommerce: *WooCommerce → Settings → Advanced → REST API* → create a
  key with Read/Write permission for order/stock nodes.

## Couriers (ExperGo, TCS, Leopards, DHL, FedEx)

`GET /api/couriers/presets` lists the supported couriers with their base
URLs. Each needs the buyer's own courier account + API key, stored in the
vault (`courierApi`).
