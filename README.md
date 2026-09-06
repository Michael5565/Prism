# Prism

Prism is a Chrome extension for Drive search and image-safe dark mode in Google Docs and Sheets.

## Repository layout

- `extension/` — Chrome extension source. Load this folder unpacked from `chrome://extensions`.
- `website/` — Prism pricing and activation pages.
- `license-worker/` — Cloudflare Worker and KV-backed license validation.

## Local development

Load `extension/` as an unpacked extension. The pricing page uses Paddle Checkout and retrieves generated license keys from the deployed Worker after payment.

For the Worker, see [`license-worker/SETUP.md`](license-worker/SETUP.md). Configure the `LICENSES` KV namespace and Paddle webhook secret before deploying.

## Cloudflare Pages

- Root directory: `/`
- Build command: `npm run build`
- Build output directory: `website`

The build is intentionally dependency-free; Cloudflare Pages only needs to publish the static `website/` directory.

## Pricing

Prism currently offers $6.99/month or $49/year, with image-safe Docs Dark Mode included in Pro.
