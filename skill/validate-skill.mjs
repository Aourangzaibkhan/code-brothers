#!/usr/bin/env node
/**
 * validate-skill.mjs — structural validation for the Agensi skill package.
 *
 * Usage: node skill/validate-skill.mjs [dir]
 *   dir defaults to skill/.package (the packaging script's staging dir).
 *   Pass an extracted ZIP directory to validate a built package instead.
 *
 * Checks:
 *   1. SKILL.md exists with valid frontmatter (name, description, version).
 *   2. Every reference/*.md and scripts/*.mjs file the SKILL.md mentions exists.
 *   3. templates/ holds exactly the 10 template JSONs, each parses with the
 *      WorkflowDefinition shape, and each is byte-identical to the repo's
 *      templates/ copy (the repo is the single source of truth).
 *   4. No secret-looking literals anywhere in the package (private keys,
 *      cloud access keys, long API tokens, real-looking passwords). The
 *      Agensi security scan rejects secrets; this is the local tripwire.
 *   5. Every bundled script passes `node --check`.
 *
 * Exit code 0 = the package is structurally valid.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.argv[2] ?? join(ROOT, 'skill', '.package');

const failures = [];
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(name);
}

function listFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listFiles(full, out);
    else out.push(full);
  }
  return out;
}

/* 1. SKILL.md frontmatter ------------------------------------------- */
const skillPath = join(DIR, 'SKILL.md');
check('SKILL.md exists', existsSync(skillPath));
const skill = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : '';
const fm = skill.match(/^---\n([\s\S]*?)\n---\n/);
check('SKILL.md has YAML frontmatter', fm !== null);
const front = {};
if (fm) {
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) front[m[1]] = m[2].trim();
  }
}
check(
  'frontmatter name is a valid skill slug',
  typeof front.name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(front.name),
  String(front.name),
);
check(
  'frontmatter description is present (buyer-facing)',
  typeof front.description === 'string' && front.description.length >= 40,
  `${String(front.description ?? '').length} chars`,
);
check(
  'frontmatter version is semver',
  typeof front.version === 'string' && /^\d+\.\d+\.\d+$/.test(front.version),
  String(front.version),
);

/* 2. Referenced files exist ------------------------------------------ */
const refMentions = [...new Set([...skill.matchAll(/reference\/([a-z0-9-]+\.md)/g)].map((m) => m[1]))];
for (const ref of refMentions) {
  check(`referenced reference/${ref} exists`, existsSync(join(DIR, 'reference', ref)));
}
const scriptMentions = [...new Set([...skill.matchAll(/scripts\/([a-z0-9-]+\.mjs)/g)].map((m) => m[1]))];
for (const s of scriptMentions) {
  check(`referenced scripts/${s} exists`, existsSync(join(DIR, 'scripts', s)));
}

/* 3. Templates -------------------------------------------------------- */
const tplDir = join(DIR, 'templates');
const tplFiles = existsSync(tplDir)
  ? readdirSync(tplDir).filter((f) => /^template-\d+-.*\.json$/.test(f)).sort()
  : [];
check('templates/ holds exactly 10 template JSONs', tplFiles.length === 10, `${tplFiles.length} files`);
for (const file of tplFiles) {
  const staged = readFileSync(join(tplDir, file));
  let parsed;
  try {
    parsed = JSON.parse(staged.toString('utf8'));
  } catch {
    check(`template ${file} parses as JSON`, false);
    continue;
  }
  const shapeOk =
    typeof parsed.id === 'string' &&
    typeof parsed.name === 'string' &&
    Array.isArray(parsed.nodes) &&
    Array.isArray(parsed.edges) &&
    typeof parsed.settings === 'object';
  check(`template ${file} has WorkflowDefinition shape`, shapeOk);
  const repoCopy = join(ROOT, 'templates', file);
  check(
    `template ${file} is byte-identical to the repo copy`,
    existsSync(repoCopy) && readFileSync(repoCopy).equals(staged),
  );
}

/* 4. No secret-looking literals --------------------------------------- */
const SECRET_PATTERNS = [
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key block'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/sk-(live|proj)-[A-Za-z0-9]{16,}/, 'live secret key'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/EAAT[A-Za-z0-9]{10,}/, 'Meta access token'],
  [/"password"\s*:\s*"[^".]{8,}"/, 'hardcoded password value'],
  [/CB_MASTER_KEY=[A-Za-z0-9]{16,}/, 'hardcoded master key'],
  [/api[_-]?key\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/, 'hardcoded API key'],
];
const textFiles = existsSync(DIR)
  ? listFiles(DIR).filter((f) => /\.(md|mjs|json|txt)$/.test(f))
  : [];
let secretsFound = 0;
for (const file of textFiles) {
  const content = readFileSync(file, 'utf8');
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(content)) {
      console.log(`FAIL  secret scan: ${label} in ${file.replace(DIR + '/', '')}`);
      secretsFound++;
    }
  }
}
check('no secret-looking literals in the package', secretsFound === 0, `${secretsFound} hit(s)`);

/* 5. Scripts parse ----------------------------------------------------- */
for (const file of textFiles.filter((f) => f.endsWith('.mjs'))) {
  try {
    execFileSync('node', ['--check', file], { stdio: 'pipe' });
    check(`script parses: ${file.replace(DIR + '/', '')}`, true);
  } catch {
    check(`script parses: ${file.replace(DIR + '/', '')}`, false);
  }
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.length} check(s): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nSkill package is structurally valid.');
