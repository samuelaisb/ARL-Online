# ARL Online — Agent Guide

This document describes how the ARL Online website is structured. **Read this before editing the codebase.** Other agents should treat it as the canonical map of the project.

## Required: update documentation after edits

**Any agent that changes how the website works must update this file (and any other affected docs) before finishing.**

When you change structure, APIs, scripts, env vars, or user-facing behavior:

1. Update the relevant sections in `AGENTS.md`.
2. If you add new directories, components, or endpoints, document them here.
3. If behavior diverges from what is written here, fix the doc — do not leave stale instructions.

If the change is trivial (typo, comment-only, dependency bump with no behavioral change), a doc update is not required.

---

## What this app does

ARL Online is a small inventory browser with an admin flow:

- **Inventory** — lists items (title, body, image, tag) loaded from the server. Filter buttons show **Equipment**, **Books**, or **Rooms** (default: equipment). Each card shows a real-time **Available**, **Check availability** (no bookable window within 7 days), or **Unavailable** badge. **Reserve Inventory** opens a modal with the reservation calendar (date-range selection persisted via API); confirming dates saves the reservation via `POST /api/inventory/:id/reservations`, which triggers Slack (optional) and Resend notification email server-side (fire-and-forget; email failure does not roll back the save).
- **Header admin** — signed-in users with an `@apathyisboring.com` email see an **Admin** control in the site header (dropdown with Add Item and remove-items list). Opens the same add-item modal; images are compressed client-side before upload.
- **Header auth** — optional Supabase email/password login and registration (Log in / Register in the site header). Session is client-side only; inventory and admin APIs are not gated on the server yet.

