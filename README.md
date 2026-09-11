# SafeRoute AI

SafeRoute AI is a static web prototype for **context-aware travel safety**. It helps a traveler choose a safer route (not just the fastest one) by factoring in time of day, battery level, offline availability, nearby emergency services, and a trusted-guardian last-known-location safety net.

> ⚠️ This is a prototype/demo built for a hackathon ("Vibeathon"). Demo data such as safety scores is simulated, and the guardian SMS feature is a client-side demonstration only. See [Limitations](#limitations-of-automatic-guardian-sms) below before relying on this for real safety needs.

## 1. Project Purpose

Standard navigation apps optimize for speed or distance. SafeRoute AI explores a different question: *what would a route recommendation look like if it also weighed lighting, transit access, accessibility, and community safety signals — while still working when connectivity or battery is limited?*

The site is aimed at travelers (particularly women and solo travelers) who want:
- A quick, context-aware route suggestion instead of just the shortest path.
- Visibility into nearby emergency services at all times.
- A safety net that keeps working even with poor connectivity or low battery.
- A simple way to let a trusted contact know their last known location if something goes wrong.

## 2. Features

- **Live interactive map with best-route selection** — powered by [Leaflet](https://leafletjs.com/) + OpenStreetMap tiles. When you set a From/To (typed address or "Current location") and tap **Recommend best route**, the app geocodes both points, fetches multiple possible routes, scores them with the context-aware heuristic (distance + turn count + day/after-dark weighting), and draws all options on the map — the recommended route in solid pink, other options in dashed grey. The map, ETA, and offline text directions all update together whenever the location changes.
- **Context-aware route recommendation** — choose "Day," "After dark," or "Event" context; the app adjusts its relative safety score, route notes, and which route option is chosen accordingly.
- **Current-location detection** — uses the browser Geolocation API to fill in the "From"/"To" fields and to power nearby-help lookups.
- **Nearby police & hospital lookup** — queries OpenStreetMap's Overpass API for the nearest police station and hospital around the user's coordinates, with distance calculated via the haversine formula. Falls back to an offline/demo message if the lookup fails.
- **Safety score breakdown** — a visual score (lighting, transit, accessibility, community signals) for the recommended route.
- **Offline route text** — saves a plain-text, turn-by-turn route summary to `localStorage` so it remains usable without an internet connection.
- **Low-battery mode** — a toggle that reduces geolocation refresh frequency/accuracy and switches messaging to a text-first, lower-power experience.
- **Emergency access** — a persistent, always-visible emergency panel with one-tap `tel:112` calling and a `tel:181` Women Helpline link.
- **Trusted Guardian / last-known-location alert** — an opt-in feature where the user names a guardian and phone number. SafeRoute records the last known GPS coordinates in `localStorage` and can prepare an SMS (via the device's native SMS app) containing a Google Maps link to that last known location, along with a timestamp. It also reacts to the browser's online/offline events to surface guardian-relevant status messages.
- **Online/offline status indicator** in the navigation bar.
- **Responsive layout** for mobile and desktop, with a PWA-style `manifest.json` for "add to home screen" support.

All of the above features from the original prototype have been preserved — no functionality was removed. The live map and routing were added on top of the existing behavior; if the routing/geocoding services are unreachable (offline, blocked, rate-limited), the app automatically falls back to the original simulated text-only recommendation so the site still works.

**Services used for the map (no API key required, but rate-limited public demo endpoints):**
- Map tiles: OpenStreetMap tile servers.
- Geocoding (turning typed addresses into coordinates): [Nominatim](https://nominatim.org/) public API.
- Routing (turn-by-turn walking directions and alternatives): the OpenStreetMap.de public [OSRM](https://project-osrm.org/) "routed-foot" demo server.

These are free public demo services intended for light, occasional use — see [Limitations](#limitations-of-automatic-guardian-sms) and the note below on production readiness.

## 3. How to Run Locally

This is a static site with no build step and no dependencies, so any local static file server works.

**Option A — just open the file:**
```bash
open index.html   # macOS
# or double-click index.html in your file explorer
```
Note: some browsers restrict Geolocation and other APIs on the `file://` protocol, so a local server (Option B) is recommended for full functionality.

**Option B — Python's built-in server:**
```bash
cd saferoute-ai
python3 -m http.server 8000
```
Then visit `http://localhost:8000` in your browser.

**Option C — Node's `http-server` (if you have Node.js installed):**
```bash
cd saferoute-ai
npx http-server -p 8000
```
Then visit `http://localhost:8000`.

Browser permission prompts for Geolocation should be accepted to test the "Current location," nearby-help, and guardian last-known-location features.

## 4. How to Deploy on GitHub Pages

1. Create a new GitHub repository named `saferoute-ai` (or push this folder's contents into an existing repo).
2. Push all files in this repository to the `main` branch:
   ```bash
   git init
   git add .
   git commit -m "Initial commit: SafeRoute AI static site"
   git branch -M main
   git remote add origin https://github.com/<your-username>/saferoute-ai.git
   git push -u origin main
   ```
3. In your GitHub repository, go to **Settings → Pages**.
4. Under **Build and deployment → Source**, select **Deploy from a branch**.
5. Choose the **`main`** branch and the **`/ (root)`** folder, then click **Save**.
6. GitHub will publish the site at:
   ```
   https://<your-username>.github.io/saferoute-ai/
   ```
   (It may take a minute or two for the first deployment to go live.)

The included `.nojekyll` file tells GitHub Pages to skip Jekyll processing, which ensures all files (including any starting with an underscore, and this project's structure) are served as-is.

No further configuration, build step, or server-side code is required — the entire app is a single static `index.html` plus `manifest.json`.

## 5. Limitations of the Live Map & Route Recommendation

- **Public demo services, not production infrastructure.** Geocoding (Nominatim) and routing (OSRM "routed-foot" demo) are free, keyless public endpoints meant for light/occasional use. They are rate-limited and can be slow or briefly unavailable — this is expected behavior for a static, no-backend prototype, not a bug.
- **"Safety" scoring is a heuristic, not real safety data.** The app does not have access to real lighting, crime, or crowd-density data. The route score is calculated from distance and estimated turn count, with a configurable bias toward shorter/simpler routes when "After dark" is selected. It is a stand-in for what a real implementation would compute from verified safety datasets.
- **Walking directions only.** The routing profile used is pedestrian ("foot"), matching the product's focus on personal safety while walking; it is not meant for driving directions.
- **Graceful fallback.** If geocoding or routing fails (no internet, service downtime, an address that can't be resolved), the app automatically reverts to the original simulated route summary so the rest of the site (offline text route, emergency features, guardian alerts) keeps working.
- **For production use**, replace the demo geocoding/routing endpoints with a paid or self-hosted provider (e.g., Mapbox, Google Maps Platform, OpenRouteService, or a self-hosted OSRM/Valhalla instance) with proper API keys and rate limits, and feed the safety score from a real lighting/incident/community-reports dataset instead of the current heuristic.

## 6. Limitations of Automatic Guardian SMS

The Trusted Guardian feature is intentionally scoped as a **client-side demo** and has important limitations that should be understood before relying on it:

- **No automatic sending.** GitHub Pages hosts static files only; there is no backend server. The app cannot silently send an SMS on your behalf when your device goes offline — a phone has no way to run background code once a browser tab is closed or the device loses signal.
- **"Prepare guardian SMS" opens your device's SMS app.** Clicking this button pre-fills a text message (with your last known coordinates and a timestamp) using the `sms:` URI scheme, but a human still has to be present to tap "Send" in their native Messages app. This requires the device to still have connectivity, battery, and an active browser session at that moment.
- **Offline/online detection is best-effort.** The app listens for the browser's `online`/`offline` events to display status messages (e.g., "Device offline — last known location recorded at..."), but this only reflects network reachability *as reported by the browser*, not GPS signal loss, app termination, or the device being powered off.
- **Location is "last known," not live.** The guardian message explicitly states this is the last verified location, not a live/real-time location, since the prototype does not run continuous background tracking.
- **Data stays in the browser.** Guardian name/phone and last known coordinates are stored in `localStorage` on the user's own device only. They are not transmitted to any server, which means there is no way to trigger a real notification if the device is lost, destroyed, or its browser data is cleared.
- **For production use**, a real implementation would need: an authenticated backend, a registered SMS/notification provider (e.g., Twilio, an SMS gateway, or push notifications), a persistent background service or native mobile app (rather than a browser tab) to detect connectivity loss, and explicit user consent/compliance handling for storing and transmitting a guardian's contact information and someone's location data.

---

*Emergency numbers (112, Women Helpline 181) are shown based on publicly available Indian government information. Actual call functionality depends on the browser and device supporting the `tel:` URI scheme.*
