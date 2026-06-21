---
name: web-api-recovery
description: Recover web application internal APIs from browser network traffic, JavaScript bundles, source maps, and request/response samples. Produces endpoint maps, auth/session notes, signing/encryption hypotheses, and reproducible curl/httpx clients.
whenToUse: When the target is a web app, SPA, minified JavaScript bundle, WebAssembly-backed frontend, browser runtime flow, internal REST/GraphQL/batchexecute/gRPC-web API, or when the user asks to reproduce a browser request from DevTools/cURL/HAR.
allowedTools: Bash, Read, Grep, Glob, WebFetch
---

# web-api-recovery skill

Goal: turn a browser interaction into a **reproducible API map**:
endpoints, methods, headers, cookies/session requirements, request bodies,
response schemas, client code, and unresolved signing/encryption questions.

This skill adapts the workflow of `metterian/reverse-api-skill` for this
plugin. It prefers observation and documentation over exploitation: capture
what the user's browser can do, then reproduce the
same flow in a small client.

## Inputs

Collect whichever input the user can provide:

- Target URL or local web app URL.
- Goal: e.g. "recover the search API", "reproduce login + profile fetch",
  "find where the `x-sign` header comes from".
- Captured data: HAR, cURL, request/response snippets, DevTools Network export,
  screenshots, or browser MCP access.
- Auth context: whether cookies/tokens are test credentials and may be reused
  in a local repro script.
- Output preference: endpoint notes, `curl`, Python `httpx`, TypeScript `fetch`,
  or a report only.

## Preferred workflow

### Stage 1 — Capture

Use the least invasive capture path that answers the question:

1. **Existing capture first.** If the user pasted cURL/HAR/request details,
   analyse that instead of driving a browser.
2. **Browser MCP observation.** If Chrome DevTools or Playwright MCP is available,
   observe a single user-approved flow and capture XHR/fetch/WebSocket traffic.
3. **Manual DevTools fallback.** Ask the user to copy the request as cURL from
   DevTools Network when MCP capture is unavailable.

Keep the capture to the named workflow.

Capture checklist:

```markdown
- Page / action observed:
- Request URL + method:
- Status code:
- Request headers that matter:
- Cookies/session source:
- Request body:
- Response content type:
- Response shape:
- Redirects / preflight / CSRF calls:
```

### Stage 2 — Protocol classification

Classify each request mechanically:

| Signal | Protocol / pattern |
|---|---|
| `/graphql`, JSON body with `query` / `operationName` | GraphQL |
| URL contains `batchexecute`, body has `f.req=` | Google batchexecute |
| `content-type: application/grpc-web*` | gRPC-web |
| JSON REST resource paths and HTTP verbs | REST / JSON RPC |
| `application/x-www-form-urlencoded` with method/action params | form RPC |
| `ws://` / `wss://` upgrade | WebSocket |
| `.wasm` plus signed request params | likely WASM-assisted signing |

Record the classification in the output. If multiple protocols are present,
map them separately.

### Stage 3 — Authentication and state model

Explain how the browser proves identity for the captured flow:

- Cookie session, bearer token, CSRF token, signed header, nonce/timestamp,
  device/session ID, localStorage/sessionStorage token, or mTLS/client cert.
- Where the value appears to originate: HTML bootstrap, `/csrf` endpoint,
  login response, JS bundle constant, storage, or WebCrypto/WASM computation.
- Whether the value can be safely parameterised in a local client.

Do **not** help steal, forge, bypass, or refresh third-party credentials. For
user-owned/test systems, show placeholders and require the user to provide
their own test token/cookie at runtime.

### Stage 4 — Server-side authorization boundary checks

After the auth/session model is mapped, test whether the server enforces object
ownership and tenant boundaries. This covers IDOR / BOLA-style failures where a
valid session can read or modify another tenant's object by changing an id. This
is especially important for SaaS /
multi-tenant admin apps where a valid user token is separate from project,
workspace, tenant, or merchant credentials.

Use test accounts or test tenants. Keep probes narrow and rate-limited.

Checklist:

```markdown
- User identity source: token / JWT / cookie / session id
- Tenant identity source: project_id / workspace_id / hid / merchant_id / org_id
- Tenant secret source: header / body / storage / endpoint response
- Sensitive object ids: user_id / order_id / card_id / batch_id / role_id
- Server-side ownership check observed: yes/no/unknown
```

Run negative tests before claiming a privilege boundary:

| Test | Expected secure behaviour |
|---|---|
| Same token, different `project_id` / tenant id | 403 / 404 / empty scoped result |
| Same token, object id from another tenant | 403 / 404 |
| Missing tenant credential but valid user token | rejected |
| Tenant credential from project A with object from project B | rejected |
| Client-side VIP/admin flag modified, server action unchanged | server re-checks DB/role |
| WebSocket token in URL | document leakage risk and prefer header/subprotocol/cookie |

For JWTs, decode headers/claims for context. Report algorithm, claim names, expiry,
and whether the server appears to trust client-controlled claims. Explicitly test
that `alg: none` or client-side role/VIP changes are rejected before marking the
server-side check as strong.

If IDOR or cross-tenant access is confirmed, report only the minimal proof:
endpoint, parameter changed, two object ids, observed status/body delta,
and impact category.

