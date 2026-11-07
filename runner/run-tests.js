#!/usr/bin/env node
// =============================================================================
// run-tests.js — run every certification test in tests.yaml, live
//
// Reads config.yaml (hosts, phases, PIN sources) and tests.yaml (one test per
// checklist row), sends each sample body to Development or Production, checks
// the answer, and writes a results CSV whose columns match the checklist's
// "Your outcome" and "Your date and time stamp" columns.
//
// What it handles for you:
//   * REST token (R-001) before anything else, retried once if it fails.
//   * Placeholders: dates (Toronto time), RequestReference, account numbers,
//     and the PINs / pickup confirmation numbers captured from earlier calls.
//   * Order: creates first, then documents/tracking, pickups, voids, close.
//   * Production safety: needs --confirm-production, skips Consolidate /
//     Close Manifest, never books freight pickups, and voids every shipment
//     and pickup it created before it exits.
//
// Requires Node.js 18+ (built-in fetch) and one package: npm install (in this folder).
// See README.md in this folder for the environment variables and examples.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..');

// =============================================================================
// Command line
// =============================================================================

// Parse "--name value" / "--flag" pairs into an object.
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [key, inline] = a.slice(2).split('=');
    const next = argv[i + 1];
    if (inline !== undefined) out[key] = inline;
    else if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

const HELP = `
Purolator certification test runner

  node run-tests.js --env dev|prod [options]

Options
  --env dev|prod            Development (default) or Production
  --confirm-production      Required with --env prod (real, billable shipments)
  --protocol SOAP|REST      Only one protocol (default: both)
  --only S-001,R-003        Only these IDs (their PIN / pickup sources run too)
  --section "Cross-border"  Only rows in this section (case-insensitive, partial)
  --status Verified         Statuses to send, comma-separated
                            (default: Verified,Not available,Not yet verified)
  --dry-run                 Resolve and save every request; send nothing,
                            no credentials needed
  --allow-close             Run Consolidate / Close Manifest in Production too
  --allow-unvoidable        Also book freight pickups (cannot be cancelled)
  --ship-days-ahead N       {{Current_Date}} = today + N (default 0)
  --delay-ms N              Pause between calls (default 250)
  --keep-documents          Keep base64 labels/documents in saved responses
  --out DIR                 Results folder (default: runner/results/<env>-<time>)
  --help                    This text
`;

// =============================================================================
// Settings, tests and credentials
// =============================================================================

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(HELP); process.exit(0); }

const config = YAML.parse(fs.readFileSync(path.join(__dirname, 'config.yaml'), 'utf8'));
const allTests = YAML.parse(fs.readFileSync(path.join(__dirname, 'tests.yaml'), 'utf8')).tests;

const ENV_NAME = String(args.env || process.env.PUROLATOR_ENV || 'dev').toLowerCase();
const ENV = config.environments[ENV_NAME];
if (!ENV) { console.error(`--env must be one of: ${Object.keys(config.environments).join(', ')}`); process.exit(1); }

// Host overrides (for example a certification host Purolator gave you).
if (process.env.PUROLATOR_SOAP_BASE) ENV.soapBase = process.env.PUROLATOR_SOAP_BASE;
if (process.env.PUROLATOR_REST_BASE) ENV.restBase = process.env.PUROLATOR_REST_BASE;

const DRY = Boolean(args['dry-run']);
const IS_PROD = ENV_NAME === 'prod';
const D = config.defaults;
const OPT = {
  statuses: args.status ? String(args.status).split(',').map(s => s.trim()) : D.statuses,
  delayMs: Number(args['delay-ms'] ?? D.delayMs),
  timeoutMs: Number(D.timeoutMs),
  shipDaysAhead: Number(args['ship-days-ahead'] ?? D.shipDaysAhead),
  runClose: ENV.runCloseSteps || Boolean(args['allow-close']),
  voidCreated: ENV.voidCreatedShipments,
  allowUnvoidable: Boolean(args['allow-unvoidable']),
  keepDocuments: Boolean(args['keep-documents']),
};