Admin UI is hidden unless Supabase auth is configured and the user is signed in with an `@apathyisboring.com` email (`isApathyAdmin` in `src/lib/auth.js`).

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│  Browser (Svelte 5 SPA, built by Vite → dist/)          │
│  src/App.svelte + components + lib                      │
└──────────────────────────┬──────────────────────────────┘
                           │ fetch /api/*
┌──────────────────────────▼──────────────────────────────┐
│  Express server (server.js)                               │
│  - REST API                                               │
│  - Serves dist/ (production UI)                           │
│  - Serves src/assets/fonts and brand at /assets/fonts, /assets/brand │
│  - Persists inventory to data/inventory.json              │
│  - Sends email via Resend                                 │
└─────────────────────────────────────────────────────────┘
```

**Local dev:** `npm run dev` starts both required processes so the Vite URL can load API data and server-owned assets.

| Process | Command | URL | Role |
|---------|---------|-----|------|
| Vite dev server | `npm run dev` (or `npm run dev:client`) | http://localhost:5173 | Svelte UI with HMR; proxies `/api`, `/assets/brand`, `/assets/fonts`, and `/assets/inventory` to Express |
| Express API/static server | `npm run dev` (or `npm run dev:server`) | http://localhost:3000 | Serves API routes plus static fonts, brand logos, and inventory seed assets |

In development, Express uses a strict port so Vite's proxy cannot silently point at the wrong server. `npm run dev` (via `scripts/dev.js`) automatically frees the API port before starting — manual intervention is rarely needed. For `npm run dev:server` alone, if port 3000 is already in use you must stop the old server or set `PORT`.

**Production / preview:** `npm start` rebuilds `dist/` before starting Express. Use `npm run serve` only when you intentionally want to serve the existing built files without rebuilding.

---

## Directory layout

```
ARL-Online/
├── AGENTS.md              # This file — agent-oriented project map
├── index.html             # Vite HTML entry (not served directly in prod)
├── vite.config.js         # Vite + Svelte; build outDir: dist; API/static asset proxy in dev
├── svelte.config.js       # Svelte preprocessor config
├── server.js              # Express app: API, static files, email
├── send-email.js          # Standalone Resend smoke-test script (not the web app)
├── scripts/
│   └── dev.js             # Starts Express + Vite together for npm run dev
├── package.json
├── .env.example           # Required env template (copy to .env)
├── locales/               # UI copy: en.json + fr.json (nested snake_case keys)
├── data/                  # Gitignored — inventory.json created at runtime
├── dist/                  # Gitignored — Vite production build output
├── docs/                  # Brand / design reference (not app code)
├── public/
│   └── assets/
│       └── fonts/         # Symlink → src/assets/fonts (so Vite resolves @font-face at build)
├── src/
│   ├── main.js            # Mounts App.svelte when #app exists, imports app.css
│   ├── App.svelte         # Root layout: inventory state, header admin wiring, modal
│   ├── app.css            # Global styles (fonts, layout, components)
│   ├── components/
│   │   ├── InventoryPanel.svelte   # Tag filter, grid, shared ReserveCalendarModal, availability clock
│   │   ├── InventoryCard.svelte    # Card: availability badge + Reserve button (opens panel modal)
│   │   ├── ReserveCalendarModal.svelte # Single dialog in InventoryPanel; ItemCalendar + reservation save
│   │   ├── ItemCalendar.svelte     # Month calendar: block reserved dates, create reservations
│   │   ├── AdminPanel.svelte       # Admin UI: "Add Item" button + remove-items list (header dropdown or full panel)
│   │   ├── AddItemModal.svelte     # Dialog form for new items (includes tag/category selector)
│   │   ├── AuthModal.svelte        # Login / register dialog (email + password)
│   │   ├── HeaderAuth.svelte       # Site header auth + gated admin dropdown + modal wiring
│   │   ├── LocaleSwitcher.svelte   # EN/FR toggle in site header
│   │   └── QuoteFooter.svelte      # Fixed bottom quote rotator (10s rotation, 600ms fade)
│   ├── lib/
│   │   ├── auth.js        # Supabase session store + sign-in/up/out helpers
│   │   ├── i18n.js        # Locale store + `$t()` translate function (en/fr JSON)
│   │   ├── inventory.js   # API client + legacy localStorage migration
│   │   ├── calendar.js    # Date/reservation helpers (shared by client + server.js)
│   │   ├── availability-clock.js # Shared 60s clock for badge + calendar "today"
│   │   ├── image.js       # Client-side image compression (canvas → JPEG)
│   │   └── supabase.js    # Supabase browser client (anon key)
│   └── assets/
│       ├── brand/         # Apathy is Boring + FES logos; served at /assets/brand
│       ├── fonts/         # Inter + Ringold; served at /assets/fonts
│       └── inventory/     # Seed catalog from MyTurn library; served at /assets/inventory/
│           ├── items.json # 9 items: title, body, image path, sourceId, tag
│           └── images/    # Downloaded item photos (jpg/jpeg/png)
```

There is no other `public/` content. Font files live under `src/assets/fonts/` and are symlinked at `public/assets/fonts/` so Vite can resolve them during `vite build` (avoids “didn't resolve at build time” warnings). Express still serves the canonical copies from `src/assets/fonts` at runtime.

---

## Frontend (Svelte 5)

### Entry and root

- `index.html` loads `/src/main.js`.
- `main.js` uses Svelte 5 `mount()` when `#app` exists and imports global `app.css`.
- `App.svelte` holds top-level state: `items`, `loading`, `loadError`. It loads inventory on mount and wires the site header (logo + `LocaleSwitcher` + `HeaderAuth` with admin props), inventory panel, add-item modal, fixed bottom quote footer, and fixed bottom-right FES attribution.

### Components

| Component | Responsibility |
|-----------|----------------|
| `InventoryPanel` | Tag filter buttons, loading/error/empty states, filtered card grid, single shared `ReserveCalendarModal`, and shared availability clock subscription |
| `InventoryCard` | Availability badge (**Available**, **Check availability**, **Unavailable**) and **Reserve Inventory** button; opens the panel-level modal via callback |
| `ReserveCalendarModal` | One instance in `InventoryPanel`; native `<dialog>` with `ItemCalendar`; on confirm, closes modal and signals success to the originating card |
| `ItemCalendar` | Month-view calendar; tag-specific block selection (equipment/books) or flexible range (rooms); `todayKey` refreshes via shared availability clock; POST reservation via API |
| `AdminPanel` | Add-item button, list of current items with remove buttons (confirm + DELETE API). `variant="dropdown"` for compact header menu |
| `AddItemModal` | Native `<dialog>`; form validation; tag/category radio selector; image pick + compress; POST new item. Exposes `open()` / `close()` via `export function` |
| `QuoteFooter` | Fixed site footer; rotates 10 activist quotes every 10s with fade in/out; resets index on locale change |
| `HeaderAuth` | Header Log in / Register when signed out; email, gated **Admin** dropdown, and Sign out when signed in. Admin visible only for `@apathyisboring.com` emails via `isApathyAdmin`. Hidden if Supabase env vars are missing |
| `AuthModal` | Native `<dialog>` for email/password login and registration. Exposes `open(mode)` / `close()` |
| `LocaleSwitcher` | EN/FR language toggle; persists choice in `localStorage` key `arl-locale` |

### Shared libraries

- **`src/lib/i18n.js`** — Store-based i18n (no extra dependency). Imports `locales/en.json` and `locales/fr.json`. Exports `locale` (writable store), `t` (derived translate function — use `$t('domain.key')` in templates), `translateKey()` for non-reactive scripts, and `quotes` (derived quote list). Initial locale: saved `arl-locale`, else `fr` when `navigator.language` starts with `fr`, else `en`. Updates `document.documentElement.lang` on change. Dynamic strings use `{variable}` interpolation (e.g. `$t('admin.remove_confirm', { title })`).
- **`src/lib/supabase.js`** — `createClient` wrapper; reads `SUPABASE_URL` + `SUPABASE_API` (or `VITE_` / `SUPABASE_ANON_KEY` aliases). Exports `supabaseConfigured` and `getAuthRedirectUrl()` (`SITE_URL` / `VITE_SITE_URL`, else `window.location.origin`).
- **`src/lib/auth.js`** — `session` and `authReady` Svelte stores; `initAuth`, `signInWithEmail`, `signUpWithEmail`, `signOut`, `isApathyAdmin`. `signUpWithEmail` passes `emailRedirectTo` from `getAuthRedirectUrl()`. `isApathyAdmin` returns true when the session user's email ends with `@apathyisboring.com` (case-insensitive). Subscribes to `onAuthStateChange` on first init.
- **`src/lib/inventory.js`** — `INVENTORY_TAGS`, `DEFAULT_INVENTORY_TAG`, `fetchInventory`, `createInventoryItem`, `deleteInventoryItem`, `loadInventoryItems`, `createReservation`, `deleteReservation`. Also migrates legacy items from `localStorage` key `arl-inventory-items` to the server on first load when the server inventory is empty.
- **`src/lib/calendar.js`** — `parseDateKey`, `compareDateKeys`, `hasReservationCollision`, `isCurrentlyReserved`, `hasAvailabilityWithinDays`, `getCalendarMonthGrid`, `toDateKey`, and related date helpers. Shared by `InventoryCard`, `ItemCalendar`, and `server.js`.
- **`src/lib/availability-clock.js`** — `availabilityNow` store plus ref-counted 60s interval (`subscribeAvailabilityClock` / `unsubscribeAvailabilityClock`). Used by `InventoryPanel`, `InventoryCard`, and `ItemCalendar` for badge and today highlighting.
- **`src/lib/reservation-rules.js`** — Tag-specific reservation block rules (`getBlockEndDate`, `validateReservationDates`, `isFixedBlockTag`). Shared by `ItemCalendar.svelte` and `server.js` reservation endpoints.
- **`src/lib/image.js`** — `compressImageFile(file)` — scales to max 1200px, exports JPEG at 0.8 quality as a data URL.

### Auth (Supabase)

- Client-only: `@supabase/supabase-js` in the browser; no Express middleware. **Recommended follow-up:** verify Supabase JWT on inventory/admin/reservation API routes server-side.
- `vite.config.js` sets `envPrefix: ['VITE_', 'SUPABASE_', 'SITE_']` so `.env` keys like `SUPABASE_URL`, `SUPABASE_API`, and `SITE_URL` are available to the client build.
- Enable **Email** provider in the Supabase dashboard. If email confirmation is on, registration shows a “check your email” message and the user logs in after confirming.
- Set **`SITE_URL`** to the public production origin (no trailing slash) for production Docker/Cloud builds so confirmation emails redirect there instead of localhost. Omit locally to use the current browser origin (`http://localhost:5173` in dev). The same URL must be allowed in Supabase → **Authentication** → **URL Configuration** (Site URL and Redirect URLs).
- Header auth UI is omitted entirely when URL or anon key env vars are unset. Admin controls are omitted when auth is unset, the user is signed out, or `isApathyAdmin(session)` is false.

### Styling

- Global CSS in `src/app.css` (not per-component styles).
- Fonts referenced as `/assets/fonts/...` (served by Express from `src/assets/fonts`, not bundled by Vite).
- Brand colors from `docs/Apathy_is_Boring_Brand_Guidelines.md` as CSS variables in `:root` (`--color-light`, `--color-dark`, `--color-lemon`, `--color-lavender`, `--color-plum`, `--color-mint`, `--color-pear`, `--color-grape`). White-dominant UI: white/`Light` surfaces, `Dark` text, `Lemon` primary actions, `Mint` reserve buttons. Contrast pairings follow the brand matrix (Group A backgrounds with Group B foregrounds).

### Svelte conventions in this repo

- Svelte 5 runes (`$state`, `$props`) used in components. Auth state (`session`, `authReady`) uses classic `writable` stores from `src/lib/auth.js`; `HeaderAuth.svelte` subscribes via `$session` / `$authReady`.
- Callback props instead of `createEventDispatcher` (e.g. `oncreated`, `onAddItem`).
- Modal opened via `bind:this` on `AddItemModal` and calling `addItemModal.open()`.
- `initAuth()` is called from `HeaderAuth.svelte` `onMount` (not `App.svelte`).
- `AuthModal.svelte` enforces a minimum password length of 6 client-side.
- FES attribution is an inline `<aside class="site-attribution">` in `App.svelte`, not a separate component.

---

## Backend (Express)

Single file: `server.js`.

### Static assets

- `GET /*` from `dist/` — built SPA (`index.html`, hashed JS/CSS).
- `GET /assets/fonts/*` from `src/assets/fonts/`.
- `GET /assets/brand/*` from `src/assets/brand/` (Apathy is Boring header logo, FES attribution logo).
- `GET /assets/inventory/*` from `src/assets/inventory/` (seed images and `items.json`).

### Data

- Inventory stored in `data/inventory.json` (array of items).
- Item shape: `{ id, title, body, image, createdAt, tag, reservations }`.
- `tag` is one of `equipment`, `books`, or `rooms`. Defaults to `equipment` when missing. Existing items in `data/inventory.json` are migrated to include `tag: "equipment"` on read.
- `reservations` is an array of `{ id, startDate, endDate, status }` where `startDate` / `endDate` are `YYYY-MM-DD` strings and `status` is `reserved` or `available`. New items default to `[]`. Only `reserved` entries block calendar dates and affect the availability badge.
- **Tag-specific reservation rules** (enforced in `ItemCalendar` and `POST`/`PATCH` reservation APIs via `src/lib/reservation-rules.js`; ranges are inclusive):
  - **equipment** — Start must be a **Tuesday**; end is automatically the **following Tuesday** (+7 days). One-week block; pickup/drop-off hours message shown on the calendar.
  - **books** — Start must be a **Tuesday**; end is **four weeks later** (+28 days, also a Tuesday). One-month block; same pickup/drop-off message.
  - **rooms** — Flexible inclusive range on any days (existing two-click range selection).
- Calendar UI for equipment/books: only Tuesdays are selectable; clicking a Tuesday selects the full fixed block. Equipment and books modals show localized pickup/drop-off hours (10am–5pm Tuesdays).
- `image` is either a `data:image/jpeg;base64,...` URL from the client compressor, or a path like `/assets/inventory/images/...` for seeded MyTurn items. `POST /api/inventory` rejects other image formats/paths with 400.
- Inventory read-modify-write paths are serialized via an in-process lock in `server.js` to avoid `inventory.json` races.
- Seeding runs via `ensureInventory()`, called by all inventory mutation endpoints. If `data/inventory.json` is missing or empty, 9 items from `src/assets/inventory/items.json` are written to disk before the operation proceeds.
- Seeded item IDs use the format `myturn-{sourceId}` when `sourceId` is present in the seed file.

### API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/inventory` | Returns `{ items: [...] }` |
| `POST` | `/api/inventory` | Body: `{ title, body, image, tag? }`. `image` must be JPEG data URL or `/assets/inventory/...` path. `tag` must be `equipment`, `books`, or `rooms` (defaults to `equipment`). Creates item, returns `{ item }` |
| `DELETE` | `/api/inventory/:id` | Removes item by id; returns `{ success: true }` or 404 |
| `POST` | `/api/inventory/:id/reservations` | Body: `{ startDate, endDate }` (`YYYY-MM-DD`). Validates tag-specific block rules; persists reservation; fires optional Slack webhook and Resend notification email (email failure is logged, does not fail the response); returns `{ reservation, item: { id, reservations } }`, 400 on invalid dates, or 409 on overlap |
| `PATCH` | `/api/inventory/:id/reservations/:reservationId` | Body: optional `{ startDate, endDate, status }`. Validates tag rules on update; returns `{ item, reservation }`, 400 on invalid dates, or 409 on overlap |
| `DELETE` | `/api/inventory/:id/reservations/:reservationId` | Removes reservation; returns `{ success: true, item }` |

JSON body limit: 10mb (for image data URLs).

### Email (Resend)

- `RESEND_API_KEY` is lazy-initialized: the server starts without it (logs a warning); reservation emails fail with a clear error when sent if unset.
- `EMAIL_FROM` defaults to `onboarding@resend.dev`; `RESERVE_INVENTORY_EMAIL_TO` falls back to `EMAIL_TO` (default `samuel@apathyisboring.com`). Set in `.env` for production.
- `RESERVE_INVENTORY_EMAIL_TO` falls back to `EMAIL_TO` when unset.
- Reservation emails inline-attach uploaded images when `image` is a data URL. For seed items with path-based images, an HTML link is used — these will not render inline in most email clients.

### Slack reservation webhook (optional)

When `SLACK_RESERVATION_WEBHOOK_URL` is set, a successful `POST /api/inventory/:id/reservations` POSTs text-only JSON to the Slack workflow trigger (5s fetch timeout). Failures are logged and do not block the reservation response. Configure the Slack workflow trigger to accept these variables:

| Variable | Content |
|----------|---------|
| `item_id` | Inventory item id |
| `item_title` | Item title |
| `item_body` | Item description |
| `item_tag` | `equipment`, `books`, or `rooms` |
| `reservation_id` | New reservation UUID |
| `start_date` | Reservation start (`YYYY-MM-DD`) |
| `end_date` | Reservation end (`YYYY-MM-DD`) |

User email is not sent — auth is client-only and the reservation API does not receive it.

### Server port

- Default `PORT=3000`.
- In development (`NODE_ENV=development` or `STRICT_PORT=true`), the server exits if the port is already in use so the Vite proxy target stays correct. `npm run dev` pre-clears the port automatically; `npm run dev:server` does not.
- Outside development, if the port is in use, the server tries successive ports (up to 20 attempts).

---

## Environment variables

See `.env.example`:

| Variable | Required | Purpose |
|----------|----------|---------|
| `RESEND_API_KEY` | No* | Resend API key; required for reservation emails |
| `EMAIL_FROM` | No | Sender address |
| `EMAIL_TO` | No | Default recipient |
| `RESERVE_INVENTORY_EMAIL_TO` | No | Reservation email recipient |
| `SLACK_RESERVATION_WEBHOOK_URL` | No | Slack workflow trigger URL; POST text JSON on new reservation |
| `PORT` | No | Express listen port |
| `SUPABASE_URL` | No* | Supabase project URL (client auth). Aliases: `VITE_SUPABASE_URL` |
| `SUPABASE_API` | No* | Supabase anon/public key. Aliases: `SUPABASE_ANON_KEY`, `VITE_SUPABASE_ANON_KEY` |
| `SITE_URL` | No | Public site origin for Supabase `emailRedirectTo` on sign-up. Aliases: `VITE_SITE_URL`. Baked at build time; omit in local dev to use browser origin |
| `NODE_ENV` | No | Set to `development` by `npm run dev`; enables strict port mode |
| `STRICT_PORT` | No | Set `true` to force strict port outside development |
| `VITE_API_TARGET` | No | Overrides Vite proxy target (default: `http://localhost:${PORT}`) |

\*Both `SUPABASE_URL` and anon key are required for header auth to appear; omit either to hide auth UI. \*Reservation emails require `RESEND_API_KEY` at send time.

---

## npm scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Starts Express API/static assets and Vite dev server together |
| `npm run dev:client` | Vite dev server only; requires an Express server at `VITE_API_TARGET` or `PORT` |
| `npm run dev:server` | Express API/static asset server in development mode (no build step) |
| `npm run build` | Production build to `dist/` |
| `npm start` | `build` + Express server, so source changes are reflected after restart |
| `npm run serve` | Express only; serves the existing `dist/` without rebuilding |
| `npm run preview` | Alias for `npm start` |
| `npm run send-email` | One-off Resend test via `send-email.js` |
| `npm run docker:build` | Docker image build with `SUPABASE_URL`, `SUPABASE_API`, and `SITE_URL` from `.env` as build args (`scripts/docker-build.sh`; set `IMAGE` for Artifact Registry tag) |
| `npm run cloud:build` | Build + push + deploy via Google Cloud Build (no local Docker required). Reads Supabase + `SITE_URL` from `.env`; deploys to `arl-online` in `northamerica-northeast1`. |

---

## Docker / Cloud Run

Production image: multi-stage `Dockerfile` at the repo root.

| Stage | Role |
|-------|------|
| `build` | `npm ci` + `npm run build` (Vite → `dist/`) |
| `production` | `npm ci --omit=dev`, `node server.js` (copies `src/lib/` for shared calendar/reservation helpers) |

**Build-time args** (optional — omit Supabase vars to hide header auth in the built UI):

- `SUPABASE_URL`
- `SUPABASE_API`
- `SITE_URL` — production origin for Supabase email-confirmation redirects (recommended for Cloud Run deploys)

**Runtime env** (Cloud Run / container platform):

- `RESEND_API_KEY` (required for reservation notification emails)
- `PORT` (Cloud Run sets this automatically, default `3000` locally)
- `EMAIL_FROM`, `EMAIL_TO`, `RESERVE_INVENTORY_EMAIL_TO` (optional)

**Local build and run:** `npm run docker:build` reads Supabase vars from `.env` and passes them as Docker build args. Override the tag with `IMAGE=region-docker.pkg.dev/project/repo/arl-online:latest npm run docker:build`.

```bash
docker build \
 --build-arg SUPABASE_URL=https://your-project.supabase.co \
 --build-arg SUPABASE_API=your-anon-key \
 --build-arg SITE_URL=https://arl-online-123477413804.northamerica-northeast1.run.app \
 -t arl-online .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e RESEND_API_KEY=re_xxxx \
  arl-online
```

**Cloud Run:** choose **Dockerfile** as the build type; set build args for Supabase if auth is enabled; map runtime secrets for `RESEND_API_KEY` and email vars.

**Persistence:** `data/inventory.json` lives on the container filesystem. Cloud Run disk is ephemeral — inventory resets on redeploy unless you attach a volume or move storage elsewhere.

---

## Common change patterns

| Task | Where to edit |
|------|----------------|
| New inventory field | `server.js` (`normalizeInventoryItem`), `AddItemModal.svelte`, `InventoryCard.svelte`, API client in `inventory.js` |
| Inventory tags / filter | `server.js` (`normalizeTag`, `migrateInventoryTags`), `src/assets/inventory/items.json`, `InventoryPanel.svelte`, `AddItemModal.svelte`, `src/lib/inventory.js`, `locales/en.json` + `fr.json`, styles in `app.css` |
| Reservation calendar | `server.js` (reservation endpoints), `src/lib/calendar.js`, `src/lib/reservation-rules.js`, `ItemCalendar.svelte`, `InventoryCard.svelte`, `locales/en.json` + `fr.json` |
| New page / tab | `App.svelte`, new component under `components/`, styles in `app.css` |
| New API route | `server.js`; add client function in `src/lib/` if the UI needs it |
| Email content | `server.js` reservation notification handler |
| Dev proxy | `vite.config.js` `server.proxy` |
| Auth UI / session | `HeaderAuth.svelte`, `AuthModal.svelte`, `src/lib/auth.js`, `src/lib/supabase.js` |
| User-facing copy / new language | Add matching keys to `locales/en.json` and `locales/fr.json`; use `$t('domain.key')` in components or `translateKey()` in `src/lib/` |

After any of the above, **update this file**.

---

## Related documentation

- `docs/Apathy_is_Boring_Brand_Guidelines.md` — brand/design reference (not wired into the app automatically).

---

## Changelog (agent-maintained)

Document meaningful structural changes here with date and short note.

| Date | Change |
|------|--------|
| 2026-06-11 | Initial AGENTS.md. Frontend migrated to Svelte 5 + Vite; Express serves `dist/`. |
| 2026-06-11 | Added `src/assets/inventory/` seed data (9 MyTurn library items with images and descriptions). |
| 2026-06-11 | Wired seed inventory into `GET /api/inventory`; serve images at `/assets/inventory/`. |
| 2026-06-11 | Inventory card images use a fixed frame with `object-fit: contain`; grid cards no longer stretch to row height. |
| 2026-06-11 | Fixed inventory image cropping: absolute-positioned image in frame (flex `min-height: auto` was clipping). |
| 2026-06-11 | Applied Apathy is Boring brand palette; white-dominant light UI with brand contrast pairings. |
| 2026-06-11 | Admin panel: remove-item list with confirm dialog; `DELETE /api/inventory/:id`. |
| 2026-06-11 | Inventory grid: 3 columns on viewports ≥900px; container widens to 56rem on large screens. |
| 2026-06-11 | `npm start` now rebuilds before serving; `npm run dev:server` does not rebuild. Added `npm run serve` for serving an existing build. |
| 2026-06-11 | Thin full-width site header with Apathy is Boring logo on the left; brand assets at `/assets/brand/`. |
| 2026-06-11 | Page title and heading renamed to "Activist Resource Library - Montreal". |
| 2026-06-11 | Fixed Vite font build warnings: `public/assets/fonts` symlink + Inter filename uses literal comma (quoted in CSS). |
| 2026-06-11 | Fixed bottom-right FES attribution badge with logo and “Activist Resource Library” credit text. |
| 2026-06-11 | Fixed local dev startup: `npm run dev` now starts Express + Vite together, with strict dev porting and asset/API proxy targets. |
| 2026-06-11 | Added persistent quote footer (`QuoteFooter.svelte`): 10 quotes rotate every 10s with fade transitions; FES badge sits above footer. |
| 2026-06-11 | Supabase client auth: header Log in / Register, `AuthModal`, `HeaderAuth`, `src/lib/auth.js` + `supabase.js`; `SUPABASE_URL` + `SUPABASE_API` in `.env`. |
| 2026-06-11 | `scripts/dev.js` now kills any process already holding the API port before starting, preventing the "Port in use" hard-exit on `npm run dev`. |
| 2026-06-11 | Code review: fixed `InventoryCard` "Reserving…" label stuck on success; `POST`/`DELETE` now call `ensureInventory()` to prevent seed bypass; removed dead `.panel` CSS; fixed stale server startup log. Updated AGENTS.md for doc accuracy. |
| 2026-06-11 | Added production multi-stage `Dockerfile` and `.dockerignore` for Cloud Run / container deploys. |
| 2026-06-11 | FES attribution logo links to https://www.fesplanet.org (opens in a new tab). |
| 2026-06-11 | Added `scripts/docker-build.sh` + `npm run docker:build` to bake Supabase creds from `.env` into the production Docker image. |
| 2026-06-11 | Added `cloudbuild.yaml` + `scripts/cloud-build.sh` + `npm run cloud:build` for Cloud Build deploys (no local Docker). Supabase baked in at build time; deployed to Cloud Run service `arl-online`. |
| 2026-06-11 | Supabase sign-up passes `emailRedirectTo` via `SITE_URL` / `VITE_SITE_URL` (`getAuthRedirectUrl`); Docker/Cloud Build bake `SITE_URL` for production confirmation redirects. |
| 2026-06-11 | Moved admin from main tab to header dropdown; visible only to signed-in `@apathyisboring.com` users (`isApathyAdmin`). Removed Inventory/Admin tab navigation. |
| 2026-06-11 | Added i18n: `locales/en.json` + `locales/fr.json`, `src/lib/i18n.js` store-based `$t()`, `LocaleSwitcher` in header; all UI strings extracted (domains: site, language, inventory, auth, admin, add_item, quotes). |
| 2026-06-11 | Reservation calendar: items include `reservations` array; `POST`/`DELETE` reservation APIs; `src/lib/calendar.js` + `ItemCalendar.svelte`; per-card availability badge and localized EN/FR calendar UI. |
| 2026-06-11 | Calendar moved to `ReserveCalendarModal` on Reserve Inventory click (not embedded in cards); confirm saves reservation + sends email; wider modal layout for month nav. |
| 2026-06-11 | Inventory tags: `equipment`, `books`, `rooms` on each item; filter buttons in `InventoryPanel`; tag selector in `AddItemModal`; server validation + migration of existing items to `equipment`; seed data tagged. |
| 2026-06-11 | Tag-specific reservation rules: equipment (Tue→+7d), books (Tue→+28d), rooms (flexible range); `src/lib/reservation-rules.js`; calendar UX + server validation; localized pickup/drop-off hours on equipment/books calendars. |
| 2026-06-11 | Optional `SLACK_RESERVATION_WEBHOOK_URL`: POST text-only JSON to Slack workflow trigger on successful reservation create (`POST /api/inventory/:id/reservations`). |
| 2026-06-11 | Reservation email moved server-side on `POST /api/inventory/:id/reservations` (fire-and-forget); client no longer calls `reserveInventoryItem` after save. Slim reservation response omits item image/body to avoid large-payload failures. |
| 2026-06-11 | Calendar grid: existing reservations (`status: reserved`) shown on all item tags with branded lavender cell styling and legend swatch; equipment/books mid-week reserved days no longer appear as generic blocked weekdays. |
| 2026-06-11 | Inventory badge: **Check availability** (lavender) when not reserved today but no bookable window within 7 days; `hasAvailabilityWithinDays` in `calendar.js`; EN/FR `calendar.check_availability`. |
| 2026-06-11 | Code review fixes: Dockerfile copies `src/lib/`; server imports shared `calendar.js`; in-process inventory file lock; JPEG/path image validation; removed open email relay endpoints; lazy Resend init; single `ReserveCalendarModal` + shared availability clock; package.json devDeps cleanup; assorted UX hardening (reservation copy, AuthModal password, QuoteFooter locale, main.js guard). |
