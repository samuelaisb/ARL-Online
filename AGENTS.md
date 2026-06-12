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

- **Inventory** — lists items (title, body, image, tag) loaded from the server. Filter buttons show **Equipment**, **Books**, or **Rooms** (default: equipment). Each card shows a real-time **Available**, **Check availability** (no bookable window within 7 days), or **Unavailable** badge (confirmed `reserved` only — pending requests do not mark the card unavailable). **Reserve Inventory** opens a modal with the reservation calendar when Supabase auth is configured and the user is signed in; otherwise a sign-up prompt dialog appears (Register opens the header auth modal). Confirming dates submits a **pending** reservation via `POST /api/inventory/:id/reservations` (member email derived from JWT on the server), which triggers Slack (optional) and an admin-facing Resend notification (fire-and-forget). The member sees a message that AisB will review and email confirmation. Reservation create requires a valid Supabase session (`Authorization: Bearer` JWT).
- **Header admin** — signed-in users with an `@apathyisboring.com` email see an **Admin** link in the site header that navigates to `/admin`. The admin page shows add-item, remove-items, **Pending Reservations** (approve/refuse pending requests), and **Edit Reservations** (delete approved reservations); images are compressed client-side before upload. Approve/refuse call `POST .../approve` or `POST .../refuse` and email the member via Resend. Non-admins who visit `/admin` directly see an access-denied message.
- **Header auth** — optional Supabase email/password login and registration (Log in / Register in the site header). Sign-up requires reading the member agreement (`content/contracts/{locale}/member-agreement.md`) via a lavender **Sign contract** button; agreeing sets a mint checkmark and stores `signed_member_agreement: true` in Supabase `user_metadata` on `signUp`. Mutating API routes validate the Supabase JWT server-side; admin routes also require an `@apathyisboring.com` email.

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
│  - Persists inventory + reservations to Supabase (Postgres) │
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
│   ├── dev.js             # Starts Express + Vite together for npm run dev
│   └── migrate-inventory-to-supabase.js  # Upsert data/inventory.json into Supabase
├── supabase/
│   └── migrations/
│       └── 001_inventory.sql  # inventory_items + reservations tables (apply in Supabase SQL Editor)
│       └── 002_reservation_approval.sql  # user_email + pending/reserved/refused statuses
│       └── 003_lock_down_roles.sql  # REVOKE table access from anon/authenticated roles
├── package.json
├── .env.example           # Required env template (copy to .env)
├── content/
│   └── contracts/         # Member agreement markdown per locale (`en/member-agreement.md`, etc.)
├── locales/               # UI copy: en.json + fr.json (nested snake_case keys)
├── data/                  # Gitignored — optional legacy inventory.json for one-time import
├── dist/                  # Gitignored — Vite production build output
├── docs/                  # Brand / design reference (not app code)
├── public/
│   └── assets/
│       └── fonts/         # Symlink → src/assets/fonts (so Vite resolves @font-face at build)
├── src/
│   ├── main.js            # Mounts App.svelte when #app exists, imports app.css
│   ├── App.svelte         # Root layout: routing, inventory state, header, modals
│   ├── app.css            # Global styles (fonts, layout, components)
│   ├── components/
│   │   ├── InventoryPanel.svelte   # Tag filter, grid, reserve auth gate, shared modals, availability clock
│   │   ├── InventoryCard.svelte    # Card: availability badge + Reserve button (opens panel modal)
│   │   ├── ReserveAuthRequiredModal.svelte # Dialog when signed-out user clicks Reserve (prompts sign up)
│   │   ├── ReserveCalendarModal.svelte # Single dialog in InventoryPanel; ItemCalendar + reservation save
│   │   ├── ItemCalendar.svelte     # Month calendar: block reserved dates, create reservations
│   │   ├── AdminPage.svelte        # `/admin` page shell: access gate + page header + AdminPanel
│   │   ├── AdminPanel.svelte       # Admin UI: add/remove items + edit-reservations list
│   │   ├── AddItemModal.svelte     # Dialog form for new items (includes tag/category selector)
│   │   ├── AuthModal.svelte        # Login / register dialog (email + password; register requires member agreement)
│   │   ├── MemberAgreementModal.svelte # Scrollable member contract dialog on sign-up
│   │   ├── HeaderAuth.svelte       # Site header auth + gated Admin link + modal wiring
│   │   ├── LocaleSwitcher.svelte   # EN/FR toggle in site header
│   │   └── QuoteFooter.svelte      # Fixed bottom quote rotator (10s rotation, 600ms fade)
│   ├── lib/
│   │   ├── auth.js        # Supabase session store + sign-in/up/out helpers (`signed_member_agreement` on sign-up)
│   │   ├── member-agreement.js # Loads `content/contracts/` markdown by locale; renders HTML via `marked`
│   │   ├── i18n.js        # Locale store + `$t()` translate function (en/fr JSON)
│   │   ├── inventory.js   # API client + legacy localStorage migration
│   │   ├── inventory-store.js # Supabase inventory + reservation CRUD (server)
│   │   ├── calendar.js    # Date/reservation helpers (shared by client + server.js)
│   │   ├── availability-clock.js # Shared 60s clock for badge + calendar "today"
│   │   ├── image.js       # Client-side image compression (canvas → JPEG)
│   │   ├── router.js      # Client-side path store + `navigate()` for `/` and `/admin`
│   │   ├── supabase.js    # Supabase browser client (anon key)
│   │   └── supabase-server.js # Supabase service-role client (server only)
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
- `App.svelte` holds top-level state: `items`, `loading`, `loadError`. It loads inventory on mount, routes between inventory (`/`) and admin (`/admin`) via `src/lib/router.js`, wires a lemon **PSA banner** (localized hyperlink above the header), the site header (logo + `LocaleSwitcher` + `HeaderAuth`), inventory or admin page, add-item modal, fixed bottom quote footer, and fixed bottom-right FES attribution.

