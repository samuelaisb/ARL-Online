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

- **Inventory tab** — lists items (title, body, image) loaded from the server. Users can **Reserve Inventory**, which sends a reservation email via Resend.
- **Admin tab** — opens a modal to add new items (title, body, uploaded image). Images are compressed client-side before upload.
- **Header auth** — optional Supabase email/password login and registration (Log in / Register in the site header). Session is client-side only; inventory and admin APIs are not gated on auth yet.

The admin UI remains available to anyone who can open the site (not restricted to signed-in users).

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
├── data/                  # Gitignored — inventory.json created at runtime
├── dist/                  # Gitignored — Vite production build output
├── docs/                  # Brand / design reference (not app code)
├── public/
│   └── assets/
│       └── fonts/         # Symlink → src/assets/fonts (so Vite resolves @font-face at build)
├── src/
│   ├── main.js            # Mounts App.svelte, imports app.css
│   ├── App.svelte         # Root layout: tabs, inventory state, modal wiring
│   ├── app.css            # Global styles (fonts, layout, components)
│   ├── components/
│   │   ├── InventoryPanel.svelte   # Inventory tab: loading, errors, grid
│   │   ├── InventoryCard.svelte    # Single item card + reserve button
│   │   ├── AdminPanel.svelte       # Admin tab: "Add Item" button + remove-items list
│   │   ├── AddItemModal.svelte     # Dialog form for new items
│   │   ├── AuthModal.svelte        # Login / register dialog (email + password)
│   │   ├── HeaderAuth.svelte       # Site header auth controls + modal wiring
│   │   └── QuoteFooter.svelte      # Fixed bottom quote rotator (10s rotation, 600ms fade)
│   ├── lib/
│   │   ├── auth.js        # Supabase session store + sign-in/up/out helpers
│   │   ├── inventory.js   # API client + legacy localStorage migration
│   │   ├── image.js       # Client-side image compression (canvas → JPEG)
│   │   └── supabase.js    # Supabase browser client (anon key)
│   └── assets/
│       ├── brand/         # Apathy is Boring + FES logos; served at /assets/brand
│       ├── fonts/         # Inter + Ringold; served at /assets/fonts
│       └── inventory/     # Seed catalog from MyTurn library; served at /assets/inventory/
│           ├── items.json # 9 items: title, body, image path, sourceId
│           └── images/    # Downloaded item photos (jpg/jpeg/png)
```

There is no other `public/` content. Font files live under `src/assets/fonts/` and are symlinked at `public/assets/fonts/` so Vite can resolve them during `vite build` (avoids “didn't resolve at build time” warnings). Express still serves the canonical copies from `src/assets/fonts` at runtime.

---

## Frontend (Svelte 5)

### Entry and root

- `index.html` loads `/src/main.js`.
- `main.js` uses Svelte 5 `mount()` and imports global `app.css`.
- `App.svelte` holds top-level state: `activeTab`, `items`, `loading`, `loadError`. It loads inventory on mount and wires the site header (logo + `HeaderAuth`), tabs, modal, fixed bottom quote footer, and fixed bottom-right FES attribution.

### Components

| Component | Responsibility |
|-----------|----------------|
| `InventoryPanel` | Shows loading, load error, empty state, or grid of cards |
| `InventoryCard` | Displays one item; handles reserve flow and success/error status on the card |
| `AdminPanel` | Add-item button, list of current items with remove buttons (confirm + DELETE API) |
| `AddItemModal` | Native `<dialog>`; form validation; image pick + compress; POST new item. Exposes `open()` / `close()` via `export function` |
| `QuoteFooter` | Fixed site footer; rotates 10 activist quotes every 10s with fade in/out |
| `HeaderAuth` | Header Log in / Register buttons when signed out; email + Sign out when signed in. Hidden if Supabase env vars are missing |
| `AuthModal` | Native `<dialog>` for email/password login and registration. Exposes `open(mode)` / `close()` |

### Shared libraries

- **`src/lib/supabase.js`** — `createClient` wrapper; reads `SUPABASE_URL` + `SUPABASE_API` (or `VITE_` / `SUPABASE_ANON_KEY` aliases). Exports `supabaseConfigured`.
- **`src/lib/auth.js`** — `session` and `authReady` Svelte stores; `initAuth`, `signInWithEmail`, `signUpWithEmail`, `signOut`. Subscribes to `onAuthStateChange` on first init.
- **`src/lib/inventory.js`** — `fetchInventory`, `createInventoryItem`, `deleteInventoryItem`, `loadInventoryItems`, `reserveInventoryItem`. Also migrates legacy items from `localStorage` key `arl-inventory-items` to the server on first load when the server inventory is empty.
- **`src/lib/image.js`** — `compressImageFile(file)` — scales to max 1200px, exports JPEG at 0.8 quality as a data URL.

### Auth (Supabase)

- Client-only: `@supabase/supabase-js` in the browser; no Express middleware.
- `vite.config.js` sets `envPrefix: ['VITE_', 'SUPABASE_']` so `.env` keys like `SUPABASE_URL` and `SUPABASE_API` are available to the client build.
- Enable **Email** provider in the Supabase dashboard. If email confirmation is on, registration shows a “check your email” message and the user logs in after confirming.
- Header auth UI is omitted entirely when URL or anon key env vars are unset.

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
- Item shape: `{ id, title, body, image, createdAt }`.
- `image` is either a `data:image/jpeg;base64,...` URL from the client compressor, or a path like `/assets/inventory/images/...` for seeded MyTurn items.
- Seeding runs via `ensureInventory()`, called by all three inventory endpoints (`GET`, `POST`, `DELETE`). If `data/inventory.json` is missing or empty, 9 items from `src/assets/inventory/items.json` are written to disk before the operation proceeds.
- Seeded item IDs use the format `myturn-{sourceId}` when `sourceId` is present in the seed file.

### API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/inventory` | Returns `{ items: [...] }` |
| `POST` | `/api/inventory` | Body: `{ title, body, image }`. Creates item, returns `{ item }` |
| `DELETE` | `/api/inventory/:id` | Removes item by id; returns `{ success: true }` or 404 |
| `POST` | `/api/reserve-inventory` | Body: `{ item }`. Sends reservation email; returns `{ success, id }` |
| `POST` | `/api/send-email` | Body: `{ subject, body }`. Generic email endpoint (legacy/auxiliary) |

