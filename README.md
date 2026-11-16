# D2D CRM (V1)

Phone-first, browser-based lead log for door-to-door and phone solar sales. Plain HTML/CSS/JS, no build step, no server, no accounts. Installable as a PWA and works offline.

## What's in V1
- **Today**: callbacks due (overdue flagged), today's sits, stats vs. the daily door target (default 125), big Log button.
- **Quick log**: Door or Call, pick/create a lead by address or phone, one-tap outcome, optional note and callback time. "Save + next" for fast knocking.
- **Leads**: search + status filters, sorted by priority (callbacks due, then new, then oldest touch).
- **Lead detail**: edit all fields, tap-to-call (`tel:`), tap-to-navigate (Google Maps), timeline, next action, book sits.
- **Appointments**: sit booked, then mark Sat / Closed / No-show.
- **Import**: CSV with column mapping (auto-guessed), dedupe by phone/address, skips suppressed. **Export**: JSON backup (restorable), CSV for leads / touches / appointments.
- **Suppression**: Do not knock / Do not call hides a lead everywhere and blocks re-adding it.
- **Stats**: day / week / month totals, conversion rates, touches per day, outcome breakdown.

Not included on purpose: auto-dialer, mass texting.

## Run locally
```
cd d2d-crm
python3 -m http.server 8080
# open http://localhost:8080 (service worker needs http://localhost or https)
```

## Deploy on GitHub Pages (when you're ready)
1. Create a GitHub account and a new repository (e.g. `d2d-crm`). Public is simplest; Pages on private repos needs a paid plan.
2. Upload everything in this folder to the repo root (drag and drop on github.com works), including `.nojekyll`.
3. Repo **Settings > Pages > Build and deployment**: Source = "Deploy from a branch", Branch = `main`, folder = `/ (root)`. Save.
4. After a minute the app is at `https://<username>.github.io/d2d-crm/`.
5. On the phone: open the link, then Share > Add to Home Screen (iOS Safari) or menu > Install app (Android Chrome).

All paths are relative, so it works from a sub-path like `/d2d-crm/`. When you change files, bump `VERSION` in `sw.js` so phones pick up the update.

## Data & backups
Data is stored in the browser (IndexedDB, falls back to localStorage), per device and per browser. Clearing site data erases it. **Export a JSON backup from More > Backup regularly.** Data on the GitHub Pages URL is separate from data on localhost.

Every record carries `owner_id` and `user_id` (a local owner is created on first run).

## Moving to Supabase later
All storage goes through `js/db.js` (`window.DB`): `init, list, get, put, putMany, remove, removeWhere, exportAll, importAll, wipe`. Reimplement those against supabase-js (tables: leads, touches, appointments, suppression, users) and the UI doesn't change. Reads are currently synchronous from an in-memory cache; a Supabase version should keep a cache and sync in the background (the offline queue from the design doc).

## Files
```
index.html  manifest.webmanifest  sw.js  .nojekyll
css/style.css
js/db.js     storage layer
js/logic.js  dispositions, priority sort, stats, CSV (pure functions)
js/app.js    UI / screens
icons/       PWA icons
tests/e2e.py Playwright test on a 390px viewport (python3 tests/e2e.py)
```

## Status rules
Dispositions set lead status: Interested, Callback, Sit booked (creates an appointment), Not interested, Wrong number, Do not knock/call (adds to suppression). Not home / No answer / Voicemail / Talked mark a New lead as Contacted and keep any existing callback time. A "conversation" = Talked, Interested, Callback, Sit booked, Not interested, Do not knock/call.