### Components

| Component | Responsibility |
|-----------|----------------|
| `InventoryPanel` | Tag filter buttons with per-category item counts, skeleton loading grid, filtered equal-height card grid, shared `ReserveCalendarModal` + `ReserveAuthRequiredModal` (when Supabase auth is on and user is signed out), and shared availability clock subscription |
| `InventoryCard` | Equal-height card: clamped title/body, white image frame, availability badge (**Available**, **Check availability**, **Unavailable**), hover lift, and **Reserve Inventory** button pinned to card bottom; opens the panel-level modal via callback |
| `ReserveAuthRequiredModal` | Native `<dialog>` shown when a signed-out user clicks Reserve (Supabase configured); error message + Register (opens header `AuthModal`) and Log in link |
| `ReserveCalendarModal` | One instance in `InventoryPanel`; native `<dialog>` with `ItemCalendar`; on confirm, closes modal and signals success to the originating card |
| `ItemCalendar` | Month-view calendar; tag-specific block selection (equipment/books) or flexible range (rooms); `todayKey` refreshes via shared availability clock; POST reservation via API |
| `AdminPage` | `/admin` route: back link, access gate (auth configured, signed in, `isApathyAdmin`), page header, and `AdminPanel` |
| `AdminPanel` | Add-item, remove-item, **Pending Reservations** (approve/refuse), and edit-reservations toggle buttons; loads full inventory (including member emails) via `GET /api/admin/inventory`; remove list (confirm + `DELETE /api/inventory/:id`); pending list (approve/refuse + member email); approved reservation list (confirm + `DELETE /api/inventory/:id/reservations/:reservationId`, updates shared inventory state) |
| `AddItemModal` | Native `<dialog>`; form validation; tag/category radio selector; image pick + compress; POST new item. Exposes `open()` / `close()` via `export function` |
| `QuoteFooter` | Fixed site footer; rotates 10 activist quotes every 10s with fade in/out; resets index on locale change |
| `HeaderAuth` | Header Log in / Register when signed out; email, gated **Admin** link to `/admin`, and Sign out when signed in. Admin link visible only for `@apathyisboring.com` emails via `isApathyAdmin`. Exposes `openLogin()` / `openRegister()` for reserve auth prompt. Hidden if Supabase env vars are missing |
| `AuthModal` | Native `<dialog>` for email/password login and registration; register mode requires member agreement sign-off. Exposes `open(mode)` / `close()` |
| `MemberAgreementModal` | Scrollable member contract dialog opened from register flow; **Agree to the terms** sets signed state in parent. Exposes `open()` / `close()` |
| `LocaleSwitcher` | EN/FR language toggle; persists choice in `localStorage` key `arl-locale` |

