# Blockwalk

Phone-first park-and-walk route planner for a door-to-door solar rep. It opens on a full-screen map. Paste any list of doors, cluster them into parking spots, and get a driving order between those spots with the walk along the block computed on the phone.

This folder is a separate app from the D2D CRM at the repository root. It is static and is meant to be served at `https://magger1024.github.io/README/blockwalk/`. Paths are relative. The service worker's scope is the directory it ships in, which on GitHub Pages is `/README/blockwalk/`, so it does not take over the CRM.

No API keys, secrets, or real addresses are in this repo. Without keys the app runs in **demo mode**: a fictional Northfield Demo list and an on-phone optimizer.

## Use it

On a phone, open the GitHub Pages URL and add it to the home screen. The map is the whole screen. Search sits on top. Sun, Layers, and Me float on the right. The sheet at the bottom has Start, End, Optimize, and the day's doors, miles, and hours.

- **Start** defaults to current location (or the demo location if GPS is off). **End** defaults to the same place. Long-press the map to drop a stop or set either end.
- **Import** a paste (one address per line), a CSV, or a public Google Sheet link. Lists are not capped. A list bigger than "doors per day" (default 150) is split into compact day areas. Only the open day is optimized.
- **Geocoding** keeps a pin only when Google returns `ROOFTOP` and not a partial match. Anything else is flagged. Address Validation can promote a premise match. Otherwise switch to satellite and drag the pin. Dragged pins are stored as your correction.
- Place IDs are kept. Coordinates that came from Google are dropped after 30 days and refreshed from the place id. Manual pins are not Google cache and are kept.
- **Optimize** sends park points, not every door, to Google Route Optimization when the Worker is configured: one vehicle, live traffic, your departure time, fixed start and end, visit time = doors × minutes per door + the walk, `searchMode: CONSUME_ALL_AVAILABLE_TIME`. If the Worker is missing or the call fails, the phone runs nearest-neighbor plus 2-opt and Or-opt with the same start and end.
- **From here** re-optimizes the doors you have not marked, starting at your live location. Marked doors stay knocked.
- Dispositions are one tap: Not home, Sit, Come back, No. Come back stores a revisit time (three hours later, or 10:00 the next morning after 3pm). Skip drops a door. Lock keeps its relative place on the next solve. Next and Last move a door.
- **Navigate to next** opens Google Maps, Waze, or Apple Maps for the next parking spot only. **Send to Tesla** calls the Worker, which calls Tessie. The button stays disabled until the Worker's health check says Tessie is configured.
- **Sun** asks the Solar API for building insights when you tap a house, and draws the annual flux GeoTIFF only at street zoom. Overlay fetches stop at 45 blocks a day and are cached 30 days. Google results are labeled `Source: Includes solar data from Google.` The demo overlay is synthetic and says so.
- Counters on the Settings tab track stops sent, geocodes, sun lookups, and overlay blocks against the free monthly tiers. Crossing a free tier warns before the call. The overlay cap blocks the 46th block of the day. Google Cloud quotas are still the real brake.
- The route lives in IndexedDB. Export writes a JSON backup that leaves out the browser key, Worker URL, and passcode. The service worker caches the shell so a loaded day still opens offline.

## Settings and keys

| Setting | Where it lives |
| --- | --- |
| Maps browser key | This phone only (IndexedDB). Maps JavaScript API and Places API. |
| Worker URL and passcode | This phone only. |
| Service account, server Maps key, Tessie token and VIN | Cloudflare Worker secrets. Never in the repo. |

Restrict the browser key by HTTP referrer:

```
https://magger1024.github.io/README/blockwalk/*
https://magger1024.github.io/*
http://localhost:*/*
http://127.0.0.1:*/*
```

API restriction on that key: Maps JavaScript API and Places API only. The same instructions are on the Settings tab.

Worker deploy, the Google Cloud project, which APIs to enable, and the quota caps are in [`worker/README.md`](worker/README.md). The Worker is not deployed from this repository.

## Develop

```bash
cd blockwalk
node --test tests/*.test.js
node tests/benchmark.js
npm install
npx playwright install chromium
npm run e2e
```

Unit tests cover clustering, the local optimizer (including 2-opt / Or-opt deltas, locked and knocked stops), day splitting, and the free-tier cost counters. The benchmark builds synthetic street grids of 50, 200, 500, and 1,000 stops and prints park-and-walk length, full-stop length, nearest-neighbor length, and runtime. It exits non-zero if the local solver is longer than nearest neighbor. Real address lists stay out of git (`blockwalk/.gitignore`).

`npm run serve` hosts the repository at `http://127.0.0.1:4173/README/blockwalk/`.

## Deviations from the design doc

- The map with no browser key is an offline canvas with a procedural street grid, so the PWA, the tests, and a day with no signal do not depend on a tile server. Google Maps JavaScript and Places Autocomplete load after a key is saved in Settings.
- Geocoding, Address Validation, Solar, and Route Optimization go through the Worker with a server key. That matches the architecture diagram and keeps the referrer-locked browser key on Maps JS and Places only.
- The on-phone optimizer minimizes planar distance with a fixed start and end. It does not know live traffic. Google does, once the Worker is configured.
- Solver time budgets scale with the number of park points (8s up to 30, 20s up to 100, 45s up to 1,000, 120s above that) while staying on `CONSUME_ALL_AVAILABLE_TIME`. A 20-stop day is not asked to wait out a 45 second budget. Solves over 45 seconds, or over 1,000 park points, use the long-running endpoint and the phone polls.
- U-turn avoidance is off by default and is sent as `VisitRequest.avoidUTurns` only when Settings turns it on. `sideOfRoad` is on for multi-door park points.
- Revisit reminders shipped here. The doc listed them as V2.
- Benchmarks use a synthetic grid. The doc's private Maryland files are not in this public repo.
- Minutes per door defaults to 3 until a week of knock gaps can suggest a median.
- The GeoTIFF reader handles classic little-endian, single-band, strip or tiled, uncompressed or zlib, predictor 1 or 2. Other compressions fail with an error instead of drawing a guess.
- Send to Tesla uses Tessie's documented `/{vin}/command/share?value=lat,lng`. The VIN stays in a Worker secret.
