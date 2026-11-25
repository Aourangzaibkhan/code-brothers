# Setup — code-brothers, step by step

Source of truth: `docs/setup-guide.md` in the repository (and
`setup-guide.ur.md` in Roman Urdu). This file is the condensed buyer
version of the same steps — if anything here disagrees with the repo
guide, the repo guide wins.

## What you need

- A computer with **~4 GB free RAM** (lite profile).
- **Docker** with the Compose v2 plugin (Docker Desktop on Windows/Mac,
  Docker Engine on Linux) and **Git**.
- About 15 minutes.

## 1. Clone

```bash
git clone https://github.com/AourangZaibKhan/code-brothers.git
cd code-brothers
```

## 2. Create `.env`

```bash
cp .env.example .env
```

Set real values — never use the placeholders:

| Variable | What to put |
| :--- | :--- |
| `CB_MASTER_KEY` | 64 hex characters. Generate one: `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | A long random password for the database |
| `REDIS_PASSWORD` | A long random password for Redis |
| `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` | Optional in lite (free cloud AI tiers). Leave empty to skip. |

**Back up `CB_MASTER_KEY` outside this folder** (password manager, printed
paper). The credentials vault is encrypted with it — lose it and saved
credentials cannot be recovered. The API refuses to boot on a weak or
missing master key; that is deliberate.

## 3. Start the lite stack

```bash
docker compose -f docker/docker-compose.lite.yml up -d
docker compose -f docker/docker-compose.lite.yml ps
```

Wait until postgres and redis report `healthy`. Dashboard:
**http://localhost:8080**. API: **http://localhost:3000**. Both are bound
to localhost only.

No Docker? Local development without Docker works too:
`npm ci && npm run build`, then
`npm start --workspace=@code-brothers/api` and
`npm run dev --workspace=@code-brothers/web` (needs Node 22+ and a local
Postgres/Redis — the compose file is the supported path for buyers).

## 4. Claim the owner account (first boot only)

There are **no default passwords**. On first boot the API prints a
one-time setup token in its log:

```bash
docker compose -f docker/docker-compose.lite.yml logs api | grep -i "setup token"
```

1. Open **http://localhost:8080**.
2. Enter the setup token, your email, and a strong new password.
3. Click **Claim account**. Setup closes permanently — the token can never
   be used again, by anyone.

Then go to **Security Center → Two-Factor Authentication** and enable
**TOTP 2FA** with any authenticator app.

Lost the setup token? It is only printed once. If nobody claimed the
account yet, restart the `api` service to print a fresh one.

## 5. Add credentials

Dashboard → **Credentials Vault**. Credentials are write-only: the
platform encrypts them and never shows them back in the browser. Which
credential each connector needs is in `reference/connectors.md`.

## 6. Import the first template

Dashboard → **Workflows → Templates**, or via the API / MCP server:

```bash
# API: log in first, then import template-01 (see reference/api.md)
curl -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"..."}'
```

Fill in the template's `settings.variables` (phone number, product links),
run it manually once, check the execution, then **Activate**.

Validate any template file before importing:

```bash
node templates/validate.mjs
```

## 7. Public webhooks (only if providers must reach you)

WhatsApp, Shopify and Daraz need to reach your webhooks over HTTPS.
Cloudflare Tunnel gives you a public HTTPS address **without opening any
port**:

```bash
cloudflared tunnel login
cloudflared tunnel create code-brothers
cloudflared tunnel route dns code-brothers hooks.yourdomain.com
cloudflared tunnel run code-brothers
```

Forward `hooks.yourdomain.com` to `http://localhost:3000` and paste that
HTTPS URL into your store/Meta webhook settings. Keep the dashboard on
localhost. No domain? The same compose file also runs on an **Oracle Cloud
Always Free** VPS ($0, 24/7).

## 8. Before real customers

Work through `docs/hardening-guide.md` in the repo: 2FA, kill-switch test,
backup test, SSRF self-test.
