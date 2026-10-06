# Claude Code handoff — updated 2026-10-05 (after the deep review)

Claude Code is taking the lead on ARL Online from here. This is the state of the project and what to do next. `AGENTS.md` stays the canonical map; this file is the working backlog. Update or trim it as items are done.

## Where things stand

- **GitHub:** `main` is pushed up to `f4eb05c` (Google and Discord sign-in, the privacy policy page, member agreement updates). The big feature commit before it is `355cc29` (Expertise consultations, Zoom scheduling, Share Expertise, branded emails).
- **Build:** `npm run build` passes with no Svelte or accessibility warnings. `node --check` passes on `server.js` and the server libs. Every locale key used in `src/` exists in both `en.json` and `fr.json`.
- **No secrets** in the repo. `.env` is gitignored. `.DS_Store` files are untracked and ignored.
- **Production (confirmed by the user, 2026-10-05):**
  - The Expertise release is live on Cloud Run (`arl-online`, `us-east1`).
  - Migrations `005_expertise.sql`, `006_consultation_scheduling.sql`, and `007_expertise_copy.sql` are applied to the production Supabase project.
  - Zoom works in production: consultations create and delete Zoom meetings, so `zoom-client-secret` is in Secret Manager and bound.
  - Future migrations are still applied by hand in the Supabase SQL editor, and the startup schema check only probes migration 002, so a missing migration shows up on the first request that needs it, not at boot.
- **Deep review, 2026-10-05.** A full review produced 99 verified findings, and the most important were fixed the same day. Those fixes are **uncommitted in the working tree and not deployed** (see **User actions** below). No migration is needed. What changed:
  - **Page weight:** compression, long-lived caching for hashed files, WOFF2 font subsets, real lazy page chunks with a reload fallback (`PageLoadError.svelte`), 128 px Kimchi photos. Uploaded photos are now served from `/media/items/...` instead of base64 inside `/api/inventory` (1.1 MB → about 11 KB), with a 2,000,000-character upload cap.
  - **Search:** robots.txt lets Google fetch the two public inventory reads, unknown paths and missing items return real 404s with a not-found view, item load errors no longer say "Item not found", one JSON-LD block of each kind, favicons and an apple-touch-icon, and a www → apex 301 (DNS still to do).
  - **Navigation and accessibility:** Android Back no longer loops on deep-linked items, focus returns to the card when the overlay closes, the rotating quote footer is gone, and focus rings are visible (Mint / Grape).
  - **Email and Slack:** every app email has Reply-To (`samuel@apathyisboring.com` by default). Routes wait for their emails and Slack post and report `emailSent`, a Resend 429 is retried once, and bulk deletes are paced.
  - **Expertise and reservations:** 10 saved requests per account per day, one open request per expert, finished ("held") meetings are never emailed as cancelled, clearer consultation form copy, and a Slack alert when a mentor profile is published or edited. Members see, withdraw and cancel their equipment, book and room reservations on `/account`. Admin deletes now email the member. Room approval emails no longer mention Tuesday pickup.
  - **Password reset and change:** **Forgot password?** in the login dialog, a **Set a new password** dialog from the email link, and **Change password** on `/account`.

## User actions from the 2026-10-05 fixes

Steps outside the repo for the uncommitted fixes, in order.

**Before deploying**