### Shared libraries

- **`src/lib/i18n.js`** — Store-based i18n (no extra dependency). Imports `locales/en.json` and `locales/fr.json`. Exports `locale` (writable store), `t` (derived translate function — use `$t('domain.key')` in templates), `translateKey()` for non-reactive scripts, and `quotes` (derived quote list). Initial locale: saved `arl-locale`, else `fr` when `navigator.language` starts with `fr`, else `en`. Updates `document.documentElement.lang` on change. Dynamic strings use `{variable}` interpolation (e.g. `$t('admin.remove_confirm', { title })`).
- **`src/lib/image.js`** — `compressImageFile(file)` — scales to max 1200px, exports JPEG at 0.8 quality as a data URL.
- **`src/lib/auth.js`** — `session` and `authReady` Svelte stores; `initAuth`, `signInWithEmail`, `signUpWithEmail`, `signOut`, `isApathyAdmin`. `signUpWithEmail` passes `emailRedirectTo` from `getAuthRedirectUrl()` and sets `user_metadata.signed_member_agreement` when the user agrees during registration. `isApathyAdmin` returns true when the session user's email ends with `@apathyisboring.com` (case-insensitive). Subscribes to `onAuthStateChange` on first init.
- **`src/lib/member-agreement.js`** — Imports `content/contracts/{locale}/member-agreement.md` at build time; `getMemberAgreementHtml()` returns rendered HTML for the active locale (French falls back to English until `fr/` copy exists).
- **`src/lib/inventory.js`** — `INVENTORY_TAGS`, `DEFAULT_INVENTORY_TAG`, `fetchInventory`, `fetchAdminInventory`, `createInventoryItem`, `deleteInventoryItem`, `loadInventoryItems`, `createReservation`, `deleteReservation`, `approveReservation`, `refuseReservation`. Public `fetchInventory` returns reservations without `userEmail`; admin panel uses `fetchAdminInventory` (auth + admin). Mutating calls attach `Authorization: Bearer <access_token>` from the Supabase session. Also migrates legacy items from `localStorage` key `arl-inventory-items` to the server on first load when the server inventory is empty (per-item try/catch; localStorage always cleared after attempt).
- **`src/lib/calendar.js`** — `parseDateKey`, `compareDateKeys`, `hasReservationCollision`, `isCurrentlyReserved`, `hasAvailabilityWithinDays`, `getCalendarMonthGrid`, `toDateKey`, and related date helpers. `getBlockingReservations` (`pending` + `reserved`) drives calendar collision; `getConfirmedReservations` (`reserved` only) drives the unavailable badge. Shared by `InventoryCard`, `ItemCalendar`, and `server.js`.
- **`src/lib/availability-clock.js`** — `availabilityNow` store plus ref-counted 60s interval (`subscribeAvailabilityClock` / `unsubscribeAvailabilityClock`). `InventoryPanel` subscribes on mount; cards and calendar read `$availabilityNow` without subscribing directly.
- **`src/lib/reservation-rules.js`** — Tag-specific reservation block rules (`getBlockEndDate`, `validateReservationDates`, `isFixedBlockTag`). Shared by `ItemCalendar.svelte` and `server.js` reservation endpoints.
- **`src/lib/router.js`** — Writable `path` store synced to `window.location.pathname`; `navigate(to)` for client-side transitions; `isAdminRoute()`. Listens to `popstate` for back/forward.
- **`src/lib/supabase.js`** — `createClient` wrapper; reads `SUPABASE_URL` + `SUPABASE_API` from `window.__ARL_ENV__` (served by `GET /config.js` at runtime) with fallback to Vite `import.meta.env` (`VITE_SUPABASE_*` aliases). Exports `supabaseConfigured` and `getAuthRedirectUrl()` (`SITE_URL` / `VITE_SITE_URL`, else `window.location.origin`).