JSON body limit: 10mb (for image data URLs).

### Email (Resend)

- Requires `RESEND_API_KEY` in `.env`; server exits on startup if missing.
- `EMAIL_FROM` defaults to `onboarding@resend.dev`; `EMAIL_TO` and `RESERVE_INVENTORY_EMAIL_TO` default to `samuel@apathyisboring.com` if unset. Set both in `.env` for production.
- `RESERVE_INVENTORY_EMAIL_TO` falls back to `EMAIL_TO` when unset.
- Reservation emails inline-attach uploaded images when `image` is a data URL. For seed items with path-based images, an HTML link is used — these will not render inline in most email clients.

### Server port

- Default `PORT=3000`.
- In development (`NODE_ENV=development` or `STRICT_PORT=true`), the server exits if the port is already in use so the Vite proxy target stays correct. `npm run dev` pre-clears the port automatically; `npm run dev:server` does not.
- Outside development, if the port is in use, the server tries successive ports (up to 20 attempts).

---

## Environment variables

See `.env.example`:

| Variable | Required | Purpose |
|----------|----------|---------|
| `RESEND_API_KEY` | Yes | Resend API key |
| `EMAIL_FROM` | No | Sender address |
| `EMAIL_TO` | No | Default recipient |
| `RESERVE_INVENTORY_EMAIL_TO` | No | Reservation email recipient |
| `PORT` | No | Express listen port |
| `SUPABASE_URL` | No* | Supabase project URL (client auth). Aliases: `VITE_SUPABASE_URL` |
| `SUPABASE_API` | No* | Supabase anon/public key. Aliases: `SUPABASE_ANON_KEY`, `VITE_SUPABASE_ANON_KEY` |
| `NODE_ENV` | No | Set to `development` by `npm run dev`; enables strict port mode |
| `STRICT_PORT` | No | Set `true` to force strict port outside development |
| `VITE_API_TARGET` | No | Overrides Vite proxy target (default: `http://localhost:${PORT}`) |

\*Both `SUPABASE_URL` and anon key are required for header auth to appear; omit either to hide auth UI.

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

---

## Docker / Cloud Run

Production image: multi-stage `Dockerfile` at the repo root.

| Stage | Role |
|-------|------|
| `build` | `npm ci` + `npm run build` (Vite → `dist/`) |
| `production` | `npm ci --omit=dev`, `node server.js` (no rebuild on start) |

**Build-time args** (optional — omit both to hide header auth in the built UI):

- `SUPABASE_URL`
- `SUPABASE_API`

**Runtime env** (required in Cloud Run / container platform):

- `RESEND_API_KEY` (required — server exits without it)
- `PORT` (Cloud Run sets this automatically, default `3000` locally)
- `EMAIL_FROM`, `EMAIL_TO`, `RESERVE_INVENTORY_EMAIL_TO` (optional)

**Local build and run:**

```bash
docker build \
  --build-arg SUPABASE_URL=https://your-project.supabase.co \
  --build-arg SUPABASE_API=your-anon-key \
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
| New page / tab | `App.svelte`, new component under `components/`, styles in `app.css` |
| New API route | `server.js`; add client function in `src/lib/` if the UI needs it |
| Email content | `server.js` reservation / send-email handlers |
| Dev proxy | `vite.config.js` `server.proxy` |
| Auth UI / session | `HeaderAuth.svelte`, `AuthModal.svelte`, `src/lib/auth.js`, `src/lib/supabase.js` |

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
