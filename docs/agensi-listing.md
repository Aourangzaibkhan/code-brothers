# Agensi listing draft — code-brothers skill (DO NOT SUBMIT without the user's go-ahead)

This file is the **ready-to-paste listing** for the Agensi Creator
Dashboard. Nothing here has been submitted. The ZIP is built with
`bash skill/package-skill.sh` → `code-brothers-skill-v1.0.0.zip`.

## Listing

- **Skill name:** code-brothers
- **Title (listing headline):** Code Brothers — Business Automation Platform for WhatsApp, Shopify, Daraz & Social
- **Price:** **$9 one-time** (seller keeps $6.30 after Agensi's 30%).
  One-time, not a subscription. Price can be changed later; the change
  never applies to past purchases. The listing can be removed at any time;
  earnings already made are still paid out.
- **Category:** Business automation / e-commerce operations.
- **Tags (suggested):** whatsapp-automation, shopify, daraz, ecommerce,
  workflow-automation, self-hosted, cod, inventory-sync, ai-assistant, mcp

## Description (buyer-facing — paste into the listing description)

> Deploy and operate your own business-automation platform — free,
> open-source, self-hosted — with your AI agent doing the work.
>
> Code Brothers is a self-hosted automation platform (a free n8n/Zapier
> alternative) for WhatsApp, Instagram, YouTube, Shopify, Daraz and local
> stores. This skill teaches your agent to deploy it from one Docker
> Compose stack, claim the owner account, connect your accounts, and run
> its 10 ready workflow templates: a WhatsApp sales assistant that answers
> customers in their language, a payment-screenshot verifier, 3-channel
> stock sync, a COD fake-order shield, an Instagram comment-to-sale bot, a
> Reels/Shorts factory, a YouTube auto-promoter, a comment spam shield, an
> abandoned-cart recovery loop, and a nightly CEO digest on WhatsApp.
>
> The skill includes the full setup guide, connector setup for every
> provider, the 10 template files, the API reference, a troubleshooting
> guide, a platform health-check script, and an MCP server (11 tools) so
> your agent can list, import, run and activate workflows on your own
> instance.
>
> **Please read before buying — the honest part:**
>
> - The platform code itself is **free on GitHub (MIT)** at
>   github.com/AourangZaibKhan/code-brothers. You are paying for this
>   skill — the deployment and operating know-how, the templates, and the
>   MCP tools — not for the code.
> - **You need your own accounts and API keys.** Nothing is included:
>   WhatsApp (phone number or Meta Business app), Instagram Business,
>   YouTube Data API, a Shopify custom app, a Daraz developer app, and
>   optionally a free-tier AI key (Gemini/Groq/OpenRouter) or local
>   Ollama. Docker + Git and ~4 GB RAM are required.
> - **Connectors were tested against mock providers only.** No live
>   WhatsApp/Shopify/Daraz/Instagram/YouTube account was ever connected
>   during development, so no template has ever called a real provider
>   endpoint. You connect your own accounts before any template talks to
>   a real provider. Full detail is in the skill's verification-status
>   reference.
> - The WhatsApp QR engine is unofficial (ban risk if sending limits are
>   ignored); the official Cloud API is recommended for shops. The AI
>   media worker's transcribe/OCR/TTS endpoints answer 503 until the
>   optional models are installed.

## Requires (Permissions section of the submit form — one item each)

Per Agensi's docs, the self-hosted server goes under **Requires**, one
item each; "Needs access to" is only for well-known services.

- A machine or VPS running the code-brothers Docker Compose stack
  (Docker + Git, ~4 GB RAM) — the skill deploys it, Agensi does not host it
- GitHub — to clone the public code-brothers repository (MIT, free)
- The buyer's own WhatsApp account or Meta Business app (for WhatsApp flows)
- The buyer's own Shopify store + custom app (for Shopify flows)
- The buyer's own Daraz seller + developer app (for Daraz flows)
- The buyer's own Instagram Business profile + Facebook Page (for Instagram flows)
- The buyer's own Google Cloud project with YouTube Data API v3 (for YouTube flows)
- The buyer's own free-tier AI key or local Ollama install (optional — for the AI Copilot)

## Agensi tools to attach (up to 10, at submit time or later)

Agensi tools need **no buyer API keys** — uses are charged per use from
the buyer's Agensi balance, separate from the $9 skill price. Attach
tools in these categories in the submit form (pick the exact tools in the
form — tool availability is decided there, not in this file):

- **Shopify product/competitor data** — competitor price tracking for the
  stock-sync and competitor-scan flows.
- **Facebook Ad Library** — competitor ad research (free per Agensi's
  pricing examples).
- **SERP API** — live Google results / rank checks for the growth flows.
- **Web search** — general live research the skill's procedures call for.
- **SEO data** — keyword/SERP/backlink data for the YouTube growth flows.

**Not covered by Agensi tools (stated plainly in the listing):** live
WhatsApp messaging and live Shopify store connections. Agensi has not
confirmed WhatsApp coverage, and no promises exist on additions. Those
always need the buyer's own accounts (see Requires).

## What was tested (for the review — and the listing)

- 404 Node tests + 14 Python tests pass; strict CI (no `|| true`) with
  real Docker image builds; CI + Security green on the submitted commit.
- All 10 templates run end to end against mock providers
  (`npm run verify:templates`); MCP server verified over stdio against a
  live test API (`npm run verify:mcp-server`, 21 checks); persistence,
  dashboard proxy, worker cron and AI routing verified with
  `verify:*` scripts.
- Full statement: `skill/reference/verification-status.md`.

## What is NOT included

- No live accounts, API keys, phone numbers or store access.
- No hosting — the buyer runs the stack on their own machine/VPS.
- No done-for-you setup — the skill instructs the buyer's agent; the
  buyer (or their agent) runs the steps.
- No guarantee of sales, views or revenue. No refunds handled by the
  creator — Agensi is the merchant of record and handles taxes, invoicing
  and refunds.

## Submission checklist (user-side steps — none done yet)

1. Agensi account + **Creator Mode** on (Dashboard → Settings).
2. **Payouts**: Zoneless (USDC on Solana) — Stripe does not cover
   Pakistan. KYC with Zoneless is required before a paid skill can go
   live. Seller already has a Binance account: use a **Solana-network
   USDC deposit address** in Binance, and convert USDC → PKR via P2P.
   Never send USDC to a wrong-network address. USDC becomes payable 14
   days after each sale; $3.50 minimum payout.
3. Upload `code-brothers-skill-v1.0.0.zip` in Creator Dashboard →
   Submit a Skill; set price **$9 one-time**; add tags; paste the
   description above; fill the Requires list; attach the Agensi tools.
4. Security review (8-point automated scan + AI/human review, usually
   24–48 hours). If the scan flags anything, fix it in `skill/` and
   re-upload a new version (bump `version:` in `SKILL.md` frontmatter).
5. After going live: updates ship as new versions; buyers' agents run
   the latest approved version automatically.

## Still open before a listing can happen

- **User's go-ahead** (required — listing is gated on it).
- **Skill-packaging decision** — done by this package: single SKILL.md
  skill (not a pack), teaching the agent to deploy + operate the
  platform, with the MCP server as the agent interface. Rationale: Agensi
  delivers only text into the buyer's agent and hosts no servers, so the
  platform cannot be sold as running code; the skill is the sellable unit.
- **Payout route accepted?** The user has a Binance account, so the
  Zoneless/USDC route is workable — but the user has not explicitly said
  yes to it yet.
- **Live connector verification is permanently impossible** (the user has
  no Meta/Shopify/Daraz accounts). The listing states this honestly.