### Auth (Supabase)

- Browser client: `@supabase/supabase-js`. **Server:** `requireAuth` middleware validates `Authorization: Bearer <token>` via `getSupabaseAdmin().auth.getUser(token)`; `requireAdmin` requires `@apathyisboring.com` email **and** a confirmed email (`email_confirmed_at` or `confirmed_at` on the Supabase user). **Confirm email MUST stay enabled** in Supabase Auth → Providers → Email so unconfirmed accounts cannot pass `requireAdmin`. Applied to reservation create (auth only) and all inventory admin / reservation mutation routes (auth + admin).
- Production loads **`GET /config.js`** before the SPA bundle (`index.html`); Express injects public Supabase URL, anon key, and `SITE_URL` from runtime env. Vite dev proxies `/config.js` to Express; local dev still works via `.env` when the server is not running.
- `vite.config.js` sets `envPrefix: ['VITE_', 'SITE_']` so only `VITE_*` and `SITE_*` keys are exposed to the client build (prevents accidental service-role leak). Supabase public creds come from `/config.js` at runtime or `VITE_SUPABASE_*` in `.env`.
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
- `AuthModal.svelte` enforces a minimum password length of 8 client-side.
- FES attribution is an inline `<aside class="site-attribution">` in `App.svelte`, not a separate component.

---

## Backend (Express)

Single file: `server.js`. Uses `helmet` for security headers (CSP with `connect-src` including `SUPABASE_URL`), `app.set('trust proxy', 1)` for correct rate limiting behind Cloud Run, and admin audit logging (`[admin-audit]` console lines on every admin mutation).

### Static assets

- `GET /config.js` — runtime public client config (`window.__ARL_ENV__`: `SUPABASE_URL`, `SUPABASE_API`, `SITE_URL`); `Cache-Control: no-store`.
- `GET /*` from `dist/` — built SPA (`index.html`, hashed JS/CSS). Unknown GET paths fall through to `index.html` for client routes such as `/admin`.
- `GET /assets/fonts/*` from `src/assets/fonts/`.
- `GET /assets/brand/*` from `src/assets/brand/` (Apathy is Boring header logo, FES attribution logo).
- `GET /assets/inventory/*` from `src/assets/inventory/` (seed images and `items.json`).

### Data

- Inventory and reservations persist in **Supabase Postgres** via `src/lib/inventory-store.js` (service role key on the server). Apply `supabase/migrations/001_inventory.sql`, `002_reservation_approval.sql`, and `003_lock_down_roles.sql` before first run (or after deploy if upgrading).
- Tables: `inventory_items` (`id`, `title`, `body`, `image`, `tag`, `created_at`) and `reservations` (`id`, `item_id`, `start_date`, `end_date`, `status`, `user_email`). RLS is enabled with no public policies — Express uses the service role (bypasses RLS). Migration `003_lock_down_roles.sql` revokes direct `SELECT`/`INSERT`/`UPDATE`/`DELETE` on both tables from `anon` and `authenticated` roles (defense in depth).
- **Public** API item shape (`GET /api/inventory`): `{ id, title, body, image, createdAt, tag, reservations }` where `reservations` is `{ id, startDate, endDate, status }[]` — **`userEmail` is never returned on public routes**. Admin route `GET /api/admin/inventory` returns full items including `userEmail` on reservations.
- `status` on reservations: `pending` (new member request), `reserved` (admin-approved), `refused` (admin declined — dates freed), or legacy `available`. New creates always use `pending` with member email from JWT.
- `pending` and `reserved` block calendar dates; only `reserved` marks the card **Unavailable** badge.
- **Tag-specific reservation rules** (enforced in `ItemCalendar` and `POST`/`PATCH` reservation APIs via `src/lib/reservation-rules.js`; ranges are inclusive):
  - **equipment** — Start must be a **Tuesday**; end is automatically the **following Tuesday** (+7 days). One-week block; pickup/drop-off hours message shown on the calendar.
  - **books** — Start must be a **Tuesday**; end is **four weeks later** (+28 days, also a Tuesday). One-month block; same pickup/drop-off message.
  - **rooms** — Flexible inclusive range on any days (existing two-click range selection).
