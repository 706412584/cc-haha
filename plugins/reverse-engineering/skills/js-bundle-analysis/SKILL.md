---
name: js-bundle-analysis
description: Analyse JavaScript bundles, source maps, Webpack/Browserify chunks, obfuscated frontend code, and WebAssembly-assisted client logic to recover API surfaces, request construction, signing/encryption candidates, and module-level evidence.
whenToUse: When the input is a local JavaScript bundle, minified/obfuscated frontend asset, source map, Webpack/Browserify/Next.js chunk set, WebAssembly-backed web client, or when web-api-recovery needs help locating where headers, tokens, signatures, encrypted payloads, or endpoint paths are produced.
allowedTools: Bash, Read, Grep, Glob
---

# js-bundle-analysis skill

Goal: turn frontend assets into a **module-level map** of API calls,
request construction, signing/encryption logic, storage dependencies, source-map
recovery, and unresolved runtime questions.

Use this skill as the static companion to `web-api-recovery`: `web-api-recovery`
answers "what did the browser send?"; this skill answers "where did the bundle
construct it?"

## Scope reminder

Proceed for assets the user provides.

## Inputs

Collect the narrowest useful input:

- local bundle path, directory of chunks, source map, saved page HTML, or manifest
- target question: endpoint discovery, `x-sign` header, encrypted payload,
  WebSocket framing, WASM crypto, source reconstruction, or module inventory
- known request sample from `web-api-recovery`, if available
- allowed output: notes only, module map, endpoint table, or reproduction hints

Prefer local files. Do not crawl a third-party website for all assets unless the
user confirms that broad collection is in scope.

## Workflow

### Stage 1 — Inventory the asset set

Identify what kind of frontend artifact you have:

| Signal | Meaning |
|---|---|
| `webpackJsonp`, `__webpack_require__`, numeric module IDs | Webpack bundle/chunks |
| `parcelRequire`, Browserify wrapper, Rollup IIFE | bundled JS |
| `_next/static`, `buildManifest`, route chunks | Next.js app |
| `sourceMappingURL=` or `.map` sibling | possible source-map recovery |
| `WebAssembly.instantiate`, `.wasm` fetch/import | WASM-assisted logic |
| string-array decoder, switch flattening, self-defending code | obfuscation |

Record:

```markdown
- Asset root:
- Bundle/chunk count:
- Source maps present:
- Framework/bundler hints:
- WASM present:
- Obfuscation signs:
```

### Stage 2 — Recover readable structure

Use the least invasive path first:

1. If source maps exist and are local/user-provided, inspect those first.
2. If the bundle is Webpack/Browserify/minified, suggest or run `webcrack` only
   after user approval.
3. If it is a heavily obfuscated single file, suggest or run `deob` only after
   user approval.
4. If external tools are unavailable, manually search likely identifiers.

Optional commands:

```bash
# Webpack/Browserify/module recovery. Best first choice for frontend bundles.
npx --yes webcrack@latest input.js -o out-webcrack

# Babel-AST deobfuscation for standalone obfuscated scripts.
npx --yes deob input.js -o out-deob
```

Do not install dependencies silently. When commands are run, keep output under an
artifact directory and do not upload bundles to hosted playgrounds.

### Stage 3 — Locate API surfaces

Search recovered source, source maps, or raw bundles for:

```text
fetch axios XMLHttpRequest $.ajax ky got graphql batchexecute grpc-web
/api/ /graphql /rpc/ /v1/ /v2/ websocket WebSocket EventSource
operationName query mutation variables f.req content-type authorization csrf
```

For each API candidate, capture:

```markdown
- Module/file:
- Function/component:
- Method/path/protocol:
- Request body builder:
- Response handler:
- Storage/auth dependencies:
- Confidence:
```

Confidence is **high** only when the path is tied to a concrete call site, not
just a string literal.

### Stage 4 — Locate signing, crypto, and state dependencies

Search for request-shaping terms:

```text
sign signature x-sign x-signature hmac sha256 md5 aes rsa crypto.subtle
nonce timestamp csrf token access_token refresh_token localStorage sessionStorage
cookie indexedDB wasm WebAssembly instantiate importObject
hid secret project_id workspace_id tenant_id merchant_id org_id user_id is_vip role
```

For each candidate signing/encryption function, record:

- source file/module and function name if recoverable
- inputs: path, method, timestamp, nonce, body hash, cookie, token, device id,
  tenant id, project id, API key, build id, or app key
