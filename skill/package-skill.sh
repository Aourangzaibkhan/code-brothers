#!/usr/bin/env bash
# Build the Agensi submission ZIP for the code-brothers skill.
#
# What it does:
#   1. Stages SKILL.md + reference/ + scripts/ + README.md from skill/
#   2. Copies FRESH template JSONs from the repo's templates/ (the repo is
#      the single source of truth — staged copies must never be edited)
#   3. Validates the repo templates (templates/validate.mjs) and the staged
#      skill (validate-skill.mjs)
#   4. Zips the stage into code-brothers-skill-v<VERSION>.zip at the repo root
#
# Usage: bash skill/package-skill.sh
# Version comes from the `version:` field in skill/SKILL.md frontmatter.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_DIR="$ROOT/skill"
STAGE="$SKILL_DIR/.package"

VERSION="$(node -e 'const fs=require("fs");const m=fs.readFileSync(process.argv[1],"utf8").match(/^version:\s*(.+)$/m);if(!m){console.error("no version in SKILL.md frontmatter");process.exit(1)}console.log(m[1].trim())' "$SKILL_DIR/SKILL.md")"
OUT="$ROOT/code-brothers-skill-v$VERSION.zip"

rm -rf "$STAGE" "$ROOT"/code-brothers-skill-v*.zip
mkdir -p "$STAGE/templates"

cp "$SKILL_DIR/SKILL.md" "$STAGE/SKILL.md"
cp -r "$SKILL_DIR/reference" "$STAGE/reference"
cp -r "$SKILL_DIR/scripts" "$STAGE/scripts"
cp "$SKILL_DIR/README.md" "$STAGE/README.md"
cp "$ROOT"/templates/template-*.json "$STAGE/templates/"

# The repo templates are the authority: byte-identical copies are valid by
# construction, and validate-skill.mjs re-checks that below.
node "$ROOT/templates/validate.mjs"
node "$SKILL_DIR/validate-skill.mjs" "$STAGE"

(cd "$STAGE" && zip -qr "$OUT" .)
echo "Built $OUT"
unzip -l "$OUT"
