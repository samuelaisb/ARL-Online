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

- **Inventory** — lists items (title, body, image, tag) loaded from the server. Filter buttons show **Equipment**, **Books**, or **Rooms** (default: equipment). Each card shows a real-time **Available**, **Check availability** (no bookable window within 7 days), or **Unavailable** badge (confirmed `reserved` only — pending requests do not mark the card unavailable). Clicking a card title or **Reserve Inventory** updates the browser URL to `/{tag}/{slug}` (Reserve adds `?reserve=1`) while keeping the inventory grid mounted; `ItemDetailPage` renders the item as a modal **overlay** (`<dialog>`) on top of the grid (it is no longer a full-page route). The overlay uses a three-column layout (image | description | calendar); availability status appears inline in the breadcrumb after the item title; the calendar is always visible in the right column. Signed-out users who confirm a reservation or arrive via `?reserve=1` see a sign-up prompt dialog (Register opens the header auth modal). `?reserve=1` scrolls/highlights the calendar column for signed-in users. Closing the overlay (X, Escape, backdrop click, or browser Back) returns to the underlying inventory/category path; deep links / refreshes on `/{tag}/{slug}` render the matching category grid with the overlay open on top. Confirming dates submits a **pending** reservation via `POST /api/inventory/:id/reservations` (member email derived from JWT on the server), which triggers Slack (optional) and an admin-facing Resend notification (fire-and-forget). The member sees a message that AisB will review and email confirmation. Reservation create requires a valid Supabase session (`Authorization: Bearer` JWT). Cancelling the auth prompt removes `?reserve=1` via `history.replaceState`.
- **Header admin** — signed-in `@apathyisboring.com` admins reach `/admin` via the **Admin** link on the `/account` page (not the site header). The admin page shows add-item, remove-items, **Pending Reservations** (approve/refuse pending requests), and **Edit Reservations** (delete approved reservations); images are compressed client-side before upload. Approve/refuse call `POST .../approve` or `POST .../refuse` and email the member via Resend. Non-admins who visit `/admin` directly see an access-denied message.
- **Header auth** — optional Supabase email/password login and registration (Log in / Register in the site header when signed out; **View account** + **Sign out** when signed in — Sign out triggers Kimchi `kimchi.signed_out`). **View account** navigates to `/account`. Sign-up requires reading the member agreement (`content/contracts/{locale}/member-agreement.md`) via a lavender **Sign contract** button; agreeing sets a mint checkmark and stores `signed_member_agreement: true` in Supabase `user_metadata` on `signUp`. Register also includes an optional unchecked **email updates** checkbox; the choice is stored as `email_updates_opt_in` in `user_metadata`. Mutating API routes validate the Supabase JWT server-side; admin routes also require an `@apathyisboring.com` email.

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
| Vite dev server | `npm run dev` (or `npm run dev:client`) | http://localhost:5173 | Svelte UI with HMR; proxies `/api`, `/assets/brand`, `/assets/fonts`, `/assets/inventory`, `/robots.txt`, and `/sitemap.xml` to Express |
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
│   ├── prerender.js       # Post-build static HTML shells for category/marketing routes (Tier 2 SEO)
│   ├── migrate-inventory-to-supabase.js  # Upsert data/inventory.json into Supabase (with slug generation)
│   └── backfill-slugs.js  # Populate null/empty slugs on existing inventory_items rows (idempotent)
├── supabase/
│   └── migrations/
│       └── 001_inventory.sql  # inventory_items + reservations tables (apply in Supabase SQL Editor)
│       └── 002_reservation_approval.sql  # user_email + pending/reserved/refused statuses
│       └── 003_lock_down_roles.sql  # REVOKE table access from anon/authenticated roles
│       └── 004_inventory_slug.sql   # slug column + unique (tag, slug) index for item detail URLs
├── package.json
├── .env.example           # Required env template (copy to .env)
├── content/
│   └── contracts/         # Member agreement markdown per locale (`en/member-agreement.md`, etc.)
├── locales/               # UI copy: en.json + fr.json (nested snake_case keys)
├── data/                  # Gitignored — optional legacy inventory.json for one-time import
├── dist/                  # Gitignored — Vite production build output
├── docs/                  # Brand / design reference (not app code)
├── public/
│   ├── robots.txt         # Crawler rules + sitemap URL (copied to dist/ at build)
│   └── assets/
│       └── fonts/         # Symlink → src/assets/fonts (so Vite resolves @font-face at build)
├── src/
│   ├── main.js            # Mounts App.svelte when #app exists, imports app.css
│   ├── App.svelte         # Root layout: routing, inventory state, header, modals
│   ├── app.css            # Global styles (fonts, layout, components)
│   ├── components/
│   │   ├── InventoryPanel.svelte   # Tag filter, grid, reserve auth gate, shared modals, availability clock
│   │   ├── InventoryCard.svelte    # Card: title links to /{tag}/{slug}; availability badge + Reserve button
│   │   ├── ItemDetailPage.svelte   # /{tag}/{slug} item overlay (`<dialog>`): breadcrumb, 3-col grid (image | description | calendar), auth gate; rendered on top of the grid
│   │   ├── ReserveAuthRequiredModal.svelte # Dialog when signed-out user clicks Reserve (prompts sign up)
│   │   ├── ItemCalendar.svelte     # Month calendar: block reserved dates, create reservations
│   │   ├── AdminPage.svelte        # `/admin` page shell: access gate + page header + AdminPanel
│   │   ├── AccountPage.svelte      # `/account` page: member email, sign out, admin link for admins
│   │   ├── AdminPanel.svelte       # Admin UI: add/remove items + edit-reservations list
│   │   ├── AddItemModal.svelte     # Dialog form for new items (includes tag/category selector)
│   │   ├── AuthModal.svelte        # Login / register dialog (email + password; register requires member agreement + optional email-updates opt-in)
│   │   ├── MemberAgreementModal.svelte # Scrollable member contract dialog on sign-up
│   │   ├── SiteNav.svelte          # Header nav: Inventory + How it works (client-side routing)
│   │   ├── HowThisWorksPage.svelte # `/howthisworks` guide: browse, account, reserve, approval, pickup
│   │   ├── HeaderAuth.svelte       # Site header auth: Log in / Register or View account + Sign out + modal wiring
│   │   ├── LocaleSwitcher.svelte   # EN/FR toggle in site header
│   │   ├── KimchiNotification.svelte # Bottom-right Kimchi widget shell: avatar + stacked bubbles
│   │   ├── KimchiBubble.svelte       # Single Kimchi chat bubble (pop-in, 350ms fade-out, auto-dismiss)
│   │   └── QuoteFooter.svelte      # Fixed bottom quote rotator (10s rotation, 600ms fade)
│   ├── lib/
│   │   ├── auth.js        # Supabase session store + sign-in/up/out helpers (`signed_member_agreement`, `email_updates_opt_in` on sign-up)
│   │   ├── member-agreement.js # Loads `content/contracts/` markdown by locale; renders HTML via `marked`
│   │   ├── i18n.js        # Locale store + `$t()` translate function (en/fr JSON)
│   │   ├── inventory.js   # API client + legacy localStorage migration
│   │   ├── inventory-store.js # Supabase inventory + reservation CRUD (server)
│   │   ├── calendar.js    # Date/reservation helpers (shared by client + server.js)
│   │   ├── availability-clock.js # Shared 60s clock for badge + calendar "today"
│   │   ├── image.js       # Client-side image compression (canvas → JPEG)
│   │   ├── notification-store.js # Queue store + `notify()` API for Kimchi chat-bubble notifications
│   │   ├── router.js      # Client-side routing: inventory, item detail /{tag}/{slug}, admin, static pages
│   │   ├── seo.js         # Client SEO: meta/OG/Twitter/canonical/hreflang/JSON-LD + per-item Product schema
│   │   ├── seo-server.js  # Async server HTML injection for crawlers (item lookup by slug)
│   │   ├── slug.js        # slugifyTitle() + ensureUniqueSlug() for immutable per-tag item URLs
│   │   ├── supabase.js    # Supabase browser client (anon key)
│   │   └── supabase-server.js # Supabase service-role client (server only)
│   └── assets/
│       ├── brand/         # Apathy is Boring + FES logos; served at /assets/brand
│       ├── fonts/         # Inter + Ringold; served at /assets/fonts
│       └── inventory/     # Seed catalog from MyTurn library; served at /assets/inventory/
│           ├── items.json # 9 items: title, body, image path, sourceId, tag
│           └── images/    # Downloaded item photos (jpg/jpeg/png)
```

There is no other `public/` content beyond `robots.txt` and the fonts symlink. Font files live under `src/assets/fonts/` and are symlinked at `public/assets/fonts/` so Vite can resolve them during `vite build` (avoids “didn't resolve at build time” warnings). Express still serves the canonical copies from `src/assets/fonts` at runtime.

---

## Frontend (Svelte 5)

### Entry and root

- `index.html` loads `/src/main.js`.
- `main.js` uses Svelte 5 `mount()` when `#app` exists and imports global `app.css`.
- `App.svelte` holds top-level state: `items`, `loading`, `loadError`. It loads inventory on mount, routes between inventory (`/`, `/equipment`, `/books`, `/rooms`), **How it works** (`/howthisworks`), **About** (`/about`), **Account** (`/account`), and admin (`/admin`) via `src/lib/router.js`. On item routes (`/{tag}/{slug}` e.g. `/equipment/megaphone`) it renders the inventory grid **and** the lazy-loaded `ItemDetailPage` overlay concurrently (the grid stays mounted underneath; `InventoryPanel` filters to the item's tag), so deep links show the item overlay on top of the right category grid. It wires a skip link (`site.skip_to_content` → `#main-content`), client-side SEO tags via `src/lib/seo.js` (`$effect` on route + locale; per-item Product JSON-LD on detail routes), Plausible SPA pageviews on route change when the script is present, a lemon **PSA banner** (localized hyperlink above the header), the site header (logo + `SiteNav` + `LocaleSwitcher` + `HeaderAuth`), lazy-loaded admin / how-it-works / about / item-detail pages, add-item modal, fixed bottom quote footer, fixed bottom-left FES attribution, and the `KimchiNotification` chat widget. Homepage page header includes `site.intro` + `site.intro_extended` copy. `/` defaults to the equipment filter; category paths sync the inventory filter via `navigate(categoryToPath(tag))`.

### Components

| Component | Responsibility |
|-----------|----------------|
| `InventoryPanel` | Tag filter buttons with per-category item counts (URL-synced via `categoryToPath` / `getCategoryFromPath`, and to the item's tag via `getItemRouteParams` while an item overlay is open), skeleton loading grid, filtered equal-height card grid, and shared availability clock subscription; **Reserve Inventory** on cards navigates to `/{tag}/{slug}?reserve=1` |
| `InventoryCard` | Equal-height card: clamped title/body (title links to `/{tag}/{slug}` via `navigateToItem`, opening the item overlay), white image frame, availability badge (**Available**, **Check availability**, **Unavailable**), hover lift, and **Reserve Inventory** button pinned to card bottom; Reserve navigates to item overlay with `?reserve=1` |
| `ItemDetailPage` | `/{tag}/{slug}` **modal overlay** (native `<dialog showModal()>`, opened on mount): breadcrumb bar with inline availability badge after item title, fetches item via API, 404 state, **three-column grid** (image | title/body | always-visible `ItemCalendar`). No overlay Reserve button — calendar is persistent. `?reserve=1` scrolls/highlights the calendar column (signed-in) or opens auth modal (signed-out). Confirm reservation gated via `ItemCalendar` `onbeforeconfirm` + `ReserveAuthRequiredModal`. Close (X / Escape / backdrop click) calls `closeItemOverlay(tag)`. Rendered concurrently with the inventory grid by `App.svelte`; the grid keeps `id="main-content"` (the overlay does not) |
| `ReserveAuthRequiredModal` | Native `<dialog>` shown when a signed-out user arrives via `?reserve=1` or confirms a calendar reservation (Supabase configured); error message + Register (opens header `AuthModal`) and Log in link; dismiss clears `?reserve=1` |
| `ItemCalendar` | Month-view calendar in the item overlay right column; optional `onbeforeconfirm` gate; tag-specific block selection (equipment/books) or flexible range (rooms); `todayKey` refreshes via shared availability clock; POST reservation via API; Kimchi `kimchi.reservation_sent` on successful pending create |
| `AdminPage` | `/admin` route: back link, access gate (auth configured, signed in, `isApathyAdmin`), page header, and `AdminPanel` |
| `AdminPanel` | Add-item, remove-item, **Pending Reservations** (approve/refuse), and edit-reservations toggle buttons; loads full inventory (including member emails) via `GET /api/admin/inventory`; remove list (confirm + `DELETE /api/inventory/:id`); pending list (approve/refuse + member email); approved reservation list (confirm + `DELETE /api/inventory/:id/reservations/:reservationId`, updates shared inventory state); Kimchi confirmations on remove, approve, and delete success |
| `AddItemModal` | Native `<dialog>`; form validation; tag/category radio selector; image pick + compress; POST new item; Kimchi `kimchi.item_added` on success. Exposes `open()` / `close()` via `export function` |
| `QuoteFooter` | Fixed site footer; rotates 10 activist quotes every 10s with fade in/out; resets index on locale change |
| `SiteNav` | Centered header links: **Inventory** (`/`), **How it works** (`/howthisworks`), and **About** (`/about`); active state from `path` store (inventory active on `/`, `/equipment`, `/books`, `/rooms`); uses `navigate()` for SPA transitions |
| `HowThisWorksPage` | `/howthisworks` route: localized five-step guide (browse, account, reserve, approval, pickup), expandable FAQ section (`how_this_works.faq`), and back link to inventory |
| `AboutPage` | `/about` route: mission, Canada-wide framing, and partner sections (Apathy is Boring, FES) with back link to inventory |
| `AccountPage` | `/account` route: signed-in members see email, **Sign out**, and gated **Admin** link (`@apathyisboring.com` only); signed-out visitors see login/register prompts; Kimchi `kimchi.signed_out` on successful sign-out |
| `HeaderAuth` | Header **Log in** / **Register** when signed out; **View account** (`auth.view_account`) + **Sign out** when signed in (Kimchi `kimchi.signed_out` on success). Exposes `openLogin()` / `openRegister()` for reserve auth prompt. Hidden if Supabase env vars are missing |
| `AuthModal` | Native `<dialog>` for email/password login and registration; register mode requires member agreement sign-off and offers an optional email-updates checkbox. Exposes `open(mode)` / `close()` |
| `MemberAgreementModal` | Scrollable member contract dialog opened from register flow; **Agree to the terms** sets signed state in parent. Exposes `open()` / `close()` |
| `LocaleSwitcher` | EN/FR language toggle; persists choice in `localStorage` key `arl-locale` |
| `KimchiNotification` | Fixed bottom-right chat widget shell (above quote footer): Kimchi avatar (`content/kimchi-awake.jpg` / `kimchi-sleep.jpg`) + `KimchiBubble` stack; signed-out greeting split into two bubbles (`kimchi.greeting`, then `kimchi.greeting_cta` + `/howthisworks` link after 1 second), or `kimchi.logged_in` confirmation when a session exists; also confirms on login during the visit; avatar tap adds a new random `kimchi.taps` message on top of existing stack; clickable green/grey status dot toggles awake/sleep (sleep shows `kimchi.sleep` “Zzz…” then suppresses all bubbles until awake; wake shows a random `kimchi.taps` message); inventory/reservation action confirmations queued from `AddItemModal`, `AdminPanel`, and `ItemCalendar` via `notify()` |
| `KimchiBubble` | One Kimchi chat bubble: elastic `backOut` pop-in, 350ms fade-out pinned in place during exit (flex stack collapse safe), per-bubble auto-dismiss timer, optional tail when anchored above avatar, close button |

### Shared libraries

- **`src/lib/i18n.js`** — Store-based i18n (no extra dependency). Imports `locales/en.json` and `locales/fr.json`. Exports `locale` (writable store), `t` (derived translate function — use `$t('domain.key')` in templates), `translateKey()` for non-reactive scripts, and `quotes` (derived quote list). Initial locale: `?lang=en|fr` query param, else saved `arl-locale`, else `fr` when `navigator.language` starts with `fr`, else `en`. Updates `document.documentElement.lang` on change. Dynamic strings use `{variable}` interpolation (e.g. `$t('admin.remove_confirm', { title })`).
- **`src/lib/seo.js`** — `getSiteOrigin`, `getSeoForRoute`, `getItemSeoConfig`, `getProductJsonLd`, `ROUTE_SEO_KEYS`, `applySeoTags`, `applyHreflangTags`, `setRobotsMeta` / `clearRobotsMeta`, `upsertMeta` / `upsertMetaProperty` / `upsertLink` / `upsertJsonLd`, `getOrganizationJsonLd`, `getFaqJsonLd`, `buildSeoHeadHtml`. Locale keys under `seo.*` in EN/FR JSON. `/admin` and `/account` set `noindex`; public routes inject Organization JSON-LD; `/howthisworks` also injects FAQPage JSON-LD; item detail routes use item title, truncated body description, item image, canonical `/{tag}/{slug}`, and Product JSON-LD.
- **`src/lib/seo-server.js`** — Async `injectSeoIntoHtml(html, pathname, locale, origin, escapeHtml, options)` (looks up item by slug for `/{tag}/{slug}` via `findItemBySlug` option), `resolveRequestLocale(req)`, and `ROUTE_META` (paths mirroring `ROUTE_SEO_KEYS`) for Express HTML responses.
- **`src/lib/image.js`** — `compressImageFile(file)` — scales to max 1200px, exports WebP at 0.8 quality with JPEG fallback as a data URL.
- **`src/lib/auth.js`** — `session` and `authReady` Svelte stores; `initAuth`, `signInWithEmail`, `signUpWithEmail`, `signOut`, `isApathyAdmin`. `signUpWithEmail` passes `emailRedirectTo` from `getAuthRedirectUrl()` and sets `user_metadata.signed_member_agreement` when the user agrees during registration plus `user_metadata.email_updates_opt_in` from the register checkbox (defaults `false`). `isApathyAdmin` returns true when the session user's email ends with `@apathyisboring.com` (case-insensitive). Subscribes to `onAuthStateChange` on first init.
- **`src/lib/member-agreement.js`** — Imports `content/contracts/{locale}/member-agreement.md` at build time; `getMemberAgreementHtml()` returns rendered HTML for the active locale (French falls back to English until `fr/` copy exists).
- **`src/lib/inventory.js`** — `INVENTORY_TAGS`, `DEFAULT_INVENTORY_TAG`, `fetchInventory`, `fetchInventoryItem(tag, slug)`, `fetchAdminInventory`, `createInventoryItem`, `deleteInventoryItem`, `loadInventoryItems`, `createReservation`, `deleteReservation`, `approveReservation`, `refuseReservation`. Public `fetchInventory` / `fetchInventoryItem` return reservations without `userEmail` and include `slug`; admin panel uses `fetchAdminInventory` (auth + admin). Mutating calls attach `Authorization: Bearer <access_token>` from the Supabase session. Also migrates legacy items from `localStorage` key `arl-inventory-items` to the server on first load when the server inventory is empty (per-item try/catch; localStorage always cleared after attempt).
- **`src/lib/calendar.js`** — `parseDateKey`, `compareDateKeys`, `hasReservationCollision`, `isCurrentlyReserved`, `hasAvailabilityWithinDays`, `getCalendarMonthGrid`, `toDateKey`, and related date helpers. `getBlockingReservations` (`pending` + `reserved`) drives calendar collision; `getConfirmedReservations` (`reserved` only) drives the unavailable badge. Shared by `InventoryCard`, `ItemCalendar`, and `server.js`.
- **`src/lib/availability-clock.js`** — `availabilityNow` store plus ref-counted 60s interval (`subscribeAvailabilityClock` / `unsubscribeAvailabilityClock`). `InventoryPanel` subscribes on mount; cards and calendar read `$availabilityNow` without subscribing directly.
- **`src/lib/reservation-rules.js`** — Tag-specific reservation block rules (`getBlockEndDate`, `validateReservationDates`, `isFixedBlockTag`). Shared by `ItemCalendar.svelte` and `server.js` reservation endpoints.
- **`src/lib/slug.js`** — `slugifyTitle()` and `ensureUniqueSlug()`; used server-side when creating/seeding/backfilling inventory slugs (unique per tag).
- **`src/lib/notification-store.js`** — Queue-based notification API for the Kimchi widget. `notify(message, duration?, options?)` (default 5000ms) accepts a string or `{ text, link: { href, label } }` and returns an id (or `-1` when suppressed while Kimchi is asleep); `{ force: true }` bypasses the sleep gate (e.g. sleep “Zzz…” bubble). `setKimchiNotificationsEnabled(enabled)` toggles the sleep gate; `dismiss(id)`; `clearNotifications()`; read-only `notifications` store. All queued notifications stack upward in `KimchiNotification.svelte` (newest anchored above the avatar). Action keys: `kimchi.item_added`, `kimchi.item_removed`, `kimchi.reservation_approved`, `kimchi.reservation_deleted`, `kimchi.reservation_sent`.
- **`src/lib/router.js`** — Writable `path` store synced to `window.location.pathname`; `navigate(to)` for client-side transitions; `navigateToItem(item)` (opens the item overlay; pushes the item path with a `{ arlItemOverlay: true }` history-state marker); `closeItemOverlay(tag)` (closes the overlay keeping URL in sync — `history.back()` when the current entry carries the overlay marker and there is prior history, else `navigate(categoryToPath(tag))` for deep links / refreshes); `navigateToItemWithReserve(item)`, `hasReserveIntent()`, `setReserveIntent()`, and `clearReserveIntent()` for the `?reserve=1` deep-link flow (reserve-intent `replaceState` calls preserve the existing `history.state`); `CATEGORY_ROUTES`, `ITEM_ROUTE_RE`, `getItemRouteParams`, `isItemDetailRoute`, `getCategoryFromPath`, `isInventoryHomePath`, `categoryToPath`, `itemToPath`; `isAdminRoute()`, `isHowThisWorksRoute()`, `isAboutRoute()`, `isAccountRoute()`. Item routes `/{tag}/{slug}` are distinct from category routes (`/equipment` only). Listens to `popstate` for back/forward.
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
- `GET /*` from `dist/` — built SPA (`index.html`, hashed JS/CSS). Unknown GET paths fall through to injected `index.html` for client routes such as `/admin` and `/account` (meta/OG/canonical/hreflang/JSON-LD injected server-side via `seo-server.js`; `/admin` and `/account` also get `X-Robots-Tag: noindex, nofollow`).
- `GET /robots.txt` — static file from `dist/` (copied from `public/` at build).
- `GET /sitemap.xml` — dynamic sitemap (static routes + all items as `/{tag}/{slug}` with `lastmod` from `createdAt`); `Cache-Control: public, max-age=3600`.
- `GET /assets/fonts/*` from `src/assets/fonts/`.
- `GET /assets/brand/*` from `src/assets/brand/` (Apathy is Boring header logo, FES attribution logo).
- `GET /assets/inventory/*` from `src/assets/inventory/` (seed images and `items.json`).

### Data

- Inventory and reservations persist in **Supabase Postgres** via `src/lib/inventory-store.js` (service role key on the server). Apply `supabase/migrations/001_inventory.sql`, `002_reservation_approval.sql`, `003_lock_down_roles.sql`, and `004_inventory_slug.sql` before first run (or after deploy if upgrading).
- Tables: `inventory_items` (`id`, `title`, `body`, `image`, `tag`, `slug`, `created_at`) and `reservations` (`id`, `item_id`, `start_date`, `end_date`, `status`, `user_email`). Unique index on `(tag, slug)`. RLS is enabled with no public policies — Express uses the service role (bypasses RLS). Migration `003_lock_down_roles.sql` revokes direct table access from `anon`/`authenticated`. Slugs are generated server-side at create/seed time from title (`src/lib/slug.js`); immutable after create; collisions within a tag append `-2`, `-3`, etc. `ensureInventory()` runs a once-per-process slug backfill (`ensureSlugsBackfilled()`) that is **decoupled from the `inventorySeeded` flag** — it always populates missing slugs on existing rows even when the inventory is already seeded, and retries on the next request if it fails (errors are logged, not swallowed, and never break the inventory read). `npm run backfill:slugs` triggers the same backfill on demand.
- **Public** API item shape (`GET /api/inventory`, `GET /api/inventory/by-slug/:tag/:slug`): `{ id, title, body, image, createdAt, tag, slug, reservations }` where `reservations` is `{ id, startDate, endDate, status }[]` — **`userEmail` is never returned on public routes**. Admin route `GET /api/admin/inventory` returns full items including `userEmail` on reservations.
- `status` on reservations: `pending` (new member request), `reserved` (admin-approved), `refused` (admin declined — dates freed), or legacy `available`. New creates always use `pending` with member email from JWT.
- `pending` and `reserved` block calendar dates; only `reserved` marks the card **Unavailable** badge.
- **Tag-specific reservation rules** (enforced in `ItemCalendar` and `POST`/`PATCH` reservation APIs via `src/lib/reservation-rules.js`; ranges are inclusive):
  - **equipment** — Start must be a **Tuesday**; end is automatically the **following Tuesday** (+7 days). One-week block; pickup/drop-off hours message shown on the calendar.
  - **books** — Start must be a **Tuesday**; end is **four weeks later** (+28 days, also a Tuesday). One-month block; same pickup/drop-off message.
  - **rooms** — Flexible inclusive range on any days (existing two-click range selection).
- Calendar UI for equipment/books: only Tuesdays are selectable; clicking a Tuesday selects the full fixed block. Equipment and books modals show localized pickup/drop-off hours (10am–5pm Tuesdays).
- `image` is either a `data:image/webp;base64,...` or `data:image/jpeg;base64,...` URL from the client compressor (WebP preferred, JPEG fallback), or a path like `/assets/inventory/images/...` for seeded MyTurn items. `POST /api/inventory` rejects other image formats/paths with 400.
- Seeding runs via `ensureInventory()` in `inventory-store.js` (no-op after first successful seed via `inventorySeeded` flag). If the DB is empty: import `data/inventory.json` when present, else insert 9 seed items from `src/assets/inventory/items.json`.
- `addReservation` and `approveReservation` use an in-process per-item lock around collision-check + write (single Cloud Run instance only; not safe across replicas).
- Seeded item IDs use the format `myturn-{sourceId}` when `sourceId` is present in the seed file.
- One-time upsert from legacy JSON: `npm run migrate:inventory` (or rely on auto-import when the DB is empty on first `GET /api/inventory`).

### API endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/inventory` | — | Returns `{ items: [...] }` with reservations sanitized (no `userEmail`; `Cache-Control: no-store`) |
| `GET` | `/api/inventory/by-slug/:tag/:slug` | — | Returns `{ item }` for one public item by tag + slug (sanitized; `Cache-Control: public, max-age=300`) |
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
- All Resend email links and path-based inventory images use `SITE_URL` (or `VITE_SITE_URL`), falling back to `https://activistresourcelibrary.com` when unset — admin notifications link to `/admin` and the item page; member decision emails link to the item and library home.
- `EMAIL_FROM` defaults to `noreply@activistresourcelibrary.com`; legacy `onboarding@resend.dev` in env is ignored at runtime. `RESERVE_INVENTORY_EMAIL_TO` falls back to `EMAIL_TO` (default `samuel@apathyisboring.com`). Set in `.env` for production.
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
| `PLAUSIBLE_DOMAIN` | No | When set, Express injects deferred Plausible script into HTML and extends CSP `script-src` / `connect-src` for `https://plausible.io`; client fires SPA pageviews on route change |
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
| `npm run build` | Production build to `dist/` + `scripts/prerender.js` static shells for `/howthisworks`, `/about`, `/equipment`, `/books`, `/rooms` |
| `npm start` | `build` + Express server, so source changes are reflected after restart |
| `npm run serve` | Express only; serves the existing `dist/` without rebuilding |
| `npm run preview` | Alias for `npm start` |
| `npm run send-email` | One-off Resend test via `send-email.js` |
| `npm run docker:build` | Docker image build with `SUPABASE_URL`, `SUPABASE_API`, and `SITE_URL` from `.env` as build args (`scripts/docker-build.sh`; set `IMAGE` for Artifact Registry tag) |
| `npm run cloud:build` | Build + push + deploy via Google Cloud Build (no local Docker required). Reads Supabase + `SITE_URL` from `.env` (default production URL `https://activistresourcelibrary.com`); deploys to `arl-online` in `us-east1`. Images push to Artifact Registry in `us-east1` (`GCP_ARTIFACT_REGION`). Sets runtime env on Cloud Run (`SITE_URL`, optional `EMAIL_*`, `SLACK_RESERVATION_WEBHOOK_URL`); mounts `SUPABASE_SERVICE_ROLE_KEY` and `RESEND_API_KEY` from Google Secret Manager via `--set-secrets` (see comment block in `scripts/cloud-build.sh`). |
| `npm run migrate:inventory` | Upsert `data/inventory.json` into Supabase (`inventory_items` + `reservations`); requires `data/inventory.json` to exist |
| `npm run backfill:slugs` | Populate slugs on existing `inventory_items` rows with a null/empty slug (idempotent; safe to re-run). Use after applying `004_inventory_slug.sql` to fix items that have `slug = null` |

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

**Persistence:** Inventory and reservations live in Supabase Postgres. Apply `supabase/migrations/001_inventory.sql`, `002_reservation_approval.sql`, `003_lock_down_roles.sql`, and `004_inventory_slug.sql` to your project before deploying.

---

## Common change patterns

| Task | Where to edit |
|------|----------------|
| New inventory field | `src/lib/inventory-store.js`, `AddItemModal.svelte`, `InventoryCard.svelte`, API client in `inventory.js`, SQL migration if needed |
| Inventory tags / filter | `inventory-store.js`, `src/assets/inventory/items.json`, `InventoryPanel.svelte`, `AddItemModal.svelte`, `src/lib/inventory.js`, `locales/en.json` + `fr.json`, styles in `app.css` |
| Reservation calendar | `server.js` (reservation endpoints), `inventory-store.js`, `src/lib/calendar.js`, `src/lib/reservation-rules.js`, `ItemCalendar.svelte`, `InventoryCard.svelte`, `locales/en.json` + `fr.json` |
| New page / tab | `App.svelte`, `src/lib/router.js`, new component under `components/`, optional `SiteNav.svelte` link, styles in `app.css`; Express already serves `index.html` for unknown GET paths (e.g. `/howthisworks`) |
| New API route | `server.js`; add client function in `src/lib/` if the UI needs it |
| Email content | `server.js` reservation notification handler |
| Dev proxy | `vite.config.js` `server.proxy` |
| Auth UI / session | `HeaderAuth.svelte`, `AuthModal.svelte`, `src/lib/auth.js`, `src/lib/supabase.js` |
| User-facing copy / new language | Add matching keys to `locales/en.json` and `locales/fr.json`; use `$t('domain.key')` in components or `translateKey()` in `src/lib/` |

After any of the above, **update this file**.

---

## Related documentation

- `docs/Apathy_is_Boring_Brand_Guidelines.md` — brand/design reference (not wired into the app automatically).
- `docs/automated-notifications.md` — Kimchi chat bubbles: every `notify()` trigger, locale keys, durations, and sleep suppression.
- `docs/automated-emails.md` — Resend emails: triggers, recipients, subjects, env vars, and failure behavior.
- `docs/automated-webhooks.md` — Slack reservation webhook: payload, env var, timeout, and failure behavior.

---

## Google Search Console setup

1. **Verify ownership** — In [Google Search Console](https://search.google.com/search-console), add the property `https://activistresourcelibrary.com` (URL-prefix or domain property).
2. **HTML tag or DNS** — Use the meta-tag verification method (temporary tag in `index.html`) or DNS TXT record via your domain host. Remove the verification meta tag after confirming if you used the HTML method.
3. **Submit sitemap** — After deploy, submit `https://activistresourcelibrary.com/sitemap.xml` under **Sitemaps**. The dynamic sitemap lists static routes plus every inventory item at `/{tag}/{slug}` with `lastmod`.
4. **Check robots.txt** — Confirm `https://activistresourcelibrary.com/robots.txt` allows `/`, disallows `/api/` and `/admin`, and references the sitemap URL.
5. **Inspect URLs** — Use **URL inspection** on the homepage and `/howthisworks` to confirm canonical, hreflang (`?lang=en` / `?lang=fr`), and Organization JSON-LD on public pages. `/admin` should show `noindex` (meta + `X-Robots-Tag`).
6. **Optional analytics** — Set `PLAUSIBLE_DOMAIN=activistresourcelibrary.com` in production env for privacy-friendly traffic data alongside Search Console.

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
| 2026-06-12 | Kimchi notification widget: `KimchiNotification.svelte` (fixed bottom-right cat-mascot chat bubble, elastic pop transitions, `content/kimchi.jpg` avatar bundled by Vite) + `src/lib/notification-store.js` (`notify`/`dismiss` queue API); mounted in `App.svelte`; greeting with `/howthisworks` link on mount; `kimchi.*` keys in EN/FR locales. |
| 2026-06-12 | Kimchi avatar click: random localized short messages (`kimchi.taps` in EN/FR) replace any open bubble and pop a new chat message. |
| 2026-06-12 | Kimchi avatar positioned to sit flush on the FES attribution badge via `--site-attribution-block-height` in `app.css` (replaces fixed `+4rem` offset). |
| 2026-06-12 | Kimchi notification bubble fades out on dismiss/auto-dismiss (elastic pop retained on enter). |
| 2026-06-12 | **How it works** page at `/howthisworks` (`HowThisWorksPage.svelte`, `how_this_works.*` locales); `SiteNav` in header (Inventory + How it works); Kimchi greeting link uses client-side `navigate()`. |
| 2026-06-12 | Kimchi avatar: green "online" status dot (bottom-right, white ring, soft pulse; static under reduced motion). |
| 2026-06-12 | Kimchi greeting bubble: shrink-to-fit width, no trailing whitespace after link; `kimchi.greeting_cta` locale key (EN/FR) for the CTA line. |
| 2026-06-12 | Kimchi notifications stack upward (all queued bubbles visible; newest anchored above avatar with tail); 350ms fade-out unchanged; avatar tap dismisses newest bubble before showing tap message. |
| 2026-06-12 | Kimchi stack fade fix: `KimchiBubble.svelte` child component with lifecycle auto-dismiss timers and exit fade pinned absolute (prevents flex collapse skipping 350ms outro). Avatar tap now adds messages on top of the existing stack (no dismiss-first). |
| 2026-06-12 | Kimchi logged-in confirmation: signed-in users see `kimchi.logged_in` instead of the anonymous greeting; logging in during a visit queues the same confirmation bubble. |
| 2026-06-12 | Mobile inventory filter layout: 2-column grid (Rooms full-width) below 640px, single column below 360px; `overflow: hidden` on filter bar — fixes Equipment count badge overlapping the active button background. |
| 2026-06-12 | Kimchi action confirmations: `notify()` on add/remove item (`AddItemModal`, `AdminPanel`), approve/delete reservation (`AdminPanel`), and pending reservation submit (`ItemCalendar`); new `kimchi.item_added`, `item_removed`, `reservation_approved`, `reservation_deleted`, `reservation_sent` EN/FR keys. |
| 2026-06-13 | Kimchi chat bubbles use brand Lemon glow and accents (`--color-lemon`) instead of orange border/shadow styling. |
| 2026-06-13 | Kimchi avatar uses `kimchi-awake.jpg` / `kimchi-sleep.jpg`; status dot toggles awake/sleep; sleep shows “Zzz…” then suppresses `notify()` until awake; wake shows a random `kimchi.taps` message. |
| 2026-06-13 | FES attribution badge moved to bottom-left; Kimchi widget sits directly above quote footer (no longer stacked on the badge). |
| 2026-06-13 | FES attribution copy ends at “created by” (logo only for FES name); badge max-width narrowed then widened (~20% above half-width baseline). |
| 2026-06-13 | Kimchi sign-out notification: `kimchi.signed_out` bubble shown after `signOut()` succeeds in `HeaderAuth.svelte`. |
| 2026-06-13 | Kimchi register-click notification: `kimchi.register_click` bubble shown when Register is clicked from the header or `ReserveAuthRequiredModal`. |
| 2026-06-13 | Kimchi avatar tap messages use a shuffle/exhaust cycle (no repeat until all messages shown); implemented in `KimchiNotification.svelte`. |
| 2026-06-13 | Added "Welcome to the Activist Resource Library!" (EN) and French equivalent to `kimchi.taps` in both locale files. |
| 2026-06-13 | Kimchi item-reaction notifications: hovering an inventory card for 1.5s triggers a random `kimchi.item_reactions` bubble (no-repeat shuffle, 3s cross-card cooldown); shared state via `<script module>` in `InventoryCard.svelte`; EN/FR locale keys added. |
| 2026-06-13 | Kimchi item reactions: hover delay increased to 3s; same reaction also fires on **Reserve Inventory** click (shared `triggerItemReaction()` with shuffle + cooldown). |
| 2026-06-13 | Kimchi signed-out intro split into two stacked bubbles: `kimchi.greeting` immediately, then `kimchi.greeting_cta` + `/howthisworks` link after 1 second; `kimchi.logged_in` unchanged for signed-in users. |
| 2026-06-13 | Kimchi signed-out intro CTA bubble delay increased from 500ms to 1 second (`GREETING_SPLIT_DELAY` in `KimchiNotification.svelte`). |
| 2026-06-13 | Site header layout: desktop stays single-line (no wrap); mobile uses a fixed two-row grid (logo + locale/auth on row 1, centered nav on row 2). |
| 2026-06-13 | Fixed mobile header overlap bug: switched mobile header to a 3-row single-column grid (logo row 1, nav row 2, locale+auth row 3) so the logged-in auth area (email + Admin + Sign Out) never overflows into the logo. Email address hidden on mobile to reduce row-3 width. |
| 2026-06-13 | Mobile header reorganized to 2-row layout (≤640px): row 1 = logo + auth buttons, row 2 = nav links + EN/FR locale switcher; achieved via CSS grid `actions` area spanning both rows with `flex-direction: column`; desktop single-row layout unchanged. |
| 2026-06-13 | Quote footer mobile pin fix: fixed height + absolute quote stack (no rotation layout shift), `100dvh` page min-height, safe-area padding, `viewport-fit=cover`, and GPU compositing on `.quote-footer`. |
| 2026-06-13 | Fixed mobile scroll gap under quote footer: removed `transform: translateZ(0)` from `.quote-footer`; the GPU compositing layer caused iOS Safari to lag repositioning the fixed element when the browser chrome hid/showed, creating a ~½ inch gap. |
| 2026-06-13 | Added `docs/automated-notifications.md`, `docs/automated-emails.md`, and `docs/automated-webhooks.md` — scannable reference for Kimchi bubbles, Resend emails, and Slack webhook triggers. |
| 2026-06-13 | Mobile header auth fix: `.header-auth` set to `flex-wrap: nowrap` at ≤640px so Log in / Register (and Connexion / Inscription in FR) stay side by side instead of stacking. |
| 2026-06-13 | Kimchi item reactions: hover delay increased from 3s to 6s (`ITEM_HOVER_DELAY` in `InventoryCard.svelte`). |
| 2026-06-13 | Register flow: optional email-updates checkbox (unchecked by default); choice stored in Supabase `user_metadata.email_updates_opt_in` via `signUpWithEmail`. |
| 2026-06-13 | Phase 1 SEO: `public/robots.txt` + `public/sitemap.xml`; `src/lib/seo.js` + `seo-server.js` for client/server meta/OG/Twitter/canonical/hreflang/JSON-LD; `/admin` noindex; skip link + homepage intro copy; image alt/aspect-ratio; optional Plausible (`PLAUSIBLE_DOMAIN`); Google Search Console section in AGENTS.md. |
| 2026-06-13 | Phase 2 SEO: category routes (`/equipment`, `/books`, `/rooms`; `/` = equipment); `/about` page; FAQ section + FAQPage JSON-LD on `/howthisworks`; dynamic `GET /sitemap.xml`; lazy-loaded admin/how-it-works/about/calendar chunks; WebP image compression with JPEG fallback. |
| 2026-06-13 | Phase 3 SEO (SEO-20): `004_inventory_slug.sql`; `src/lib/slug.js`; per-tag slugs on items; `GET /api/inventory/by-slug/:tag/:slug`; item detail routes `/{tag}/{slug}` with `ItemDetailPage.svelte`; Product JSON-LD + per-item meta (client + server); card title links; sitemap item URLs; `item_detail.*` locales; slug backfill on seed/migrate/`ensureInventory`. |
| 2026-06-13 | Phase 3 SEO (SEO-23): Tier 1 server-injected item meta via async `seo-server.js` + `findInventoryItemBySlug`; Tier 2 build-time prerender (`scripts/prerender.js` → `dist/{route}/index.html` for marketing/category pages); `npm run build` runs prerender after Vite. |
| 2026-06-13 | Reserve flow URL sync: grid/detail Reserve navigates to `/{tag}/{slug}?reserve=1`; `ItemDetailPage` auto-opens calendar on `?reserve=1`; closing modals clears the query param; reserve calendar moved from `InventoryPanel` to item detail page only. |
| 2026-06-13 | Reserve calendar integrated inline into `ItemDetailPage` overlay (`.item-detail-reserve` section with `ItemCalendar`); removed stacked `ReserveCalendarModal.svelte`; Escape closes inline calendar before overlay; auth-required modal remains a separate dialog. |
| 2026-06-13 | Fixed broken Reserve button: removed `triggerItemReaction()` from the Reserve button click handler in `InventoryCard.svelte` (Kimchi item reactions now fire only on hover, not on Reserve click); fixed `navigateToItemWithReserve` early-return path in `router.js` to use `replaceState` to add `?reserve=1` to the URL when already on the item detail page, so `tryOpenReserveFromQuery` can detect the reserve intent. |
| 2026-06-13 | Item detail is now a modal **overlay** instead of a full-page route: `ItemDetailPage.svelte` is a native `<dialog showModal()>` rendered by `App.svelte` concurrently with the inventory grid on `/{tag}/{slug}` routes (grid stays mounted; `InventoryPanel` filters to the item's tag via `getItemRouteParams`). URL still updates to `/{tag}/{slug}` (+`?reserve=1`). New `router.js` helpers `navigateToItem(item)` (push with `{ arlItemOverlay: true }` history-state marker) and `closeItemOverlay(tag)` (`history.back()` for in-app entries, else `navigate(categoryToPath(tag))` for deep links); reserve-intent `replaceState` calls preserve `history.state`. Close via X / Escape / backdrop / browser Back stays in sync; reserve auth + calendar modals stack on top of the overlay. SEO (URL/canonical/sitemap/server `seo-server.js`/Product JSON-LD) unchanged. `.modal--item-detail` styles in `app.css`. |
| 2026-06-13 | Fixed Reserve flow silently no-opping when `inventory_items.slug` was `null`: (1) **Root cause** — `ensureInventory()` short-circuited on the module-level `inventorySeeded` flag before its slug backfill could run, so a long-lived server that cached the flag never repopulated null slugs (and the old running process predated slug serialization). Refactored `ensureInventory()` into `seedInventoryIfEmpty()` + `ensureSlugsBackfilled()` (separate once-per-process flag, retry-on-failure, logged errors) so the backfill always runs independent of seeding; `backfillMissingSlugs()` now returns its update count. (2) Added `scripts/backfill-slugs.js` + `npm run backfill:slugs` to trigger the backfill on demand. (3) Client defensive fallback: `itemToPath()`/new `resolveItemSlug()` in `router.js` generate a client-side slug from the title when `item.slug` is missing (never collapse to a category path); `InventoryPanel.openReserve` and `InventoryCard` title link no longer early-return on missing slug (warn + navigate). Backfilled the 9 live equipment items. |
| 2026-06-13 | Item overlay three-column layout: image (left) | description + availability badge (middle) | always-visible `ItemCalendar` (right). Removed expandable `.item-detail-reserve` section and overlay Reserve button. `?reserve=1` scrolls/highlights calendar (signed-in) or auth modal (signed-out). `ItemCalendar` adds optional `onbeforeconfirm` auth gate. Responsive stack: image → description → calendar below 900px. Wider `.modal--item-detail` (72rem). |
| 2026-06-13 | Kimchi item reactions: hover delay reduced from 6s to 4s (`ITEM_HOVER_DELAY` in `InventoryCard.svelte`). |
| 2026-06-13 | Item overlay calendar column: removed redundant “Reserve: {title}” heading above `ItemCalendar`; dropped `.item-detail__calendar-heading` CSS. |
| 2026-06-13 | Item overlay availability badge moved from the description column to the breadcrumb current-page crumb (e.g. `Transport buggy (AVAILABLE)`); reuses `availability-badge` variants; removed `.item-detail__badge` CSS. |
| 2026-06-13 | Fixed breadcrumb availability badge not showing: `.item-detail-breadcrumb__badge` CSS rule was declared before `.availability-badge` in `app.css`, so the later rule's `position: absolute` clobbered the `position: static` override; moved breadcrumb badge rule to after the `.availability-badge` block so it wins the cascade. |
| 2026-06-13 | Dockerfile build stage copies `scripts/` so `npm run build` prerender step succeeds in Cloud Build. |
| 2026-06-13 | Logged-in header auth: replaced email + Admin + Sign out with a single **View account** button (`auth.view_account`) that navigates to new `/account` page (`AccountPage.svelte`: email, sign out, admin link for `@apathyisboring.com` admins); `/account` is noindex + disallowed in `robots.txt`; removed unused `.header-auth__email` styles. |
| 2026-06-16 | Reservation create: startup `checkReservationSchema()` warns when migration `002_reservation_approval.sql` is missing; POST `/api/inventory/:id/reservations` returns a schema hint instead of a generic 500 when `user_email` / `pending` status are unavailable. |
| 2026-06-16 | Resend emails: all links and path-based images use `SITE_URL` (fallback production origin); admin notifications include item + `/admin` URLs; member approve/refuse emails include item + library links. |
| 2026-06-16 | Default `EMAIL_FROM` changed from `onboarding@resend.dev` to `noreply@activistresourcelibrary.com`. |
| 2026-06-16 | `server.js` ignores legacy `EMAIL_FROM=onboarding@resend.dev`; `cloud-build.sh` always sets `EMAIL_FROM` on deploy (migrates away from Resend sandbox sender). |