- algorithm hints: hash, HMAC, AES/RSA, WebCrypto, CryptoJS, WASM export
- canonicalisation details: query sorting, URL encoding, JSON key order,
  body minification, timestamp precision, header casing
- outputs: header, query parameter, body field, encrypted blob
- whether the logic is complete, partial, or only a hypothesis

Useful optional local tools for validation:

| Tool | Use |
|---|---|
| Node.js `crypto` | built-in MD5/SHA/HMAC/AES/RSA checks |
| `crypto-js` | match frontend CryptoJS implementations |
| `qs` | reproduce query/body serialisation and array formats |
| stable JSON stringify helper | test body canonicalisation for signatures |
| `wabt` / `wasm2wat` | inspect WASM-assisted sign/export glue |
| `mitmproxy` / HAR diff | compare two requests with one changed field |

For systems under analysis, use placeholders and test values supplied by the user.

### Stage 4b — Tenant and object-boundary clues

For SaaS/admin apps, explicitly separate user authentication from tenant/object
authorisation. Static bundle analysis should flag where these values originate
and whether the client appears to trust user-controllable ids:

```text
project_id workspace_id tenant_id org_id merchant_id hid secret
batch_id card_id card_key order_id role_id user_id vip level balance
```

Record:

```markdown
- Tenant id source:
- Tenant secret source:
- Object id source:
- Client-side permission flags:
- Endpoints accepting ids from UI/router/storage:
- Needs server-side IDOR/BOLA test in web-api-recovery: yes/no
```

A client-side role/VIP/admin flag is never proof of authorisation. Treat it as a
UI hint until `web-api-recovery` confirms whether the server enforces the action.

### Stage 5 — WASM-assisted frontend logic

If the bundle loads `.wasm`:

1. Identify the `.wasm` path and import/export names.
2. Record the JS wrapper functions that call exports.
3. Determine whether exports participate in signing, encryption, decoding, or
   feature checks.
4. Route deeper binary/WASM reverse engineering back to native RE tooling when
   JS wrapper evidence is insufficient.

Output shape:

```markdown
## WASM notes
- WASM file:
- JS wrapper:
- Exports called:
- Inputs/outputs observed:
- Likely role:
- Needs native/WASM RE: yes/no
```

### Stage 6 — Produce the bundle analysis report

Return or write:

```markdown
# JS bundle analysis — <target>

## Scope and assets
- Basis:
- Files analysed:
- Tools used:
- Not uploaded externally:

## Bundle structure
- Bundler/framework:
- Source maps:
- Main modules/chunks:
- WASM:

## API candidates
| Method | Path / operation | Module | Builder | Auth/state | Confidence |
|---|---|---|---|---|---|

## Signing / encryption candidates
| Header/param/body field | Module/function | Inputs | Algorithm hint | Canonicalisation | Confidence |
|---|---|---|---|---|---|

## Tenant/object boundary clues
| Endpoint/function | Tenant/object parameter | Source | Client-side check | Needs server test |
|---|---|---|---|---|

## Storage/state dependencies
- Cookies:
- localStorage/sessionStorage:
- IndexedDB/bootstrap globals:

## Handoff to web-api-recovery
- Requests to capture next:
- Values to compare against a real browser request:
- Repro assumptions:

## What was not covered
- Dynamic values not observed:
- Source maps unavailable:
- Obfuscation not fully removed:
- Anti-bot/CAPTCHA/rate-limit mechanisms not bypassed:
```

## Handoff rules

- If you find endpoint candidates but no runtime evidence, hand off to
  `web-api-recovery` for a single capture.
- If `web-api-recovery` has a captured header/parameter but no origin, use this
  skill to trace where it is produced.
- If WASM or native crypto is the blocker, hand off to the binary/WASM analysis
  lane and clearly state what JS wrapper evidence exists.

## Confidence rules

- **High** — source-map/recovered module call site plus matching captured request.
- **Medium** — concrete call site found, but dynamic values are not verified.
- **Low** — string literals or partially deobfuscated code only.

Never claim the recovered API surface is complete unless every relevant UI path
was exercised or every route chunk was in scope.

## References

- webcrack — https://github.com/j4k0xb/webcrack
- js-deobfuscator — https://github.com/kuizuo/js-deobfuscator
- reverse-api-skill — https://github.com/metterian/reverse-api-skill
