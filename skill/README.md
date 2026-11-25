# Agensi skill package — source

This directory is the **source** for the code-brothers Agensi skill
listing. It is not the submission itself: the submission is the ZIP built
by `package-skill.sh`.

## What goes in the ZIP

| Path in the ZIP | Source | Notes |
|---|---|---|
| `SKILL.md` | `skill/SKILL.md` | The skill. Frontmatter: `name`, `description`, `version`. |
| `reference/*.md` | `skill/reference/` | Setup, connectors, templates, API, troubleshooting, verification status. |
| `scripts/check-platform.mjs` | `skill/scripts/` | Buyer health-check script (reads `CB_API_URL` + `CB_API_TOKEN` from env). |
| `templates/template-*.json` | **generated** from the repo's `templates/` | Fresh copies at package time. Never edit staged copies — the repo is the single source of truth. |
| `README.md` | `skill/README.md` | This file. |

Agensi delivers **only text files** to buyers (SKILL.md + supporting
files) through the agent connection — no binaries, no `.env`, no
`node_modules`. The platform code itself stays free on GitHub (MIT); the
skill is the know-how that makes an agent able to deploy and operate it.

## Build the ZIP

```bash
bash skill/package-skill.sh
# → code-brothers-skill-v<VERSION>.zip at the repo root
```

The script validates the repo templates, validates the staged skill
(`validate-skill.mjs`: frontmatter, referenced files, template
byte-identity with the repo, secret scan, script syntax), then zips.
`npm run verify:skill` does the same plus a ZIP round-trip check (unzip
to a temp dir and re-validate).

## Versioning

Bump `version:` in `skill/SKILL.md` frontmatter for every submission
(1.0.0 → 1.0.1 for fixes, 1.1.0 for new capabilities). Agensi serves
buyers the latest approved version automatically.

## Rules for editing this package

- **Never put a secret in here** — no passwords, tokens, API keys or
  private keys, not even "test" ones. `validate-skill.mjs` scans for
  them, and Agensi's security scan would reject the submission.
- **Never promise what is not verified.** Anything the platform cannot
  do, or that was only tested against mocks, must say so — see
  `reference/verification-status.md`. The listing draft in
  `docs/agensi-listing.md` carries the same honesty rules.
- **Templates come from the repo.** If a template changes, rebuild the
  ZIP; do not hand-edit a staged copy.
- **Keep SKILL.md executable.** An agent must be able to follow it
  without guessing. If a step needs a value the buyer does not have, the
  skill says exactly where to get it.
