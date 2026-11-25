# Templates — the 10 ready workflows

All 10 files live in `templates/` in this package (fresh copies of the
repo's `templates/`). Each file is a `WorkflowDefinition`
`{ id, name, description, nodes, edges, settings }`. Validate before
importing: `node templates/validate.mjs` in the repo.

**Honest status:** all 10 run end to end against mock providers
(`npm run verify:templates` in the repo). **No template has ever called a
live provider** — connect your own credentials first (see
`reference/connectors.md`), fill in the variables, run manually once,
then activate.

Variables are declared under each template's `settings.variables`.
Credentials are added in the dashboard's Credentials Vault, never in the
template file.

## 01 — Multilingual WhatsApp AI Sales Assistant (Voice + Text)

- File: `template-01-whatsapp-sales-assistant.json`
- Trigger: incoming WhatsApp text or voice note (webhook).
- Flow: Whisper transcription (AI media worker) → RAG catalog search →
  stock check → answer in the customer's language → collect address →
  create a Shopify draft order.
- Variables: `mediaWorkerBaseUrl` (default `http://ai-media-worker:8000`),
  `apiBaseUrl` (default `http://localhost:3000`).
- Needs: WhatsApp credential (`whatsappApi` or QR session), Shopify
  credential (`shopifyApi`), AI media worker running for voice notes.
- Nodes: `core.webhookTrigger`, `core.switch`, `core.httpRequest`,
  `core.setData`, `core.if`, `whatsapp.sendMessage`,
  `shopify.createDraftOrder`, `whatsapp.downloadMedia`.

## 02 — Payment Screenshot Auto-Verifier

- File: `template-02-payment-screenshot-verifier.json`
- Trigger: buyer sends a JazzCash / EasyPaisa / UPI / PIX / bank receipt
  on WhatsApp.
- Flow: OCR (AI media worker) extracts amount + TID → duplicate TID check
  against the `payment_tids` ledger → order marked paid or flagged.
- Variables: `mediaWorkerBaseUrl`.
- Needs: WhatsApp credential, AI media worker (OCR), local database
  (the TID ledger).
- Nodes: `core.webhookTrigger`, `core.httpRequest`, `core.setData`,
  `local.dbQuery`, `core.if`, `whatsapp.sendMessage`,
  `courier.bookShipment`, `whatsapp.downloadMedia`.

## 03 — Unified 3-Channel Stock Sync

- File: `template-03-stock-sync-3-channel.json`
- Trigger: a sale on Shopify (webhook).
- Flow: deduct the mapped Master SKU stock on Daraz and the local website
  (and refresh the Shopify level). Duplicate the workflow with a Daraz or
  WooCommerce trigger to sync from the other channels.
- Variables: `shopifyLocationId`.
- Needs: Shopify, Daraz and local-store credentials; SKU mappings in the
  catalog (`POST /api/catalog/sku-mappings`).
- Nodes: `core.webhookTrigger`, `core.loop`, `daraz.updateStock`,
  `shopify.updateInventory`, `local.dbQuery`, `core.log`.

## 04 — COD Fake-Order Shield

- File: `template-04-cod-fake-order-shield.json`
- Trigger: a new COD order (webhook).
- Flow: customer risk score lookup by phone → high-risk buyers get a
  partial-advance template request; normal buyers get a confirmation
  message in their own language, then the courier booking proceeds.
- Variables: none.
- Needs: WhatsApp credential, courier credential, risk-score data in the
  local database.
- Nodes: `core.webhookTrigger`, `local.dbQuery`, `core.if`,
  `whatsapp.sendTemplate`, `whatsapp.sendMessage`, `courier.bookShipment`.

## 05 — Instagram Comment-to-Sale Bot

- File: `template-05-instagram-comment-to-sale.json`
- Trigger: a comment containing the trigger keyword on a Reel (webhook).
- Flow: instant public reply + a private DM with the product link; the AI
  Assistant handles follow-up questions in the Unified Inbox.
- Variables: `productLink`.
- Needs: Instagram credential (`instagramApi`).
- Nodes: `core.webhookTrigger`, `core.if`, `instagram.replyComment`,
  `instagram.sendDm`, `core.log`.

## 06 — 1-Click Long Video to 5 Reels/Shorts Factory

- File: `template-06-reels-shorts-factory.json`
- Trigger: manual (one click).
- Flow: transcribe a long video, cut one Short/Reel per transcription
  segment, upload each to YouTube Shorts and publish it as an Instagram
  Reel. Clip boundaries come from the transcription segments.
- Variables: `mediaWorkerBaseUrl`.
- Needs: YouTube + Instagram credentials, AI media worker (transcription).
- Nodes: `core.manualTrigger`, `core.httpRequest`, `core.setData`,
  `core.loop`, `youtube.uploadVideo`, `instagram.publishPost`.

## 07 — YouTube Upload Auto-Promoter

- File: `template-07-youtube-upload-auto-promoter.json`
- Trigger: a new YouTube video is published (webhook).
- Flow: AI writes localized promo copy → shares it to the WhatsApp
  broadcast list and as an Instagram post/story.
- Variables: `broadcastPhone`.
- Needs: YouTube, WhatsApp and Instagram credentials; an AI provider for
  the promo copy (or the built-in generator fallback).
- Nodes: `core.webhookTrigger`, `core.setData`, `whatsapp.sendMessage`,
  `instagram.publishPost`, `core.log`.

## 08 — AI Comment Growth & Spam Shield

- File: `template-08-comment-growth-spam-shield.json`
- Trigger: every 15 minutes (cron).
- Flow: fetch new YouTube comments → AI classification
  (spam / lead / question) → spam is hidden, leads get a reply with the
  purchase link, questions get a natural AI answer.
- Variables: `monitoredVideoId`, `productLink`, `youtubeApiBaseUrl`.
- Needs: YouTube credential; an AI provider for classification.
- Nodes: `core.cronTrigger`, `core.httpRequest`, `core.loop`,
  `core.switch`, `youtube.replyComment`, `core.setData`.

## 09 — Abandoned Cart Recovery Loop

- File: `template-09-abandoned-cart-recovery.json`
- Trigger: Shopify/website checkout abandoned (webhook).
- Flow: wait 2 hours → if still unpaid, send a polite personalized
  WhatsApp reminder with the checkout link (the AI Assistant answers
  follow-up questions).
- Variables: none.
- Needs: WhatsApp credential; Shopify or local-store webhook.
- Nodes: `core.webhookTrigger`, `core.wait`, `core.if`,
  `whatsapp.sendMessage`, `core.log`.

## 10 — Daily CEO WhatsApp Digest

- File: `template-10-ceo-digest.json`
- Trigger: every night at 22:00 (cron).
- Flow: aggregate Shopify + Daraz + local website orders, revenue,
  returns and top SKUs → build a PDF summary → send it to the owner on
  WhatsApp.
- Variables: `ownerPhone`.
- Needs: Shopify, Daraz and local-store credentials; WhatsApp credential.
- Nodes: `core.cronTrigger`, `shopify.getOrders`, `daraz.getOrders`,
  `local.wooGetOrders`, `core.pdfGenerate`, `whatsapp.sendMessage`,
  `core.aggregate`.