- Calendar UI for equipment/books: only Tuesdays are selectable; clicking a Tuesday selects the full fixed block. Equipment and books modals show localized pickup/drop-off hours (10am–5pm Tuesdays).
- `image` is either a `data:image/jpeg;base64,...` URL from the client compressor, or a path like `/assets/inventory/images/...` for seeded MyTurn items. `POST /api/inventory` rejects other image formats/paths with 400.
- Seeding runs via `ensureInventory()` in `inventory-store.js` (no-op after first successful seed via `inventorySeeded` flag). If the DB is empty: import `data/inventory.json` when present, else insert 9 seed items from `src/assets/inventory/items.json`.
- `addReservation` and `approveReservation` use an in-process per-item lock around collision-check + write (single Cloud Run instance only; not safe across replicas).
- Seeded item IDs use the format `myturn-{sourceId}` when `sourceId` is present in the seed file.
- One-time upsert from legacy JSON: `npm run migrate:inventory` (or rely on auto-import when the DB is empty on first `GET /api/inventory`).

### API endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/inventory` | — | Returns `{ items: [...] }` with reservations sanitized (no `userEmail`; `Cache-Control: no-store`) |
| `GET` | `/api/admin/inventory` | Admin | Returns full `{ items: [...] }` including `userEmail` on reservations for admin UI |
| `POST` | `/api/inventory` | Admin | Body: `{ title, body, image, tag? }`. Creates item, returns `{ item }` (10mb JSON limit on this route only) |
| `DELETE` | `/api/inventory/:id` | Admin | Removes item by id; returns `{ success: true }` or 404 |
| `POST` | `/api/inventory/:id/reservations` | User | Body: `{ startDate, endDate }`. Member email from JWT; creates `status: pending`; IP rate-limited (30/15min); max 5 pending reservations per user (429); returns sanitized `{ reservation, item }`, 401/400/409 as applicable |
| `POST` | `/api/inventory/:id/reservations/:reservationId/approve` | Admin | Pending → `reserved`; member approval email via Resend |
| `POST` | `/api/inventory/:id/reservations/:reservationId/refuse` | Admin | Pending → `refused`; member refusal email via Resend |
| `PATCH` | `/api/inventory/:id/reservations/:reservationId` | Admin | Body: optional `{ startDate, endDate, status }` (`pending`/`reserved`/`refused` only); 400 on invalid status |
| `DELETE` | `/api/inventory/:id/reservations/:reservationId` | Admin | Removes reservation; returns `{ success: true, item }` |

JSON body limit: **100kb** default; **10mb** on `POST /api/inventory` only (image data URLs).

### Email (Resend)

- `RESEND_API_KEY` is lazy-initialized: the server starts without it (logs a warning); reservation emails fail with a clear error when sent if unset.
- Admin notification on new pending request → `RESERVE_INVENTORY_EMAIL_TO`. Member approval/refusal emails → reservation `userEmail` (skipped with log if missing).
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
| `status` | `pending` on create |
| `user_email` | Member email from JWT |