// Production guard: an explicit flag (or env var) every time.
if (IS_PROD && !DRY && !(args['confirm-production'] || process.env.PUROLATOR_CONFIRM_PRODUCTION === 'yes')) {
  console.error('Production creates real, billable shipments. Add --confirm-production to run it.\n' +
    'Every shipment and pickup the run creates is voided at the end.');
  process.exit(1);
}

// Credentials from environment variables only — never from files in the repo.
const CRED = {
  restClientId: process.env.PUROLATOR_REST_CLIENT_ID,
  restSecret: process.env.PUROLATOR_REST_CLIENT_SECRET,
  restApiKey: process.env.PUROLATOR_X_API_KEY,
  restToken: process.env.PUROLATOR_TOKEN,        // optional: skip the token call
  soapKey: process.env.PUROLATOR_SOAP_KEY,
  soapPassword: process.env.PUROLATOR_SOAP_PASSWORD,
};

// Placeholder values that come from the caller.
const ACCOUNT_VARS = {
  AccountNumber: process.env.PUROLATOR_ACCOUNT,
  Different_AccountNumber: process.env.PUROLATOR_ACCOUNT_2,
  Freight_account: process.env.PUROLATOR_FREIGHT_ACCOUNT,
};
for (const [name, envVar] of Object.entries(config.externalInputs || {})) {
  if (process.env[envVar]) ACCOUNT_VARS[name] = process.env[envVar];
}

// =============================================================================
// Select tests
// =============================================================================

const byId = Object.fromEntries(allTests.map(t => [t.id, t]));
const bodyCache = {};   // test id → sample body text (read once)

// Tests whose captured PIN / pickup number another test needs.
function sourcesFor(test) {
  const ids = new Set();
  const src = config.pinSources[test.protocol] || {};
  if (test.phase === 'uses-pin' || test.voids === 'shipment') {
    ids.add(src.default);
    if (test.voids === 'shipment') ids.add(src.void);
    const docType = documentType(readBody(test));
    if (docType && src.byDocumentType?.[docType]) ids.add(src.byDocumentType[docType]);
    if (test.pinFrom) ids.add(test.pinFrom);
  }
  if (test.phase === 'pickups' && !test.creates) ids.add(config.pickupSources[test.protocol]);
  if (test.protocol === 'REST' && test.phase !== 'token') ids.add('R-001'); // token first
  ids.delete(test.id);
  return [...ids].filter(Boolean);
}

let selected = allTests.filter(t => {
  if (args.protocol && t.protocol.toUpperCase() !== String(args.protocol).toUpperCase()) return false;
  if (args.section && !t.section.toLowerCase().includes(String(args.section).toLowerCase())) return false;
  if (args.only && !String(args.only).split(',').map(s => s.trim()).includes(t.id)) return false;
  return true;
});
// --only / --section: pull in the tests they depend on, so a lone document or
// void test still gets a fresh PIN.
if (args.only || args.section) {
  const want = new Set(selected.map(t => t.id));
  for (const t of selected) for (const id of sourcesFor(t)) want.add(id);
  selected = allTests.filter(t => want.has(t.id) &&
    (!args.protocol || t.protocol.toUpperCase() === String(args.protocol).toUpperCase()));
}

// Credentials check (after selection, so a SOAP-only run needs no REST keys).
if (!DRY) {
  const needRest = selected.some(t => t.protocol === 'REST' && !t.skip);
  const needSoap = selected.some(t => t.protocol === 'SOAP' && !t.skip);
  const missing = [];
  if (needRest && !CRED.restApiKey) missing.push('PUROLATOR_X_API_KEY');
  if (needRest && !CRED.restToken && !(CRED.restClientId && CRED.restSecret))
    missing.push('PUROLATOR_REST_CLIENT_ID + PUROLATOR_REST_CLIENT_SECRET (or PUROLATOR_TOKEN)');
  if (needSoap && !(CRED.soapKey && CRED.soapPassword)) missing.push('PUROLATOR_SOAP_KEY + PUROLATOR_SOAP_PASSWORD');
  if (!ACCOUNT_VARS.AccountNumber) missing.push('PUROLATOR_ACCOUNT');
  if (missing.length) { console.error('Missing environment variables:\n  ' + missing.join('\n  ')); process.exit(1); }
}

