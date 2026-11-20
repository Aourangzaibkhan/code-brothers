# Code Brothers — Workflow Templates

10 ready-to-import automation templates from **Section 10** of the platform
spec. Each file is a `WorkflowDefinition` in the exact shape used by
`@code-brothers/core` (`packages/core/src/types.ts`): `{ id, name,
description, nodes, edges, settings }`, using node types and parameter names
from the core registry and the connector packages.

| # | File | Spec template |
| :- | :--- | :--- |
| 1 | `template-01-whatsapp-sales-assistant.json` | Multilingual WhatsApp AI Sales Assistant (Voice + Text) |
| 2 | `template-02-payment-screenshot-verifier.json` | Payment Screenshot Auto-Verifier |
| 3 | `template-03-stock-sync-3-channel.json` | Unified 3-Channel Stock Sync |
| 4 | `template-04-cod-fake-order-shield.json` | COD Fake-Order Shield |
| 5 | `template-05-instagram-comment-to-sale.json` | Instagram Comment-to-Sale Bot |
| 6 | `template-06-reels-shorts-factory.json` | 1-Click Long Video to 5 Reels/Shorts Factory |
| 7 | `template-07-youtube-upload-auto-promoter.json` | YouTube Upload Auto-Promoter |
| 8 | `template-08-comment-growth-spam-shield.json` | AI Comment Growth & Spam Shield |
| 9 | `template-09-abandoned-cart-recovery.json` | Abandoned Cart Recovery Loop |
| 10 | `template-10-ceo-digest.json` | Daily CEO WhatsApp Digest |

## Before you import

- Fill in workflow **variables** referenced as `{{ $vars.… }}` (owner phone,
  product links, location IDs) — they are declared under each template's
  `settings.variables` with empty placeholder values.
- Add the credentials each connector node needs (WhatsApp Cloud API,
  Shopify, Daraz, YouTube, Instagram) in the Credentials Vault.
- Templates that call the AI media worker expect it at
  `http://ai-media-worker:8000` (the `docker-compose.full.yml` service name);
  adjust the URL if you run the worker elsewhere.

## Validate

```bash
node templates/validate.mjs
```

Checks JSON validity, unique node ids, that every edge endpoint exists, and
that all node types exist in the core/connector registries. Exits non-zero
on any failure.
