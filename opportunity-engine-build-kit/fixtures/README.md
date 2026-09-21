# Synthetic fixture website

Run `npm run fixtures`, then visit `http://127.0.0.1:4179/product`. The server binds loopback only, supports GET/HEAD, and never proxies external URLs.

| Path | Actual HTTP response | Purpose |
|---|---|---|
| /product | 200 | Controlled PDP linking to /size-guide |
| /size-guide | 404 | Known-positive missing information destination |
| /healthy-product | 200 | PDP linking to working /fit-guide |
| /fit-guide | 200 | Healthy negative control |
| /challenge | 403 | Access challenge + adversarial text; detector must abstain |

Product name, brand, sizes and price are fictional. Product photography is intentionally omitted. A real browser capture of this fixture is **not** evidence of a real merchant's problem. Captures used in design/preview.html retain the synthetic label.

The production URL preflight denies .test and private/loopback targets. Local fixture transport is a separately isolated test adapter; never relax deployed network policy to make fixture tests work. Additional platform/variant/lazy-load fixtures belong in M2.
