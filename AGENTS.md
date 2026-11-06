# ARL Online — Agent Guide

ARL Online is the Activist Resource Library (https://activistresourcelibrary.com): a Svelte 5 SPA, an Express server (`server.js`), Supabase Postgres, Resend email and Zoom, deployed to Google Cloud Run. This file is the map every agent (Claude Code, Cursor, others) starts from. It stays short on purpose: the detail lives in the topic docs below, so open the one you need instead of reading everything.

## Start here

1. Read this file. It is the map: rules, architecture, which code runs where, where to edit for common changes, scripts, the directory layout and what the app does.
2. Read **Where things stand** and the **Backlog** in `docs/claude-handoff.md`: what's live, what's open, and what the owner still has to do outside the repo.
3. Open the topic doc for the area you're changing. The topic docs are long, so search them for the file, function, route or locale key you're touching (for example `grep -n 'ItemCalendar' docs/frontend.md`) instead of reading them top to bottom.

| Doc | What it holds | Read it when |
|-----|---------------|--------------|
| `AGENTS.md` (this file) | Rules, architecture, where code runs, common change patterns, npm scripts, directory layout, what the app does | Always, first |
| `CLAUDE.md` | Claude Code's entry point: commands, conventions, git and deploy rules; imports the two `.cursor/rules` files | Loaded automatically by Claude Code |
| `docs/claude-handoff.md` | Production state, open owner steps, the backlog in priority order, pre-launch decisions | At the start of a session |
| `docs/frontend.md` | Every component and `src/lib` module, auth (Supabase), styling, Svelte conventions | Changing anything under `src/` |
| `docs/backend.md` | `server.js`: static assets, data, the API table, email, Slack, GA, reminders; environment variables; Docker / Cloud Run; Search Console | Changing `server.js`, a route, an env var or the deploy |
| `docs/consultations.md` | Expertise consultations end to end: flows, Zoom, schema, sanitization, emails and Slack, the files-to-touch checklist, deferred gaps | Anything about mentors, consultations, Zoom, item owners or migrations 005–008, 014, 015 |
| `docs/automated-emails.md` | Every Resend email: trigger, recipients, subject, failure behavior | Adding or changing an email |
| `docs/automated-notifications.md` | Every Kimchi bubble: trigger, locale keys, EN/FR text, timing, browser storage keys | Adding or changing a Kimchi bubble |
| `docs/automated-webhooks.md` | The Slack reservation webhook payload and the staff-booking GA event | Changing what Slack or GA receives from the server |
| `docs/changelog.md` | History: the deploy log and one row per change, newest first | Finding when or why something changed. Not needed to start work |
| `docs/Apathy_is_Boring_Brand_Guidelines.md` | Brand colors, type and voice (not wired into the app) | Design or copy work |
| `.cursor/rules/update-documentation.mdc`, `.cursor/rules/expertise-consultations.mdc` | The docs-upkeep rule and the consultation invariants | Loaded automatically (Cursor; Claude Code through `CLAUDE.md`) |

**Moved on 2026-11-05.** These sections used to be in this file. Older notes, changelog rows, commit messages and memories still point at them here:

| Old pointer | Now in |
|-------------|--------|
| `AGENTS.md` → **Expertise consultations** (with **Who hosts it**, **Schema**, **Files to touch**, **Deferred / known gaps**) | `docs/consultations.md` |
| `AGENTS.md` → **Expertise consultations → Known issues** (it duplicated the backlog) | `docs/claude-handoff.md` → **Backlog** |
| `AGENTS.md` → **Frontend** (**Components**, **Shared libraries**, **Auth (Supabase)**, **Styling** with **Page layout**, **Motion** and **Loading states**) | `docs/frontend.md` |
| `AGENTS.md` → **Backend** (**API endpoints**, **Email (Resend)**, **Slack reservation webhook**, **Staff bookings in GA**, **Day-before reminders**), **Environment variables**, **Docker / Cloud Run**, **Google Search Console setup** | `docs/backend.md` |
| `AGENTS.md` → **Changelog**, and the release entries that filled `docs/claude-handoff.md` → **Where things stand** | `docs/changelog.md` |
| `AGENTS.md` → **Related documentation** | The table above |

**Local tooling that isn't in git.** On the owner's Mac, `.claude/` (untracked) holds the dev agents' test tools: the mock backend in `.claude/harness/mock/` (runs the real `server.js` against an in-memory Supabase with recorded Resend, Zoom and Slack, so write flows can be tested without touching production; start with its `README.md`), browser harness pages in `.claude/harness/`, the `/account` agenda checks in `.claude/design-f/checks/` (`node .claude/design-f/checks/agenda-check.mjs`), preview launch configurations in `.claude/launch.json`, and old worktrees in `.claude/worktrees/`. An agent in a fresh clone, a cloud session or Cursor on another machine won't have them. Local `.env` points at **production** (Supabase, Zoom, Resend, Slack), so don't exercise write flows in `npm run dev` without the owner's go-ahead.

## Required: update documentation after edits

Any agent that changes how the website works updates the docs before finishing. `.cursor/rules/update-documentation.mdc` says the same, and `CLAUDE.md` imports it.

1. Fix the doc that covers what you changed (table above): a component or `src/lib` module → `docs/frontend.md`; a route, env var, email plumbing or deploy step → `docs/backend.md`; consultation behavior → `docs/consultations.md` (and `.cursor/rules/expertise-consultations.mdc` if an invariant changes); an email, Kimchi bubble or webhook → the matching `docs/automated-*.md`.
2. New, moved or removed files, directories, npm scripts or change patterns → this file (**Directory layout**, **Where code runs**, **npm scripts**, **Common change patterns**).
3. Add a row at the top of the **Change log** table in `docs/changelog.md` (newest first).
4. After a deploy: update **Where things stand** in `docs/claude-handoff.md` (what's in production, open owner steps, checks not yet done) and add an entry at the top of the **Deploy log** in `docs/changelog.md`. When a backlog item is fixed, delete it from the handoff.
5. If behavior no longer matches a doc, fix the doc. Never leave one describing removed files, routes or flows.

Skip doc updates for typo fixes, comment-only edits, formatting, and dependency bumps that don't change how the app runs or is developed.

Keep this file a map: detail goes in the topic docs. Don't add new markdown files unless the user asks.

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
│  - Sends staff bookings' GA event (Measurement Protocol)  │
└─────────────────────────────────────────────────────────┘
```

**Local dev:** `npm run dev` starts both required processes so the Vite URL can load API data and server-owned assets.

**Local dev uses the production database.** The local `.env` points at the production Supabase project and has live Zoom, Resend, and Slack credentials, so `npm run dev` reads and writes real data. Requesting, scheduling, or cancelling locally creates real Zoom meetings, sends real emails, and posts to Slack. Browse read-only, and test write paths against a mocked Supabase client (or a separate dev project) unless the user approves a live test. Browsing is read-only for the view counter too: `POST /api/inventory/:id/view` records only in the deployed service (`NODE_ENV=production`, set by the Dockerfile, or Cloud Run's `K_SERVICE`), so `npm run dev`, `npm start` and `npm run preview` never write a count.

| Process | Command | URL | Role |
|---------|---------|-----|------|
| Vite dev server | `npm run dev` (or `npm run dev:client`) | http://localhost:5173 | Svelte UI with HMR; proxies `/api`, `/media`, `/assets/brand`, `/assets/fonts`, `/assets/inventory`, `/robots.txt`, and `/sitemap.xml` to Express |
| Express API/static server | `npm run dev` (or `npm run dev:server`) | http://localhost:3000 | Serves API routes plus static fonts, brand logos, and inventory seed assets |

In development, Express uses a strict port so Vite's proxy cannot silently point at the wrong server. `npm run dev` (via `scripts/dev.js`) automatically frees the API port before starting — manual intervention is rarely needed. For `npm run dev:server` alone, if port 3000 is already in use you must stop the old server or set `PORT`.

**Production / preview:** `npm start` rebuilds `dist/` before starting Express. Use `npm run serve` only when you intentionally want to serve the existing built files without rebuilding.

---

## Where code runs

`src/lib/` holds browser code, server code and modules both use, side by side, with nothing in the file names to tell them apart. `server.js` imports from `src/lib/` directly: Node runs those files as they are (the production image copies `src/lib/` next to `server.js`; nothing is built for the server). Vite bundles whatever the components import. So a module the server imports must not touch `window`, `document`, `localStorage` or Svelte stores when it loads, and a browser module must never import a server-only one (that would put the service-role client in the bundle).

| Runs in | `src/lib/` modules |
|---------|--------------------|
| **Server only** (imported by `server.js` or a script) | `inventory-store.js` (every Supabase read and write for items and reservations), `supabase-server.js` (service-role client), `reservation-messages-store.js`, `item-media.js`, `zoom.js`, `email-brand.js` (also `send-email.js`), `ga-measurement-protocol.js`, `seo-server.js`, `bike-share.js`, `nearby-stations.js` (`npm run place:stations` only) |
| **Both** | `calendar.js`, `reservation-rules.js`, `expertise-fields.js`, `item-routes.js`, `item-location.js`, `slug.js`, `seo.js`, `map-tiles.js`, `booking-event.js` |
| **Browser only** | `inventory.js` (the browser's API client), `supabase.js` (anon client), `auth.js`, `router.js`, `i18n.js`, `analytics.js`, `item-views.js`, `contact.js`, `image.js`, `motion.js`, `availability-clock.js`, `notification-store.js`, `kimchi-memory.js`, `kimchi-calendar.js`, `agenda.js`, `agenda-booking.js`, `agenda-consultation.js`, `consultation-notices.js`, `transit-overlay.js`, `markdown.js`, `member-agreement.js`, `privacy-policy.js` |

Pairs that are easy to mix up: `inventory.js` (browser → `/api/*`) and `inventory-store.js` (server → Supabase); `supabase.js` (anon key, browser) and `supabase-server.js` (service role, server); `seo.js` (head tags, both sides) and `seo-server.js` (HTML injection for crawlers, server).

`server.js` is one file of about 6,000 lines with no table of contents. Find things in it by route path (`grep -n "'/api/account" server.js`) or by the function names in `docs/backend.md` → **API endpoints**, not by line number.

---

## Common change patterns

| Task | Where to edit |
|------|----------------|
| New inventory field | `src/lib/inventory-store.js`, `AddItemModal.svelte`, `InventoryCard.svelte`, API client in `inventory.js`, SQL migration if needed; add it to `toPublicItem` in `src/lib/item-location.js` only if the public may see it |
| Item locations / maps | `supabase/migrations/010_item_locations.sql` (and SQL for new places), `src/lib/item-location.js`, `src/lib/map-tiles.js` (tile hosts feed the CSP), `inventory-store.js` (cache and resolution), `server.js` (`sanitizeItemForPublic`, `memberReservationLocation`, `buildMemberDecisionEmailPayload`), `ItemDetailPage.svelte`, `AgendaBookingCard.svelte`, `LocationMapPanel.svelte`, `LocationMap.svelte`, the `item_detail.location_*` / `account_reservations.location_*` / `map.*` keys, `app.css` (`.item-location*`, `.location-map*`, `.reservation-location*`) |
| Inventory tags / filter | `inventory-store.js`, `src/lib/inventory.js`, `src/lib/item-routes.js` (`CATEGORY_ROUTES`, `ITEM_ROUTE_RE`; `router.js` re-exports them), `InventoryPanel.svelte`, `HomePage.svelte` (icon + `home.{tag}_description`; for a homepage shelf, a `SHELVES` entry + `home.{tag}_heading` / `home.{tag}_all` in both locales, and a `.home-shelf--{tag}` frame rule in `app.css` if it needs a non-square frame), `AddItemModal.svelte`, `locales/en.json` + `fr.json`, sitemap/SEO (`seo.js`, `server.js`), styles in `app.css` |
| Reservation calendar | `server.js` (reservation endpoints), `inventory-store.js`, `src/lib/calendar.js`, `src/lib/reservation-rules.js`, `ItemCalendar.svelte`, `InventoryCard.svelte`, `locales/en.json` + `fr.json` |
| Expertise consultations | See `docs/consultations.md` → **Files to touch (checklist)**. Core: `005_expertise.sql`, `007_expertise_copy.sql`, `008_consultation_follow_up.sql`, `inventory-store.js`, `server.js` emails/Slack, `ConsultationRequestForm.svelte`, `ItemDetailPage.svelte`, `AccountAgenda.svelte` + `AgendaConsultationCard.svelte` (with `src/lib/agenda.js`, `consultation-notices.js`, `agenda-consultation.js`), `AdminPanel.svelte`, `MentorBrowser.svelte`, `AccountShareExpertise.svelte`, `AddItemModal.svelte`, `locales` `consultation.*` / `account_consultations.*` / `account_agenda.*` / `share_expertise.*` / `admin.consultation_*` / `admin.mentors_*` / `kimchi.consultation_sent` / `kimchi.mentor_updated` / `kimchi.mentor_profile_*` |
| New page / tab | `App.svelte`, `src/lib/router.js`, **`APP_PAGE_PATHS` in `src/lib/item-routes.js`** (otherwise the server answers 404 and the client shows the not-found view), `ROUTE_SEO_KEYS` + `seo.*` titles in `seo.js` / locales, `SITEMAP_STATIC_PATHS` in `server.js` if public, new component under `components/`, optional `SiteNav.svelte` link, styles in `app.css` |
| New API route | `server.js`; add client function in `src/lib/` if the UI needs it |
| Email content | `server.js` (copy and triggers), `src/lib/email-brand.js` (shared branded layout) |
| Dev proxy | `vite.config.js` `server.proxy` |
| Font, brand image, or seed photo | Add the file under a **new name** in `src/assets/{fonts,brand,inventory}/` (served with a 7-day cache) and update the references. Fonts: regenerate the WOFF2 subset (see `docs/frontend.md` → **Styling**), then update the `@font-face` in `app.css` and the preload (`index.html` for Inter, `BRAND_FONT_PRELOAD` in `server.js` for Ringold) |
| Auth UI / session | `HeaderAuth.svelte`, `AuthModal.svelte`, `CompleteSignupModal.svelte`, `OAuthProviderIcon.svelte`, `src/lib/auth.js`, `src/lib/supabase.js` |
| User-facing copy / new language | Add matching keys to `locales/en.json` and `locales/fr.json`; use `$t('domain.key')` in components or `translateKey()` in `src/lib/` |
| Admin Members / Stats / Needs attention | `server.js` (`/api/admin/users*`, `/api/admin/item-views`, the `POST /api/inventory/:id/view` beacon, `requireAuth`'s suspension check), `inventory-store.js` (`cancelReservationByAdmin`, `anonymizeReservationsForEmail`, `recordItemView`, `loadItemViewStats`, `addReservation`'s `bookedByStaff`), `supabase/migrations/009_admin_stats.sql` and `012_staff_bookings.sql`, `src/lib/inventory.js` (admin wrappers, `ERROR_CODE_KEYS`), `src/lib/item-views.js`, `src/lib/analytics.js` (`isInternalTrafficBrowser`) and `src/lib/auth.js` (`isApathyAdminEmail`), so Stats and GA leave out the same staff traffic, `AdminPanel.svelte`, `AdminAttention.svelte`, `AdminUsers.svelte`, `AdminStats.svelte`, `Skeleton.svelte` (`tiles` / `stats`), locales `admin.attention_*` / `stats_*` / `users_*`, `kimchi.user_*`, `auth.account_suspended`, `app.css` (`.admin-actions`, `.admin-attention*`, `.admin-stats*`, `.admin-stat*`, `.admin-spark*`, `.admin-rank*`, `.admin-users*`, `.admin-avatar*`, `.skeleton-tile*`, `.skeleton-stat*`), and `docs/automated-emails.md` / `automated-notifications.md` for new emails or bubbles |
| Admin Create Reservation | `server.js` (`POST /api/admin/inventory/:id/reservations` with `readStaffBookingDates` / `readStaffBookingMeeting`, `buildStaffReservationEmailPayload`, `confirmedReservationEmailParts` shared with the approval email, `staffBookingAccountLine` / `staffBookingAccountParagraph` shared with a mentor meeting's emails (`buildConsultationScheduledEmailPayloads`'s `account`), `findAuthUserByEmail`, and the GA pass `sendDueStaffBookingEvents` with its middleware), `inventory-store.js` (`addReservation`'s `status`, `bookedByStaff`, `queueGaEvent`, and for a mentor `meetingAt`, `createMeeting` and `deleteMeeting`; `listPendingGaEvents`, `moveGaEvent`), `supabase/migrations/012_staff_bookings.sql` and `013_staff_booking_ga_events.sql`, `src/lib/analytics.js` (`trackBookingRequestSent`'s `bookedByStaff`), `src/lib/booking-event.js`, `src/lib/ga-measurement-protocol.js`, `isTestCancellation` in `src/lib/reservation-rules.js`, `src/lib/inventory.js` (`createStaffReservation`, `ERROR_CODE_KEYS`), `AdminCreateReservation.svelte` (plus `MeetingTimePicker.svelte`'s `parseMeetingTimeInput` / `toLocalInputValue` for a mentor's meeting time), `AdminPanel.svelte`, locales `admin.create_reservation*` / `admin.create_consultation*` / `kimchi.reservation_created*` (a mentor meeting reuses `kimchi.consultation_scheduled*`), `app.css` (`.admin-create-reservation*`), `docs/automated-emails.md` triggers 10 and 6 |
| Item owners, `/account` booking tools, reminders | `supabase/migrations/015_item_owners_and_reminders.sql`; `inventory-store.js` (`itemOwnerEmail`, `isItemOwner`, `listHostedReservationsForOwner`, `rescheduleReservation`, `rescheduleConsultation`, `reassignItemsOwnedBy`, the reminder functions); `reservation-rules.js` (`reservationStartsAt`, `isReminderDue`, `reminderStateFor`, `validateRoomTimes`, `canBookFollowUp`); `calendar.js` (`libraryWallTimeToMs`); `zoom.js` (`moveConsultationMeeting`); `server.js` (the hosted routes, `POST /api/reservations/:id/message`, `POST /api/consultations/:id/reschedule`, `loadConsultationForUser`'s `isOwner`, `consultationHostVoice`, `buildReservationMessageEmailPayload`, `buildConsultationRescheduledEmailPayloads`, `buildReservationRescheduledEmailPayload`, `buildReservationReminderEmailPayloads`, `sendDueReservationReminders` and the pass middleware, `setReminderState` / `restoreReminderIfNotEmailed` after each confirm or move); `src/lib/inventory.js`; `AccountAgenda.svelte`, `AgendaBookingCard.svelte`, `AgendaConsultationCard.svelte` (with `src/lib/agenda.js`, `agenda-booking.js`, `agenda-consultation.js`), `ReservationMessageForm.svelte`, `AccountPage.svelte`; locales `account_hosted.*`, `reservation_message.*`, `account_reservations.message_*` / `suggest_*`, `account_consultations.message_*` / `suggest_*` / `reschedule*`, `kimchi.*`; `app.css` (`.reservation-message*`, `.hosted-reschedule*`, `.agenda*`); `docs/automated-emails.md` triggers 12–18 |
| Booking conversations (messages between the member and the host) | `supabase/migrations/016_reservation_messages.sql`; `src/lib/reservation-messages-store.js` (`addReservationMessage`, `shouldNotify`, `releaseNotification`, `listReservationMessages`, `markThreadRead`, `countUnreadMessages`, `deleteReservationThreads`, called from `anonymizeReservationsForEmail`); `server.js` (`loadThreadParticipant`, `serializeThreadMessage`, `withUnreadMessages`, `GET /api/reservations/:id/messages`, `POST /api/reservations/:id/message`, `buildReservationMessageEmailPayload`); `src/lib/inventory.js` (`fetchReservationMessages`, `sendReservationMessage`); `ReservationMessageForm.svelte`, the unread sticker in `AgendaBookingCard.svelte` / `AgendaConsultationCard.svelte`; locales `reservation_message.*`; `app.css` (`.reservation-thread*`, `.consultation-status--unread`); `docs/automated-emails.md` triggers 13–14; mock harness tables in `.claude/harness/mock/preload.mjs` and scenario `s10-conversations.mjs` |
| `/account` agenda, inline questions, design F look | Sections, grouping, tools and primary actions: `src/lib/agenda.js` (re-run `node .claude/design-f/checks/agenda-check.mjs`, untracked, under several time zones). Page-wide state, loading, focus and consultation notices: `AccountAgenda.svelte` (notice rules in `src/lib/consultation-notices.js`, kept in step with `docs/automated-notifications.md`). Card markup and actions: `AgendaBookingCard.svelte` (`src/lib/agenda-booking.js`), `AgendaConsultationCard.svelte` (`src/lib/agenda-consultation.js`). A new question: `InlineConfirm.svelte` with a `*_confirm` key (never `window.confirm`); a new **More** item: the entry's `tools` in `agenda.js`, its label and `TOOL_KINDS`. Locales `account_agenda.*` (plurals as `_one` / `_other`, picked with `pluralKey`). Styles in the **Design F** block of `app.css` (`.f-*`, `.action-btn*`, `.agenda*`, `.needs-you*`, `.inline-confirm*`, `.more-menu*`, the stickers): flat, 2px `Dark` borders, no shadows, no hover lift, 3px Grape focus ring |
| New Kimchi bubble | `notify()` (a reply to the visitor's own action) or `notifyWhenIdle()` (load-time or deferred; waits for dialogs) from `src/lib/notification-store.js`, with `{ textKey, vars }` and new `kimchi.*` keys in both locales. Unprompted bubbles pass `ambient: true`. Once-only memory goes through `src/lib/kimchi-memory.js` (ids, statuses, dates and counts only) and is spent only when the id isn't `-1`. Give the message a carrier for when Kimchi sleeps (inline text or a hidden `role="status"` line), and add the row to `docs/automated-notifications.md` (new browser keys also go in the privacy policy's Kimchi bullet) |

After any of the above, update the docs (see **Required: update documentation after edits**).

---

## npm scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Starts Express API/static assets and Vite dev server together |
| `npm run dev:client` | Vite dev server only; requires an Express server at `VITE_API_TARGET` or `PORT` |
| `npm run dev:server` | Express API/static asset server in development mode (no build step) |
| `npm run build` | Production Vite build to `dist/` (SEO head tags are injected per request by Express, not at build time) |
| `npm start` | `build` + Express server, so source changes are reflected after restart |
| `npm run serve` | Express only; serves the existing `dist/` without rebuilding |
| `npm run preview` | Alias for `npm start` |
| `npm run send-email` | One-off Resend test via `send-email.js` |
| `npm run docker:build` | Docker image build with `SUPABASE_URL`, `SUPABASE_API`, and `SITE_URL` from `.env` as build args (`scripts/docker-build.sh`; set `IMAGE` for Artifact Registry tag) |
| `npm run cloud:build` | Manual deploy; normal deploys happen on every push to `main` (see `docs/backend.md` → **Docker / Cloud Run**). Use it to change Cloud Run env vars or secrets. Build + push + deploy via Google Cloud Build (no local Docker required). Reads Supabase + `SITE_URL` from `.env` (default production URL `https://activistresourcelibrary.com`); deploys to `arl-online` in `us-east1`. Images push to Artifact Registry in `us-east1` (`GCP_ARTIFACT_REGION`). Sets runtime env on Cloud Run (`SITE_URL`, optional `EMAIL_*`, `SLACK_RESERVATION_WEBHOOK_URL`, `ZOOM_ACCOUNT_ID` + `ZOOM_CLIENT_ID` (both required together), `ZOOM_HOST_USER`, `ORG_PHONE`, `EMAIL_FUNDER_LOGO_URL`); mounts `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, and `ZOOM_CLIENT_SECRET` (`zoom-client-secret`, must already exist in Secret Manager) via `--set-secrets` (see comment block in `scripts/cloud-build.sh`). `--set-env-vars` **replaces** the whole env list, so anything set by hand in the Cloud Run console (e.g. `ORG_ADDRESS`) is wiped on the next deploy. |
| `npm run migrate:inventory` | Upsert `data/inventory.json` into Supabase (`inventory_items` + `reservations`); requires `data/inventory.json` to exist |
| `npm run place:stations -- <lat> <lon> <location-id>` | Looks up a place's nearby métro, light-rail and commuter-rail stations on OpenStreetMap (one Overpass query) and prints the `UPDATE item_locations SET nearby_stations = …` to run in the Supabase SQL editor. Touches no database. Run it when a place is added or a line opens |
| `npm run zoom:check` | Verify Zoom credentials: token, granted scopes, host user, and host screen-share settings (needs network) |
| `npm run backfill:slugs` | Populate slugs on existing `inventory_items` rows with a null/empty slug (idempotent; safe to re-run). Use after applying `004_inventory_slug.sql` to fix items that have `slug = null` |

---

## Directory layout

```
ARL-Online/
├── AGENTS.md              # This file — the agent map (start here)
├── CLAUDE.md              # Claude Code entry point: commands, conventions, git/deploy rules; imports the Cursor rules below
├── .claude/               # Untracked, owner's Mac only: dev-agent harness (harness/mock), design F checks, launch.json, worktrees/ (see Start here)
├── .cursor/rules/         # Cursor rules: update-documentation.mdc, expertise-consultations.mdc
├── Dockerfile             # Multi-stage production image (see docs/backend.md → Docker / Cloud Run)
├── cloudbuild.yaml        # Used only by the manual npm run cloud:build; pushes to main deploy through a trigger set up in Google Cloud, not this file
├── .gitignore             # node_modules, dist, .env, data, .DS_Store, .claude/worktrees/ (the rest of .claude/ is untracked but not ignored)
├── .dockerignore          # Keeps .env, node_modules, dist out of the Docker context
├── index.html             # Vite HTML entry (not served directly in prod)
├── vite.config.js         # Vite + Svelte; build outDir: dist; API/static asset proxy in dev
├── svelte.config.js       # Svelte preprocessor config
├── server.js              # Express app: API, static files, email
├── send-email.js          # Standalone Resend smoke-test script (not the web app)
├── scripts/
│   ├── dev.js             # Starts Express + Vite together for npm run dev
│   ├── migrate-inventory-to-supabase.js  # Upsert data/inventory.json into Supabase (with slug generation)
│   ├── backfill-slugs.js  # Populate null/empty slugs on existing inventory_items rows (idempotent)
│   ├── docker-build.sh    # npm run docker:build (Supabase + SITE_URL build args from .env)
│   ├── cloud-build.sh     # npm run cloud:build (Cloud Build → Cloud Run; Secret Manager setup in header comment)
│   ├── place-stations.js  # npm run place:stations: prints the SQL that stores a place's nearby stations
│   └── zoom-check.js      # Verify Zoom S2S credentials, scopes, host user (npm run zoom:check)
├── supabase/
│   └── migrations/
│       ├── 001_inventory.sql  # inventory_items + reservations tables (apply in Supabase SQL Editor)
│       ├── 002_reservation_approval.sql  # user_email + pending/reserved/refused statuses
│       ├── 003_lock_down_roles.sql  # REVOKE table access from anon/authenticated roles
│       ├── 004_inventory_slug.sql   # slug column + unique (tag, slug) index for item detail URLs
│       ├── 005_expertise.sql   # expertise tag + expert_email + consultation fields (time_slots, request_summary, meeting_at)
│       ├── 006_consultation_scheduling.sql # cancelled status + zoom_meeting_id/join_url/password + cancelled_at/by
│       ├── 007_expertise_copy.sql # expertise long_body (short list text stays in body)
│       ├── 008_consultation_follow_up.sql # reservations.follow_up_of (expert-booked follow-up consultations)
│       ├── 009_admin_stats.sql # reservations.created_at + anonymized_at, item_views table + view-count functions (admin Stats, member delete)
│       ├── 010_item_locations.sql # item_locations table (seeded with the office) + inventory_items.location_id, backfilled
│       ├── 011_item_location_stations.sql # item_locations.nearby_stations, the office's stations and its corrected transit note
│       ├── 012_staff_bookings.sql # reservations.booked_by_staff (Create Reservation rows, the Staff count in Stats)
│       ├── 013_staff_booking_ga_events.sql # reservations.ga_event + ga_event_at (staff bookings' GA event, sent by the server an hour late)
│       ├── 014_account_email_change.sql # auth.users trigger: an account's email change moves its mentor item and reservations
│       ├── 015_item_owners_and_reminders.sql # inventory_items.owner_email (backfilled), reservations.reminder_email + reminder_email_at, 014's function plus owner_email
│       └── 016_reservation_messages.sql # reservation_messages + reservation_message_state: booking conversations, read and emailed times per side
├── package.json
├── .env.example           # Required env template (copy to .env)
├── content/
│   ├── kimchi.jpg         # 311 KB original photo; nothing in the app references it
│   ├── kimchi-awake.jpg, kimchi-sleep.jpg # Kimchi avatar images, 128 px (2× the 64 px avatar); under Vite's 4 KB limit, so inlined into the JS bundle
│   ├── contracts/         # Member agreement: `en/member-agreement.md` (live), `fr/member-agreementfr.md` (empty placeholder, not wired in)
│   └── policies/          # Privacy policy (Québec Law 25): `en/privacy-policy.md`, `fr/privacy-policy.md` (both live at `/privacy`)
├── locales/               # UI copy: en.json + fr.json (nested snake_case keys)
├── data/                  # Gitignored — optional legacy inventory.json for one-time import
├── dist/                  # Gitignored — Vite production build output
├── docs/                  # Topic docs (frontend, backend, consultations, automated-{emails,notifications,webhooks}), claude-handoff.md (state + backlog), changelog.md (history), brand guidelines; screenshots/ holds two June 2026 header screenshots nothing links to
├── public/
│   ├── robots.txt         # Crawler rules + sitemap URL (copied to dist/ at build)
│   ├── favicon.ico        # 16 + 32 px PNGs in an ICO container; favicon-16x16.png, favicon-32x32.png, apple-touch-icon.png (180) beside it
│   └── assets/
│       └── fonts/         # Symlink → src/assets/fonts (so Vite resolves @font-face at build)
├── src/
│   ├── main.js            # Mounts App.svelte when #app exists, imports app.css
│   ├── App.svelte         # Root layout: routing, inventory state, header, modals
│   ├── app.css            # Global styles (fonts, layout, components)
│   ├── components/
│   │   ├── HomePage.svelte         # `/` landing page: welcome copy, four icon links to the category grids, random experts, equipment, books and rooms
│   │   ├── InventoryPanel.svelte   # Tag filter, grid, reserve auth gate, shared modals, availability clock
│   │   ├── InventoryCard.svelte    # Card: whole card links to /{tag}/{slug} (stretched title link); availability badge (hidden for expertise) + Reserve / Request Consultation. Expertise uses the same card (photo, name, short text)
│   │   ├── ItemDetailPage.svelte   # /{tag}/{slug} item overlay (`<dialog>`): breadcrumb, 3-col grid or compact expertise panel (photo, long text, consultation form), location (or "Meetings available online"), auth gate; rendered on top of the grid
│   │   ├── LocationMapPanel.svelte # An opened map: lazy-imports LocationMap, with a loading frame and Try again
│   │   ├── LocationMap.svelte      # Leaflet map (own chunk + Leaflet CSS): area circle or exact pin, Streets / Transit switch
│   │   ├── ReserveAuthRequiredModal.svelte # Dialog when signed-out user clicks Reserve (prompts sign up)
│   │   ├── ItemCalendar.svelte     # Month calendar: block reserved dates, create reservations
│   │   ├── ConsultationRequestForm.svelte # Expertise items: up to three Date / From / To times + own words + summary, "Who sees this", Send request; a "Request sent" panel after (replaces calendar)
│   │   ├── AdminPage.svelte        # `/admin` page shell: access gate + page header + AdminPanel
│   │   ├── AccountPage.svelte      # `/account` page: member email, sign out, admin link, Share Expertise + Member agreement + Change password buttons, then the agenda (AccountAgenda)
│   │   ├── AccountShareExpertise.svelte # `/account` Share Expertise: one mentor profile, edit when email matches
│   │   ├── AccountAgenda.svelte    # `/account` agenda (design F): loads own bookings, hosted bookings and consultations; Needs you, Coming up (week timeline), Changed since your last visit, Earlier; one action / menu / panel / question at a time; consultation notices (Kimchi B4–B6, C8)
│   │   ├── AgendaBookingCard.svelte # One agenda entry for a booking: own (withdraw / cancel, message the host, suggest a new time, address + map), a group of own bookings, or a hosted one (approve / decline, new dates, message the member, cancel)
│   │   ├── AgendaConsultationCard.svelte # One agenda entry for a consultation, either role: schedule (Needs you), Join Zoom, cancel / withdraw / decline, choose a new time, follow-up, messages
│   │   ├── InlineConfirm.svelte    # A question in the page instead of window.confirm: the *_confirm text, Yes + Keep it, Escape cancels (/account and /admin)
│   │   ├── MoreMenu.svelte         # The "More" disclosure on an agenda entry: a button and a list of action buttons (not an ARIA menu); Escape / outside click closes
│   │   ├── ReservationMessageForm.svelte # A booking's conversation (GET /api/reservations/:id/messages) and its field (POST …/message; Send / Close); focus()
│   │   ├── ConfirmationMessage.svelte # Optional "Message to the member" textarea (label, hint, bindable value) under Schedule / Approve; max CONFIRMATION_MESSAGE_MAX
│   │   ├── MeetingTimePicker.svelte # Visible native datetime-local field with <label>, hint and bindable error; focus(); exports nowLocalInputValue() and parseMeetingTimeInput()
│   │   ├── AdminPanel.svelte       # Admin UI: add/remove items, mentors, reservations, members, stats
│   │   ├── AdminAttention.svelte   # Admin "Needs attention" strip: pending / next-7-days consultations / overdue count tiles
│   │   ├── AdminUsers.svelte       # Admin Members: account list, bookings, display name, password reset, suspend, delete
│   │   ├── AdminCreateReservation.svelte # Admin Create Reservation: book an item for any email (member or not), confirmed and emailed
│   │   ├── AdminStats.svelte       # Admin Stats: view and request counts, 30-day sparkline, rankings, quiet items
│   │   ├── MentorBrowser.svelte    # Admin mentors list + edit expertise details
│   │   ├── AddItemModal.svelte     # Dialog form for new items (includes tag/category selector)
│   │   ├── AuthModal.svelte        # Login / register / reset-password dialog (Google/Discord OAuth buttons + email/password; register requires member agreement + optional email-updates opt-in; Forgot password? → reset view)
│   │   ├── OAuthProviderIcon.svelte # Inline Google / Discord logo SVG for the OAuth buttons
│   │   ├── CompleteSignupModal.svelte # Post-OAuth dialog: sign the member agreement (or sign out) before using the account
│   │   ├── SetPasswordModal.svelte # New-password dialog: after a reset link signs the member in, or Change password on /account
│   │   ├── MemberAgreementModal.svelte # Scrollable member contract dialog on sign-up
│   │   ├── SiteNav.svelte          # Header nav: Inventory + How it works (client-side routing)
│   │   ├── HowThisWorksPage.svelte # `/howthisworks` guide: browse, account, reserve, approval, pickup, CTA, FAQ
│   │   ├── AboutPage.svelte        # `/about` page: mission, partners, privacy link, public contact form (`#contact`)
│   │   ├── PrivacyPage.svelte      # `/privacy` page: renders `content/policies/{locale}/privacy-policy.md`
│   │   ├── HeaderAuth.svelte       # Site header auth: Log in / Register or View account + Sign out + modal wiring (AuthModal, CompleteSignupModal, SetPasswordModal)
│   │   ├── LocaleSwitcher.svelte   # EN/FR toggle in site header
│   │   ├── KimchiNotification.svelte # Bottom-right Kimchi widget shell: avatar + stacked bubbles, greetings and welcomes, sleep, taps, bubble links
│   │   ├── PageLoadError.svelte    # `{:catch}` for App.svelte's lazy chunks: one guarded auto-reload, then a reload notice (in `<main>`, or floating for the item overlay)
│   │   ├── Skeleton.svelte         # Content-shaped loading placeholder (rows / form / page / detail variants), optional delayed status
│   │   ├── BusyLabel.svelte        # Button label that keeps its verb and adds hopping dots while busy (no width change)
│   │   ├── RouteProgress.svelte    # `{:pending}` for lazy chunks, and page changes waiting on one: Mint hairline at the top of the viewport + delayed status
│   │   ├── LoadingStatus.svelte    # Visually hidden role=status, empty at mount, filled after 1s
│   │   └── KimchiBubble.svelte       # Single Kimchi chat bubble (spring pop-in, leaves at once, auto-dismiss that pauses on hover/focus)
│   ├── lib/
│   │   ├── auth.js        # Supabase session store + sign-in/up/out + OAuth helpers (`signed_member_agreement`, `email_updates_opt_in` on sign-up) + password reset/change
│   │   ├── member-agreement.js # Loads `content/contracts/` markdown by locale; renders HTML via `markdown.js`
│   │   ├── privacy-policy.js   # Loads `content/policies/` markdown by locale (EN + FR); renders HTML via `markdown.js`
│   │   ├── markdown.js         # Shared `Marked` instance factory for legal copy; controls which links open in a new tab
│   │   ├── i18n.js        # Locale store + `$t()` translate function (en/fr JSON)
│   │   ├── inventory.js   # API client + legacy localStorage migration (`expertise` in INVENTORY_TAGS; consultation create/approve payloads)
│   │   ├── reservation-messages-store.js # Booking conversations (016): add / list / mark read, once-until-read email decision, unread counts, delete on account deletion
│   │   ├── inventory-store.js # Supabase inventory + reservation CRUD (server; expert_email + long_body + consultation fields; skip collisions for expertise)
│   │   ├── expertise-fields.js # Short/long expertise text length limits (shared by client + server)
│   │   ├── calendar.js    # Date/reservation helpers (shared by client + server.js)
│   │   ├── availability-clock.js # Shared 60s clock for badge + calendar "today"
│   │   ├── motion.js      # `revealOnLoad` image attachment (hidden over its frame's fill while loading, then swapped in within one frame)
│   │   ├── image.js       # Client-side image compression (canvas → WebP, JPEG fallback)
│   │   ├── item-media.js  # Server only: data-URL photo → /media/items/{id}/{hash}.{ext} URL, parsing, 2,000,000-char upload cap
│   │   ├── contact.js     # About-page contact form client (POST /api/contact)
│   │   ├── item-views.js  # Item page view beacon for admin Stats (once per item per tab session and day; staff and staff-flagged browsers skipped)
│   │   ├── analytics.js   # GA4 `track()`, `booking_request_sent`, conversions `arl_account` / `arl_request` + staff browsers tagged `traffic_type: internal`
│   │   ├── booking-event.js # `booking_request_sent` name + parameters, shared by analytics.js and the server
│   │   ├── ga-measurement-protocol.js # GA4 Measurement Protocol sender for staff bookings' event (server only)
│   │   ├── item-routes.js # Shared category/item path helpers + `isKnownAppPath` (server 404s and the client not-found view)
│   │   ├── item-location.js # Item places: office fallback, address lines (EN/FR), directions URL, public/member location shapes, `toPublicItem` whitelist
│   │   ├── map-tiles.js   # Map tile layers (OpenStreetMap streets, Thunderforest Transport) + their hosts for the CSP
│   │   ├── transit-overlay.js # Map layer: stations (line colours, distances, edge chips) and bike-share docks, as DOM markers
│   │   ├── nearby-stations.js # Overpass query + parser for a place's nearby stations (place:stations script; server only)
│   │   ├── bike-share.js  # GBFS reader with caches for GET /api/bike-share (server only)
│   │   ├── notification-store.js # Queue store + `notify()` / `notifyWhenIdle()` API for Kimchi chat bubbles: sleep gate (remembered), ambient budget, kinds
│   │   ├── kimchi-memory.js # Kimchi's per-browser memory: storage helpers, per-user snapshots, once-per-id lists, Montréal day flags (ids, statuses, dates and counts only)
│   │   ├── kimchi-calendar.js # Kimchi's calendar: 15 Canadian holidays + 3 days of remembrance (quiet days), pure date-key functions
│   │   ├── router.js      # Client-side routing: inventory (incl. /expertise), item detail /{tag}/{slug}, admin, static pages
│   │   ├── reservation-rules.js # Tag block rules (equipment/books fixed Tue blocks; rooms + expertise flexible)
│   │   ├── agenda.js      # /account agenda: buildAgenda (sections, Sunday-first weeks, groups, due-back rows), each entry's tools and primary action, label helpers (pure)
│   │   ├── agenda-booking.js # AgendaBookingCard's rules: tool labels, who cancelled, the host's new-dates draft and checks (pure)
│   │   ├── agenda-consultation.js # AgendaConsultationCard's fixed parts: cancel feedback by role (A7), message tools, labels, meeting time checks and formats (pure)
│   │   ├── consultation-notices.js # /account consultation notices: held / closed rows, B4 snapshot diff, B6 timing and nudge, the one load-time bubble (B6 > B4 > B5 > C8) (pure)
│   │   ├── seo.js         # Client SEO: meta/OG/Twitter/canonical/hreflang/JSON-LD + per-item Product schema
│   │   ├── seo-server.js  # Async server HTML injection for crawlers (item lookup by slug)
│   │   ├── slug.js        # slugifyTitle() + ensureUniqueSlug() for immutable per-tag item URLs
│   │   ├── supabase.js    # Supabase browser client (anon key)
│   │   ├── supabase-server.js # Supabase service-role client (server only)
│   │   ├── zoom.js            # Zoom Server-to-Server OAuth client: create/delete consultation meetings (server only)
│   │   └── email-brand.js     # Apathy is Boring HTML + plain-text layout for Resend emails
│   └── assets/
│       ├── brand/         # Apathy is Boring + FES logos; served at /assets/brand (`apathy-is-boring-wordmark.png` is the trimmed 830×385 wordmark for the header and homepage; `apathy-is-boring-logo.png` is the padded 1024 px square kept for og:image and icons)
│       ├── fonts/         # Inter + Ringold; served at /assets/fonts. The site loads only the WOFF2 subsets (inter/Inter-latin.woff2, ringold/Ringold-Sans.woff2 for every page's band title); the TTF/OTF and inter/static/ are unreferenced sources
│       └── inventory/     # Seed catalog from MyTurn library; served at /assets/inventory/
│           ├── items.json # 9 items: title, body, image path, sourceId, tag
│           └── images/    # Downloaded item photos (jpg/jpeg/png)
```

Besides `robots.txt` and the fonts symlink, `public/` holds the site icons: the AisB wordmark trimmed and centred on a Lemon (`#ffdd2a`) square with about 12% padding, exported as `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png` (180 px, opaque for iOS) and `favicon.ico` (the 16 and 32 PNGs). They were generated with `sharp` outside the repo; to change them, regenerate all four from `src/assets/brand/apathy-is-boring-logo.png`. Vite copies them to the `dist/` root and Express serves them from there (`public, max-age=3600`). Font files live under `src/assets/fonts/` and are symlinked at `public/assets/fonts/` so Vite can resolve them during `vite build` (avoids “didn't resolve at build time” warnings). Express still serves the canonical copies from `src/assets/fonts` at runtime.

---

## What this app does

ARL Online is a small inventory browser with an admin flow:

- **Homepage** — `/` (`HomePage.svelte`) is a short welcome (`home.heading`, `home.intro`, `home.free`), four category links with icons (Expertise, Equipment, Books, Rooms, each with a one-line `home.{tag}_description`), **Meet our experts** (four random mentors, linking to their profiles), the same kind of random picks from the other shelves (**View our equipment** and **Browse our books**, four each; **See our rooms**, two), and two numbered steps at the bottom of the card.
- **Site footer** — every page ends with `SiteFooter.svelte`: the library's name and a one-line blurb, the **Created by** FES / **Run by** Apathy is Boring logos, a **Library** column (the four categories) and a **Help & info** column (How it works, About, Contact us, Privacy policy, Join our Discord), then a copyright line.
- **Inventory** — lists items (title, body, image, tag) loaded from the server. Filter buttons show **Expertise**, **Equipment**, **Books**, or **Rooms**, in `INVENTORY_TAGS` order (a 2×2 grid on phones, one column at ≤360px). Category paths: `/equipment`, `/books`, `/rooms`, `/expertise` (`/` is the homepage, not a category). Non-expertise cards show a real-time **Available**, **Check availability** (no bookable window within 7 days), or **Unavailable** badge (confirmed `reserved` only — pending requests do not mark the card unavailable); **expertise cards hide the badge**. Clicking anywhere on a card or on **Reserve Inventory** / **Request Consultation** updates the browser URL to `/{tag}/{slug}` (Reserve/Request adds `?reserve=1`) while keeping the inventory grid mounted; `ItemDetailPage` renders the item as a modal **overlay** (`<dialog>`) on top of the grid (it is no longer a full-page route). Equipment, books, and rooms use a three-column overlay (image | description | calendar). Expertise uses a compact overlay (small photo, long bio, consultation form). Availability status appears inline in the breadcrumb after the item title (hidden for expertise). The Expertise list shows each expert's short text; the long text appears when that expert is opened. Signed-out users who confirm a reservation/consultation or arrive via `?reserve=1` see a sign-up prompt dialog (Register opens the header auth modal). `?reserve=1` scrolls/highlights the right column for signed-in users. Closing the overlay (X, Escape, backdrop click, or browser Back) returns to the underlying inventory/category path; deep links / refreshes on `/{tag}/{slug}` render the matching category grid with the overlay open on top. Confirming dates (equipment/books/rooms; rooms also ask for a **Start time**, an **End time** and **What will you use the room for?**) submits a **pending** reservation via `POST /api/inventory/:id/reservations` (member email derived from JWT on the server), which triggers the optional Slack webhook (awaited for at most 5 s; a Slack failure never fails the request). The member sees a message that AisB will review and email confirmation, and can follow the request (and withdraw it, or cancel an approved booking before its first day, message the item's host or suggest a new time) on the `/account` agenda (`AccountAgenda.svelte`). Reservation create requires a valid Supabase session (`Authorization: Bearer` JWT). Cancelling the auth prompt removes `?reserve=1` via `history.replaceState`. See `docs/consultations.md` for the consultation flow.
- **Item locations** — every equipment, book and room item has a place (`item_locations`, migration 010; all current items are at the Apathy is Boring office, 5310 Boulevard Saint-Laurent, Montréal QC H2T 1S1). **Publicly** the item overlay shows only the city, province and postal code (**Pickup location** for equipment and books, **Location** for rooms; FR `Montréal (Québec) H2T 1S1`), "You'll get the full address once your reservation is confirmed.", and a **Show map** toggle that opens an approximate 300 m area (no pin). Expertise overlays say **Meetings available online** instead. The **full address** (place name, street, exact pin, **Get directions**) goes only to the member: in the reservation approval email (which also has the transit note) and on `/account` for a confirmed reservation that hasn't ended. Maps are Leaflet, loaded only when someone opens a map: OpenStreetMap street tiles by default, or Thunderforest's Transport tiles (bus routes with their numbers) behind a **Transit** button when `THUNDERFOREST_API_KEY` is set. On both sit our own markers: the place's nearby métro and train stations in their line colours with a distance (an edge chip points the way when a station is off the map; `item_locations.nearby_stations`, migration 011) and live bike-share docks with "bikes / free docks" (BIXI, through `GET /api/bike-share`), with the same facts as text under the map. Directions are a Google Maps link (no key) with transit selected; confirmed bookings also get **Open in Transit** (the Transit app's trip planner). There is no admin screen for places yet: new items go to the office, and other places are added by SQL (see the header of `010_item_locations.sql`).
- **Item owners and booking tools** — every item has an owner, its host (`inventory_items.owner_email`, migration 015). Items that had none went to samuel@apathyisboring.com; a new item gets its creator (the admin who adds it in `/admin`, or the member who publishes a mentor profile with **Share Expertise**). For a mentor the effective owner is the mentor's own `expert_email` when set, else `owner_email` (`itemOwnerEmail()` in `inventory-store.js`). The owner manages the item's bookings from the `/account` agenda (`AccountAgenda.svelte`): a request for a room, equipment or book waits under **Needs you** with **Approve** (**Choose new dates**, **Message the member** and **Decline request** in its **More** menu), and a confirmed booking of their item sits on the timeline with a **Your item** sticker (choose new dates, message the member, cancel); a mentor's requests wait under **Needs you** with **Schedule meeting**, and its meetings offer message the member, choose a new time, book a follow-up from the day of the meeting and cancel from **More**. The person who booked gets **Message the host** and, until it starts, **Suggest a new time** on every active booking of any kind, in the entry's **More** menu with **Withdraw request** or **Cancel**: a conversation on the booking (migration 016, `reservation_messages`) that both sides read and answer on `/account`. A new message emails the other side (the effective owner, the library inbox when there is none, or the member) only when they have opened the conversation since the last such email, so a run of messages sends one email; the email's Reply-To is the library's (`EMAIL_REPLY_TO`), so neither side gets the other's address from it. Unread messages show as an **N new messages** sticker on the entry that opens the conversation. Nothing moves until the host acts. About a day before a confirmed booking starts, the deployed server emails a reminder ("Your reservation is coming up!"; for a mentor meeting, "Your consultation is coming up!" to the member and the mentor). See `docs/consultations.md`, `docs/backend.md` → **Day-before reminders**, and `docs/automated-emails.md` triggers 12–18. No admin screen shows or changes an owner yet (SQL only).
- **Header admin** — signed-in `@apathyisboring.com` admins reach `/admin` via the **Admin** link on the `/account` page (not the site header). The admin page shows add-item (including Expertise + optional expert email), **Mentors** (browse expertise items and edit name, expert email, short text, long text, and photo; the public slug stays the same), remove-items, **Pending Reservations** (approve/refuse; expertise rows require a meeting date+time and approving schedules the Zoom consultation), and **Edit Reservations** (delete approved reservations; each row shows the member's email; expertise rows show booked meeting time + Zoom link, and deleting one cancels the Zoom meeting and emails both people; deleting an equipment, book or room booking that hasn't ended emails the member), and **Create Reservation** (book equipment, a book or a room for any email address, member or not, or a meeting with a mentor at a set time, which gets its Zoom link at once; see `docs/frontend.md` → **Components** → `AdminCreateReservation`); images are compressed client-side before upload. Every action that changes something (remove, approve, refuse, delete, follow-up, Create Reservation, and Members' password reset, suspend and delete) first asks an inline question in its row or under its form (`InlineConfirm.svelte`), not a browser dialog. Approve/refuse call `POST .../approve` or `POST .../refuse` and email the member via Resend. Above the toggles a **Needs attention** strip counts pending requests, consultations in the next 7 days and overdue requests (each tile opens its list). **Members** lists every Supabase account (search, filter, their bookings, a staff-only display name, **Send password reset**, **Suspend**, **Delete**), and **Stats** shows item page views (an anonymous, cookieless per-item daily counter fed by the item overlay), request counts and rankings (see `docs/frontend.md` → **Components** → `AdminAttention`, `AdminUsers`, `AdminStats`). Non-admins who visit `/admin` directly see an access-denied message.
- **Header auth** — optional Supabase email/password login and registration, plus **Log in / Sign up with Google** and **with Discord** buttons above the email form for each OAuth provider enabled in Supabase (see `docs/frontend.md` → **Auth (Supabase) → OAuth providers**) (Log in / Register in the site header when signed out; **View account** + **Sign out** when signed in — Sign out triggers Kimchi `kimchi.signed_out`). **View account** navigates to `/account`. Sign-up requires reading the member agreement (`content/contracts/{locale}/member-agreement.md`; covers borrowing, the online account, booking and sharing Expertise, and links the privacy policy at `/privacy`) via a lavender **Sign contract** button; agreeing sets a mint checkmark and stores `signed_member_agreement: true` in Supabase `user_metadata` on `signUp`. Register also includes an optional unchecked **email updates** checkbox; the choice is stored as `email_updates_opt_in` in `user_metadata`. **Forgot password?** in the login form emails a Supabase reset link that brings the member back to the page they were on with a **Set a new password** dialog, and `/account` has **Change password** for accounts with an email/password login (see `docs/frontend.md` → **Auth (Supabase) → Password reset and change**). An account suspended from admin **Members** can't sign in (email/password and Google/Discord both show `auth.account_suspended`), and the server refuses the token it still holds (403 `account_suspended`). Mutating API routes validate the Supabase JWT server-side; admin routes also require an `@apathyisboring.com` email.

Admin UI is hidden unless Supabase auth is configured and the user is signed in with an `@apathyisboring.com` email (`isApathyAdmin` in `src/lib/auth.js`).
