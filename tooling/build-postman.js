#!/usr/bin/env node
/*
 * build-postman.js — builds the two Postman collections in postman/ from samples/index.csv.
 *
 *   node tooling/build-postman.js
 *
 * One request per checklist row that has a sample file, named "<ID> <Item>" and grouped
 * in the same section folders as samples/. Rows with no sample (Not applicable) are skipped.
 * Hosts, keys and account numbers come from a Postman environment (see postman/HOW-TO-LOAD.md);
 * the collections themselves never carry credentials.
 *
 * Re-run after changing a sample or index.csv, then commit the regenerated collections.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'postman');

/* ----------------------------------------------------------------- CSV */
// Minimal RFC 4180 parser: index.csv has quoted fields containing commas.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...data] = rows.filter(r => r.length > 1);
  return data.map(r => Object.fromEntries(head.map((h, i) => [h.replace(/^﻿/, ''), r[i] || ''])));
}

/* ----------------------------------------------------------------- scripts */
// Collection pre-request: dates in the carrier's time zone + a fresh RequestReference.
// Same variable names as the Purolator_2026 collections and the README placeholders.
const PRE_REQUEST = [
  "// Runs before every request: refreshes the date variables and RequestReference.",
  "// Purolator validates dates in ITS time zone (America/Toronto); using the PC's local",
  "// date late in the day sends 'yesterday' from western Canada and fails (9001-11).",
  "const now = new Date();",
  "const pad = n => String(n).padStart(2, '0');",
  "const day = off => new Date(now.getTime() + off * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });",
  "// Ship date: today + shipDaysAhead (environment variable, default 1) so weekend/cut-off edge cases are avoided.",
  "const ahead = Number(pm.variables.get('shipDaysAhead') || 1);",
  "pm.variables.set('Current_Date', day(ahead));",
  "// Next business day for pickups (skip Saturday and Sunday).",
  "let p = 1; while ([0, 6].includes(new Date(now.getTime() + p * 86400000).getDay())) p++;",
  "pm.variables.set('pickupDate', day(p));",
  "pm.variables.set('manifestDate', day(0));",
  "pm.variables.set('trackDateFrom', day(-30));",
  "pm.variables.set('trackDateTo', day(0));",
  "pm.variables.set('pickupHistoryFromDate', day(-30));",
  "pm.variables.set('pickupHistoryToDate', day(0));",
  "// REQ + yyyymmddhhmmss (REST allows up to 36 characters).",
  "pm.variables.set('RequestReference', 'REQ' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()));",
];

// Collection test: pass/fail + capture the values later rows need ({{PIN}}, {{Freight_PIN}},
// {{PickUpConfirmationNumber}}, {{Reference}}). Both APIs can answer 200 with errors in the body.
const TESTS = [
  "// Runs after every request.",
  "const body = pm.response.text();",
  "const isSoap = body.trim().startsWith('<');",
  "pm.test('HTTP 2xx', () => pm.expect(pm.response.code).to.be.within(200, 299));",
  "// SOAP: any <Error> under ResponseInformation/Errors. REST: a non-empty errors array.",
  "let errText = '';",
  "if (isSoap) {",
  "  const m = body.match(/<(?:\\w+:)?Error>[\\s\\S]*?<(?:\\w+:)?Code>([^<]*)<[\\s\\S]*?<(?:\\w+:)?Description>([^<]*)</);",
  "  if (m) errText = m[1] + ' ' + m[2];",
  "} else {",
  "  try {",
  "    const j = pm.response.json();",
  "    const errs = (j && (j.errors || (j.responseInformation && j.responseInformation.errors))) || [];",
  "    if (Array.isArray(errs) && errs.length) errText = errs.map(e => (e.code || '') + ' ' + (e.description || e.message || '')).join('; ');",
  "  } catch (e) { /* not JSON (labels, PDFs) */ }",
  "}",
  "pm.test('No errors in the response body' + (errText ? ': ' + errText : ''), () => pm.expect(errText).to.equal(''));",
  "// Capture IDs for later rows. The last value wins, so run sections top to bottom.",
  "const created = JSON.parse(pm.environment.get('createdPins') || '[]');",
  "const req = pm.info.requestName;",
  "function keep(name, value, kind) {",
  "  if (!value) return;",
  "  pm.environment.set(name, value);",
  "  if (kind) { created.push({ id: req.split(' ')[0], kind, value }); pm.environment.set('createdPins', JSON.stringify(created)); }",
  "}",
  "if (pm.response.code < 300 && !errText) {",
  "  if (isSoap) {",
  "    const pin = body.match(/<(?:\\w+:)?ShipmentPIN>\\s*<(?:\\w+:)?Value>\\s*([^<\\s]+)/);",
  "    const fpin = body.match(/<(?:\\w+:)?(?:ProNumber|PIN)>\\s*(?:<(?:\\w+:)?Value>)?\\s*(\\d{6,})/);",
  "    const pu = body.match(/<(?:\\w+:)?PickUpConfirmationNumber>\\s*([^<\\s]+)/);",
  "    if (pin) keep('PIN', pin[1], /Return/i.test(req) ? 'return shipment' : 'shipment');",
  "    else if (fpin && /Freight/i.test(req)) keep('Freight_PIN', fpin[1], 'freight shipment');",
  "    if (pu) keep('PickUpConfirmationNumber', pu[1], 'pickup');",
  "  } else {",
  "    // REST field paths differ by endpoint: search the JSON for the first shipment PIN.",
  "    const find = (n, keys) => { if (!n || typeof n !== 'object') return null;",
  "      for (const k of Object.keys(n)) { if (keys.includes(k) && n[k] != null && typeof n[k] !== 'object') return String(n[k]);",
  "        if (keys.includes(k) && n[k] && n[k].value) return String(n[k].value); }",
  "      for (const k of Object.keys(n)) { const r = find(n[k], keys); if (r) return r; } return null; };",
  "    let j = null; try { j = pm.response.json(); } catch (e) {}",
  "    if (j && /ship\\/v1\\/shipment/.test(pm.request.url.toString()) && pm.request.method === 'POST') {",
  "      const pin = find(j, ['shipmentPin', 'shipmentPIN', 'pin']);",
  "      if (pin && !/validateOnly\"\\s*:\\s*true/.test(pm.request.body ? pm.request.body.raw : '')) keep('PIN', pin, 'shipment');",
  "    }",
  "    if (j && /pickup\\/v1\\/schedule/.test(pm.request.url.toString())) keep('PickUpConfirmationNumber', find(j, ['pickupConfirmationNumber', 'confirmationNumber']), 'pickup');",
  "  }",
  "}",
];

