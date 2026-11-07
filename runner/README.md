# YAML test runner

Runs every row of the certification checklist — all SOAP and REST samples — against Development or Production, and writes the results in the same shape as the checklist's yellow columns.

| File | What it is |
|---|---|
| `tests.yaml` | Every checklist row as a test (415): where to send it, which sample, its sample status, expected outcome, run phase, and what it creates. **Generated** from `samples/index.csv`. |
| `config.yaml` | Hosts, run order, which shipment's PIN each document/void test uses, Production safety settings. Edit this one. |
| `run-tests.js` | The runner. |
| `build-tests-yaml.js` | Rebuilds `tests.yaml` after `samples/index.csv` changes. |

## Setup (once)

Install [Node.js 18 or later](https://nodejs.org), then in **PowerShell** from the repository folder:

```powershell
cd runner
npm install
```

## Credentials

The runner reads credentials from environment variables only — nothing is stored in the repository. Set the ones for the protocol you run, in the same PowerShell window:

```powershell
# REST
$env:PUROLATOR_REST_CLIENT_ID     = "<client id>"
$env:PUROLATOR_REST_CLIENT_SECRET = "<client secret>"
$env:PUROLATOR_X_API_KEY          = "<x-api-key>"
# (or $env:PUROLATOR_TOKEN = "<bearer token>" to skip the token call)

# SOAP
$env:PUROLATOR_SOAP_KEY      = "<key>"
$env:PUROLATOR_SOAP_PASSWORD = "<password>"

# Accounts (fill {{AccountNumber}}, {{Different_AccountNumber}}, {{Freight_account}})
$env:PUROLATOR_ACCOUNT         = "<registered account>"
$env:PUROLATOR_ACCOUNT_2       = "<second account>"      # optional
$env:PUROLATOR_FREIGHT_ACCOUNT = "<freight account>"     # optional

# Optional: only needed for the three "Not yet verified" tracking rows
$env:PUROLATOR_TRACK_REFERENCE = "<a shipmentReference you sent>"   # S-020
$env:PUROLATOR_FREIGHT_PIN     = "<a real freight PRO number>"      # S-031, S-032
```

macOS / Linux: use `export NAME="value"` instead of `$env:NAME = "value"`.

## Run

```powershell
# See every request the run would send, with placeholders filled. Sends nothing.
node run-tests.js --env dev --dry-run

# Everything, Development
node run-tests.js --env dev

# Everything, Production (real, billable — see below)
node run-tests.js --env prod --confirm-production

# Narrower runs
node run-tests.js --env dev --protocol REST
node run-tests.js --env dev --section "Cross-border"
node run-tests.js --env dev --only S-138,R-163      # their source shipments run too
node run-tests.js --env dev --status Verified
```

`node run-tests.js --help` lists every option.

## What the runner does for you

- **Token first.** Gets the REST token (`R-001`) and uses it on every REST call; retries once if the token call fails.
- **Placeholders.** Fills `{{Current_Date}}`, `{{pickupDate}}` (next business day), `{{manifestDate}}`, history/tracking date ranges — all in Toronto time, which is how Purolator validates dates — plus a fresh `RequestReference` per call and your account numbers.
- **PINs and pickup numbers.** Captures the shipment PIN from each create and the confirmation number from each scheduled pickup, then hands them to the tests that need them. Each document type reads a PIN from a shipment created for it (for example the Dangerous Goods Declaration reads the PIN from the dangerous goods shipment); the mapping is `pinSources` in `config.yaml`.
- **Order.** Creates → documents and tracking → pickups (schedule, validate, modify, history, void) → Void Shipment → end-of-day close → manifest documents.
- **Pending documents.** Asks again (up to 3 times, 2 seconds apart) while a document is still `Pending`.

## Production safety

Production creates real, billable shipments, so with `--env prod` the runner:

- refuses to start without `--confirm-production`;
- **voids every shipment and pickup it created** before it exits — also when you press Ctrl+C — and lists anything it could not void (`cleanup.csv`, and a warning on screen);
- **skips Consolidate and Close Manifest** (a closed shipment can no longer be voided). Add `--allow-close` only if you mean it;
- **never books freight pickups** (`S-030`, `R-226`–`R-229`): the API cannot cancel them. `--allow-unvoidable` overrides this in either environment.

In Development, test shipments are left in place and the close steps run.

## Results

Each run writes a folder under `runner/results/` (ignored by git — responses can contain your account details):

| File | What it is |
|---|---|
| `results.csv` | One row per test. **Your outcome** (Pass / Fail / Skipped) and **Your date and time stamp** match the checklist columns; also HTTP status, error code and message, whether the result matches the checklist, the PIN used and the PIN or confirmation number captured. |
| `summary.json` | Totals, tests that differ from the checklist, anything still open. |
| `cleanup.csv` | Production only: every void the cleanup sent. |
| `responses/` | The raw response for each test. Tokens are masked; long base64 labels are shortened unless you add `--keep-documents`. |
| `requests/` | Dry run only: every resolved request. |

**Matches expected** compares your result with the checklist: a *Verified* row should pass; a *Not available* row should fail with the error code the checklist names. `No` means your account behaves differently from ours — worth a look, and worth telling us.

## Pass rules

- **SOAP:** HTTP 200 and no `<Error>` under `ResponseInformation` (and no SOAP fault).
- **REST:** HTTP 2xx and no `errors` in the body.

A pass means the call was accepted. It does not check every field of the response — compare with the *Expected outcome* column when it matters.

## Changing the tests

- New or changed rows in `samples/index.csv`: run `node build-tests-yaml.js`. It also warns if a PIN source in `config.yaml` no longer points at a shipment create.
- Different PIN sources, hosts or Production behaviour: edit `config.yaml`.
- Another host (for example a certification host Purolator gave you): set `$env:PUROLATOR_SOAP_BASE` / `$env:PUROLATOR_REST_BASE`.

## Need help?

See the [wiki](https://github.com/sengerr/Purolator_Certification_Testing/wiki) for where to find support articles and who to contact.
