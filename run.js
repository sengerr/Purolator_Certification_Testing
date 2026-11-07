#!/usr/bin/env node
/*
 * run.js — YAML test runner for the Purolator certification checklist.
 *
 *   npm install                                   (once)
 *   node run.js runs/dev-soap.yaml                (Development SOAP, every section)
 *   node run.js runs/dev-rest.yaml --dry-run      (list what would be sent, send nothing)
 *   node run.js runs/prod-soap.yaml --production  (Production: real, billable shipments)
 *
 * A run spec (YAML, see runs/) says which collection, tier and sections to run.
 * Credentials never live in the spec or the repo: they are read from the env file the
 * spec names (.env.development / .env.production, both git-ignored) or from environment
 * variables of the same name. Copy .env.example to start.
 *
 * Output (results/, git-ignored):
 *   <tier>-<protocol>-<stamp>.csv           one row per request: ID, item, HTTP, ms, outcome, errors
 *   <tier>-<protocol>-<stamp>-created.csv   every shipment / pickup the run created — void these
 *   the checklist file in the spec          "Your outcome" and "Your date and time stamp" filled in
 */
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const newman = require('newman');
const ExcelJS = require('exceljs');

const ROOT = __dirname;
const args = process.argv.slice(2);
const specPath = args.find(a => !a.startsWith('--'));
const DRY = args.includes('--dry-run');
const PROD_OK = args.includes('--production');

if (!specPath) {
  console.error('Usage: node run.js runs/<spec>.yaml [--dry-run] [--production]');
  process.exit(2);
}

/* ----------------------------------------------------------------- spec */
const spec = yaml.load(fs.readFileSync(path.resolve(specPath), 'utf8'));
const protocol = String(spec.protocol || '').toUpperCase();
const tier = spec.tier;
if (!['SOAP', 'REST'].includes(protocol)) throw new Error('spec.protocol must be SOAP or REST');
if (!['Development', 'Production'].includes(tier)) throw new Error('spec.tier must be Development or Production');

// Production guard: the spec AND the command line must both say so.
if (tier === 'Production' && !(spec.confirm_production === true && PROD_OK)) {
  console.error('Production creates real, billable shipments and real pickups.\n' +
    'Set confirm_production: true in the spec AND add --production to the command to run it.');
  process.exit(2);
}

const HOSTS = {
  Development: { soapBase: 'https://devwebservices.purolator.com', baseUrl: 'https://shipapi-sandbox.purolator.com', authScope: 'portal_api_sandbox' },
  Production:  { soapBase: 'https://webservices.purolator.com',    baseUrl: 'https://shipapi.purolator.com',         authScope: 'portal_api' },
};