// =============================================================================
// Dates and placeholders
// =============================================================================

// Purolator validates dates in Toronto time, not the machine's (9001-11 otherwise).
function torontoDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
}
// Next business day for pickups (skip Saturday and Sunday).
function nextBusinessDay() {
  for (let n = 1; n < 7; n++) {
    const day = new Date(`${torontoDate(n)}T12:00:00`).getDay();
    if (day !== 0 && day !== 6) return torontoDate(n);
  }
  return torontoDate(1);
}

const DATE_VARS = {
  Current_Date: torontoDate(OPT.shipDaysAhead),
  manifestDate: torontoDate(0),               // rolling 10-day window, not future
  pickupDate: nextBusinessDay(),
  pickupHistoryFromDate: torontoDate(-30),
  pickupHistoryToDate: torontoDate(0),
  trackDateFrom: torontoDate(-30),
  trackDateTo: torontoDate(0),
};

// A fresh reference per call: "REQ" + timestamp + 4 random hex.
// No underscores (REST rejects them) and well under the 36-character limit.
function requestReference() {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return `REQ${stamp}${crypto.randomBytes(2).toString('hex')}`;
}

// Replace {{Name}} with values; report any left unresolved.
function fill(text, vars) {
  const missing = new Set();
  const out = text.replace(/\{\{(\w+)\}\}/g, (m, name) => {
    if (vars[name] !== undefined && vars[name] !== null && vars[name] !== '') return String(vars[name]);
    missing.add(name);
    return m;
  });
  return { text: out, missing: [...missing] };
}

// =============================================================================
// Bodies, document types and response parsing
// =============================================================================

function readBody(test) {
  if (!test.body) return '';
  if (!(test.id in bodyCache)) bodyCache[test.id] = fs.readFileSync(path.join(ROOT, test.body), 'utf8');
  return bodyCache[test.id];
}