- Review the working tree and commit it (or ask Claude to). Nothing from the deep review is committed yet.
- Check that the Ringold Sans licence (Bijou Type through TypeNetwork, licence ID 349110 in the font's name table) allows a self-hosted, subsetted WOFF2. If it doesn't, get TypeNetwork's official WOFF2 and add it under a new file name.

**Deploy**

- `npm run cloud:build` (Claude runs it only with the user's go-ahead). No migration and no new required env var. `npm ci` in the Docker build picks up the new `compression` dependency.
- Optional: to send replies to a shared mailbox, add `EMAIL_REPLY_TO=<one address>` to `.env` before deploying. Don't set it only in the Cloud Run console: `--set-env-vars` wipes console values on the next deploy.

**Dashboards (any time)**

- **Slack Workflow Builder:** in the workflow behind `SLACK_RESERVATION_WEBHOOK_URL`, make the message show `{status}` and `{request_summary}` (for example `{status}: {request_summary}` on the first line), then publish. The staff alerts `mentor_profile_published`, `mentor_profile_updated` and `reservation_cancelled_by_member` use the same 13 keys, so the trigger needs no new variables. Until this is done those alerts look like empty reservations.
- **Supabase → Authentication:**
  - **Email Templates → Reset Password:** read the copy and keep `{{ .ConfirmationURL }}`. It is English-only; add a French line by hand if wanted.
  - **SMTP Settings:** custom SMTP must be on. The built-in sender only delivers to the Supabase team's own addresses and a few emails an hour. Resend's SMTP: host `smtp.resend.com`, port 465, username `resend`, password a Resend API key, sender on `activistresourcelibrary.com`. This also covers sign-up confirmation emails.
  - **URL Configuration:** keep `https://activistresourcelibrary.com/**` (and `http://localhost:5173/**`) in Redirect URLs, with the apex as Site URL. Reset links return to the starting page plus `?password_reset=1`.
  - Optional, **Providers → Email:** keep the minimum password length at 8 or lower. Turning on **Secure password change** makes **Change password** ask members whose session is older than 24 hours to log in again.
- **www host:** `www.activistresourcelibrary.com` has no DNS record. The server already 301s www to the apex.
  - Add a Cloud Run domain mapping: Cloud Run → Manage custom domains → Add mapping → service `arl-online` → `www.activistresourcelibrary.com`, or `gcloud beta run domain-mappings create --service arl-online --domain www.activistresourcelibrary.com --region us-east1`. If Google asks to verify the domain, use the account that verified the apex.
  - At Namecheap (Domain List → Manage → Advanced DNS), add the record Google shows, normally `CNAME www → ghs.googlehosted.com.` (`gcloud beta run domain-mappings describe --domain www.activistresourcelibrary.com --region us-east1` prints it).
  - Once the certificate is issued, `curl -sI https://www.activistresourcelibrary.com/about` should return a 301 to `https://activistresourcelibrary.com/about`.

**After deploying**

- **Headers:** `curl -sI -H 'Accept-Encoding: br, gzip' https://activistresourcelibrary.com/` shows `content-encoding: br` and `cache-control: no-cache`. `/assets/fonts/inter/Inter-latin.woff2` shows `content-type: font/woff2` and `cache-control: public, max-age=604800`. A hashed `/assets/index-*.js` shows `public, max-age=31536000, immutable`. `/assets/does-not-exist.js` returns a plain-text 404.
- **Search Console** (`AGENTS.md` → Google Search Console, steps 4–5): (a) Settings → robots.txt → request a recrawl. (b) URL Inspection on an item URL from the sitemap → Test live URL: the screenshot shows the item title, and Page resources lists `/api/inventory/by-slug/...` as loaded, not blocked. (c) URL Inspection on a made-up path such as `/how-it-works` reports Not found (404).
- **Share previews:** item links shared before the deploy show the old logo until each platform refetches. Re-scrape the important URLs in Facebook's Sharing Debugger and LinkedIn's Post Inspector, for example `/rooms/meeting-room-max-15-people` and `/expertise/samuel-miriello`.
- **Smoke tests:**
  - Forgot password? end to end with a non-staff address: the email arrives, the link opens **Set a new password**, and the new password logs in.
  - Approve a test reservation or send a consultation email to yourself and press Reply: it should be addressed to `samuel@apathyisboring.com`. Optional: `npm run send-email` sends one test email through the live Resend key.
  - Open `/books` and check the photos load from `/media/items/...`. Edit a mentor's text in `/admin` without choosing a new photo and check the photo is kept.
  - Optional on an Android phone in Chrome: open an item link directly (from WhatsApp, Discord or a search result), press Back twice. The second Back should leave the site.
  - Optional on an iPhone with a home indicator: the FES badge and Kimchi sit just above it and don't cover the last card's Reserve button.

**Ongoing**

- Keep Cloud Run at a single instance. The new daily request cap is in memory, like the locks and rate limits, and resets on every deploy or restart.
- Replace a font, brand image (logo, favicon) or inventory seed photo by adding it under a new file name. Those paths are cached for 7 days, so overwriting one leaves returning visitors on the old copy.

## Backlog, in priority order

What's left from the 2026-10-05 deep review and the earlier code review. Fixed items are gone, and partly fixed ones keep only what remains. Authorization on the schedule, cancel and mentor-profile routes holds, emails are HTML-escaped, and public routes strip private fields. Line numbers drift, so items are given by file and function.

### High

#### Scheduling

- **Meeting-time picker probably does nothing on iPhone/iPad.** Where: `MeetingTimePicker.svelte`; the `.meeting-time-picker__input` hiding rules in `app.css`; used by `AccountConsultations.svelte` and `AdminPanel.svelte`. Problem: the only real field is a hidden, unfocusable `datetime-local`, and the button relies on `showPicker()`, which iOS WebKit ignores for date inputs. Desktop Firefox and Safari probably can't set the time part either, so experts there can't schedule, and screen readers get an unlabeled field. Fix: make the `datetime-local` a normal visible field (drop `aria-hidden` / `tabindex`, `<label for>`, `aria-describedby` on the hint) styled like other inputs; keep the button only as an optional `showPicker()` helper that focuses the field first. Left unfixed on 2026-10-05 on purpose, because it needs a real-device check: test on an iPhone and in desktop Firefox and Safari (plus VoiceOver) before and after the change.

### Medium

#### Security and privacy

- **Calendar-invite (ICS) injection through mentor names.** Where: `icsEscape` and `icsFold` in `server.js`; `readMentorProfileInput`; admin `PATCH /api/inventory/:id`. Problem: `icsEscape` only replaces `\r?\n`, so a bare `\r` in a self-published mentor name reaches `SUMMARY:`; titles also go into email subjects. Fix: `.replace(/\r\n|\r|\n/g, '\\n')` and strip other control characters; reject `/[\u0000-\u001f\u007f]/` in titles on both write paths. Make `icsFold` fold at 75 bytes without splitting a UTF-8 character.
- **Members can harvest mentor emails.** Where: `serializeConsultationForUser` (member view) behind `GET /api/account/consultations`. Problem: `expertEmail` is returned while the request is still `pending`, so anyone can request, read the email, cancel and repeat. Fix: return `expertEmail` only once `status === 'reserved'` (or never). Update the `AGENTS.md` sanitization table and the "Account API" invariant in `.cursor/rules/expertise-consultations.mdc`.

#### Accounts and sign-in

- **Esc or Android Back closes the post-OAuth member agreement.** Where: `CompleteSignupModal.svelte`. Problem: in Chromium a close request can fire a non-cancelable `cancel`, and nothing reopens the dialog until a reload, so a new Google/Discord member can reserve and publish without agreeing. Fix: add `closedby="none"` and an `onclose` that calls `showModal()` again while `$needsMemberAgreement`. Server-side enforcement is part of the agreement decision under **Before public launch**.
- **Auth errors in raw English, and expired confirmation links are a dead end.** Where: `AuthModal.svelte` (login/register submit and OAuth), `CompleteSignupModal.svelte`, `formatRedirectError` in `HeaderAuth.svelte`, `takeAuthCallbackError` in `supabase.js`. Problem: Supabase's English `error.message` ("Invalid login credentials", "Email not confirmed") shows in the French UI. An expired confirmation link (`otp_expired`) says "try again" with no resend, and any `?error_description=` text is echoed into the login dialog. Fix: add `authErrorMessage(error)` in `auth.js` mapping `error.code` to EN/FR `auth.error_*` keys. Offer **Resend confirmation email** (`supabase.auth.resend({ type: 'signup' })`) on `email_not_confirmed` and `otp_expired`, and never append the raw description.
- **Signing in from the consultation form loses the typed request.** Where: `ConsultationRequestForm.svelte`; `signUpWithEmail` in `auth.js`; `ReserveAuthRequiredModal.svelte`. Problem: the time slots and summary live only in component state, so the Google/Discord redirect returns to empty fields. Email confirmation links open the homepage instead of the item. Fix: keep a draft in `sessionStorage` (`arl-consult-draft:{itemId}`), restore it on mount and clear it after a successful submit. Set `emailRedirectTo` to the current path and search. Optional: consultation wording for the account-required prompt (it says "reserve inventory").

#### French and errors

- **Server and network errors reach French users in English.** Where: the `result.error || translateKey(...)` wrappers in `src/lib/inventory.js` and `contact.js`; English-only error JSON in `server.js`. Problem: the shared `ERROR_CODE_KEYS` table now covers the image, daily-limit, pending-limit, rate-limit, open-request, held-meeting and member-reservation codes. Everything else (409 date overlap, expired session, Zoom unavailable, meeting in the past, contact send failure, not found) and a rejected `fetch` ("Failed to fetch") still show raw English. Fix: give those responses a `code`, add `errors.*` EN/FR keys, and route all member-facing wrappers through `apiErrorMessage`. Catch the fetch `TypeError` as `errors.network`.
- **French pages canonicalize to the English URL.** Where: `buildCanonicalUrl` / `buildHreflangUrl`, `buildSeoHeadHtml`, `applyHreflangTags` in `seo.js`; `resolveRequestLocale` in `seo-server.js`. Problem: `?lang=fr` pages set `canonical` to the bare (English) URL while every hreflang target carries `?lang=`, so Google is likely to drop the French versions. The server also picks French for any Accept-Language containing "fr". Fix: make each language self-canonical (bare URL for en and x-default, `?lang=fr` for fr) and point the en/x-default alternates at the bare URL. Parse q-values or stop negotiating, and add `Vary: Accept-Language` if negotiation stays. Update Search Console step 5 in `AGENTS.md`.
- **Catalogue text is English-only (L).** Where: `inventory_items` (`title`, `body`, `long_body`); `AddItemModal`, `MentorBrowser`, `AccountShareExpertise`; `InventoryCard`, `ItemDetailPage`, `seo.js`. Problem: there is one text field per item, so French pages wrap English titles and bios in `lang="fr"`. Fix: migration `008` with nullable `title_fr`, `body_fr`, `long_body_fr` and `content_lang`; optional French fields in the three forms; a `localizedField(item, field, locale)` helper; `lang={item.content_lang}` on fallback text. Translating the existing items is a separate content task.

#### Accessibility

- **Calendar days are bare ISO dates in a broken grid.** Where: `ItemCalendar.svelte`; `calendar.selected_range` in both locales. Problem: day buttons are named "2026-10-13" with no weekday or reason when unavailable, inside `role="grid"` with no rows, and the selection line shows raw ISO dates outside a live region. The FR string is missing "du". Fix: use `role="group"` (or a real table), name days with `Intl.DateTimeFormat` plus a state key, format the selection as "Pickup {start} · Return {end}" in an `aria-live="polite"` wrapper, and add a legend swatch for unavailable days.
- **Page-to-page navigation doesn't reset scroll or move focus.** Where: `navigate()` in `router.js`; `App.svelte`; each lazy page's `onMount`. Problem: only closing the item overlay moves focus (since 2026-10-05). In-content links (Kimchi's `/howthisworks` link, the privacy policy's `/about` link, About's privacy link) can open the next page part-way down, with focus left on `<body>` and nothing announced. Fix: `window.scrollTo(0, 0)` when the page kind changes (not for overlay open/close or category filters). Focus `<main id="main-content" tabindex="-1">` from each lazy page's `onMount` after an in-app navigation (not on first load).

#### Consultations

- **No way to report a concern.** Where: `AccountConsultations.svelte`; `buildConsultationEmail` in `server.js`. Problem: Reply-To now reaches a person, but no consultation row or email tells a member how to raise a problem, and past rows have no actions. Fix: add a **Report a concern** link (to `/about` or a role mailbox) on every consultation row, including closed ones (`account_consultations.report_concern`, EN/FR), and a "Something not right? Reply to this email" line in the consultation emails. A reports table, attendance state and email blocklist are a product decision (see **Before public launch**).

#### Performance

- **Single-item routes run a full inventory fetch and discard it.** Where: `ensureInventory` in `inventory-store.js`; admin create, the three mentor-profile routes, by-slug, reservation create and the sitemap in `server.js`. Problem: each call selects every item with every reservation and its stored base64 image, then throws it away, adding about 0.3 s to item opens and about 1 MB of Supabase egress per call. Fix: export `ensureInventoryReady()` (seed + slug backfill only) and use it at those sites. Give the sitemap a light `select('tag, slug, created_at')`.

### Low

#### Server hardening

- **Upload parsers run before auth.** Where: `imageUploadJson` on `/api/account/mentor-profile` and `POST`/`PATCH /api/inventory` in `server.js`. Problem: the 3mb JSON parsers run before `requireAuth` and the rate limiter. Fix: order them limiter → `requireAuth` → parser (`requireAuth` only reads headers).
- **Rejected Zoom token stays cached.** Where: `src/lib/zoom.js` (`cachedToken`). Problem: a revoked token is reused until it expires. Fix: on a 401, clear `cachedToken` and retry once.
- **`meetingAt` validation is loose.** Where: the `Date.parse(meetingAt)` check in `server.js`. Problem: strings without a timezone are accepted and there is no upper bound. Fix: require `Z` or an offset and cap it at about one year ahead.
- **Same mentor name at once → 500.** Where: mentor-profile create in `inventory-store.js`. Problem: two simultaneous publishes can hit the unique `(tag, slug)` index. Fix: catch the unique violation and retry with a new suffix.
- **Schema check only probes migration 002.** Where: `checkReservationSchema()` in `inventory-store.js`. Fix: also probe the 005–007 columns (`time_slots`, `meeting_at`, `zoom_meeting_id`, `cancelled_by`, `expert_email`, `long_body`) and log which migration is missing. Optional: a check constraint on `reservations.cancelled_by` (`member`/`expert`/`admin`) in a new `008_*.sql`.
- **Reservation dates are never checked against today.** Where: `validateReservationDates` in `reservation-rules.js`; `countPendingReservationsByEmail` and `approveReservation` in `inventory-store.js`. Problem: the API accepts past-dated requests, stale pending rows count toward the 5-request cap, and past-dated requests can be approved. Fix: pass `libraryTodayKey()` in and reject non-expertise starts before today. Count non-expertise pending rows only while `end_date >= today`, and have `approveReservation` refuse expired rows. Optional: cap room range length.
- **A session without an email would skip approval.** Where: `POST /api/inventory/:id/reservations`; `addReservation`. Problem: latent (no sign-in path makes such a session today), but a null email writes `status: 'reserved'` and skips the cap. Fix: return 403 when `!userEmail || !isConfirmedUser(req.user)`, and always write `pending`.
- **`$` patterns in titles corrupt the server-rendered head.** Where: `injectSeoIntoHtml` in `seo-server.js`. Problem: `.replace('</head>', string)` interprets `` $` ``, `$'` and `$&` in an item title or bio. Fix: use a replacer function, `.replace('</head>', () => ...)`.
- **Schedule/cancel limiter is IP-only.** Where: `consultationActionLimiter` in `server.js`. Fix: add a second limiter keyed by `req.user.id` after `requireAuth`, like `reservationAccountLimiter`.

#### Consultations and Zoom

- **Finished Zoom meetings stay joinable.** Where: `serializeConsultationForUser` and `ZOOM_ROOM_NOTICE` in `server.js`; `AccountConsultations.svelte`; `src/lib/zoom.js`. Problem: meetings are deleted only on cancel, and Completed rows on `/account` still show **Join Zoom** and the passcode, so the pair can keep meeting on AisB's account with no host. The email says "You can join before the host", but no host ever joins. Fix: delete meetings once `meetingAt` + 60 min + a grace period has passed (from `GET /api/account/consultations` or a Cloud Scheduler ping) and clear the zoom fields. Return them only while the meeting isn't over, and reword the notice. The safeguarding question is under **Before public launch**.
- **Overlapping meetings on one Zoom host.** Where: `scheduleConsultation` in `inventory-store.js`; `createConsultationMeeting` in `zoom.js`. Problem: every meeting uses `ZOOM_HOST_USER`, and scheduling never checks other meetings at the same time. Depending on the plan, a second meeting may not start. Fix: before creating the meeting, count `reserved` consultations within ±60 min and return 409 at a `ZOOM_MAX_CONCURRENT` limit (default 1), or confirm the plan's allowance first.
- **Expert isn't told about an admin refusal, and stale rows dead-end.** Where: the refuse route in `server.js`; `handleSchedule` / `handleCancel` in `AccountConsultations.svelte`. Problem: only the member is emailed on refusal. When a row changed elsewhere, the expert gets an English error and the stale buttons stay. Fix: also send the expert a short "declined by the library team" email. On 400/404, reload the list and show `account_consultations.no_longer_active` (EN/FR).
- **Changing a mentor's email mid-consultation misroutes it.** Where: admin `PATCH /api/inventory/:id`; `MentorBrowser.svelte`. Problem: cancellation emails and the ICS CANCEL go to the new address, and the original expert loses access. Fix: return 409 (EN/FR admin message) when the email changes while a consultation is pending or reserved.
- **Consultation "Requested" date uses UTC.** Where: the expertise branch of reservation create (`startDate = toDateKey(new Date())`) and `notifySlackAlert` in `server.js`. Problem: requests after about 8 pm Montréal time show the next day on `/account`, in admin and in Slack. Fix: use `libraryTodayKey()` from `src/lib/calendar.js`.
- **Deleting a consultation erases its record.** Where: admin `DELETE /api/inventory/:id/reservations/:reservationId`; `deleteInventoryItem` (the `reservations` FK cascades). Problem: an active consultation is cancelled with emails but then removed, and removing a mentor deletes all of their consultation rows, which funder reporting may need. Fix: for expertise rows, cancel (`cancelledBy: 'admin'`) instead of deleting. A soft-hide or unpublish for mentors belongs with the self-published mentors decision.
- **Admin and mentor edits overwrite each other.** Where: `startEdit` in `MentorBrowser.svelte`; `updateMentorProfileForEmail`. Problem: both forms save from a snapshot loaded once, so the last writer silently wins. Fix: refetch the item before filling the admin form. Later, add `updated_at` and a 409 on mismatch.

#### Email and monitoring

- **Email and Slack failures only reach the logs.** Where: `sendEmailPayloads`, `postSlackWorkflow` and the welcome-email path in `server.js`; `AdminPanel.svelte`. Problem: a systemic Resend or Slack failure is only `console.error`. The admin confirmation still says "the member will get an email" when `emailSent` is false. Fix: log one-line JSON (`event: 'email_send_failed' | 'slack_failed'`) and add a GCP log-based alert (or Error Reporting notifications) that emails staff. Warn in the UI when `emailSent` is false. Document it in `docs/automated-emails.md` and `docs/automated-webhooks.md`.
- **One failed welcome send loses the email for good.** Where: `sendWelcomeEmailIfNeeded` in `server.js`; `docs/automated-emails.md` (Failure behavior). Problem: `welcome_email_sent` is claimed before sending and never rolled back. The doc still describes the old send-then-update order. Fix: on a send error, set the flag back to false while holding the lock, then rethrow. Fix the doc bullets.

#### Privacy and data

- **Public API lists consultation activity per mentor.** Where: `sanitizeItemForPublic` in `server.js`. Problem: `GET /api/inventory` and by-slug list every consultation request (date and status) on every mentor, plus refused and cancelled rows for other items. Fix: return `reservations: []` for expertise and only `pending`/`reserved` rows for other tags. Check that `ConsultationRequestForm` handles an empty array, and update the `AGENTS.md` "Public responses" row.
- **No procedure for account-deletion requests.** Where: docs; `reservations.user_email` and `inventory_items.expert_email` have no foreign key to `auth.users`. Problem: deleting only the Supabase user leaves their reservation rows and any public mentor profile. Fix: write a short runbook (delete the mentor item from `/admin` → Mentors, delete or null out the member's reservation rows in SQL, then delete the auth user), optionally as `scripts/delete-member.js`.

#### Members and accounts

- **Repeat sign-up says "Account created".** Where: `handleSubmit` in `AuthModal.svelte`. Problem: signing up again with a confirmed email shows "check your email", but Supabase sends nothing. Fix: when there's no session and `user.identities` is empty (or `user_already_exists`), show neutral EN/FR copy ("If this email is new, check your inbox. If you already have an account, log in.").
- **Sign-out on another device leaves this tab half signed in.** Where: `authHeaders` in `src/lib/inventory.js`; `signOut` in `auth.js`. Problem: every API call fails with "Invalid or expired session." until the token expires. Fix: on a 401, refresh once and retry. If that fails, sign out locally, show `errors.session_expired` and open the login dialog.
- **Failed sign-out is silent.** Where: `handleSignOut` in `HeaderAuth.svelte`; `signOut` in `auth.js`. Problem: on a network error the session is kept with no message. Fix: fall back to `signOut({ scope: 'local' })` and show `auth.sign_out_error` (EN/FR).

#### Reservations and calendar UI

- **Success messages show twice and replay.** Where: `reserveSuccessTick` in `App.svelte`, `ItemDetailPage.svelte`, `InventoryCard.svelte`; `ConsultationRequestForm.svelte`. Problem: the same "Request submitted…" shows in the overlay and in the calendar (and twice for consultations), and comes back when the item is reopened or the language changes. Fix: remove `reserveSuccessTick` and leave confirmation to `ItemCalendar` and `ConsultationRequestForm`.
- **Calendar opens on a month with nothing bookable.** Where: `ItemCalendar.svelte` (initial `viewYear` / `viewMonth`). Problem: after the month's last Tuesday, equipment and books open on an all-grey month while the card says Available. Fix: open on the month of the first free Tuesday, and disable ‹ on the current month.
- **Stale availability and a sticky 409.** Where: `handleItemDetailLoaded` in `App.svelte`; the `ItemCalendar` submit catch; the 409 branch of reservation create. Problem: grid badges use page-load data, and after a 409 the calendar keeps the taken range selected. Fix: merge the overlay's fresh item into the grid, return the item with the 409, clear the range and show `calendar.collision_error`.
- **Grid load error has no Retry.** Where: `InventoryPanel.svelte`; `refreshInventory` in `App.svelte`. Problem: a failed inventory load can only be fixed by reloading the page. Fix: pass `onRetry={refreshInventory}` and render a Retry button by the alert; optionally refetch on `online`.
- **Item descriptions lose their line breaks.** Where: `.item-detail__body p` in `app.css`. Problem: kit lists run together and manual URLs aren't links. Fix: `white-space: pre-line`; optionally linkify `https` URLs with `{#each}` (no `{@html}`).
- **iOS zooms into the consultation textareas.** Where: `.consultation-form__textarea` in `app.css`. Problem: 0.9rem (14.4 px) makes iOS zoom in about 11% on focus. Fix: 1rem, with 0.9rem only under `@media (pointer: fine)`. Don't add `maximum-scale`.

#### Account and admin UI

- **Both consultation buttons show a progress label.** Where: `AccountConsultations.svelte`. Problem: "Cancelling…" shows while scheduling and vice versa. Fix: track an `actionType` next to `actionId`.
- **Admin meeting picker has no minimum.** Where: `AdminPanel.svelte` (`handleApprove`); `handleSchedule` in `AccountConsultations.svelte`. Problem: the server rejects a past time only after the confirm dialog. Fix: pass `min` in admin and pre-check for a past time in both handlers.
- **Share Expertise 409 overwrites what the user typed.** Where: the save catch in `AccountShareExpertise.svelte`. Fix: on 409, set `profile` only and keep the typed fields so the next Save PATCHes.
- **Links from `/account` into a mentor overlay close to `/expertise`.** Where: `AccountConsultations.svelte` and `AccountShareExpertise.svelte` (`navigate(path)`). Fix: use `navigateToItem` from `router.js` (added for `AccountReservations`), which pushes the overlay history marker.
- **`aria-controls` points at nothing.** Where: `AccountPage.svelte` (`share-expertise-panel`). Problem: the panel doesn't exist until first opened. Fix: render the id on a stable wrapper, or set `aria-controls` only while open.
- **Admin lists don't scale.** Where: `reservationEntries` / `pendingEntries` and Remove Items in `AdminPanel.svelte`. Problem: Edit Reservations keeps finished bookings forever, grouped by item rather than date, and Remove Items shows only the title. Fix: sort by `startDate`, collapse rows that ended before today, show the tag (and thumbnail) on Remove Items. Optionally rename "Edit Reservations" to "Approved reservations".
- **Admin approve/refuse errors render under the whole list.** Where: `pendingError` / `reservationError` in `AdminPanel.svelte`. Problem: the error is off-screen on a long list, and a request handled elsewhere stays listed until reload. Fix: render the error in the matching row, and refresh admin items on 400/404.
- **Photo upload errors are English and transparent PNGs turn black.** Where: `compressImageFile` in `src/lib/image.js`; `AddItemModal`, `AccountShareExpertise`, `MentorBrowser`. Problem: client-side errors are hard-coded English, HEIC fails with a generic message, and the JPEG fallback paints transparency black. Fix: fill the canvas white before `drawImage`, reject HEIC/HEIF early, and throw codes mapped to EN/FR `add_item.image_error_*` keys.

#### Links, language and analytics

- **Cmd/Ctrl-click opens the overlay in the same tab.** Where: `goToDetail` in `InventoryCard.svelte`, `SiteNav.svelte`, `ItemDetailPage`, `AboutPage`, `AccountPage`, `PrivacyPage`; category filters in `InventoryPanel.svelte`. Problem: click handlers `preventDefault` without checking modifier keys, and the filters are buttons, so `/books`, `/rooms` and `/expertise` have no links. Fix: export `isPlainLeftClick(e)` from `router.js` and bail out on modified clicks. Make the filters `<a href>` with `aria-current`.
- **A stale `?lang=` overrides the visitor's choice.** Where: `setLocale` in `LocaleSwitcher.svelte`; `resolveInitialLocale` in `i18n.js`. Problem: after a reload, an OAuth sign-in or opening an item, the URL's `?lang` wins over the language picked. Fix: update or delete the `lang` param with `history.replaceState` when the locale changes.
- **Two GA4 page_views per landing.** Where: the gtag config in `index.html`; the analytics `$effect` in `App.svelte`. Problem: page views are doubled and item views can carry the previous title. Fix: `send_page_view: false` in `index.html` (the CSP hash is recomputed at server start), then send one `page_view` per route after the SEO tags apply, waiting for the item on item routes.

#### Accessibility

- **Four dialogs have no accessible name.** Where: `AuthModal`, `ReserveAuthRequiredModal`, `MemberAgreementModal`, `AddItemModal`. Fix: `$props.id()` on the `<h2>` and `aria-labelledby` on the `<dialog>`, as `SetPasswordModal` does.
- **Form errors aren't tied to fields.** Where: About contact form, `AccountShareExpertise`, `ConsultationRequestForm`, `ItemCalendar`, AuthModal login/register. Problem: the password dialogs now do this; the other forms render the status line only once it has text and never set `aria-invalid`, and hints aren't linked. Fix: keep each status line in the page (`.status:empty`), set `aria-invalid` and `aria-describedby` on the faulty field and focus it, and link `.field-hint` paragraphs.
- **Scheduling or cancelling a consultation drops focus.** Where: `handleSchedule` / `handleCancel` in `AccountConsultations.svelte`. Problem: the pressed button disappears, and with Kimchi asleep nothing is announced. Fix: a permanent visually hidden `role="status"` line (new EN/FR keys) and focus moved after `await tick()`, as `AccountReservations` does.
- **"I agree" drops focus.** Where: `handleAgreementSigned` in `AuthModal` and `CompleteSignupModal`. Fix: `await tick()`, then focus the signed paragraph (`tabindex="-1"`) or the opt-in checkbox.
- **Card availability badge is a context-free live region.** Where: `.availability-badge` in `InventoryCard.svelte`. Problem: every card announces a bare "Available" on locale or day change, before the heading. Fix: drop `role="status"` / `aria-live`, move the badge after the `<h3>` (or link it with `aria-describedby`).
- **Past consultation rows fail contrast.** Where: `.consultation-row--inactive` in `app.css`. Problem: `opacity: 0.7` drops muted text to about 3.47:1. Fix: remove the opacity and mark past rows with a surface background or border.
- **Text-field borders are 1.51:1.** Where: the `input, textarea` rule in `app.css`. Fix: a new `--color-border-input: rgba(35, 31, 32, 0.5)` (about 3.2:1). Leave `--color-border-strong` alone.
- **Kimchi bubbles.** Where: `KimchiBubble.svelte`, `KimchiNotification.svelte`, `InventoryCard.svelte` (hover reactions). Problem: the name, link (2.35:1) and close × (2.05:1) fail contrast, and the 8 s timer removes a bubble that has focus. The sleep dot's target overlaps the avatar and its state isn't remembered, and bubbles fired from the item dialog land behind its backdrop. Fix: `#6b5b00` and `#767676`; pause the timer on hover/focus and move focus to the avatar before dismissing. Remember awake/asleep in `localStorage`, give the dot a 24 px target off the avatar, and start card reactions on mouse pointers only.
- **English agreement read with a French voice.** Where: `getMemberAgreementHtml` in `member-agreement.js`; `MemberAgreementModal.svelte`. Fix: return the source language and set `lang` on the agreement container. Polish: `lang` and `aria-label` on the EN/FR switcher buttons.
- **Modals don't contain scroll.** Where: `.modal` in `app.css`. Problem: the page behind scrolls, and on Android pulling down can plausibly trigger pull-to-refresh and lose a draft. Fix: `overscroll-behavior: contain` on `.modal` and `html:has(dialog.modal[open]) { overflow: hidden; }`.
- **Fixed corner widgets on short viewports.** Where: `.site-attribution` in `app.css`; `.kimchi-widget` in `KimchiNotification.svelte`. Problem: on landscape phones and at 400% zoom the ~82 px FES badge and Kimchi still cover the bottom corners. Fix: under `@media (max-height: 500px)` put the badge in normal flow and hide or shrink Kimchi.

#### Search, brand and page weight

- **Mentors are marked up as Products.** Where: `getProductJsonLd` / `getItemSeoConfig` in `seo.js`; sitemap in `server.js`. Problem: every item, including people, is a schema.org Product with no offers (Search Console errors). Slugs never change, so a mentor can't drop a former name from their URL. Fix: ProfilePage + Person (`og:type profile`) for expertise and no Product block elsewhere unless offers are added. Add an admin-only "regenerate link" for mentors.
- **Header wordmark is below the brand minimum.** Where: the header `<img>` in `App.svelte`; `src/assets/brand/apathy-is-boring-logo.png`; `index.html`. Problem: the untrimmed 1024 px square makes the glyphs 16–23 px tall (minimum 30 px), its `width`/`height` say 240×64, and there's no `theme-color`. The og:image fallback is the same transparent square, with no `og:image:width`, `height` or `alt`. Fix: export a trimmed wordmark with clear space and set its true size. Add `<meta name="theme-color">` and an opaque share image with size and alt tags.
- **Inventory isn't cacheable and loads on every page.** Where: `GET /api/inventory` (`Cache-Control: no-store`); `refreshInventory` in `App.svelte`. Problem: the ETag can never return 304, and `/about`, `/privacy`, `/howthisworks` and `/account` fetch the whole catalogue on a full load. It is about 11 KB now, so this is minor. Fix: send `no-cache`, and load inventory only on routes that show it.

#### Content

- **Pickup notice has no place, and the privacy policy is hard to find.** Where: `calendar.pickup_dropoff_hours` (EN/FR); site nav. Fix: add "at Apathy is Boring, 5310 Boulevard Saint-Laurent, Montréal" to that string in both locales, and add a small Privacy link to the nav or a page footer.
- **French copy slips.** Where: `locales/fr.json`. Problem: the how-it-works text names a "Réserver l'inventaire" button that renders as "Réserver"; "ait approuvé", "cliquez une date", "Vérifier disponibilité", "ramassage" vs "cueillette"; spacing before `? ! ; :` is mixed (new strings use U+00A0, older ones plain or none). The consent line uses a different library name (see **Before public launch**). Fix: correct those strings, pick one punctuation convention, and remove the unused `item_detail.reserve`.

#### Deploy and tooling

- **`--set-env-vars` wipes console-set variables.** Where: `scripts/cloud-build.sh`. Problem: every deploy replaces the whole env list, so anything set in the console (notably `ORG_ADDRESS`) is lost. Fix: use gcloud's custom delimiter (`--set-env-vars "^|^K=v|K2=v"`) or `--env-vars-file`, pass `ORG_ADDRESS` from `.env`, and update the docs that say to set it by hand.
- **Single instance isn't enforced.** Where: the `gcloud run deploy` call in `cloud-build.sh`. Problem: locks, rate limits and the daily cap are in memory, but nothing sets `--max-instances`. Fix: add `--max-instances 1`, check the live value with `gcloud run services describe arl-online --region us-east1`, and note it in `AGENTS.md`.
- **Partial Zoom credentials turn Zoom off silently.** Where: `cloud-build.sh`. Fix: warn when only some of the three `ZOOM_*` values are set.
- **Dockerfile leftovers.** Where: `Dockerfile`. Fix: drop `COPY scripts ./scripts` (only the removed prerender needed it) and fix the comment claiming the Vite envPrefix includes `SUPABASE_` (it's `['VITE_', 'SITE_']`).
- **npm audit is red.** Where: `package-lock.json` (`ip-address` via `express-rate-limit`). Problem: moderate advisory, not exploitable here. Fix: `npm audit fix` (lockfile only).
- **`npm run migrate:inventory` renames live slugs.** Where: `scripts/migrate-inventory-to-supabase.js`; `upsertInventoryFromJson` in `inventory-store.js`; `package.json`. Problem: the one-time June migration flips every equipment slug (x ↔ x-2) and re-inserts old reservations if run again. Fix: delete the script, its npm entry and `upsertInventoryFromJson`, and update the `AGENTS.md` lines that list it.
- **`npm run dev` kills any process touching port 3000.** Where: `freePort` in `scripts/dev.js`. Problem: `lsof -ti tcp:3000` also matches client sockets (a browser can be SIGKILLed), and every failure is swallowed. Fix: `lsof -nP -iTCP:3000 -sTCP:LISTEN -t`, kill only this repo's `node server.js`, and log failures.

### Polish

- **Email copy.** Where: `buildMemberDecisionEmailPayload` and the consultation email builders in `server.js`. Problem: reservation dates aren't labelled pickup/return, the consultation-confirmed intro names the mentor by email, cancel/refuse CTAs open the Equipment tab, and the 60-minute length isn't stated. Fix: "Pick up" / "Return by" rows (rooms: "From" / "To"), "with {title}" plus an Expert row, a Length row, and CTAs to the item or `/expertise`. Give the sender a display name (`Activist Resource Library <noreply@activistresourcelibrary.com>` in `DEFAULT_EMAIL_FROM` and the `cloud-build.sh` fallback).
- **Room calendar never says a second tap sets the end.** Where: `ItemCalendar.svelte`. Problem: the `calendar.select_end_date` branch is unreachable. Fix: show "Tap an end date, or reserve this day only" after the first tap (new EN/FR key), or delete the dead branch.
- **Email-updates choice can't be changed.** Where: `AccountPage.svelte`; `auth.js`. Problem: `email_updates_opt_in` is collected but never shown or used. Fix: an **Email updates** checkbox on `/account` saved through `supabase.auth.updateUser` (EN/FR keys).
- **Filter count says "items" for mentors and isn't pluralized.** Where: `filter_with_count` (EN/FR); `InventoryPanel.svelte`; `i18n.js`. Fix: an `Intl.PluralRules` helper with `_one` / `_other` keys and a mentor-specific key.
- **Lopsided category filter on phones.** Where: `.inventory-filter__btn:nth-child(3)` in `app.css` (≤640 px block and its ≤360 px reset). Fix: delete both rules to get a 2×2 grid.
- **Sitemap duplicates and lastmod.** Where: `SITEMAP_STATIC_PATHS` and the sitemap route in `server.js`; `buildCanonicalUrl`. Problem: `/` and `/equipment` are both self-canonical with the same content, and `lastmod` is the creation date. Fix: drop `/equipment` from the sitemap and canonicalize it to `/` (or 301). Add `updated_at` for lastmod, or omit lastmod.
- **English copy.** Where: `how_this_works.steps.account` and `faq[0]` (EN/FR); production data. Problem: sign-up copy mentions email/password only, and two equipment items share the same Pyle microphone title. Fix: mention Google and Discord, and rename or merge one Pyle item in admin.
- **Member emails in mentor-profile logs.** Where: the two `[mentor-profile]` `console.log` calls in `server.js`. Fix: log `userId: req.user?.id` instead of `email`.

## Before public launch (product decisions, need the user)

- Replace the placeholder `CONSULTATION_DATA_FORM_URL` in `server.js` with the real YES Employment participant data form.
- Set `EMAIL_FUNDER_LOGO_URL` if the funder strip should appear on consultation emails.
- Zoom: either grant the app `user:read:settings:admin` + `user:update:settings:admin`, or set **Who can share = All Participants** for the host in the Zoom web portal. `npm run zoom:check` reports which.
- Confirm the Slack workflow trigger accepts `time_slots`, `request_summary`, `expert_email`, `admin_url`. The message edit for the staff alerts is under **User actions**.
- French member agreement: `content/contracts/fr/member-agreementfr.md` is an empty file and `src/lib/member-agreement.js` maps `fr` to English. Translate the current English agreement (now 12 sections, including Expertise and privacy), save it as `fr/member-agreement.md`, and import it once the copy is approved.
- **Member agreement text contradicts itself and the privacy policy.** In `content/contracts/en/member-agreement.md`, 1.1 says "in effect indefinitely" but 7.3 mentions a one-year membership and a *required* funder survey (the policy says it's optional), 4.2 is an office-lease clause, and 12.3 points at an unlinked "Membership Package". Needs AisB/FES sign-off on new wording before translation.
- **Server-side, versioned member agreement.** Acceptance is a client-written `signed_member_agreement: true` with no version or date, so members who signed the June 8-section text were never asked to accept sections 8–11. New OAuth accounts get the welcome email before agreeing. Proposed: `MEMBER_AGREEMENT_VERSION` in `member-agreement.js`, `POST /api/account/member-agreement` writing `app_metadata.member_agreement = { version, acceptedAt }`, re-asking members on an older version, and holding the welcome email until the agreement is recorded. Decide too whether the server should refuse reservations and mentor profiles without it (`requireMemberAgreement`, exempting legacy email accounts).
- **14+ or guardian consent.** The privacy policy (EN/FR) promises guardian consent for members under 14, but sign-up never asks for age. Either make the library 14+ (rewrite that line, add a required "I am 14 or older" checkbox to register and `CompleteSignupModal`, store `age_14_plus`, add an agreement clause, and decide about existing accounts) or build a real guardian-consent step. Ask counsel how Law 25 s. 4.1 applies.
- **Self-published mentors.** Profiles go live at once; staff now get a Slack alert on publish and edit. Still to decide: a reserved-name check for non-admins (e.g. reject `/apathy\s*is\s*boring|\baisb\b|activist resource library|\bfes\b|\b(staff|admin)\b/i`, EN/FR error), a "community mentor" label (a `consultation.*` note, or a `source` column `admin`|`member` in `008_*.sql` for a chip), approval before publishing (`approved_at` with Approve/Unpublish in Admin → Mentors), and owner unpublish (`DELETE /api/account/mentor-profile` reusing the item-delete path).
- **Unsupervised one-to-one calls.** Members (possibly minors) and unreviewed mentors meet on AisB's Zoom with no staff present. Decide on safeguards alongside the two items above, and whether to build a reports table, attendance/no-show state and an email blocklist checked on reservation create and mentor-profile publish.
- **Admin access.** Any confirmed `@apathyisboring.com` account is admin, with no allowlist and no offboarding, so former staff keep access to member data until their Supabase user is deleted. Proposed: require `app_metadata.role === 'admin'` (or an `ADMIN_EMAILS` env var, not comma-separated while `cloud-build.sh` uses commas) in `requireAdmin` and `isAdminUser`, and document offboarding (remove from the list, delete the Supabase user; it takes effect at once).
- **Refusal reasons.** Refusal emails use fixed copy. Optional: a small dialog with a reason (≤500 characters) used as the email intro, plus a Kimchi `kimchi.reservation_refused` notice.
- Should a member withdrawing a still-pending consultation request email the expert "Consultation cancelled"? Skip it when `cancelledBy === 'member' && previousStatus === 'pending'`?
- **Same-Tuesday handover.** Equipment and book blocks are inclusive Tuesday to Tuesday, so the next loan can start a week after a return at the earliest. Is that gap a deliberate turnaround buffer? If not, allow touching ends for fixed blocks (`hasReservationCollision`, client and server) and say returns come in before pickups. If it is, say so in the FAQ.
- **Contact inbox and Reply-To.** `CONTACT_TO` is hard-coded to one personal address, and email replies (`EMAIL_REPLY_TO`) default to it too. Once a role or privacy mailbox exists, read `CONTACT_TO` from env, set `EMAIL_REPLY_TO` to the role mailbox in `.env`, and pass both through `cloud-build.sh`.
- **Seeding.** `seedInventoryIfEmpty` still re-adds the June seed items if the catalogue is ever emptied. Gate it behind an env flag (e.g. `SEED_INVENTORY_IF_EMPTY=true`) or remove the legacy `data/` branch.
- **Mentor photos.** They sit letterboxed (`object-fit: contain`) in the shared 16:9 card frame, a deliberate choice for a uniform grid. Switch expertise cards to `cover` if fuller portraits are preferred.
- **French brand.** Pick the official French library name (`fr.json` uses "Bibliothèque ressources activistes", the consent line says "Bibliothèque de ressources militantes"). Provide the L'APATHIE C'EST PLATE wordmark if the header should switch in French.
- Privacy policy (`/privacy`, added 2026-10-05) needs a human review before launch:
  - **Google Analytics runs by default.** Law 25 (s. 8.1) expects tracking technology to be off until the person turns it on, so GA in `index.html` likely needs a consent banner or Consent Mode default-denied. The policy text describes GA but does not by itself make it compliant.
  - The policy names the **person in charge of the protection of personal information** by title only, with the office address, phone, and the `/about` contact form. Under Law 25 this defaults to AisB's highest authority unless delegated in writing. Add a dedicated email if one exists.
  - It says AisB assesses protection before sending data outside Québec (Supabase, Google Cloud `us-east1`, Resend, Zoom, Slack, GA). Those privacy impact assessments need to actually exist.
  - Retention is "while the account is active and as needed". There is no self-serve account deletion; requests are handled by hand (writing a deletion runbook is in the Low backlog).
  - Keep `content/policies/en` and `fr` in sync and bump *Last updated* on every change.
- **Sign in with Google / Discord** is live (providers enabled in Supabase 2026-10-05; setup steps in `AGENTS.md` → Auth (Supabase)). Keep `https://activistresourcelibrary.com/**` in Supabase Redirect URLs so sign-in returns to the starting page. The privacy policy names both as optional sign-in providers; they also belong in the outside-Québec assessment above.
- Not built yet: reminders, rescheduling, expert-side "decline" (experts cancel instead), French emails.

## Working notes

- **Local dev uses the production database.** The local `.env` points at the production Supabase project and has live Zoom, Resend, and Slack credentials, so `npm run dev` reads and writes real data. Requesting, scheduling, or cancelling locally creates real Zoom meetings, sends real emails, and posts to Slack. Browse read-only, and test write paths against a mocked Supabase client (or a separate dev project) unless the user approves a live test.
- `npm run dev` failed twice on 2026-10-05 with "Port 3000 is in use" while another `npm run dev` was already running; the auto-free in `scripts/dev.js` did not clear it. Check `lsof -i :3000 -i :5173` and reuse or stop the existing server first.
- Supabase **Confirm email** must stay on. Admin and expert checks rely on confirmed emails, and member checks rely on it implicitly.
- Locks, rate limits and the daily request cap are per process, so don't scale Cloud Run past one instance without moving them into Postgres (e.g. `SELECT … FOR UPDATE` or advisory locks).
- Fonts, brand images and inventory seed photos are cached for 7 days. Change one by adding a new file name, not by overwriting.
- Email previews were being checked by rendering HTML to `/tmp/arl-email-preview` and serving it with `python3 -m http.server 8765`. There is no script for this in the repo.
