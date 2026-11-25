# Troubleshooting

## The API refuses to boot / `CB_MASTER_KEY` errors

The API refuses a weak or missing `CB_MASTER_KEY` on purpose. Generate a
real one and restart:

```bash
openssl rand -hex 32   # paste the 64 hex chars into .env as CB_MASTER_KEY
```

If you change the master key after credentials were saved, those
credentials cannot be decrypted — that is why the setup guide says to
back the key up outside the folder.

## `POSTGRES_PASSWORD is required` (or REDIS_PASSWORD / CB_MASTER_KEY)

Your `.env` is missing a value. The compose file requires all three with
`:?` syntax. Copy `.env.example` to `.env` and fill every variable.

## Dashboard does not open (http://localhost:8080)

```bash
docker compose -f docker/docker-compose.lite.yml ps
docker compose -f docker/docker-compose.lite.yml logs web
```

Is the `web` service up? Is `api` up? The dashboard proxies `/api` to the
API container (nginx) — if the API is down, the dashboard loads but its
data calls fail.

## Lost the setup token

It is printed once in the API log. If nobody claimed the account yet,
restart the `api` service to print a fresh one:

```bash
docker compose -f docker/docker-compose.lite.yml restart api
docker compose -f docker/docker-compose.lite.yml logs api | grep -i "setup token"
```

## A template run fails

1. Read the execution record (`GET /api/executions/:id` or the dashboard)
   — it names the failing node.
2. Check the two usual causes first: a missing credential in the Vault,
   or an empty variable under the workflow's `settings.variables`.
3. Validate the template file: `node templates/validate.mjs`.
4. If the failing node is an `httpRequest` to the AI media worker, see the
   media-worker section below.

## AI replies unavailable (503 `no_ai_provider_configured`)

No AI provider is configured. Add a free key to `.env`
(`GEMINI_API_KEY`, `GROQ_API_KEY`, or `OPENROUTER_API_KEY`), or run
Ollama on the host (`OLLAMA_HOST`), then restart the API. Until then the
Copilot answers 503 and the dashboard falls back to its built-in workflow
generator, labelled as such. This is expected, not a bug.

## Media worker answers 503 (`/transcribe`, `/ocr`, `/tts`)

The optional models are not installed — those endpoints return 503 until
they are. Templates that need transcription or OCR (01, 02, 06) cannot
run until the models are installed. See `services/ai-media-worker` in the
repo.

## Scheduled workflows never fire

The worker service (`apps/worker`, the `worker` service in both compose
files) arms `core.cronTrigger` schedules and re-scans every 5 minutes for
workflows created or activated after boot. Check:

```bash
docker compose -f docker/docker-compose.lite.yml ps      # is `worker` up?
docker compose -f docker/docker-compose.lite.yml logs worker
```

The worker needs the same `DATABASE_URL` and `CB_MASTER_KEY` as the API
and refuses to start without them. It also needs the workflow to be
**active** — a manual run does not arm the schedule.

## Data disappears after a restart

It should not: workflows, credentials, runs and RAG documents live in
Postgres (named `pgdata` volume in compose). If data is gone, the volume
was deleted or the stack was started with a different project name.
Verify with `npm run verify:persistence` in the repo.

## Login says `too_many_attempts` (429)

The login throttle locked the email+IP after repeated failures. Wait for
the `retryAfterMs` in the response, then try once with the correct
password. Check the audit log (`GET /api/security/audit-logs`) for the
failed attempts.

## Webhooks never arrive

Providers need a public HTTPS URL. Set up the Cloudflare Tunnel from
`reference/setup.md` step 7 and paste the HTTPS URL into the provider's
webhook settings. Localhost URLs are unreachable from the internet.
