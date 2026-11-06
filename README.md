# Purolator API certification testing

A checklist and a sample request for every product, service and option in the Purolator **SOAP** and **REST** APIs, for both **Development** and **Production**.

Use it to decide what you will offer your clients, send each sample, and record what happened.

## What's here

| Path | What it is |
|---|---|
| `Purolator Certification Checklist 2026.xlsx` | The checklist. Four sheets: SOAP – Development, SOAP – Production, REST – Development, REST – Production. |
| `samples/SOAP/` | One SOAP request body (`.xml`) per checklist row, grouped by section. |
| `samples/REST/` | One REST request body (`.json`) per checklist row, grouped by section. |
| `samples/index.csv` | Every row: ID, item, where to send it, sample file, sample status, expected outcome. |

Row IDs (`S-001`, `R-001` …) are the same on the Development and Production sheets, in `index.csv` and in the sample file names.

## Environments

| Environment | SOAP base URL | REST base URL |
|---|---|---|
| Development | `https://devwebservices.purolator.com` | `https://shipapi-sandbox.purolator.com` |
| Production | `https://webservices.purolator.com` | `https://shipapi.purolator.com` |

The request body is the same in Development and Production; only the host and your credentials change.

> **Production creates real, billable shipments.** Test in Development first, and void anything you create in Production.

## Filling in the checklist

Each sheet lists, per row: the item, its API value and accepted values, notes, the full URL to send it to (SOAP: also the `SOAPAction` header), a link to the sample, the sample status and the expected outcome.

The yellow columns are yours:

| Column | What to enter |
|---|---|
| Going to offer to clients | Yes / No / Later / N/A |
| Your outcome | Pass / Fail / Partial / Not tested, or your own words |
| Your date and time stamp | When you ran it, `yyyy-mm-dd hh:mm` |
| Your concerns | Anything that worries you about this item |
| Your questions | Anything you need answered |

## Sample status

| Status | Meaning |
|---|---|
| **Verified** | This exact body succeeded live. The expected outcome says where: *Development / Certification* (SOAP Development 2026-10-29, REST Certification 2026-10-06) or *Production 2026-11-06*. |
| **Not available** | Sent in Production on 2026-11-06 and refused. The expected outcome gives the exact error and what it means — for example a real service ID not offered on the test lane, an option not accepted on outbound shipments, or REST freight not enabled on the account. Your account or lane may differ, so these are worth testing yourself. |
| **Not yet verified** | Not sent live yet: tracking by reference (needs a reference from one of your shipments) and the freight pickup, freight tracking and freight documents samples (they need a real freight shipment or pickup, which the API cannot cancel). |
| **Not applicable** | No sample can be sent: a service ID spelling the REST API rejects (`9001-51`, the row names the right one), a field removed in Shipping Web Service 2.3, the 2.3 EU fields (not in the Development WSDL yet), or the REST Service Availability API (not published yet). |

## Production run, 2026-11-06

Every not-yet-verified sample was sent once in Production; every shipment and pickup it created was voided straight away (43 shipments, 2 pickups).

| | Verified | Not available | Not yet verified | Not applicable |
|---|---|---|---|---|
| SOAP (186 rows) | 169 | 10 | 4 | 3 |
| REST (229 rows) | 148 | 56 | 0 | 25 |

What Production taught us, beyond pass/fail:

- **SOAP pickups need `Version 1.2`** in the request header; `1.0` returns `3001136 Service version is invalid`.
- **REST Express Cheque payment methods are words:** `Cheque`, `Post dated Cheque`, `Certified Cheque`, `Money Order`, `Bank Draft` (`9001-146`). SOAP uses `PostDatedCheque` etc.
- **REST notifications:** `ShipmentNotification-Receiver` needs `notificationMessage` (`9001-273`); the proactive `NotifyWhen…` types need `notifications.requestorName` (`9001-322`).
- **Sunday delivery / pickup** need an Express service (`9001-100` with Ground) and are lane-dependent.
- **`ReturnPickup`, `PackageFree`, `OpenVerify`** are refused on outbound shipments (SOAP `1001107`, REST `9001-68`).
- **REST `brokerageVendorAddress` / `brokerageExporterAddress`** are in the published spec but refused (`9001-276`).

## Placeholders

Replace these before sending:

| Placeholder | Replace with |
|---|---|
| `{{AccountNumber}}` | Your registered account number |
| `{{Different_AccountNumber}}` | A second account (receiver / third-party billing) |
| `{{Freight_account}}` | Your freight account number |
| `{{Current_Date}}` | Ship date, `YYYY-MM-DD` (today up to 10 days ahead) |
| `{{Date}}` | A date relevant to the call (for example a manifest date) |
| `{{Pickup_Date}}` | Pickup date, `YYYY-MM-DD` |
| `{{PIN}}` | A shipment PIN you created earlier in your test run |
| `{{Freight_PIN}}` | A freight shipment PIN (PRO number) you created earlier |
| `{{PickUpConfirmationNumber}}` | The confirmation number returned when you scheduled a pickup |
| `{{Reference}}` | A shipment reference you sent when creating a shipment |
| `{{From_Date}}` / `{{To_Date}}` | Search date range, `YYYY-MM-DD` |
| `{{RequestReference}}` | Any reference of yours (REST: up to 36 characters) |

## Headers

**REST** — get a token from `POST /auth/v1/token` (sample `R-001`), then send on every call:

```
Authorization: Bearer <token>
x-api-key: <your API key>
Content-Type: application/json
Language: en
RequestReference: <your reference>
```

**SOAP** — HTTP Basic authentication with your key and password, plus:

```
Content-Type: text/xml; charset=utf-8
SOAPAction: <the value in the checklist's "Send to" column>
```

## Suggested order

1. REST: get a token (`R-001`). SOAP: confirm your key works with a quick estimate (`S-005`).
2. Estimates, then validate-only shipments (SOAP `ValidateShipment`, REST `validateOnly: true`).
3. Create shipments, fetch their documents with the PIN, then void them.
4. Schedule, modify and void a pickup, using the confirmation number from the schedule call.
5. Close the day (consolidate / close manifest) and fetch the summary manifest.