// Document type requested in a body (first one), SOAP or REST.
function documentType(body) {
  const m = body.match(/DocumentType>\s*([A-Za-z0-9]+)\s*</) || body.match(/"documentType"\s*:\s*\[\s*"([A-Za-z0-9]+)"/);
  return m ? m[1] : '';
}

// Recursive key search in parsed JSON (case-insensitive); unwraps {value: x}.
function findKey(node, wanted) {
  if (node === null || typeof node !== 'object') return '';
  for (const [k, v] of Object.entries(node)) {
    if (k.toLowerCase() === wanted) {
      if (typeof v === 'string' || typeof v === 'number') return String(v);
      if (Array.isArray(v) && v.length && typeof v[0] !== 'object') return String(v[0]);
      if (v && typeof v === 'object' && v.value) return String(v.value);
    }
    const deeper = findKey(v, wanted);
    if (deeper) return deeper;
  }
  return '';
}

// What a response captured: shipment PIN or pickup confirmation number.
function capture(test, text) {
  if (test.protocol === 'SOAP') {
    // Namespace prefixes vary (v1:, v2:, none), so allow any.
    if (test.creates === 'shipment') {
      const m = text.match(/ShipmentPIN>\s*<(?:\w+:)?Value>\s*([0-9A-Za-z]+)\s*</);
      return m ? m[1] : '';
    }
    if (test.creates === 'pickup' || test.creates === 'freight-pickup') {
      const m = text.match(/PickUpConfirmationNumber>\s*([0-9A-Za-z-]+)\s*</);
      return m ? m[1] : '';
    }
    return '';
  }
  let json; try { json = JSON.parse(text); } catch { return ''; }
  if (test.creates === 'shipment') return findKey(json, 'shipmentpin');
  if (test.creates === 'pickup' || test.creates === 'freight-pickup') return findKey(json, 'pickupconfirmationnumber');
  return '';
}

// Pass/fail and the first error code/message in a response.
function judge(test, status, text) {
  if (test.protocol === 'SOAP') {
    const code = (text.match(/<(?:\w+:)?Code>\s*([^<\s]+)\s*</) || [])[1] || '';
    const desc = (text.match(/<(?:\w+:)?Description>\s*([^<]+?)\s*</) || [])[1] || '';
    const fault = (text.match(/<faultstring>\s*([^<]+?)\s*</) || [])[1] || '';
    // ResponseInformation/Errors must be empty: no <Error> element anywhere.
    const hasError = /<(?:\w+:)?Error>/.test(text) || /:Fault>|<Fault>/.test(text);
    return { pass: status === 200 && !hasError, code, message: desc || fault };
  }
  let json = null; try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  const errs = json && (json.errors || json.error || json.responseInformation?.errors);
  const list = Array.isArray(errs) ? errs : (errs ? [errs] : []);
  const first = list[0] || {};
  const code = String(first.code || first.errorCode || (text.match(/\b9001-\d+\b/) || [''])[0] || '');
  const message = String(first.description || first.message || first.errorMessage || (typeof errs === 'string' ? errs : '') || '');
  return { pass: status >= 200 && status < 300 && list.length === 0, code, message };
}

// Documents can come back "Pending" for a second or two.
function isPending(text) {
  return /DocumentStatus>\s*Pending\s*</i.test(text) || /"documentStatus"\s*:\s*"Pending"/i.test(text);
}

// Saved responses: tokens masked, long base64 shortened unless --keep-documents.
function scrub(text) {
  let out = text.replace(/("access_token"\s*:\s*")[^"]+"/g, '$1<masked>"');
  if (!OPT.keepDocuments) out = out.replace(/[A-Za-z0-9+/]{300,}={0,2}/g, m => `<base64 ${m.length} chars>`);
  return out;
}

// =============================================================================
// HTTP
// =============================================================================

let restToken = CRED.restToken || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Send one request. Header names are lowercase on purpose: the Production REST
// gateway authorizer is case-sensitive about x-api-key.
async function send({ protocol, method, url, body, soapAction, auth }) {
  const headers = {};
  if (protocol === 'SOAP') {
    headers['content-type'] = 'text/xml; charset=utf-8';
    headers['soapaction'] = soapAction;
    headers['authorization'] = 'Basic ' + Buffer.from(`${CRED.soapKey}:${CRED.soapPassword}`).toString('base64');
  } else if (auth === 'basic') {
    // Token call: Basic client_id:client_secret.
    headers['content-type'] = 'application/json';
    headers['authorization'] = 'Basic ' + Buffer.from(`${CRED.restClientId}:${CRED.restSecret}`).toString('base64');
  } else {
    headers['authorization'] = `Bearer ${restToken}`;
    headers['x-api-key'] = CRED.restApiKey;
    headers['language'] = 'en';
    headers['requestreference'] = requestReference();
    if (body) headers['content-type'] = 'application/json';
  }
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method, headers, body: body || undefined,
      signal: AbortSignal.timeout(OPT.timeoutMs),
    });
    return { status: res.status, text: await res.text(), ms: Date.now() - started };
  } catch (err) {
    return { status: 0, text: String(err && err.message || err), ms: Date.now() - started, networkError: true };
  }
}

// =============================================================================
// Run state
// =============================================================================

const captured = {};            // test id → PIN or pickup confirmation number
const openShipments = { SOAP: new Set(), REST: new Set() };   // PINs to void in cleanup
const openPickups = { SOAP: new Set(), REST: new Set() };
const results = [];

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const OUT_DIR = path.resolve(args.out || path.join(__dirname, 'results', `${ENV_NAME}-${stamp}${DRY ? '-dry-run' : ''}`));
fs.mkdirSync(path.join(OUT_DIR, 'responses'), { recursive: true });
if (DRY) fs.mkdirSync(path.join(OUT_DIR, 'requests'), { recursive: true });

// In a dry run, captures are stand-ins so dependent requests still resolve.
function fakeCapture(test) { return test.creates === 'shipment' ? `<PIN from ${test.id}>` : `<pickup from ${test.id}>`; }