Mutating routes return 401 without a valid JWT and 403 when admin is required but the email is not `@apathyisboring.com` or the admin email is not confirmed.

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
| `SUPABASE_URL` | Yes* | Supabase project URL (client auth + server). Aliases: `VITE_SUPABASE_URL` |
| `SUPABASE_API` | No* | Supabase anon/public key (client auth). Aliases: `SUPABASE_ANON_KEY`, `VITE_SUPABASE_ANON_KEY` |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes* | Server-only service role for inventory/reservations. Never expose to Vite/build args |
| `SITE_URL` | No | Public site origin for Supabase `emailRedirectTo` on sign-up. Aliases: `VITE_SITE_URL`. Baked at build time; omit in local dev to use browser origin |
| `NODE_ENV` | No | Set to `development` by `npm run dev`; enables strict port mode |
| `STRICT_PORT` | No | Set `true` to force strict port outside development |
| `VITE_API_TARGET` | No | Overrides Vite proxy target (default: `http://localhost:${PORT}`) |

\*Both `SUPABASE_URL` and anon key are required for header auth to appear; omit either to hide auth UI. \*`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are required for the Express server (inventory). \*Reservation emails require `RESEND_API_KEY` at send time.

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
| `npm run cloud:build` | Build + push + deploy via Google Cloud Build (no local Docker required). Reads Supabase + `SITE_URL` from `.env` (default production URL `https://activistresourcelibrary.com`); deploys to `arl-online` in `us-east1`. Images push to Artifact Registry in `us-east1` (`GCP_ARTIFACT_REGION`). Sets runtime env on Cloud Run (`SITE_URL`, optional `EMAIL_*`, `SLACK_RESERVATION_WEBHOOK_URL`); mounts `SUPABASE_SERVICE_ROLE_KEY` and `RESEND_API_KEY` from Google Secret Manager via `--set-secrets` (see comment block in `scripts/cloud-build.sh`). |
| `npm run migrate:inventory` | Upsert `data/inventory.json` into Supabase (`inventory_items` + `reservations`) |

---

## Docker / Cloud Run

Production image: multi-stage `Dockerfile` at the repo root.

| Stage | Role |
|-------|------|
| `build` | `npm ci` + `npm run build` (Vite → `dist/`; copies `locales/` + `content/contracts/` for i18n and member agreement imports) |
| `production` | `npm ci --omit=dev`, `node server.js` (copies `src/lib/` for shared calendar/reservation helpers) |

**Build-time args** (optional fallback — client auth primarily uses runtime `/config.js`):

- `SUPABASE_URL` / `VITE_SUPABASE_URL`
- `SUPABASE_API` / `VITE_SUPABASE_ANON_KEY`
- `SITE_URL` / `VITE_SITE_URL` — production origin for Supabase email-confirmation redirects (recommended for Cloud Run deploys)

**Runtime env** (Cloud Run / container platform):

- `SUPABASE_URL`, `SUPABASE_API` (required — client auth via `/config.js` + inventory storage)
- `SUPABASE_SERVICE_ROLE_KEY` (required — inventory storage; **Cloud Run deploy via `npm run cloud:build` mounts from Secret Manager**, not plain env vars)
- `SITE_URL` (recommended — email confirmation redirects)
- `RESEND_API_KEY` (required for reservation notification emails; **Secret Manager on Cloud Run** when set in `.env` during deploy)
- `PORT` (Cloud Run sets this automatically, default `3000` locally)
- `EMAIL_FROM`, `EMAIL_TO`, `RESERVE_INVENTORY_EMAIL_TO` (optional)

**Secret Manager (Cloud Run):** Before first `npm run cloud:build` deploy with secrets, create `supabase-service-role-key` and optionally `resend-api-key` secrets and grant the Cloud Run service account `secretAccessor`. One-time `gcloud` commands are documented in the comment block at the top of `scripts/cloud-build.sh`.

**Local build and run:** `npm run docker:build` reads Supabase vars from `.env` and passes them as Docker build args. Override the tag with `IMAGE=region-docker.pkg.dev/project/repo/arl-online:latest npm run docker:build`.

