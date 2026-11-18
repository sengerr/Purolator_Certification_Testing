#!/usr/bin/env node
/*
 * build-postman.js — builds the certification checklist as Postman collections, in two formats:
 *
 *   postman/collections/<name>/            Postman v3 collection format (Native Git YAML:
 *                                          definition.yaml + one *.request.yaml per row)
 *   exports/<name>.postman_collection.json  (outside postman/ so Postman does not register it twice)
 *                                          Postman v2.1 JSON, for Newman and older Postman
 *
 *   node tooling/build-postman.js          (needs the runner's "yaml" package: cd runner && npm install)
 *
 * Four collections: SOAP and REST, each for Development and Production. One request per checklist
 * row that has a sample file, named "<ID> · <Item>", in the same section folders as samples/.
 * Rows with no sample (Not applicable) are skipped. The checklist status goes in each description.
 *
 * The collections never carry credentials or account numbers. SOAP_Key, SOAP_Password,
 * REST_ClientId, REST_Secret, REST_XApiKey, AccountNumber, Freight_account and the other
 * {{variables}} come from your own local Postman environment, which is never committed.
 *
 * Re-run after changing a sample or index.csv, then commit the regenerated files.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const YAML = require(require.resolve('yaml', { paths: [path.join(__dirname, '..', 'runner')] }));

const ROOT = path.resolve(__dirname, '..');
const V3_DIR = path.join(ROOT, 'postman', 'collections');
const JSON_DIR = path.join(ROOT, 'exports');

/* ------------------------------------------------------------------ tiers */
const TIERS = {
  Development: { soapBase: 'https://devwebservices.purolator.com', restBase: 'https://shipapi-sandbox.purolator.com', authScope: 'portal_api_sandbox' },
  Production:  { soapBase: 'https://webservices.purolator.com',    restBase: 'https://shipapi.purolator.com',         authScope: 'portal_api' },
};

/* -------------------------------------------------------------------- CSV */
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

/* ---------------------------------------------------------------- helpers */
// Stable ids, so regenerating does not churn every file in git.
const stableId = s => {
  const h = crypto.createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
// Windows-safe file name (no \ / : * ? " < > |).
const safe = s => s.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
const writeYaml = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(obj, { lineWidth: 0, blockQuote: 'literal' }));
};

// "POST /EWS/V2/Shipping/ShippingService.asmx · SOAPAction http://…/CreateShipment"
function parseSendTo(sendTo) {
  const [first, ...rest] = sendTo.split('·').map(s => s.trim());
  const [method, urlPath] = first.split(/\s+/);
  const sa = rest.find(r => r.startsWith('SOAPAction'));
  return { method, urlPath, soapAction: sa ? sa.replace(/^SOAPAction\s+/, '') : null };
}

/* ------------------------------------------------- collection-level scripts */
const PRE_SCRIPT = [
  "// Purolator validates the shipment date in ITS timezone (Toronto), so build",
  "// Current_Date there, not in the machine's local time. en-CA gives yyyy-mm-dd.",
  "const now = new Date();",
  "const pad = n => String(n).padStart(2, '0');",
  "pm.variables.set('Current_Date', now.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }));",
  "// REQ + YYYYMMDDHHMMSS, the same RequestReference convention as Purolator_2026.",
  "pm.variables.set('RequestReference', 'REQ' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())",
  "  + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()));",
].join('\n');

const POST_SCRIPT = {
  REST: [
    "// Keep the token and the last shipment PIN for the requests that follow.",
    "let body = {};",
    "try { body = pm.response.json(); } catch (e) { /* not JSON */ }",
    "if (body.access_token) pm.collectionVariables.set('REST_Token', body.access_token);",
    "const pin = body.shipmentPIN && (body.shipmentPIN.value || body.shipmentPIN);",
    "if (typeof pin === 'string') pm.collectionVariables.set('PIN', pin);",
    "pm.test('HTTP 200', () => pm.response.to.have.status(200));",
  ].join('\n'),
  SOAP: [
    "// Keep the last shipment PIN for the requests that follow, and fail on SOAP errors.",
    "const xml = pm.response.text();",
    "const m = xml.match(/<(?:\\w+:)?ShipmentPIN>\\s*<(?:\\w+:)?Value>([^<]+)</);",
    "if (m) pm.collectionVariables.set('PIN', m[1]);",
    "pm.test('HTTP 200', () => pm.response.to.have.status(200));",
    "pm.test('No errors in ResponseInformation', () => pm.expect(xml).to.not.match(/<(?:\\w+:)?Error>/));",
  ].join('\n'),
};

