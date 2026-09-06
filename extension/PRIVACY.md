# Prism — Privacy Policy

**Last updated: 25 August 2026**
**Contact: support@getwalksafe.co.uk**

## Summary
Prism runs entirely in your browser. It searches *inside* the Google Drive files you can already see on `drive.google.com` / `docs.google.com` and shows passages matching your Drive search query. **We do not collect, store, or sell your document contents.**

## Data we handle

### 1. Document text (ephemeral)
- **What:** When you search Drive, Prism discovers the file IDs visible on the page (from `<a href="/document/d/...">` etc.), then fetches each file’s text via your own Google session (`credentials: include` — `docs.google.com/.../export?format=txt` and `drive.usercontent.google.com/download?id=...`).
- **Where it lives:** Only in your browser — `chrome.storage.local` under keys `doc_{fileId}` (text + mimeType + timestamp, 1-hour TTL, evicted on quota pressure). Never sent to our servers or any third party except Google’s own export endpoints using your session cookies.
- **How it’s used:** Local snippet extraction (`extractSnippets`) to show 80-char windows around your query and to build `…/edit#find-text=` deep links for Docs.
- **How to clear:** Prism → `chrome.storage.local.clear()` or extension “Clear browsing data” → or wait 1 hour for TTL.

### 2. Search count & license
- **What:** `prismSearchCount` (integer, 0–3), `prismPremium` (bool), `prismLicenseKey` (your Paddle key, upper-cased).
- **Why:** Enforce 3 free searches, then unlock via paid license.
- **License validation:** When you enter a key, Prism `POST`s `{key}` to `https://prism-license-worker.<your-subdomain>.workers.dev/api/validate-license` (Cloudflare Worker + KV). We log only the key status (`active`/`past_due`/`cancelled`) and `current_period_end`. No document data is sent.

### 3. What we do NOT do
- No Google OAuth scopes. No `drive.readonly` / `drive.file`. No off-device Drive listing — we only harvest IDs you already see in the DOM.
- No analytics trackers, no ads, no fingerprinting.
- No remote code execution. No `eval`, no dynamically injected scripts from the network.

## Permissions justification (Chrome Web Store)

| Permission | Why |
|---|---|
| `storage` | Cache `doc_{id}` for 1h, store `prismSearchCount` / `prismPremium` locally |
| `host_permissions: https://docs.google.com/*` | `export?format=txt/csv` for native Google Docs/Sheets/Slides |
| `https://drive.google.com/*` | Discover visible file IDs + fallback downloads |
| `https://drive.usercontent.google.com/*` | Binary fallback for PDFs / Office uploads |
| `https://*.googleusercontent.com/*` | `lh3.googleusercontent.com` thumbnail IDs used in DOM discovery |
| `https://*.workers.dev/*` | License validation (`/api/validate-license`). Replace wildcard with your exact worker hostname after deploy. |

Removed in v1.0.0: `tabs`, `identity`, `cookies`, `https://accounts.google.com/*` — no longer needed.

## Single purpose
> Help users find exact passages inside files they already have access to in Google Drive — Docs, Sheets, Slides & PDFs — and jump to them.

## Retention & deletion
Uninstalling the extension removes all `chrome.storage.local` data. License records in Cloudflare KV expire after 1 year or when Paddle cancels the subscription.

## Your rights
You can export/delete local data via DevTools → Application → Storage → Local Storage / `chrome.storage.local`. For KV deletion requests email `support@getwalksafe.co.uk` with your license key.

## Children
Not directed to children under 13.

## Changes
We’ll bump the “Last updated” date and the extension changelog when this policy changes. Continued use = acceptance.
