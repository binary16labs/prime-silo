#!/usr/bin/env node
/**
 * Offload Ledger Report (ADR-004, Phase 4 — honest instrumentation)
 *
 * Aggregates the append-only offload ledger into the metrics that actually
 * answer "did this save the planner's tokens?". Per the memo-ray token-audit
 * lesson, we report COMPONENTS and a clearly-labelled ESTIMATE — never a single
 * unverified hero number.
 *
 *   node scripts/offload-report.mjs                 # default workspace
 *   node scripts/offload-report.mjs --workspace ws
 *   node scripts/offload-report.mjs --json          # machine-readable
 *
 * The headline metric for the project goal is the OFFLOAD RATE (tasks that
 * passed locally without escalation) and the READ-BACK COST (digest chars the
 * planner consumed). 75% offload is a claim to *measure here*, not assert.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function bennyHome() {
  let h = process.env.BENNY_HOME;
  if (!h) {
    const envPath = path.join(projectRoot, '.env');
    if (fs.existsSync(envPath)) {
      const m = fs.readFileSync(envPath, 'utf8').match(/^BENNY_HOME=(.*)$/m);
      if (m) h = m[1].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  h = h || '.benny_home';
  return path.isAbsolute(h) ? h : path.resolve(projectRoot, h);
}

const args = process.argv.slice(2);
const workspace = (() => { const i = args.indexOf('--workspace'); return i >= 0 ? args[i + 1] : 'default'; })();
const asJson = args.includes('--json');

const ledgerPath = path.join(bennyHome(), 'workspaces', workspace, 'offload', 'ledger', 'offload.jsonl');

if (!fs.existsSync(ledgerPath)) {
  console.error(`No ledger at ${ledgerPath}. Run some offload tasks first.`);
  process.exit(1);
}

const rows = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const total = rows.length;
const by = (pred) => rows.filter(pred).length;
const sum = (key) => rows.reduce((a, r) => a + (r[key] || 0), 0);

const passed = by((r) => r.status === 'passed');
const escalated = by((r) => r.escalated);
const redEsc = by((r) => r.status === 'red-escalated');
const failed = by((r) => r.status === 'failed');
const upgraded = by((r) => r.upgraded);
const collusion = by((r) => r.collusion_flag);

const offloadRate = total ? (passed / total) : 0;            // passed locally, no planner
const escalationRate = total ? (escalated / total) : 0;      // planner had to engage
const savedEstChars = sum('planner_tokens_saved_estimate');  // ESTIMATE (label everywhere)
const readBackChars = sum('digest_chars');                   // remaining planner cost
const wouldHaveRead = sum('artifact_chars');                 // if planner did it itself

const report = {
  workspace,
  tasks: total,
  outcomes: { passed, escalated, red_escalated: redEsc, failed },
  tier_upgrades: upgraded,
  collusion_flags: collusion,
  offload_rate: Number(offloadRate.toFixed(3)),
  escalation_rate: Number(escalationRate.toFixed(3)),
  planner_tokens_saved_estimate: savedEstChars,
  read_back_chars: readBackChars,
  artifact_chars_avoided: wouldHaveRead,
  caveat:
    'planner_tokens_saved_estimate counts local completion tokens the planner did NOT generate. ' +
    'It is an ESTIMATE — true savings depend on the planner\'s own verbosity. The honest headline ' +
    'is offload_rate (work done without the planner) and read_back_chars (what the planner still paid).',
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  console.log(`\nOffload ledger — workspace '${workspace}'  (${total} task(s))`);
  console.log('─'.repeat(56));
  console.log(`  passed locally     ${passed}   (offload rate ${pct(offloadRate)})`);
  console.log(`  escalated          ${escalated}   (escalation rate ${pct(escalationRate)})`);
  console.log(`  red (refused)      ${redEsc}`);
  console.log(`  failed             ${failed}`);
  console.log(`  tier upgrades      ${upgraded}`);
  console.log(`  collusion flags    ${collusion}`);
  console.log('─'.repeat(56));
  console.log(`  read-back cost     ${readBackChars} chars  (what the planner actually consumed)`);
  console.log(`  artifact avoided   ${wouldHaveRead} chars  (raw output the planner did NOT read)`);
  console.log(`  saved (ESTIMATE)   ~${savedEstChars} local completion tokens off the planner`);
  console.log('─'.repeat(56));
  console.log(`  NOTE: offload_rate is the honest headline. 75% is a target to`);
  console.log(`        reach here, not a number to assert. ${total < 5 ? 'Sample too small — keep going.' : ''}\n`);
}
