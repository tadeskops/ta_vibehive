# Vendored library hashes (SRI)

Every file under `assets/vendor/` is a third-party library vendored into the
repo so we can keep CSP `script-src 'self'` and avoid CDN dependence at
runtime. Each entry lists:

- File
- Upstream URL
- Version pinned
- SHA-384 (base64) for `integrity="sha384-..."` attribute

Regenerate any of these via the matching `scripts/vendor-*.ps1` script.

| File | Upstream | Version | SHA-384 |
|---|---|---|---|
| `alpine-3.14.1.min.js` | https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js | 3.14.1 | `l8f0VcPi/M1iHPv8egOnY/15TDwqgbOR1anMIJWvU6nLRgZVLTLSaNqi/TOoT5Fh` |
