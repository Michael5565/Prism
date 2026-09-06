# Prism — Search Inside Drive (v1.0.0)

Full-text search **inside** Drive files — Docs, Sheets, Slides & PDFs — injected directly on `drive.google.com` / `docs.google.com`. No side panel file picker. Uses your existing Google session via `credentials: include` — no OAuth scopes required for search.

## How it works

1. **Discover** (`content-search.js`): scans the Drive/Docs/Sheets/Slides DOM for visible file links — same trick DocLens uses, with media exclusion.
2. **Stream** (`background.js` + `api.js`): for each visible doc, `fetchSessionText()` tries:
   - `docs.google.com/document/d/{id}/export?format=txt`
   - `docs.google.com/spreadsheets/d/{id}/export?format=csv`
   - `docs.google.com/presentation/d/{id}/export?txt`
   - fallback: `drive.usercontent.google.com/download?id={id}` → `extract.js` (ZIP → docx/xlsx/pptx) or PDF parser → caches `doc_{id}` for 1h in `chrome.storage.local`
3. **Snippet** (`background.js:extractSnippets`): exact-phrase, 80-char window, strips comment markers so `find-text` deep links work.
4. **Pane** (`content-search.js` + `styles.css`): injected amber pane streams batches as they arrive — progress bar, `Doc/Sheet/Slide/PDF` badges, click snippet → `…/edit#find-text=` (Docs) or file view.
5. **Jump** (`content-doc.js`): on `docs.google.com/document/d/{id}/edit#find-text=…` uses native Find & Replace.

## Paywall

- 7-day unrestricted free trial (`TRIAL_DURATION_MS` in `content-search.js`). Start timestamp stored as `prismInstallTime` in `chrome.storage.local`.
- After trial, paywall is shown with link to `https://getwalksafe.co.uk/prismpricing` ($6.99/mo or $49/yr) and license-key input.
- License validation: `POST https://<your-worker>.workers.dev/api/validate-license` with `{key}`. Set `LICENSE_SERVER` in `content-search.js` and deploy `prism-license-worker/` (Cloudflare Worker + KV). See `prism-license-worker/SETUP.md`.
- Valid key sets `prismPremium=true`. No Google Identity / OAuth required for free tier.

## Install (dev)

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `drivelens/` folder
2. Open `drive.google.com` → search in Drive’s own search bar
3. Pane slides in → matches appear batched

## Files

- `manifest.json` — MV3, `storage` only, `content-search.js`+`styles.css`, `content-doc.js`
- `background.js` — service worker, streaming, 1h cache, `open-match` deep link
- `content-search.js` — injected pane, discovery, streaming client, paywall
- `content-doc.js` — native Find jumper
- `api.js` / `extract.js` — session export + Office/PDF extraction
- `styles.css` — injected pane theme

## Store checklist

- Privacy policy: `PRIVACY.md` + `website/privacy.html` (host at `https://getwalksafe.co.uk/privacy`)
- Store listing: `STORE_LISTING.md`
- Permissions justification: `PRIVACY.md` § Permissions
- Single purpose: search inside Drive files you can already see
- No remote code, no `identity` permission, minimal `host_permissions`
- Icons 16/48/128 in `icons/`
