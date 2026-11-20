# Code Brothers — Beginner Setup Guide

Get a working Code Brothers platform in about 15 minutes. Everything is
free and runs on your own machine — no cloud account, no open ports, no
paid AI.

> Prefer Roman Urdu? Read `setup-guide.ur.md`. Going live for real
> customers? Finish with `hardening-guide.md` afterwards.

## What you need

- A computer with **~4 GB free RAM** (lite profile) — the full offline-AI
  profile needs more.
- **Docker** with the Compose v2 plugin (Docker Desktop on Windows/Mac,
  or Docker Engine on Linux).
- **Git**.

## Step 1 — Clone the repository

```bash
git clone https://github.com/AourangZaibKhan/code-brothers.git
cd code-brothers
```

## Step 2 — Create your `.env` file

```bash
cp .env.example .env
```

Open `.env` and set real values — never use the placeholder passwords:

| Variable | What to put |
| :--- | :--- |
| `CB_MASTER_KEY` | 64 hex characters. Generate one: `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | A long random password for the database |
| `REDIS_PASSWORD` | A long random password for Redis |
| `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` | Optional in lite (free cloud AI). Leave empty to skip. See `connectors.md`. |

> **Back up `CB_MASTER_KEY` somewhere safe outside this folder** (password
> manager, printed paper). Every credential you save in the platform vault
> is encrypted with it — if you lose it, saved credentials cannot be
> recovered.

## Step 3 — Start the lite stack

From the repository root:

```bash
docker compose -f docker/docker-compose.lite.yml up -d
```

Wait until the database and Redis report `healthy`:

```bash
docker compose -f docker/docker-compose.lite.yml ps
```

The dashboard is now at **http://localhost:8080** and the API at
**http://localhost:3000** — both bound to your machine only.

## Step 4 — Claim the owner account (first boot only)

There are **no default passwords**. On first boot the API generates a
one-time setup token and prints it in its log:

```bash
docker compose -f docker/docker-compose.lite.yml logs api | grep -i "setup token"
```

1. Open **http://localhost:8080**.
2. Enter the setup token, your email, and a strong new password.
3. Click **Claim account**. Setup closes permanently — the token can never
   be used again, by anyone.

Then immediately go to **Security Center → Two-Factor Authentication** and
enable **TOTP 2FA** with any authenticator app.

## Step 5 — Add your credentials

Open **Credentials Vault** in the dashboard and add the services you use.
Credentials are write-only: the platform encrypts them and never shows
them back in the browser.

Start with what you have — every connector is free to set up. Step-by-step
instructions for each one (WhatsApp, Instagram, YouTube, Shopify, Daraz,
local website, AI keys) are in **`connectors.md`**.

## Step 6 — Import your first template

1. Open **Workflows → Templates** and import
   `templates/template-01-whatsapp-sales-assistant.json`
   (or any of the 10 templates in the `templates/` folder).
2. Fill in the workflow **variables** (your phone number, product links —
   each template lists them under `settings.variables`).
3. Press **Activate**.

Tip: validate any template file before importing:

```bash
node templates/validate.mjs
```

## Step 7 — Go live with Cloudflare Tunnel (zero open ports)

WhatsApp, Shopify and Daraz need to reach your webhooks over HTTPS. A
Cloudflare Tunnel gives you a public HTTPS address **without opening any
port** on your router or firewall:

```bash
# install cloudflared (free): https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel login
cloudflared tunnel create code-brothers
cloudflared tunnel route dns code-brothers hooks.yourdomain.com
cloudflared tunnel run code-brothers
```

Configure the tunnel to forward `hooks.yourdomain.com` to
`http://localhost:3000`, then paste that HTTPS URL into your store/Meta
webhook settings. Keep the dashboard itself on `localhost` — only the
webhook/API address needs to be public.

**No domain?** For 24/7 running you can instead deploy the same compose
file on an **Oracle Cloud Always Free** VPS — also $0.

## Step 8 — Before real customers

Work through **`hardening-guide.md`** — it turns the platform's pre-launch
security checklist into concrete steps (2FA, kill-switch test, backup
test, SSRF self-test).

## Troubleshooting

| Problem | Fix |
| :--- | :--- |
| `POSTGRES_PASSWORD is required` style error | Your `.env` is missing a value — Step 2. |
| Dashboard does not open | `docker compose … ps` — is `web` up? Then check `logs web`. |
| Lost the setup token | It is only printed once. If nobody claimed the account yet, restart the `api` service to print a fresh one. |
| AI replies unavailable | Lite profile: add a free cloud key (Step 2) or run Ollama on the host; or switch to `docker-compose.full.yml` for offline AI. |
