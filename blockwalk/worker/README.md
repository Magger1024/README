# Blockwalk Worker

Cloudflare Worker that holds Google and Tessie credentials and proxies the calls the phone cannot make with a referrer-locked browser key. It is not deployed by this repo. Deploy it yourself, then paste the Worker URL and passcode into Blockwalk Settings.

The browser key stays restricted to **Maps JavaScript API** and **Places API**. Geocoding, Address Validation, Route Optimization, and Solar go through this Worker.

## What it exposes

| Path | Purpose |
| --- | --- |
| `GET /health` | Which secrets are present. No secret values. |
| `POST /optimize` | One-vehicle Route Optimization. Traffic on, fixed start and end, `CONSUME_ALL_AVAILABLE_TIME`. |
| `POST /optimize/poll` | Poll a long-running solve (lists over 1,000 park points, or a timeout over 45s). |
| `POST /geocode` | Up to 40 addresses or place ids. |
| `POST /validate` | Address Validation for flagged pins. |
| `POST /solar/insights` | Solar `buildingInsights:findClosest`. |
| `POST /solar/layers` | Solar annual-flux GeoTIFF, downloaded here so the phone is not blocked by CORS. |
| `POST /tesla` | Tessie `POST /{vin}/command/share` with `lat,lng`. |
| `POST /sheet` | Public Google Sheet CSV, only `docs.google.com`. |

Every route except CORS preflight requires the header `X-Blockwalk-Passcode`. Requests from origins other than `https://magger1024.github.io` and localhost are rejected. The optimize body is rebuilt on the Worker and always has **one vehicle**, so a call cannot be billed as Fleet Routing.

The Google access token is cached in the isolate and in the Cache API until shortly before it expires.

## 1. Google Cloud project

Route Optimization and Solar require billing on the project. Alerts do not stop charges. Daily quotas do.

1. Create a billing account and one project.
2. Enable **Maps JavaScript API**, **Places API**, **Geocoding API**, **Address Validation API**, **Route Optimization API**, and **Solar API**.
3. In Google Maps Platform → Quotas, cap each API per day so a normal month stays inside the free tier:
   - Route Optimization: the quota is per request, not per stop. Keep the app's in-phone counter honest (free **5,000 stops / month**). A daily request cap around 40 covers a few re-optimizes.
   - Geocoding: 10,000 free / month. A daily cap around 400 is a comfortable door-day.
   - Address Validation: 5,000 free / month. Only flagged pins call it.
   - Solar building insights: 10,000 free / month.
   - Solar data layers: 1,000 free / month. The app also refuses the 46th overlay block in a day.
4. Create a budget alert at $1. It emails. It does not stop billing.
5. Create a **service account** with permission to call Route Optimization (`routeoptimization.locations.use` on the project, or the broader `roles/routeoptimization.editor` / service-usage consumer role Google documents for this API). Download the JSON key. This is the only place that JSON should exist.
6. Create two API keys:
   - **Browser key.** Application restriction: HTTP referrers. API restriction: Maps JavaScript API and Places API only.
     ```
     https://magger1024.github.io/README/blockwalk/*
     https://magger1024.github.io/*
     http://localhost:*/*
     http://127.0.0.1:*/*
     ```
     Put this key in the phone app's Settings. It is stored in IndexedDB on that phone, not in the repo.
   - **Server key.** Application restriction: none (or IP restrictions you control). API restriction: Geocoding, Address Validation, and Solar. This key is a Worker secret. Do not put it in the browser key.

## 2. Deploy

```bash
cd blockwalk/worker
npx wrangler login
npx wrangler secret put PASSCODE
npx wrangler secret put GOOGLE_CLOUD_PROJECT
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
npx wrangler secret put GOOGLE_MAPS_API_KEY
# optional, enables Send to Tesla
npx wrangler secret put TESSIE_API_TOKEN
npx wrangler secret put TESSIE_VIN
npx wrangler deploy
```

`GOOGLE_SERVICE_ACCOUNT_JSON` is the raw JSON file contents on one line. `TESSIE_VIN` is the car, not something the phone sends.

For a local check, copy `.dev.vars.example` to `.dev.vars` (gitignored) and run `npx wrangler dev`. The free Worker plan allows 50 subrequests per invocation. Geocode batches are capped at 40 so a token refresh still fits.

Paste the `*.workers.dev` (or your custom domain) URL and the passcode into Blockwalk → Settings. Send to Tesla stays disabled until `/health` reports `tessie: true`.

## 3. Tessie

Send to Tesla calls Tessie's documented share command:

```
POST https://api.tessie.com/{vin}/command/share?value={lat},{lng}&locale=en-US
Authorization: Bearer $TESSIE_API_TOKEN
```

That shares one coordinate with the car. It is not turn-by-turn from Blockwalk. Google Maps, Waze, and Apple Maps links are built on the phone and do not go through the Worker.

## Timeouts

| Park points | Solver budget | Call |
| --- | --- | --- |
| up to 30 | 8s | synchronous `optimizeTours` |
| up to 100 | 20s | synchronous |
| up to 1,000 | 45s | synchronous |
| over 1,000, or any budget over 45s | up to 120s | `optimizeToursLongRunning`, then the phone polls |

`searchMode` is `CONSUME_ALL_AVAILABLE_TIME`, so the budget is the quality limit, not a fast-mode cutoff. Small days use a short budget so the phone is not asked to wait 45 seconds for a 20-stop route that is already solved. U-turn avoidance is off unless Settings turns it on. `sideOfRoad` is on for multi-door park points.
