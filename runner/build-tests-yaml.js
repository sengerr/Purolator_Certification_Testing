#!/usr/bin/env node
// =============================================================================
// build-tests-yaml.js — regenerate tests.yaml from samples/index.csv
//
// samples/index.csv is the single source for the checklist rows. This script
// turns every row into a test entry: where to send it, which sample body, its
// sample status and expected outcome, plus the run phase and what the call
// creates (so the runner knows what to capture and what to void).
//
// Usage (Windows PowerShell, from the repository root):
//   node runner\build-tests-yaml.js
//
// Re-run it whenever samples/index.csv changes. Hand edits made directly in
// tests.yaml are overwritten — put lasting settings in config.yaml instead.
// =============================================================================

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'samples', 'index.csv');
const OUT = path.join(__dirname, 'tests.yaml');

// ---- Minimal RFC 4180 CSV parser ------------------------------------------------
// Handles quoted fields, doubled quotes and commas/newlines inside quotes.
// (No npm package needed for one well-formed file.)
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/^﻿/, ''); // drop the UTF-8 byte-order mark
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
      else if (c === '"') inQuotes = false;                           // closing quote
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;                    // CRLF
      row.push(field); field = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows;
  return data.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

// ---- Classify one row ---------------------------------------------------------------
// Returns phase, what the call creates, and its operation name.
function classify(protocol, operation, body) {
  // Operation = SOAPAction's last segment (SOAP) or "METHOD /path" (REST).
  const op = operation;

  if (protocol === 'REST') {
    if (op === 'POST /auth/v1/token') return { phase: 'token' };
    if (op === 'PUT /ship/v1/shipment') return { phase: 'void', voids: 'shipment' };
    if (op === 'POST /ship/v1/manifest') return { phase: 'close' };
    if (op === 'POST /ship/v1/documents/summary-manifest') return { phase: 'after-close' };
    if (op === 'POST /ship/v1/documents') return { phase: 'uses-pin' };
    if (op === 'POST /track/v1/shipment') return { phase: 'uses-pin' };
    if (op === 'POST /pickup/v1/schedule') {
      // Freight pickups cannot be cancelled through the API.
      const freight = /"lineOfBusiness"\s*:\s*"Freight"/i.test(body);
      return { phase: 'pickups', creates: freight ? 'freight-pickup' : 'pickup' };
    }
    if (op === 'PUT /pickup/v1/void') return { phase: 'pickups', voids: 'pickup' };
    if (op.includes('/pickup/')) return { phase: 'pickups' };
    if (op === 'POST /ship/v1/shipment') {
      // validateOnly: true creates nothing.
      const validateOnly = /"validateOnly"\s*:\s*true/.test(body);
      return { phase: 'main', creates: validateOnly ? undefined : 'shipment' };
    }
    return { phase: 'main' };
  }

  // SOAP
  switch (op) {
    case 'CreateShipment':
    case 'CreateReturnShipment':
      return { phase: 'main', creates: 'shipment' };
    case 'VoidShipment':
      return { phase: 'void', voids: 'shipment' };
    case 'Consolidate':
      return { phase: 'close' };
    case 'GetShipmentManifestDocument':
      return { phase: 'after-close' };
    case 'SchedulePickUp':
      return { phase: 'pickups', creates: 'pickup' };
    case 'VoidPickUp':
      return { phase: 'pickups', voids: 'pickup' };
    case 'ValidatePickUp':
    case 'ModifyPickUp':
    case 'GetPickUpHistory':
      return { phase: 'pickups' };
    case 'GetFreightPickup':
      // Books a freight pickup the API cannot cancel.
      return { phase: 'pickups', creates: 'freight-pickup' };
    default:
      // Documents, tracking and delivery details read a PIN; everything else
      // (estimates, validations, service availability, locator) is standalone.
      return { phase: /\{\{(PIN|Freight_PIN)\}\}/.test(body) ? 'uses-pin' : 'main' };
  }
}

// Order inside the pickups phase: create first, void last.
const PICKUP_ORDER = ['SchedulePickUp', 'ValidatePickUp', 'ModifyPickUp', 'GetPickUpHistory', 'VoidPickUp',
  'POST /pickup/v1/schedule', 'PUT /pickup/v1/modify', 'POST /pickup/v1/getHistory', 'PUT /pickup/v1/void'];

