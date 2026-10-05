# Claude Code handoff — 2026-10-05

Claude Code is taking the lead on ARL Online from here. This is the state of the project at handoff and what to do next. `AGENTS.md` stays the canonical map; this file is the working backlog. Update or trim it as items are done.

## Where things stand

- **GitHub:** everything is committed and pushed to `main` (`github.com/samuelaisb/ARL-Online`). The big feature commit is `355cc29` (Expertise consultations, Zoom scheduling, Share Expertise, branded emails). The docs-alignment + handoff commit follows it.
- **Build:** `npm run build` passes with no Svelte or accessibility warnings. `node --check` passes on `server.js` and all new server libs. Every locale key used in `src/` exists in both `en.json` and `fr.json`.
- **No secrets** in the repo. `.env` is gitignored. `.DS_Store` files are now untracked and ignored.
- **Production (confirmed by the user, 2026-10-05):**
  - This work is live on Cloud Run (`arl-online`, `us-east1`).
  - Migrations `005_expertise.sql`, `006_consultation_scheduling.sql`, and `007_expertise_copy.sql` are applied to the production Supabase project.
  - Zoom works in production: consultations create and delete Zoom meetings, so `zoom-client-secret` is in Secret Manager and bound.
  - Future migrations are still applied by hand in the Supabase SQL editor, and the startup schema check only probes migration 002, so a missing migration shows up on the first request that needs it, not at boot.

## What shipped in `355cc29` (summary)