```bash
docker build \
 --build-arg SUPABASE_URL=https://your-project.supabase.co \
 --build-arg SUPABASE_API=your-anon-key \
 --build-arg SITE_URL=https://activistresourcelibrary.com \
 -t arl-online .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SUPABASE_URL=https://your-project.supabase.co \
  -e SUPABASE_API=your-anon-key \
  -e SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
  -e RESEND_API_KEY=re_xxxx \
  arl-online
```

**Cloud Run:** choose **Dockerfile** as the build type; pass build args for Supabase if auth is enabled (or rely on runtime `/config.js`); map runtime env for `SUPABASE_URL`, `SUPABASE_API`, email vars; mount `SUPABASE_SERVICE_ROLE_KEY` and `RESEND_API_KEY` via Secret Manager (see `scripts/cloud-build.sh`).

**Persistence:** Inventory and reservations live in Supabase Postgres. Apply `supabase/migrations/001_inventory.sql`, `002_reservation_approval.sql`, and `003_lock_down_roles.sql` to your project before deploying.

---

## Common change patterns

| Task | Where to edit |
|------|----------------|
| New inventory field | `src/lib/inventory-store.js`, `AddItemModal.svelte`, `InventoryCard.svelte`, API client in `inventory.js`, SQL migration if needed |
| Inventory tags / filter | `inventory-store.js`, `src/assets/inventory/items.json`, `InventoryPanel.svelte`, `AddItemModal.svelte`, `src/lib/inventory.js`, `locales/en.json` + `fr.json`, styles in `app.css` |
| Reservation calendar | `server.js` (reservation endpoints), `inventory-store.js`, `src/lib/calendar.js`, `src/lib/reservation-rules.js`, `ItemCalendar.svelte`, `InventoryCard.svelte`, `locales/en.json` + `fr.json` |
| New page / tab | `App.svelte`, `src/lib/router.js`, new component under `components/`, styles in `app.css`; add SPA fallback in `server.js` if using a new path |
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
| 2026-06-11 | Fixed two broken features: (1) Reserved calendar cells hidden by global `button:disabled { opacity: 0.6 }` — added `.item-calendar__day--reserved:disabled { opacity: 1 }` override in `app.css`. (2) "Check availability" badge reactivity: `InventoryCard` now calls `subscribeAvailabilityClock()` on mount and uses explicit `$derived` snapshots for `reservations`/`itemTag`; `ItemCalendar` uses `itemReservations` derived const for all reservation lookups. |
| 2026-06-11 | Code review fixes: Dockerfile copies `src/lib/`; server imports shared `calendar.js`; in-process inventory file lock; JPEG/path image validation; removed open email relay endpoints; lazy Resend init; single `ReserveCalendarModal` + shared availability clock; package.json devDeps cleanup; assorted UX hardening (reservation copy, AuthModal password, QuoteFooter locale, main.js guard). |
| 2026-06-11 | Fixed Docker/Cloud Build: `Dockerfile` build stage now copies `locales/` (required by `src/lib/i18n.js` during `vite build`). |
| 2026-06-11 | Inventory + reservations migrated from `data/inventory.json` to Supabase Postgres (`inventory_items`, `reservations`); `src/lib/inventory-store.js` + `src/lib/supabase-server.js`; SQL in `supabase/migrations/001_inventory.sql`; `npm run migrate:inventory` for legacy JSON upsert; Cloud Run deploy sets `SUPABASE_SERVICE_ROLE_KEY`. |
| 2026-06-12 | Supabase migration: `GRANT ALL` on `inventory_items` and `reservations` to `service_role` (fixes 403 permission denied when tables were created without role grants). |
| 2026-06-12 | Reserve flow gated on client when Supabase auth is configured: signed-out users see `ReserveAuthRequiredModal` with sign-up prompt; Register/Log in open header `AuthModal`. |
| 2026-06-12 | Cloud Run auth fix: `GET /config.js` serves Supabase URL + anon key from runtime env; `cloud-build.sh` deploy sets `SUPABASE_API`; Docker/Cloud Build also pass `VITE_*` build args. |
| 2026-06-12 | Favicon uses the Apathy is Boring header logo (`/assets/brand/apathy-is-boring-logo.png`) via `index.html`. |
| 2026-06-12 | Admin panel: remove-items list hidden behind **Remove Item** toggle button (mirrors **Add Item**). |
| 2026-06-12 | Admin moved from header dropdown to dedicated `/admin` page (`AdminPage.svelte`, `src/lib/router.js`); header shows Admin link only for signed-in `@apathyisboring.com` users; direct visits show access-denied states; Express serves `index.html` for unknown GET paths. |
| 2026-06-12 | Admin panel: **Edit Reservations** toggle lists active reservations with delete actions; deletes persist via Supabase and refresh shared inventory state. |
| 2026-06-12 | Admin page heading updated to personalized welcome copy (`admin.heading` in EN/FR locales). |
| 2026-06-12 | Add Item modal: category selector uses the same toggle buttons as inventory filters (Equipment / Books / Rooms). |
| 2026-06-12 | Lemon PSA banner above site header: localized EN/FR copy + outbound links (`site.psa_text` / `site.psa_link` in locales). |
| 2026-06-12 | Sign-up member agreement: `MemberAgreementModal`, lavender **Sign contract** button, agree gate + mint checkmark; `signed_member_agreement` stored in Supabase `user_metadata`; contracts in `content/contracts/`. |
| 2026-06-12 | Reservation approval workflow: new creates `status: pending` with optional `userEmail`; admin **Pending Reservations** approve/refuse; member approval/refusal emails via Resend; `002_reservation_approval.sql` migration; `pending`+`reserved` block calendar, badge uses `reserved` only. |
| 2026-06-12 | Renamed admin UI copy from **Pending Reviews** to **Pending Reservations** (EN/FR locales + admin notification email). |
| 2026-06-12 | Code review hardening: server-side JWT auth (`requireAuth`/`requireAdmin`) on mutating API routes; member email from JWT not client body; `express-rate-limit` on reservation POST (30/15min); client `Authorization` header on mutating fetches; in-process per-item reservation lock; `ensureInventory` seed flag; assorted fixes (JPEG regex, marked v18, PATCH status validation, availability clock dedup, vite envPrefix narrowed, `Cache-Control: no-store` on inventory GET). |
| 2026-06-12 | `.env.example`: clarified Supabase vars are served via `/config.js`; documented optional `VITE_SUPABASE_*` aliases for build-time / Vite-only dev. |
| 2026-06-12 | Inventory card descriptions wrap long URLs and unbroken strings (`overflow-wrap: break-word` on `.inventory-content p`). |
| 2026-06-12 | Cybersecurity hardening: public inventory/reservation responses strip `userEmail`; new `GET /api/admin/inventory` for admin UI; `requireAdmin` requires confirmed email; `trust proxy` + per-user pending reservation cap (5); scoped JSON body limits; `helmet` CSP; Cloud Run secrets via Secret Manager; `003_lock_down_roles.sql`; admin audit logs; min password 8; removed legacy `available` from PATCH statuses. |
| 2026-06-12 | Inventory page visual polish: equal-height cards with bottom-aligned Reserve buttons, title/body line clamps, white image frames, card hover lift, skeleton loading grid, filter counts, visually hidden inventory heading, plum unavailable badge, extra mobile bottom padding for FES attribution. |
| 2026-06-12 | Production deploy defaults: Cloud Run `arl-online` in `us-east1` (`https://activistresourcelibrary.com`); Artifact Registry `us-east1`; `SITE_URL` always set on deploy from `.env` or default. |
| 2026-06-12 | Cloud Run deploy passes `EMAIL_*` and `SLACK_RESERVATION_WEBHOOK_URL` from `.env`; admin notification emails use absolute image URLs via `SITE_URL`. |