/* ------------------------------------------------------------------ build */
function buildModel(rows, proto, tier) {
  const t = TIERS[tier];
  const name = `Purolator Certification ${proto} — ${tier}`;
  const host = proto === 'SOAP' ? '{{soapBase}}' : '{{restBase}}';
  const sections = [];   // keep checklist order
  const bySection = new Map();
  for (const r of rows.filter(r => r.Protocol === proto && r['Sample file'] && r['Send to'])) {
    if (!bySection.has(r.Section)) { bySection.set(r.Section, []); sections.push(r.Section); }
    const { method, urlPath, soapAction } = parseSendTo(r['Send to']);
    // Normalise Windows line endings so the YAML stays a readable literal block.
    let body = fs.readFileSync(path.join(ROOT, r['Sample file']), 'utf8').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    // The token sample carries the Production scope; use the tier's scope instead.
    if (r.ID === 'R-001') body = body.replace(/"scope"\s*:\s*"[^"]*"/, '"scope": "{{authScope}}"');
    const headers = proto === 'SOAP'
      ? { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: soapAction }
      : { 'x-api-key': '{{REST_XApiKey}}', RequestReference: '{{RequestReference}}', Language: 'en', 'Content-Type': 'application/json' };
    const req = {
      id: r.ID, name: `${r.ID} · ${r.Item}`, method, url: host + urlPath, headers,
      bodyType: proto === 'SOAP' ? 'xml' : 'json', body,
      description: `**${r.Item}** — ${r['API value']}\n\nChecklist status: **${r['Sample status']}**\n\nExpected: ${r['Expected outcome']}`,
      // The token call authenticates with the client id and secret; everything else inherits.
      auth: r.ID === 'R-001' ? { type: 'basic', credentials: { username: '{{REST_ClientId}}', password: '{{REST_Secret}}' } } : null,
    };
    if (r.ID === 'R-001') delete req.headers['x-api-key'];
    bySection.get(r.Section).push(req);
  }
  const variables = proto === 'SOAP'
    ? { soapBase: t.soapBase, PIN: '' }
    : { restBase: t.restBase, authScope: t.authScope, REST_Token: '', PIN: '' };
  const auth = proto === 'SOAP'
    ? { type: 'basic', credentials: { username: '{{SOAP_Key}}', password: '{{SOAP_Password}}' } }
    : { type: 'bearer', credentials: { token: '{{REST_Token}}' } };
  const folders = sections.map((s, i) => ({ name: `${String(i + 1).padStart(2, '0')} · ${s}`, requests: bySection.get(s) }));
  const description = `Purolator ${proto} certification checklist — **${tier}** (${proto === 'SOAP' ? t.soapBase : t.restBase}).\n\n`
    + 'Generated from samples/index.csv by tooling/build-postman.js — do not edit by hand.\n\n'
    + 'Credentials and account numbers are NOT stored here. Create your own local Postman environment '
    + '(never committed) with: ' + (proto === 'SOAP' ? 'SOAP_Key, SOAP_Password' : 'REST_ClientId, REST_Secret, REST_XApiKey')
    + ', AccountNumber, Different_AccountNumber, Freight_account.'
    + (tier === 'Production' ? '\n\n> **Production creates real, billable shipments.** Void everything you create.' : '');
  return { name, proto, description, variables, auth, folders };
}

function writeV3(m) {
  const dir = path.join(V3_DIR, m.name);
  fs.rmSync(dir, { recursive: true, force: true });
  writeYaml(path.join(dir, '.resources', 'definition.yaml'), {
    $kind: 'collection',
    description: m.description,
    variables: m.variables,
    scripts: [
      { type: 'beforeRequest', code: PRE_SCRIPT, language: 'text/javascript' },
      { type: 'afterResponse', code: POST_SCRIPT[m.proto], language: 'text/javascript' },
    ],
    auth: [{ id: stableId(m.name + ':auth'), type: m.auth.type, name: `${m.auth.type} auth`, credentials: m.auth.credentials }],
  });
  m.folders.forEach((f, fi) => {
    const fdir = path.join(dir, safe(f.name));
    writeYaml(path.join(fdir, '.resources', 'definition.yaml'), { $kind: 'collection', order: (fi + 1) * 1000 });
    f.requests.forEach((r, ri) => {
      const doc = { $kind: 'http-request', description: r.description, url: r.url, method: r.method, headers: r.headers,
                    body: { type: r.bodyType, content: r.body } };
      if (r.auth) doc.auth = r.auth;
      doc.order = (ri + 1) * 1000;
      writeYaml(path.join(fdir, `${safe(r.name)}.request.yaml`), doc);
    });
  });
}

function writeV21(m) {
  // Postman v2.1 auth shape: { type, basic: [{key,value,type}] }
  const auth21 = a => ({ type: a.type, [a.type]: Object.entries(a.credentials).map(([key, value]) => ({ key, value, type: 'string' })) });
  const script = (listen, code) => ({ listen, script: { type: 'text/javascript', exec: code.split('\n') } });
  const coll = {
    info: { _postman_id: stableId(m.name), name: m.name, description: m.description,
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: m.folders.map(f => ({
      name: f.name,
      item: f.requests.map(r => {
        const [base, ...rest] = r.url.split('/');
        const request = {
          method: r.method, description: r.description,
          header: Object.entries(r.headers).map(([key, value]) => ({ key, value })),
          body: { mode: 'raw', raw: r.body, options: { raw: { language: r.bodyType } } },
          url: { raw: r.url, host: [base], path: rest },
        };
        if (r.auth) request.auth = auth21(r.auth);
        return { name: r.name, request };
      }),
    })),
    auth: auth21(m.auth),
    event: [script('prerequest', PRE_SCRIPT), script('test', POST_SCRIPT[m.proto])],
    variable: Object.entries(m.variables).map(([key, value]) => ({ key, value })),
  };
  fs.mkdirSync(JSON_DIR, { recursive: true });
  const file = path.join(JSON_DIR, `${m.name.replace(/ — /g, '_').replace(/\s+/g, '_')}.postman_collection.json`);
  fs.writeFileSync(file, JSON.stringify(coll, null, 2) + '\n');
  return file;
}

function main() {
  const rows = parseCsv(fs.readFileSync(path.join(ROOT, 'samples', 'index.csv'), 'utf8'));
  for (const proto of ['SOAP', 'REST']) {
    for (const tier of Object.keys(TIERS)) {
      const m = buildModel(rows, proto, tier);
      writeV3(m);
      const json = writeV21(m);
      const n = m.folders.reduce((a, f) => a + f.requests.length, 0);
      console.log(`${m.name}: ${n} requests in ${m.folders.length} folders -> v3 YAML + ${path.relative(ROOT, json)}`);
    }
  }
}

main();