The Expertise category is a fourth inventory tag. Members request a consultation with free-text time slots and a summary. The expert (the signed-in user whose confirmed email matches the item's `expert_email`) or an admin schedules a time. That creates a Zoom meeting and emails both people a link and an `.ics` invite. Member, expert, or admin can cancel, which deletes the meeting and emails both. Any confirmed member can publish one mentor profile from `/account` (**Share Expertise**), and admins edit mentors from `/admin` → **Mentors**. All transactional emails share one branded layout (`src/lib/email-brand.js`). SEO is now injected per request (the build-time prerender was removed). The full flow is in `AGENTS.md` → **Expertise consultations**.

## Backlog, in priority order

The 2026-10-05 review found no high-severity issues. Authorization on the schedule/cancel/mentor-profile routes holds, emails are HTML-escaped, and public routes strip private fields. These are the real problems, most important first. Line numbers drift, so they're given by function.

### 1. Schedule race can leak Zoom meetings and send false "confirmed" emails (medium)

- **Where:** `scheduleConsultation` in `src/lib/inventory-store.js`; `refuseReservation`, `removeReservation`, `patchReservation`, `deleteInventoryItem` in the same file.
- **Problem:** the final update filters on `.eq('status', 'pending')` but never checks that a row changed (supabase-js returns no error on zero rows). The four functions above don't take `withItemLock`, so an admin refuse/delete during the Zoom call (up to ~30 s) makes the update a no-op. The meeting stays alive and both people get "Consultation confirmed".
- **Fix:** add `.select('id')` to the update. If no row comes back, delete the meeting and return `{ invalidStatus: true }`. Wrap the four functions in `withItemLock(itemId, …)`.

### 2. Admin reservation PATCH bypasses the consultation lifecycle (medium)

- **Where:** `PATCH /api/inventory/:id/reservations/:reservationId` in `server.js` → `patchReservation`.
- **Problem:** on expertise rows it can set `pending`/`reserved`/`refused` with no Zoom create/delete and no email. It can revive a cancelled consultation (re-scheduling then orphans the old meeting) or mark one `reserved` with no `meeting_at`.
- **Fix:** return 400 when `item.tag === 'expertise'`. Consultations change only through schedule, cancel, or refuse.

### 3. Calendar-invite (ICS) injection through mentor names (medium)

- **Where:** `icsEscape` and `icsFold` in `server.js`; `readMentorProfileInput` in `server.js`; admin `PATCH /api/inventory/:id`.
- **Problem:** `icsEscape` only replaces `\r?\n`, so a bare `\r` gets through. Since Share Expertise, any confirmed user controls the title written into `SUMMARY:`. The title also goes into email subjects.
- **Fix:** `.replace(/\r\n|\r|\n/g, '\\n')` and strip other control characters in `icsEscape`. Reject `/[\u0000-\u001f\u007f]/` in titles on both write paths. While there, make `icsFold` fold at 75 bytes without splitting a UTF-8 character (it currently counts 73 JS characters).

### 4. Members can harvest mentor emails (medium, privacy)

- **Where:** `serializeConsultationForUser` (member view) behind `GET /api/account/consultations`.
- **Problem:** `expertEmail` is returned while the request is still `pending`. Anyone can request, read the email, cancel to free the slot, and repeat.
- **Fix:** only return `expertEmail` once `status === 'reserved'` (or never; the scheduled email already introduces them). Update the `AGENTS.md` sanitization table and the `.cursor/rules/expertise-consultations.mdc` "Account API" invariant to match.

### 5. Lower-priority server hardening

- 10mb JSON parsers run before `requireAuth` and the rate limiter on `/api/account/mentor-profile` and `POST`/`PATCH /api/inventory`. Order them as limiter → `requireAuth` → parser (`requireAuth` only reads headers).
- `src/lib/zoom.js` keeps a rejected token cached until expiry. On a 401, clear `cachedToken` and retry once.
- `meetingAt` validation (`Date.parse`) accepts strings without a timezone and has no upper bound. Require `Z` or an offset and cap it at about one year ahead.
- Two people publishing the same mentor name at once can hit the unique `(tag, slug)` index and get a 500. Catch the unique violation and retry with a new suffix.
- `checkReservationSchema()` only probes migration 002. Also probe the 005–007 columns (`time_slots`, `meeting_at`, `zoom_meeting_id`, `cancelled_by`, `expert_email`, `long_body`) and log which migration is missing.
- Optional: add a check constraint on `reservations.cancelled_by` (`member`/`expert`/`admin`) in a new `008_*.sql`.

### 6. Client fixes (low)

- `AccountConsultations.svelte`: both buttons show a progress label during either action ("Cancelling…" while scheduling). Track an `actionType` next to `actionId`.
- `ItemDetailPage.svelte` + `ConsultationRequestForm.svelte`: the consultation success message appears twice. Let only the form show it.
- `AdminPanel.svelte` meeting picker has no `min` and no past-time check; the server rejects it only after the confirm dialog. Pass `min` and pre-check in `handleApprove` (and `handleSchedule` in `AccountConsultations.svelte`).
- `AccountShareExpertise.svelte`: a 409 on create overwrites what the user typed with the existing profile. On 409, set `profile` only and keep the typed fields so the next Save PATCHes.
- Links from `/account` into an expert overlay use `navigate(path)`, so closing the overlay lands on `/expertise` instead of back on `/account`. Push with the `{ arlItemOverlay: true }` history marker (add a small helper in `router.js`).
- `AccountPage.svelte`: `aria-controls="share-expertise-panel"` points at nothing until the panel first mounts.

### 7. Deploy cleanup (low)

- `scripts/cloud-build.sh` uses `--set-env-vars`, which **replaces** the whole Cloud Run env list on every deploy, so anything set in the console (notably `ORG_ADDRESS`) is wiped. Switch to gcloud's custom delimiter (`--set-env-vars "^|^K=v|K2=v"`) or `--env-vars-file`, then pass `ORG_ADDRESS` from `.env` and update the docs that say to set it by hand.
- Warn in `cloud-build.sh` when only some of the three `ZOOM_*` credentials are set (Zoom would silently turn off). The `zoom-client-secret` secret exists in production, so checking for it before binding only matters for fresh environments.
- `Dockerfile`: drop `COPY scripts ./scripts` (only the removed prerender needed it) and fix the comment claiming the Vite envPrefix includes `SUPABASE_` (it's `['VITE_', 'SITE_']`).

## Before public launch (product decisions, need the user)

- Replace the placeholder `CONSULTATION_DATA_FORM_URL` in `server.js` with the real YES Employment participant data form.
- Set `EMAIL_FUNDER_LOGO_URL` if the funder strip should appear on consultation emails.
- Zoom: either grant the app `user:read:settings:admin` + `user:update:settings:admin`, or set **Who can share = All Participants** for the host in the Zoom web portal. `npm run zoom:check` reports which.
- Confirm the Slack workflow trigger accepts `time_slots`, `request_summary`, `expert_email`, `admin_url`.
- French member agreement: a draft exists at `content/contracts/fr/member-agreementfr.md` but `src/lib/member-agreement.js` maps `fr` to English. Rename it to `member-agreement.md` and import it once the copy is approved.
- Not built yet: reminders, rescheduling, expert-side "decline" (experts cancel instead), French emails.

## Working notes

- `npm run dev` failed twice on 2026-10-05 with "Port 3000 is in use" while another `npm run dev` was already running; the auto-free in `scripts/dev.js` did not clear it. Check `lsof -i :3000 -i :5173` and reuse or stop the existing server first.
- Supabase **Confirm email** must stay on. Admin and expert checks rely on confirmed emails, and member checks rely on it implicitly.
- Locks are per process, so don't scale Cloud Run past one instance without moving locking into Postgres (e.g. `SELECT … FOR UPDATE` or advisory locks).
- Email previews were being checked by rendering HTML to `/tmp/arl-email-preview` and serving it with `python3 -m http.server 8765`. There is no script for this in the repo.
