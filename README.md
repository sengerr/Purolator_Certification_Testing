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
| **Verified** | This exact body succeeded live. SOAP: Development environment, 2026-10-29. REST: Certification, 2026-10-06. |
| **Not yet verified** | A verified body with only this row's item changed (for example a different service ID, option value or document type). Expected to work; not yet sent. |
| **Not applicable** | A service ID spelling the REST API rejects (`9001-51`). The row says which spelling to use instead. |
| **No sample yet** | No sample in this release (see below). |

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

## No sample yet in this release

SOAP: ValidateCityPostalCodeZip, SchedulePickUp, ModifyPickUp, VoidPickUp, ValidatePickUp, GetPickUpHistory, TrackPackagesByReference, GetLocationsByPointOfInterest, Freight pickup, Freight tracking, Freight documents, and the FDA / USMCA / FCC / EU cross-border fields (USMCA and FCC indicators were removed in Shipping Web Service 2.3).

REST: modify / history / void pickup, the Service Availability API (coming soon), buyer address and brokerage addresses.