// Choose the PIN for a test that needs one. Returns { pin, from, note }.
function pinFor(test) {
  const src = config.pinSources[test.protocol];
  const docType = documentType(readBody(test));
  const wanted = test.pinFrom || (test.voids === 'shipment' ? src.void : null) ||
    (docType && src.byDocumentType?.[docType]) || src.default;
  if (captured[wanted]) return { pin: captured[wanted], from: wanted };
  // Void tests run after the document tests, so the default PIN is free by then.
  if (captured[src.default])
    return { pin: captured[src.default], from: src.default, note: `${wanted} made no PIN; used ${src.default}` };
  return { pin: '', from: wanted, note: `no PIN: ${wanted} did not create a shipment in this run` };
}

// Record one row of results.
function record(test, outcome, extra = {}) {
  const row = {
    ID: test.id, Protocol: test.protocol, Section: test.section, Item: test.item,
    'Sample status': test.sampleStatus,
    'Your outcome': outcome,
    'Your date and time stamp': new Date().toLocaleString('sv-SE', { hour12: false }).slice(0, 16),
    HTTP: extra.status ?? '', 'Error code': extra.code ?? '', 'Error message': extra.message ?? '',
    'Matches expected': extra.matches ?? '', 'Captured': extra.captured ?? '',
    'PIN used': extra.pinUsed ?? '', ms: extra.ms ?? '', Notes: extra.note ?? '',
    'Expected outcome': test.expected || '',
  };
  results.push(row);
  const flag = { Pass: '✓', Fail: '✗', Skipped: '-', 'Dry run': '·' }[outcome] || ' ';
  console.log(`${flag} ${test.id.padEnd(6)} ${outcome.padEnd(8)} ${String(extra.status ?? '').padEnd(4)} ` +
    `${(extra.code || '').padEnd(10)} ${test.item}${extra.note ? `  (${extra.note})` : ''}`);
}

// =============================================================================
// Run one test
// =============================================================================