### Stage 5 — JavaScript bundle and source-map analysis

When the request includes unknown headers, signatures, encrypted payloads, or
non-obvious parameters, inspect frontend code.

Start with built-in/manual options:

```bash
# Locate likely script URLs in saved HTML or copied page source.
# Prefer user-provided files.
```

If the user already has the bundle on disk, optional external tools may help:

```bash
# Optional: bundle unpacking and deobfuscation via webcrack.
# Install only if the user agrees; otherwise document this as a suggested step.
npx --yes webcrack@latest input.js -o out-webcrack

# Optional: Babel-AST deobfuscation for heavily obfuscated single-file JS.
# Useful for string arrays, control-flow flattening, and self-defending code.
npx --yes deob input.js -o out-deob
```

Use `webcrack` first for Webpack/Browserify bundles. Use `js-deobfuscator`
only when the script is specifically obfuscated. If neither is available,
search manually for terms such as:

```text
fetch axios XMLHttpRequest graphql batchexecute grpc-web
sign signature x-sign x-signature token csrf nonce timestamp
crypto.subtle HmacSHA256 AES RSA wasm WebAssembly instantiate
```

For each candidate signing/encryption function, record:

- file/module path and function name if available
- input fields used
- algorithm hints (hash/HMAC/AES/RSA/WebCrypto/WASM)
- whether the recovered logic is complete or only a hypothesis

Do not remove anti-bot, CAPTCHA, fingerprinting, or rate-limit controls for a
third-party site. For owned apps, frame that analysis as debugging the client's
request construction.

### Stage 6 — Reproduce the request

Generate the smallest repro that matches the captured browser request.
Default to placeholders for sensitive values:

```python
import httpx

BASE_URL = "https://example.test"

class ExampleClient:
    def __init__(self, session_cookie: str):
        self.client = httpx.Client(
            base_url=BASE_URL,
            headers={"user-agent": "api-recovery-test/1.0"},
            cookies={"session": session_cookie},
        )

    def list_items(self) -> dict:
        response = self.client.get("/api/items")
        response.raise_for_status()
        return response.json()
```

For GraphQL, preserve `operationName`, variables, and query text. For Google
batchexecute, decode only enough structure to explain the RPC id and argument
array; avoid pretending the format is complete if it is still opaque.

### Stage 7 — API reference output

Write or return an API map in this shape:

```markdown
# Web API recovery — <target>

## Scope and authorisation
- Basis:
- Flow analysed:
- Out of scope:

## Endpoints
| Name | Method | Path | Protocol | Auth | Body | Response | Confidence |
|---|---|---|---|---|---|---|---|

## Auth/session model
- Cookies/tokens:
- JWT claims / expiry / server-side role checks:
- Tenant identifiers (`project_id`, `workspace_id`, `hid`, `merchant_id`):
- Tenant secrets / API keys:
- CSRF / nonce:
- Storage dependencies:

## Server-side authorisation checks
| Endpoint | Parameter changed | Expected owner | Observed result | Verdict | Confidence |
|---|---|---|---|---|---|

- Cross-tenant access:
- Object-level access:
- Client-side role/VIP tamper result:
- Redaction notes:

## Signing / encryption
- Header / parameter:
- Candidate implementation:
- Inputs:
- Confidence:
- Unresolved questions:

## Reproduction
- curl / httpx / fetch snippet:

## What was not covered
- Endpoints not exercised:
- Dynamic behaviour not observed:
- Anti-bot/CAPTCHA/rate-limit mechanisms not bypassed:
```

## Tooling recommendations

Use tools in this order:

1. Existing capture: HAR, copied cURL, request JSON.
2. Browser MCP observation: Chrome DevTools MCP or Playwright MCP already
   available in the user's Claude environment.
3. Optional external CLI:
   - `webcrack` for bundle unpacking and Webpack/Browserify module recovery.
   - `kuizuo/js-deobfuscator` / `deob` for single-file AST deobfuscation.
   - Node.js `crypto`, `crypto-js`, `qs`, and stable JSON stringify helpers for
     validating hash/HMAC/AES/RSA, query ordering, and body canonicalisation.
   - `mitmproxy` or an offline HAR parser for request diffing.
4. Optional reference MCP: `DaisukeHori/playwright-devtools-mcp` is a useful
   all-in-one design reference for flow capture, API spec, HAR, curl, and
   Python generation, but do not require it for this skill.

Do not install new tools automatically. Ask first, or provide commands as a
suggested local setup step.

## Confidence rules

- **High** — directly captured request/response plus successful local repro.
- **Medium** — captured request/response, but signing/auth logic only partially
  explained or repro not executed.
- **Low** — inferred from static bundle strings without observing the flow.

Never claim an endpoint is complete if you only saw one UI path. Never claim a
signature algorithm is recovered unless you can cite the function and inputs or
produce matching output for a known request.

## References

- reverse-api-skill — https://github.com/metterian/reverse-api-skill
- webcrack — https://github.com/j4k0xb/webcrack
- js-deobfuscator — https://github.com/kuizuo/js-deobfuscator
- playwright-devtools-mcp — https://github.com/DaisukeHori/playwright-devtools-mcp