// Token request: store the bearer token every other REST request sends.
const TOKEN_TEST = [
  "const t = pm.response.json();",
  "pm.environment.set('REST_Token', t.access_token);",
  "pm.test('Token issued', () => pm.expect(t.access_token).to.be.a('string'));",
];

/* ----------------------------------------------------------------- build */
const rows = parseCsv(fs.readFileSync(path.join(ROOT, 'samples', 'index.csv'), 'utf8'));

function request(row) {
  // "Send to": SOAP = "POST /path · SOAPAction <uri>", REST = "POST /path"
  const [verbPath, action] = row['Send to'].split(' · SOAPAction ');
  const [method, urlPath] = verbPath.trim().split(/\s+/);
  let raw = fs.readFileSync(path.join(ROOT, row['Sample file']), 'utf8');
  const soap = row.Protocol === 'SOAP';
  const r = { method, header: [], url: (soap ? '{{soapBase}}' : '{{baseUrl}}') + urlPath,
              description: `${row.Section} · ${row.Item} (${row['API value']})\n\nSample status: ${row['Sample status']}\n\nExpected outcome: ${row['Expected outcome']}` };
  if (soap) {
    r.header.push({ key: 'Content-Type', value: 'text/xml; charset=utf-8' },
                  { key: 'SOAPAction', value: (action || '').trim() });
    r.body = { mode: 'raw', raw, options: { raw: { language: 'xml' } } };
  } else {
    if (urlPath === '/auth/v1/token') {
      // Scope differs by tier: portal_api_sandbox (Development) / portal_api (Production).
      raw = raw.replace(/"scope"\s*:\s*"[^"]*"/, '"scope": "{{authScope}}"');
      r.auth = { type: 'basic', basic: [{ key: 'username', value: '{{REST_ClientId}}', type: 'string' },
                                        { key: 'password', value: '{{REST_Secret}}', type: 'string' }] };
      r.header.push({ key: 'Content-Type', value: 'application/json' });
    } else {
      r.header.push({ key: 'x-api-key', value: '{{REST_XApiKey}}' }, { key: 'Language', value: '{{language}}' },
                    { key: 'RequestReference', value: '{{RequestReference}}' }, { key: 'Content-Type', value: 'application/json' });
    }
    r.body = { mode: 'raw', raw, options: { raw: { language: 'json' } } };
  }
  const item = { name: `${row.ID} ${row.Item}`, request: r, response: [] };
  if (urlPath === '/auth/v1/token') item.event = [{ listen: 'test', script: { type: 'text/javascript', exec: TOKEN_TEST } }];
  return item;
}

function collection(protocol) {
  const folders = new Map();
  for (const row of rows.filter(r => r.Protocol === protocol && r['Sample file'] && r['Send to'])) {
    const folder = path.basename(path.dirname(row['Sample file']));   // e.g. "04 Shipment options"
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(request(row));
  }
  const soap = protocol === 'SOAP';
  return {
    info: {
      // Fixed id so a re-import offers "Replace" instead of a second copy.
      _postman_id: soap ? '6d1f0c2e-4b7a-4c1e-9a51-cert0000soap' : '6d1f0c2e-4b7a-4c1e-9a51-cert0000rest',
      name: `Purolator Certification — ${protocol}`,
      description: `One request per row of Purolator Certification Checklist 2026.xlsx (${protocol} sheets). ` +
        'Select a Development or Production environment first — see postman/HOW-TO-LOAD.md. ' +
        'Production creates real, billable shipments.',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: soap
      ? { type: 'basic', basic: [{ key: 'username', value: '{{SOAP_Key}}', type: 'string' },
                                 { key: 'password', value: '{{SOAP_Password}}', type: 'string' }] }
      : { type: 'bearer', bearer: [{ key: 'token', value: '{{REST_Token}}', type: 'string' }] },
    event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: PRE_REQUEST } },
            { listen: 'test', script: { type: 'text/javascript', exec: TESTS } }],
    variable: [{ key: 'language', value: 'en', type: 'string' }],
    item: [...folders.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => ({ name, item })),
  };
}

for (const p of ['SOAP', 'REST']) {
  const c = collection(p);
  const file = path.join(OUT, `Purolator_Certification_${p}.postman_collection.json`);
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
  const n = c.item.reduce((s, f) => s + f.item.length, 0);
  console.log(`${path.relative(ROOT, file)}: ${n} requests in ${c.item.length} folders`);
}