async function runTest(test) {
  // ---- Reasons not to send ----------------------------------------------------
  if (test.skip) return record(test, 'Skipped', { note: test.skip });
  if (!OPT.statuses.includes(test.sampleStatus))
    return record(test, 'Skipped', { note: `status "${test.sampleStatus}" not selected` });
  if (test.phase === 'close' && !OPT.runClose)
    return record(test, 'Skipped', { note: 'end-of-day close skipped in Production (shipments must stay voidable); --allow-close to run' });
  if (test.creates === 'freight-pickup' && !OPT.allowUnvoidable)
    return record(test, 'Skipped', { note: 'books a freight pickup the API cannot cancel; --allow-unvoidable to run' });

  // ---- Token (R-001) -----------------------------------------------------------
  if (test.phase === 'token') {
    if (CRED.restToken && !DRY) return record(test, 'Skipped', { note: 'PUROLATOR_TOKEN supplied' });
    const url = ENV.restBase + test.path;
    const body = readBody(test);
    if (DRY) { fs.writeFileSync(path.join(OUT_DIR, 'requests', `${test.id}.json`), body); restToken = '<token>'; return record(test, 'Dry run'); }
    let r = await send({ protocol: 'REST', method: test.method, url, body, auth: 'basic' });
    if (r.status !== 200) { await sleep(2000); r = await send({ protocol: 'REST', method: test.method, url, body, auth: 'basic' }); } // retry once
    fs.writeFileSync(path.join(OUT_DIR, 'responses', `${test.id}.json`), scrub(r.text));
    try { restToken = JSON.parse(r.text).access_token || ''; } catch { restToken = ''; }
    return record(test, restToken ? 'Pass' : 'Fail', { status: r.status, ms: r.ms, matches: restToken ? 'Yes' : 'No',
      note: restToken ? '' : 'no access_token — every REST call after this will fail' });
  }

  // ---- Variables for this call -----------------------------------------------------
  const vars = { ...ACCOUNT_VARS, ...DATE_VARS, RequestReference: requestReference() };
  let pinInfo = null;
  const raw = readBody(test);
  if (/\{\{PIN\}\}/.test(raw)) {
    pinInfo = pinFor(test);
    vars.PIN = pinInfo.pin;
  }
  if (/\{\{PickUpConfirmationNumber\}\}/.test(raw)) vars.PickUpConfirmationNumber = captured[config.pickupSources[test.protocol]] || '';

  // ---- Build the request ---------------------------------------------------------------
  const base = test.protocol === 'SOAP' ? ENV.soapBase : ENV.restBase;
  let url = base + test.path;
  const extra = (config.requests || {})[test.id] || {};
  if (extra.query) {
    const q = Object.entries(extra.query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(fill(String(v), vars).text)}`);
    url += '?' + q.join('&');
  }
  const filled = fill(raw, vars);
  if (filled.missing.length && !DRY) {
    const why = filled.missing.map(n => {
      if (n === 'PIN') return pinInfo?.note || 'no PIN captured';
      if (n === 'PickUpConfirmationNumber') return 'no pickup was scheduled in this run';
      const envVar = config.externalInputs?.[n];
      return envVar ? `set ${envVar} to send it` : `{{${n}}} has no value`;
    });
    return record(test, 'Skipped', { note: why.join('; ') });
  }

  if (DRY) {
    const ext = test.protocol === 'SOAP' ? 'xml' : 'json';
    fs.writeFileSync(path.join(OUT_DIR, 'requests', `${test.id}.${ext}`),
      `${test.method} ${url}\n${test.soapAction ? `SOAPAction: ${test.soapAction}\n` : ''}\n${filled.text}`);
    if (test.creates) captured[test.id] = fakeCapture(test);
    return record(test, 'Dry run', { pinUsed: vars.PIN || '', note: pinInfo?.note });
  }

  // ---- Send (retry while a document is still Pending) ----------------------------------
  let r;
  for (let attempt = 0; ; attempt++) {
    r = await send({ protocol: test.protocol, method: test.method, url, body: filled.text || undefined, soapAction: test.soapAction });
    if (!isPending(r.text) || attempt >= D.pendingRetries) break;
    await sleep(D.pendingRetryMs);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'responses', `${test.id}.${test.protocol === 'SOAP' ? 'xml' : 'json'}`), scrub(r.text));

  const verdict = r.networkError ? { pass: false, code: 'network', message: r.text } : judge(test, r.status, r.text);
  const got = verdict.pass && test.creates ? capture(test, r.text) : '';

  // ---- Track what now exists, and what was cancelled ------------------------------------
  if (got) {
    captured[test.id] = got;
    if (test.creates === 'shipment') openShipments[test.protocol].add(got);
    if (test.creates === 'pickup' || test.creates === 'freight-pickup') openPickups[test.protocol].add(got);
  }
  if (verdict.pass && test.voids === 'shipment' && vars.PIN) openShipments[test.protocol].delete(vars.PIN);
  if (verdict.pass && test.voids === 'pickup' && vars.PickUpConfirmationNumber) openPickups[test.protocol].delete(vars.PickUpConfirmationNumber);

  // Did it do what the checklist says? Verified → should pass; Not available →
  // should fail with the error code the checklist names.
  let matches = '';
  if (test.sampleStatus === 'Verified') matches = verdict.pass ? 'Yes' : 'No';
  else if (test.sampleStatus === 'Not available')
    matches = verdict.pass ? 'No (now works)' : (test.expectedErrorCode ? (verdict.code === test.expectedErrorCode ? 'Yes' : 'No') : '');

  const notes = [pinInfo?.note, test.creates && verdict.pass && !got ? 'created, but no PIN/confirmation found in the response' : '']
    .filter(Boolean).join('; ');
  record(test, verdict.pass ? 'Pass' : 'Fail', {
    status: r.status, code: verdict.code, message: verdict.message, matches,
    captured: got, pinUsed: vars.PIN || '', ms: r.ms, note: notes,
  });
}

// =============================================================================
// Cleanup — void everything still open (Production)
// =============================================================================

async function cleanup() {
  if (DRY || !OPT.voidCreated) return [];
  const log = [];
  // Re-use the Void samples as templates so the bodies match what was verified.
  const templates = {
    SOAP: { shipment: byId['S-003'], pickup: byId['S-016'] },
    REST: { shipment: byId['R-004'], pickup: byId['R-011'] },
  };
  for (const protocol of ['SOAP', 'REST']) {
    for (const [kind, open] of [['shipment', openShipments[protocol]], ['pickup', openPickups[protocol]]]) {
      const t = templates[protocol][kind];
      for (const id of [...open]) {
        const vars = { ...ACCOUNT_VARS, ...DATE_VARS, RequestReference: requestReference(), PIN: id, PickUpConfirmationNumber: id };
        const base = protocol === 'SOAP' ? ENV.soapBase : ENV.restBase;
        const r = await send({ protocol, method: t.method, url: base + t.path, body: fill(readBody(t), vars).text, soapAction: t.soapAction });
        const v = judge(t, r.status, r.text);
        if (v.pass) open.delete(id);
        log.push({ protocol, kind, id, result: v.pass ? 'Voided' : 'NOT voided', http: r.status, code: v.code, message: v.message });
        console.log(`${v.pass ? '✓' : '✗'} cleanup ${protocol} ${kind} ${id} ${v.pass ? 'voided' : `NOT voided (${r.status} ${v.code} ${v.message})`}`);
        await sleep(OPT.delayMs);
      }
    }
  }
  return log;
}

// =============================================================================
// Output
// =============================================================================

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = v => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n') + '\r\n';
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const creates = selected.filter(t => t.creates === 'shipment' && !t.skip && OPT.statuses.includes(t.sampleStatus)).length;
  console.log(`Purolator certification run — ${ENV.label}${DRY ? ' (dry run, nothing sent)' : ''}`);
  console.log(`SOAP ${ENV.soapBase} · REST ${ENV.restBase}`);
  console.log(`${selected.length} tests selected, up to ${creates} create a shipment. Ship date ${DATE_VARS.Current_Date}, pickup date ${DATE_VARS.pickupDate}.`);
  if (IS_PROD && !DRY) console.log('Production: close steps ' + (OPT.runClose ? 'WILL run' : 'skipped') + '; everything created is voided at the end.');
  console.log(`Results: ${OUT_DIR}\n`);

  // Ctrl+C in Production: still void what was created.
  let stopping = false;
  process.on('SIGINT', async () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('\nStopping — voiding what this run created…');
    await finish(true);
    process.exit(130);
  });

  for (const phase of config.phases) {
    for (const test of selected.filter(t => (t.phase || 'main') === phase)) {
      if (stopping) return;
      await runTest(test);
      if (!DRY && !test.skip) await sleep(OPT.delayMs);
    }
  }
  // Rows with no phase (not applicable) are reported too.
  for (const test of selected.filter(t => !t.phase)) await runTest(test);
  await finish(false);
}

async function finish(interrupted) {
  const cleanupLog = await cleanup();
  fs.writeFileSync(path.join(OUT_DIR, 'results.csv'), toCsv(results));
  if (cleanupLog.length) fs.writeFileSync(path.join(OUT_DIR, 'cleanup.csv'), toCsv(cleanupLog));

  const n = o => results.filter(r => r['Your outcome'] === o).length;
  const leftShip = [...openShipments.SOAP, ...openShipments.REST];
  const leftPick = [...openPickups.SOAP, ...openPickups.REST];
  const summary = {
    environment: ENV.label, dryRun: DRY, interrupted, finished: new Date().toISOString(),
    pass: n('Pass'), fail: n('Fail'), skipped: n('Skipped'), dryRunRows: n('Dry run'),
    unexpected: results.filter(r => String(r['Matches expected']).startsWith('No')).map(r => r.ID),
    stillOpenShipments: OPT.voidCreated ? leftShip : `${leftShip.length} left in ${ENV.label} (not voided by design)`,
    stillOpenPickups: leftPick,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`\nPass ${summary.pass} · Fail ${summary.fail} · Skipped ${summary.skipped}${DRY ? ` · Dry run ${summary.dryRunRows}` : ''}`);
  if (summary.unexpected.length) console.log(`Different from the checklist: ${summary.unexpected.join(', ')}`);
  if (OPT.voidCreated && (leftShip.length || leftPick.length))
    console.log(`WARNING: still open — shipments ${leftShip.join(', ') || 'none'}; pickups ${leftPick.join(', ') || 'none'}. Void them by hand.`);
  console.log(`Results written to ${path.join(OUT_DIR, 'results.csv')}`);
}

main().catch(async err => {
  console.error(err);
  await finish(true).catch(() => {});
  process.exit(1);
});