/* ----------------------------------------------------------------- credentials */
// KEY=VALUE lines; # comments; values may be quoted. Real environment variables win.
function readEnvFile(file) {
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const envFile = path.resolve(ROOT, spec.env_file || (tier === 'Production' ? '.env.production' : '.env.development'));
const fileVars = readEnvFile(envFile);
const val = k => process.env[k] || fileVars[k] || '';

const NEEDED = protocol === 'SOAP' ? ['SOAP_Key', 'SOAP_Password', 'AccountNumber']
                                   : ['REST_ClientId', 'REST_Secret', 'REST_XApiKey', 'AccountNumber'];
const OPTIONAL = ['Different_AccountNumber', 'Freight_account', 'shipDaysAhead', 'Reference'];
const missing = NEEDED.filter(k => !val(k));
if (missing.length && !DRY) {
  console.error(`Missing ${missing.join(', ')} — add them to ${path.relative(ROOT, envFile)} (see .env.example).`);
  process.exit(2);
}

// Overrides from the spec (hosts are fixed per tier unless the spec says otherwise, e.g. a mock server).
const hosts = { ...HOSTS[tier], ...(spec.hosts || {}) };
const environment = {
  name: `Purolator Certification — ${tier} (run.js)`,
  values: [...Object.entries(hosts), ...[...NEEDED, ...OPTIONAL].map(k => [k, val(k)]),
           ['createdPins', '[]']]
    .filter(([, v]) => v !== '').map(([key, value]) => ({ key, value, enabled: true })),
};

/* ----------------------------------------------------------------- select requests */
const collectionFile = path.resolve(ROOT, spec.collection || `postman/Purolator_Certification_${protocol}.postman_collection.json`);
const collection = JSON.parse(fs.readFileSync(collectionFile, 'utf8'));
const idOf = name => name.split(' ')[0];
const sections = spec.sections === 'all' || !spec.sections ? null : spec.sections.map(String);
const include = new Set((spec.include || []).map(String));
const exclude = new Set((spec.exclude || []).map(String));
const excludeSections = (spec.exclude_sections || []).map(String);
// Item-name patterns to skip, e.g. pickups in Production (a pickup dispatches a real driver).
const skipPatterns = (spec.skip_items || []).map(p => new RegExp(p, 'i'));

let tokenItem = null;
collection.item = collection.item.map(folder => {
  const keep = folder.item.filter(it => {
    if (protocol === 'REST' && /\/auth\/v1\/token/.test(it.request.url)) { tokenItem = it; return false; }
    const id = idOf(it.name);
    if (exclude.has(id)) return false;
    if (include.size) return include.has(id);
    if (excludeSections.some(s => folder.name === s || folder.name.endsWith(' ' + s))) return false;
    if (sections && !sections.some(s => folder.name === s || folder.name.endsWith(' ' + s) || folder.name.startsWith(s + ' '))) return false;
    if (spec.skip_not_available && /Sample status: Not available/.test(it.request.description || '')) return false;
    return !skipPatterns.some(re => re.test(it.name));
  });
  return { ...folder, item: keep };
}).filter(f => f.item.length);
// REST: the token request always runs first so every other call has a bearer token.
if (tokenItem) collection.item.unshift({ name: '00 Token', item: [tokenItem] });

const selected = collection.item.flatMap(f => f.item.map(i => i.name));
console.log(`${spec.name || path.basename(specPath)} — ${protocol} ${tier}: ${selected.length} requests`);
if (DRY) {
  for (const f of collection.item) { console.log(`  ${f.name}`); f.item.forEach(i => console.log(`    ${i.name}`)); }
  process.exit(0);
}

/* ----------------------------------------------------------------- run */
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const RESULTS = path.join(ROOT, 'results');
fs.mkdirSync(RESULTS, { recursive: true });
const base = path.join(RESULTS, `${tier.toLowerCase()}-${protocol.toLowerCase()}-${stamp}`);

newman.run({
  collection, environment,
  delayRequest: spec.delay_ms ?? 250,          // stays well under the API call limits
  timeoutRequest: spec.timeout_ms ?? 60000,
  reporters: ['cli'],
  reporter: { cli: { noSummary: false, noAssertions: false } },
}, async (err, summary) => {
  if (err) { console.error(err); process.exit(1); }
  const now = new Date();
  const stampText = now.toLocaleString('sv-SE').slice(0, 16);   // yyyy-mm-dd hh:mm, local time
  const results = summary.run.executions.map(ex => {
    const failed = (ex.assertions || []).filter(a => a.error).map(a => a.assertion);
    const code = ex.response ? ex.response.code : '';
    return {
      id: idOf(ex.item.name), item: ex.item.name.slice(idOf(ex.item.name).length + 1),
      http: code, ms: ex.response ? ex.response.responseTime : '',
      outcome: ex.requestError ? 'Fail' : (failed.length ? 'Fail' : 'Pass'),
      errors: ex.requestError ? String(ex.requestError.message || ex.requestError) : failed.join(' | '),
    };
  });

  // ---- results CSV
  const csvq = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  fs.writeFileSync(base + '.csv', '﻿' + ['ID,Item,HTTP,ms,Outcome,Errors,Run at',
    ...results.map(r => [r.id, r.item, r.http, r.ms, r.outcome, r.errors, stampText].map(csvq).join(','))].join('\r\n') + '\r\n');

  // ---- what the run created (void shipments; cancel pickups) — matters most in Production
  const envOut = Object.fromEntries(summary.environment.values.map(v => [v.key, v.value]));
  const created = JSON.parse(envOut.createdPins || '[]');
  fs.writeFileSync(base + '-created.csv', '﻿' + ['ID,Kind,Value',
    ...created.map(c => [c.id, c.kind, c.value].map(csvq).join(','))].join('\r\n') + '\r\n');

  // ---- checklist: fill "Your outcome" (M) and "Your date and time stamp" (N) on the matching sheet
  if (spec.checklist !== false) {
    const target = path.resolve(ROOT, spec.checklist || 'results/My Certification Checklist.xlsx');
    const source = fs.existsSync(target) ? target : path.join(ROOT, 'Purolator Certification Checklist 2026.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(source);
    const ws = wb.getWorksheet(`${protocol} - ${tier}`);
    if (!ws) {
      console.warn(`Sheet "${protocol} - ${tier}" not found; checklist not updated.`);
    } else {
      // Header row = the row whose column A says "ID"; columns found by header text.
      let hdr = 0; ws.eachRow((row, n) => { if (!hdr && row.getCell(1).value === 'ID') hdr = n; });
      const col = {}; ws.getRow(hdr).eachCell((c, n) => { col[String(c.value).trim()] = n; });
      const byId = Object.fromEntries(results.map(r => [r.id, r]));
      let filled = 0;
      for (let n = hdr + 1; n <= ws.rowCount; n++) {
        const r = byId[ws.getRow(n).getCell(1).value];
        if (!r) continue;
        ws.getRow(n).getCell(col['Your outcome']).value = r.outcome;
        ws.getRow(n).getCell(col['Your date and time stamp']).value = stampText;
        filled++;
      }
      await wb.xlsx.writeFile(target);
      console.log(`Checklist: ${filled} rows updated on "${ws.name}" in ${path.relative(ROOT, target)}`);
    }
  }

  const pass = results.filter(r => r.outcome === 'Pass').length;
  console.log(`\n${pass} passed, ${results.length - pass} failed. Results: ${path.relative(ROOT, base)}.csv`);
  if (created.length) {
    console.log(`${created.length} shipments/pickups created — listed in ${path.relative(ROOT, base)}-created.csv.` +
      (tier === 'Production' ? ' VOID THEM NOW: they are real and billable.' : ''));
  }
});