// ---- Build ---------------------------------------------------------------------------
function main() {
  const rows = parseCsv(fs.readFileSync(INDEX, 'utf8'));
  const tests = rows.map(r => {
    const protocol = r.Protocol;
    const sendTo = r['Send to'] || '';
    const [route, actionPart] = sendTo.split(' · ');
    const [method, routePath] = (route || '').trim().split(/\s+/);
    const soapAction = actionPart ? actionPart.replace(/^SOAPAction\s+/, '').trim() : undefined;
    const operation = protocol === 'SOAP'
      ? (soapAction ? soapAction.split('/').pop() : '')
      : (route || '').trim();

    const bodyFile = r['Sample file'] || '';
    const body = bodyFile && fs.existsSync(path.join(ROOT, bodyFile))
      ? fs.readFileSync(path.join(ROOT, bodyFile), 'utf8') : '';

    const t = {
      id: r.ID,
      protocol,
      section: r.Section,
      item: r.Item,
      sampleStatus: r['Sample status'],
    };
    if (method) { t.method = method; t.path = routePath; }
    if (soapAction) t.soapAction = soapAction;
    if (bodyFile) t.body = bodyFile;

    // Rows with nowhere to send (Not applicable) are reported, never sent.
    if (!method) {
      t.skip = 'No sample to send (Not applicable).';
    } else {
      Object.assign(t, classify(protocol, operation, body));
      t.operation = operation;
    }
    t.expected = r['Expected outcome'];
    // An error code in the expected outcome ("returned 9001-312 …") lets the
    // runner tell an expected refusal from a new one.
    const code = (r['Expected outcome'].match(/\b(9001-\d{2,3}|\d{7}|\d{10})\b/) || [])[1];
    if (r['Sample status'] === 'Not available' && code) t.expectedErrorCode = code;
    // Drop empty keys so the YAML stays readable.
    for (const k of Object.keys(t)) if (t[k] === undefined || t[k] === '') delete t[k];
    return t;
  });

  // Keep index order, except pickups run create → modify → void.
  tests.forEach((t, i) => { t._i = i; });
  tests.sort((a, b) => {
    if (a.phase === 'pickups' && b.phase === 'pickups' && a.protocol === b.protocol) {
      const ai = PICKUP_ORDER.indexOf(a.operation), bi = PICKUP_ORDER.indexOf(b.operation);
      if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    }
    return a._i - b._i;
  });
  tests.forEach(t => delete t._i);

  // Check the PIN sources in config.yaml point at real create tests.
  const config = YAML.parse(fs.readFileSync(path.join(__dirname, 'config.yaml'), 'utf8'));
  const byId = Object.fromEntries(tests.map(t => [t.id, t]));
  const problems = [];
  for (const [proto, src] of Object.entries(config.pinSources)) {
    const ids = [src.default, src.void, ...Object.values(src.byDocumentType || {})];
    for (const id of ids) {
      if (!byId[id]) problems.push(`${proto}: ${id} is not in index.csv`);
      else if (byId[id].creates !== 'shipment') problems.push(`${proto}: ${id} does not create a shipment`);
    }
  }
  if (problems.length) console.warn('config.yaml pinSources warnings:\n  ' + problems.join('\n  '));

  const header = [
    '# =============================================================================',
    '# tests.yaml — every checklist row as a runnable test',
    '#',
    '# GENERATED from samples/index.csv by runner/build-tests-yaml.js.',
    '# Do not edit by hand: re-run the script after changing index.csv, and put',
    '# lasting settings (PIN sources, hosts, extra request details) in config.yaml.',
    '#',
    '# Fields: id · protocol · section · item · sampleStatus (from the checklist)',
    '#         method · path · soapAction · body (where and what to send)',
    '#         phase    run order (see config.yaml → phases)',
    '#         creates  shipment | pickup | freight-pickup (captured, and voided in Production)',
    '#         voids    shipment | pickup (this test cancels what an earlier test made)',
    '#         expected / expectedErrorCode  what the checklist says should happen',
    '#         skip     never sent, reported as Skipped',
    `# Rows: ${tests.length}`,
    '# =============================================================================',
    '',
  ].join('\n');

  fs.writeFileSync(OUT, header + YAML.stringify({ tests }, { lineWidth: 0 }));
  const count = (f) => tests.filter(f).length;
  console.log(`Wrote ${path.relative(ROOT, OUT)}: ${tests.length} tests ` +
    `(SOAP ${count(t => t.protocol === 'SOAP')}, REST ${count(t => t.protocol === 'REST')}, ` +
    `${count(t => t.creates === 'shipment')} create shipments, ${count(t => t.skip)} not applicable).`);
}

main();
