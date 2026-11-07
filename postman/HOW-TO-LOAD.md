# Load the certification collections into Postman

Two collections, Postman format v2.1.0, built from `samples/index.csv` by `tooling/build-postman.js`:

| File | Requests | Matches checklist sheets |
|---|---|---|
| `Purolator_Certification_SOAP.postman_collection.json` | 183 | SOAP - Development, SOAP - Production |
| `Purolator_Certification_REST.postman_collection.json` | 203 | REST - Development, REST - Production |

Each request is named after its checklist row (`S-001 Create Shipment`, `R-003 Create / validate shipment` …) and sits in the same section folder as its sample. Rows with no sample (Not applicable) are not in the collections.

No environment files are included: credentials are issued per customer and never travel with a collection. You create your own environments in step 2.

---

## 1. Import the collections from GitHub

Use the Postman desktop app (Windows or Mac) or the web app. Pick one way:

**A. Paste the links (quickest)**

1. In Postman, select **Import** (top left), or press `Ctrl+O`.
2. Paste this link and press Enter:
   `https://raw.githubusercontent.com/sengerr/Purolator_Certification_Testing/main/postman/Purolator_Certification_SOAP.postman_collection.json`
3. Select **Import**. Repeat with:
   `https://raw.githubusercontent.com/sengerr/Purolator_Certification_Testing/main/postman/Purolator_Certification_REST.postman_collection.json`

**B. Download or clone the repository**

1. On https://github.com/sengerr/Purolator_Certification_Testing select **Code > Download ZIP** and unzip it (or `git clone https://github.com/sengerr/Purolator_Certification_Testing.git`).
2. In Postman select **Import**, then drag the two `.postman_collection.json` files from the `postman` folder into the window (not the zip). Select **Import**.

The collections appear under **Collections** in the left sidebar. Each has a fixed id, so importing a newer copy later asks **Replace** or **Import as copy** — choose **Replace**.

## 2. Create an environment for each tier

Everything that is yours — hosts, keys and account numbers — comes from an environment.

1. Left sidebar > **Environments** > **+** (Create Environment).
2. Name it `Purolator — Development`.
3. Add the variables below. Put keys and passwords in **Current value** only and set their **Type** to `secret`. Leave **Initial value** blank so they are not synced to the Postman cloud or shared with your team.
4. Select **Save** (`Ctrl+S`).
5. Repeat for `Purolator — Production` with the production hosts, scope and keys.

| Variable | Used by | Development | Production |
|---|---|---|---|
| `soapBase` | SOAP | `https://devwebservices.purolator.com` | `https://webservices.purolator.com` |
| `SOAP_Key` | SOAP | your Development key | your Production key |
| `SOAP_Password` | SOAP | your key password (secret) | your key password (secret) |
| `baseUrl` | REST | `https://shipapi-sandbox.purolator.com` | `https://shipapi.purolator.com` |
| `authScope` | REST | `portal_api_sandbox` | `portal_api` |
| `REST_ClientId` | REST | your client ID | your client ID |
| `REST_Secret` | REST | your client secret (secret) | your client secret (secret) |
| `REST_XApiKey` | REST | your x-api-key (secret) | your x-api-key (secret) |
| `AccountNumber` | both | your registered account number | same |
| `Different_AccountNumber` | both | a second account (third-party / receiver billing) | same |
| `Freight_account` | freight | your freight account, if any | same |

You do not create the dates, `RequestReference`, `REST_Token`, `PIN`, `Freight_PIN` or `PickUpConfirmationNumber`: the collections' scripts set them while you run.

## 3. Select the environment

Top right, change **No Environment** to `Purolator — Development`. The eye icon beside it shows the values in use. A URL showing `{{soapBase}}` or `{{baseUrl}}` in red means no environment is selected or a variable is missing.

## 4. Send requests

- **REST:** send `01 API operations > R-001 Get token` first. It stores the token every other REST request uses. Send it again if you start getting `401` (tokens expire after about an hour).
- **SOAP:** no token step; each request uses Basic auth from `SOAP_Key` / `SOAP_Password`.
- Run each section **top to bottom**: void, document, tracking and manifest requests use the PIN that a shipment request earlier in the run created.
- Every response is checked for HTTP 2xx and for errors in the body (both APIs can answer 200 with an error). The **Test Results** tab shows which.
- To run a whole section: right-click the folder > **Run folder**, keep the order, set a delay of about `250 ms`, and check the environment.

Record each result in the yellow columns of `Purolator Certification Checklist 2026.xlsx`, or let the YAML runner do it (see the README).

> **Production creates real, billable shipments, and a scheduled pickup sends a real driver.** Test in Development first, and void anything you create in Production.

## Troubleshooting

| You see | Cause | Fix |
|---|---|---|
| `{{baseUrl}}` / `{{soapBase}}` in red | No environment selected, or the variable name differs | Select the environment; check the eye icon |
| REST `401` on the token request | Client ID / secret / scope do not match the tier | Development keys use `portal_api_sandbox`, Production keys `portal_api` |
| REST `401` on other requests | Token missing or expired | Send `R-001 Get token` again |
| REST `403` | `REST_XApiKey` missing, for the other tier, or a wrong path | Check the key and the tier |
| SOAP `401` or an HTML page in the body | `SOAP_Key` / `SOAP_Password` wrong for that host | Development and Production keys are different |
| A void or document request says the PIN is invalid | No shipment was created earlier in this run | Run the section from the top |
