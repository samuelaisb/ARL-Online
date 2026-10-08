# Automated emails (Resend)

Production emails are sent from `server.js` via the [Resend](https://resend.com) SDK. **Routes wait for their emails before they respond** (`settleNotifications()`): Cloud Run can throttle CPU once a response is out, which stalls sends still in flight. A failed email never turns a saved action into an error. The route still succeeds, logs the failure, and returns `emailSent: false` (see [`emailSent` in responses](#emailsent-in-responses)). Each send is capped at 10 seconds (`EMAIL_SEND_TIMEOUT_MS`). Resend's default rate limit is 2 requests per second per team: a send it refuses with 429 `rate_limit_exceeded` (nothing was sent) is retried once after 1 second (`EMAIL_RATE_LIMIT_RETRY_MS`). Nothing else is retried. Admin item deletes, which can email many people at once, send in paced rounds (see triggers 7 and 8).

**Reply-To:** every app email except the contact form sets `Reply-To` to `EMAIL_REPLY_TO` (default `samuel@apathyisboring.com`). `activistresourcelibrary.com` has no MX record and receives no mail, so without it a member's reply to `noreply@` would be lost. The contact form sets `Reply-To` to the visitor instead.

**Recipients are the member who made the reservation** (`userEmail` from the JWT at create time, stored on the reservation row) — plus, for expertise consultations, **the item's expert** (`inventory_items.expert_email`). There is no admin `EMAIL_TO` or env-based fallback recipient.

New pending reservation requests on equipment, books, and rooms do **not** send email — admins are notified via the [Slack webhook](automated-webhooks.md) only, and the member follows the request on `/account` (**Upcoming and pending reservations**). **Expertise consultations are the exception:** see triggers 5–7 (request received / new request, scheduled, cancelled). An admin deleting a member's upcoming equipment, book or room reservation (or its item) emails that member (trigger 8).

Email dates are written out in English (`formatReservationDates()`: "Tuesday, October 13, 2026 to Tuesday, October 20, 2026", one date when a room is booked for a single day).

---

## Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `RESEND_API_KEY` | Yes (at send time) | — | Resend API key. Server starts without it (warning logged); `getResend()` throws when sending if unset |
| `EMAIL_FROM` | No | `noreply@activistresourcelibrary.com` | Sender address on all app emails |
| `EMAIL_REPLY_TO` | No | `samuel@apathyisboring.com` (`CONTACT_TO`) | `Reply-To` on every app email except the contact form. One address (no commas: `cloud:build` passes it in a comma-separated list) |
| `SITE_URL` | Recommended (prod) | Falls back to `https://activistresourcelibrary.com` | Base origin for email links (`SITE_URL` or `VITE_SITE_URL`, trailing slash stripped). The header logo is an inline attachment (`cid:aisb-logo`) and does not depend on it |
| `ORG_ADDRESS` | No | `5310 Boulevard Saint-Laurent, Montréal QC H2T 1S1` | Footer street address (`orgContact` in `src/lib/email-brand.js`). `cloud:build` does not pass it — the comma breaks gcloud's env list |
| `ORG_PHONE` | No | `514.844.2472` | Footer phone. Passed by `cloud:build` when set in `.env` |
| `EMAIL_FUNDER_LOGO_URL` | No | unset | Absolute URL of a funder logo strip. When set, the member "consultation confirmed" email shows it above the footer |

**Cloud Run:** `RESEND_API_KEY` is mounted from Secret Manager (`resend-api-key`) when set in `.env` during `npm run cloud:build`. `EMAIL_FROM` is always set on deploy (default `noreply@activistresourcelibrary.com`; legacy `onboarding@resend.dev` in `.env` is migrated automatically). `EMAIL_REPLY_TO`, `ORG_PHONE` and `EMAIL_FUNDER_LOGO_URL` are set on the service when present in `.env` (a value set by hand in the Cloud Run console is wiped by the next deploy, because `--set-env-vars` replaces the list).

## Brand layout

All of the emails below share `renderBrandedEmail()` in `src/lib/email-brand.js` (HTML document + plain-text part):

| Piece | Treatment |
|-------|-----------|
| Header | Mint `#024238` band, English light wordmark inlined as `cid:aisb-logo` (200×114, `alt="Apathy is Boring"`), tagline **GET INVOLVED, BECAUSE APATHY IS BORING** in Light |
| Body | Light `#FAF9F7` background, Dark `#231F20` 15px Inter (Helvetica, Arial fallback), 21px uppercase headline |
| Button | Lemon `#FFDD2A` fill, Dark text, uppercase |
| Links | Grape `#473198`, bold, no underline |
| Footer | Dark background, Light 13px text: Apathy is Boring · office address · phone · apathyisboring.com, then why the person received it. No unsubscribe link (transactional) |

Ringold and P22 Mackinac Pro are not loaded. Emails are English-only, so the French wordmark is not used. The logo file is `src/assets/brand/apathy-is-boring-logo-light.png`, served at `/assets/brand/apathy-is-boring-logo-light.png`.

**Local smoke test:** `npm run send-email` runs `send-email.js` (not part of the web app — see [Dev-only script](#dev-only-script)).

---

## Emails by trigger

### 1. Reservation approved (member notification)

| Field | Value |
|-------|-------|
| **Trigger** | Successful `POST /api/inventory/:id/reservations/:reservationId/approve` |
| **Function** | `sendMemberDecisionEmail(item, reservation, 'approved')` → `buildMemberDecisionEmailPayload()` |
| **From** | `EMAIL_FROM` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | Reservation `userEmail` (from DB, originally from member JWT at create time) |
| **Subject** | `Reservation confirmed: {item title}` |
| **Timing** | Awaited after the approval is saved, before the HTTP 200 (`emailSent` in the response) |
| **Auth** | Admin only (`requireAuth` + `requireAdmin`) |

**Content summary:**

| Part | Equipment and books | Rooms |
|------|---------------------|-------|
| Intro | Your reservation request has been approved by Apathy is Boring. | Same |
| Details | **Item** (linked) + **Dates** | **Room** (linked) + **Dates** + **Where**: Apathy is Boring office, the `orgContact` address |
| Pickup | Pickups and drop offs are between 10am and 5pm on Tuesdays at the office address in `orgContact` | None (rooms can be booked on any day) |
| Closing | We look forward to seeing you at pickup. | If anything changes, just reply to this email. |
| Button | **View your item** (Lemon) plus a **Browse the library** link | **View the room** plus **Browse the library** |
| Footer | Apathy is Boring office line, then why this email was sent | Same |

No room email promises access details (entrance, hours, on-site contact); the FAQ no longer does either. Members reply to the email (Reply-To) for anything else.

**Expertise items:** approve schedules the consultation instead and sends the **Consultation scheduled** emails (trigger 6) to both member and expert. `buildMemberDecisionEmailPayload()` returns `null` for approved expertise items.

**Failure behavior:**

- No `userEmail` on reservation: skipped with console warning (`Skipping approved email: no member email…`); approve still succeeds with `emailSent: false`
- Missing `RESEND_API_KEY`, Resend error or 10 s timeout: logged (`Reservation approval email failed: …`); approve still succeeds with `emailSent: false`

---

### 2. Reservation refused (member notification)

| Field | Value |
|-------|-------|
| **Trigger** | Successful `POST /api/inventory/:id/reservations/:reservationId/refuse` |
| **Function** | `sendMemberDecisionEmail(item, reservation, 'refused')` |
| **From** | `EMAIL_FROM` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | Reservation `userEmail` |
| **Subject** | `Reservation update: {item title}` |
| **Timing** | Awaited after the refusal is saved, before the HTTP 200 (`emailSent` in the response) |
| **Auth** | Admin only |

**Content summary:**

| Part | Text |
|------|------|
| Intro | Unfortunately, the item you requested is not available for those dates. |
| Body | Item (or **Room**) title + date range |
| Closing | Please choose different dates or another item from the library. |
| Button | **Choose different dates** (item page) plus a **Browse the library** link |
| Footer | Same office line as the approval email |

**Expertise variant:** subject `Consultation update: {title}`; intro "Unfortunately, we cannot accommodate your consultation request right now." with a closing inviting another request.

**Failure behavior:** Same skip/log pattern as approval (`Skipping refused email…`, `Reservation refusal email failed: …`); refuse still succeeds with `emailSent: false`.

---

### 3. Member welcome (sign-up)

| Field | Value |
|-------|-------|
| **Trigger** | Successful `POST /api/auth/welcome-email` after sign-up or first sign-in within 7 days of account creation |
| **Function** | `sendWelcomeEmailIfNeeded(user)` → `buildWelcomeEmailPayload()` |
| **From** | `EMAIL_FROM` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | Authenticated member email from JWT |
| **Subject** | `Welcome to the Activist Resource Library` |
| **Timing** | Client fire-and-forget on `SIGNED_IN` or initial `initAuth` session when `user_metadata.welcome_email_sent` is unset (one in-flight request per user per page load) |
| **Auth** | Member JWT (`requireAuth`); IP rate-limited (10 / 15 min) |

**Content summary:**

| Part | Text |
|------|------|
| Intro | Welcome + thanks for creating a member account |
| CTA | Read **How it works** to get started (browse, reserve, pickup) |
| Pickup | Equipment reservations are typically on Tuesdays at the office address in `orgContact` |
| Contact | Questions? Contact us on the **About** page |
| Button | **How it works**, plus **Contact us** and **Browse inventory** links |
| Footer | Office line, then a note that they created a member account |

**Dedup / eligibility:**

- Skips when `user_metadata.welcome_email_sent` is already `true` (claimed in Supabase metadata before send; re-checked under a per-user server lock)
- Skips when account `created_at` is older than 7 days (legacy members are not emailed on later logins)
- Missing email on user: skipped with `sent: false`

**Failure behavior:**

- Missing `RESEND_API_KEY` or Resend error: logged (`Welcome email failed: …`); client receives 500
- The same claim posts the Slack staff alert `member_signed_up` (see `docs/automated-webhooks.md`), even when the email then fails
- Metadata update failure after send: logged; email was still delivered

---

### 4. About page contact form

| Field | Value |
|-------|-------|
| **Trigger** | Successful `POST /api/contact` from the About page form |
| **Function** | `buildContactEmailPayload()` → `getResend().emails.send()` |
| **From** | `EMAIL_FROM` |
| **To** | `samuel@apathyisboring.com` (hardcoded) |
| **Reply-To** | Submitter email from form body |
| **Subject** | `Activist Resource Library contact: {name}` |
| **Timing** | Synchronous — HTTP 500 if send fails |
| **Auth** | None (public); IP rate-limited (5 requests / 15 min); honeypot `website` field silently accepts bots |

**Content summary:**

| Part | Text |
|------|------|
| Intro | New message from the About page contact form. |
| Body | Submitter name, email, and message |
| Link | About page URL using `SITE_URL` (or production fallback) |
| Footer | Office line, then a note that this came from the About page |

**Failure behavior:**

- Missing `RESEND_API_KEY` or Resend error: logged (`Contact form email failed: …`); client receives 500
- Honeypot filled: returns `{ success: true }` without sending (anti-spam)

---

### 5. Consultation requested (member confirmation + expert notification — expertise only)

| Field | Value |
|-------|-------|
| **Trigger** | Successful `POST /api/inventory/:id/reservations` on an item with tag `expertise` |
| **Function** | `sendConsultationRequestEmails(item, reservation)` → `buildConsultationRequestEmailPayload()` (member) + `buildExpertRequestEmailPayload()` (expert) |
| **From** | `EMAIL_FROM` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | Member (`userEmail`) and expert (`item.expertEmail`) — separate emails |
| **Subject** | Member: `Consultation request received: {title}` · Expert: `New consultation request: {title}` |
| **Timing** | Awaited together with the Slack post after the pending reservation is saved, before the HTTP 201 (`emailSent` in the response) |
| **Auth** | Member JWT (`requireAuth`) |
| **Limits** | No email when the request is rejected: 10 saved creates per account per 24 h (429 `daily_request_limit`, all tags; a create counts once it is saved, even if the member's connection drops while the emails go out), and one open request per member per expert (409 `consultation_already_open` while they have a pending or not-yet-held consultation on that item). The 5-pending cap (429 `pending_request_limit`) and the IP limiter (429 `reservation_rate_limited`) send nothing either. These stop a member from emailing a mentor over and over with request → cancel loops |

**Content summary:**

| Recipient | Content |
|-----------|---------|
| Member | Thanks; the expert will pick a time and both get a Zoom invitation. Echoes their time slots + summary; links to `/account` (follow/cancel) and library home |
| Expert | Member email, time slots, summary; instructions to log in (or register) **with the expert email** and schedule from `/account`; link to `/account` |

**Failure behavior:** Missing member or expert email skips that email (missing expert email logs a warning — only admins can schedule such requests); Resend errors logged (`Consultation request email failed: …`); request still succeeds with `emailSent: false`. Equipment/books/rooms requests never trigger these emails.

---

### 6. Consultation scheduled (member + expert — expertise only)

| Field | Value |
|-------|-------|
| **Trigger** | Successful `POST /api/consultations/:reservationId/schedule` (expert or admin), admin `POST /api/inventory/:id/reservations/:reservationId/approve` on an expertise item, **or** `POST /api/consultations/:reservationId/follow-up` (expert books a follow-up; the new reservation has `followUpOf`) |
| **Function** | `runScheduleConsultation()` → `sendConsultationScheduledEmails()` → `buildConsultationScheduledEmailPayloads(item, reservation)` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | Member and expert (separate emails) |
| **Subject** | Member: `Consultation confirmed: {title}` · Expert: `Consultation scheduled: {title}`. Follow-ups: `Follow-up consultation confirmed: {title}` · `Follow-up consultation scheduled: {title}` (heading and intro say "follow-up consultation" too) |
| **Attachment** | `consultation.ics` (`METHOD:REQUEST`, UID `{reservationId}@activistresourcelibrary.com`, 60 min, Zoom link as location; both people as attendees) |
| **Timing** | Awaited after the Zoom meeting is created and the reservation is saved, before the response (`emailSent`). A failed email is logged (`Consultation scheduled email failed: …`, or `Consultation scheduled notifications failed: …` if it could not be built) and never undoes the schedule |

**Content summary:** meeting time (America/Toronto, labelled "Montreal time"), **Join Zoom** button + passcode (or "we will send you a meeting link" and an account-panel button when Zoom is not configured), note that anyone can join before the host and share their screen, how to cancel from `/account`. Member email also includes "This project is funded by YES Employment.", a **Share your information** link (**placeholder `https://REPLACE-ME.example/participant-info` — update `CONSULTATION_DATA_FORM_URL` in `server.js`**), and the funder logo strip when `EMAIL_FUNDER_LOGO_URL` is set. Expert email includes the member email and request summary. For a follow-up, the expert's optional note is shown as **Follow-up note** in both emails (it replaces the request summary row in the expert's), and the `.ics` `SUMMARY` reads `Follow-up consultation: {title}`. The follow-up route logs failures as `Follow-up consultation notifications failed: …`.

---

### 7. Consultation cancelled (member + expert — expertise only)

| Field | Value |
|-------|-------|
| **Trigger** | `POST /api/consultations/:reservationId/cancel` (member, expert, or admin); admin `DELETE` of an active expertise reservation; admin `DELETE` of an expertise item with active reservations. **Never for a held meeting** (`reserved` and `meetingAt` + 60 min has passed, `isConsultationHeld()`): the cancel route answers 400 `consultation_already_held`, and admin deletes remove the row without a Zoom delete or email |
| **Function** | `handleConsultationCancelled()` → `buildConsultationCancelledEmailPayloads(item, reservation, previousStatus)` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | Member and expert (separate emails) |
| **Subject** | `Consultation cancelled: {title}` |
| **Timing** | Awaited after the Zoom meeting is deleted, before the response (`emailSent`). Deleting an expertise item cancels its active consultations in paced rounds (`settleNotificationRounds()`): one consultation per round, each round taking at least 1 s for its two emails, to stay under Resend's rate limit |
| **Attachment** | `consultation-cancelled.ics` (`METHOD:CANCEL`, same UID) — only when it had been scheduled |

**Content summary:** "You cancelled …" for the person who cancelled; "The member / The expert / The Activist Resource Library team cancelled …" for the other. Names the scheduled time when there was one and confirms the Zoom meeting was removed.

---

### 8. Reservation cancelled by the library team (member — equipment, books, rooms)

| Field | Value |
|-------|-------|
| **Trigger** | Admin `DELETE /api/inventory/:id/reservations/:reservationId`, or admin `DELETE /api/inventory/:id`, on an equipment, book or room item, for each deleted reservation that is `pending`, or `reserved` with `endDate` on or after today (`isUpcomingMemberReservation()`; "today" is Montréal's date, see below). Past bookings, refused, cancelled and legacy `available` rows are deleted without email |
| **Function** | `sendReservationCancelledByTeamEmail()` → `buildReservationCancelledByTeamEmailPayload(item, reservation, today)` |
| **From** | `EMAIL_FROM` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | Reservation `userEmail` |
| **Subject** | `Reservation cancelled: {item title}` |
| **Timing** | Awaited before the response (`emailSent`). An item delete emails its members in paced rounds (`settleNotificationRounds()`, at least 0.5 s per email) to stay under Resend's rate limit |
| **Auth** | Admin only |

**Content summary:**

| Part | Text |
|------|------|
| Intro | Your reservation (or, for `pending`, reservation request) for {item} ({dates}) was cancelled by the Activist Resource Library team. |
| Pickup | Approved equipment or book bookings only. Before the first day: Please do not come to pickup for this reservation. From the first day on (the member may already have the item): If you have already picked up the item, please reply to this email to arrange returning it. Otherwise, please do not come to pickup. Rooms and pending requests get neither line |
| Closing | You are welcome to choose other dates or another item from the library. If you have questions, just reply to this email. |
| Button | **Browse the library** → the item's category page (`/equipment`, `/books`, `/rooms`); the item itself may be gone |

"Today" is Montréal's date, `libraryTodayKey()` in `src/lib/calendar.js` (`America/Toronto` through `Intl`), not the container's UTC date, so a booking stays upcoming until midnight Montréal time on its last day. The admin panel's delete confirms use the same helper, so "the member will be emailed" matches what the server sends whatever the admin's browser time zone.

**Failure behavior:** No member email: skipped with a warning (`Skipping cancellation email…`), `emailSent: false`. Resend error or timeout: logged (`Reservation cancelled email failed: …`), `emailSent: false`; the delete still succeeds.

---

## `emailSent` in responses

Routes that send email add `emailSent` to their JSON. It is `true` only when there was at least one email and Resend accepted every one. It is `false` when any send failed, timed out, or threw while being built, and when there was nobody to email (for example a reservation with no member email). Failures are logged either way. The client reads it only to avoid claiming an email that didn't go out: `AdminPanel` (approve, refuse, deletes, follow-up) and `AccountConsultations` (schedule, cancel, follow-up) show Kimchi's plain bubbles (`kimchi.*_plain`, or the bubble without "has been emailed") when it is `false`, and their hidden status lines add an "emailed" note only when it isn't (`AdminPanel`: only when it is `true`). There is no warning UI; see `docs/automated-notifications.md`.

| Route | `emailSent` covers |
|-------|--------------------|
| `POST /api/inventory/:id/reservations` | Expertise only: the member and expert request emails. Equipment/books/rooms responses have no `emailSent` (they only post to Slack) |
| `POST /api/inventory/:id/reservations/:reservationId/approve` | The approval email, or for expertise the two scheduled emails |
| `POST /api/inventory/:id/reservations/:reservationId/refuse` | The refusal email |
| `POST /api/consultations/:reservationId/schedule` | The two scheduled emails |
| `POST /api/consultations/:reservationId/follow-up` | The two scheduled emails, worded as a follow-up |
| `POST /api/consultations/:reservationId/cancel` | The cancellation emails. The response also has `otherPartyEmailed`: `emailSent` and the other side has an address on file (the trimmed `item.expertEmail` when the member cancels, the trimmed `reservation.userEmail` when the expert does, both when an admin does). A mentor with no address is skipped while the member's email still goes out, so `emailSent` alone can be `true` when the mentor wasn't told. Only the boolean is returned, never an address |
| `DELETE /api/inventory/:id/reservations/:reservationId` | Only when it cancelled an active consultation (not for a held one) or an upcoming equipment, book or room reservation (trigger 8) |
| `DELETE /api/inventory/:id` | Only when the item had active, not-yet-held consultations (expertise) or upcoming member reservations (other tags); `false` if any of their emails failed or a reservation had no member email |

---

## What does **not** send email

| Action | Notes |
|--------|-------|
| `POST /api/inventory/:id/reservations` (new pending request, equipment/books/rooms) | Slack webhook only — see [automated-webhooks.md](automated-webhooks.md). Expertise items send trigger 5 |
| `DELETE /api/inventory/:id/reservations/:reservationId` | No email for a past equipment/book/room booking or a held consultation (upcoming ones send trigger 8; active consultations send trigger 7) |
| `PATCH /api/inventory/:id/reservations/:reservationId` | No email |
| `POST /api/inventory` (add item) | No email |
| `DELETE /api/inventory/:id` (remove item) | No email for past or inactive rows (trigger 7 for active, not-yet-held consultations; trigger 8 for upcoming equipment/book/room reservations) |
| `POST /api/account/reservations/:reservationId/cancel` (member withdraws a request or cancels a booking) | No email to anyone. Cancelling an approved booking posts a Slack staff alert (`reservation_cancelled_by_member`, [automated-webhooks.md](automated-webhooks.md#staff-alerts)); withdrawing a pending request is silent |
| `POST` / `PATCH /api/account/mentor-profile` | No email; staff get a Slack alert ([automated-webhooks.md](automated-webhooks.md#staff-alerts)) |
| Rejected reservation create (409 `consultation_already_open`, 429 `daily_request_limit` / `pending_request_limit` / `reservation_rate_limited`) | No email |
| Reservation create failure / collision | No email |

---

## Dev-only script

`send-email.js` (`npm run send-email`) is a standalone Resend smoke test:

| Field | Value |
|-------|-------|
| From | Hardcoded `noreply@activistresourcelibrary.com` |
| Reply-To | `EMAIL_REPLY_TO` from `.env`, else `samuel@apathyisboring.com` |
| To | Hardcoded test address in script (not used by the web app) |
| Subject | `Activist Resource Library email check` |
| Body | Branded smoke-test message from `renderBrandedEmail()` (HTML + plain text) |

Exits with error if `RESEND_API_KEY` is missing. **Not invoked by the web app.**

---

## Gaps / external email

| Source | Notes |
|--------|-------|
| **Supabase Auth** | Sign-up confirmation, magic links, and password reset emails are configured in the Supabase dashboard (**Authentication → Email Templates**, sent through Supabase's mailer or the custom SMTP set under **Authentication → SMTP Settings**) — not in this codebase, and not through Resend; recipients are always the account's own email. Since 2026-10-05 the app **requests** the **Reset Password** email itself: **Forgot password?** in the login dialog calls `supabase.auth.resetPasswordForEmail(email, { redirectTo })` (`requestPasswordReset` in `src/lib/auth.js`), where `redirectTo` is the current page (item pages become their category, `?reserve` dropped) plus `?password_reset=1`. Supabase answers the same whether or not the address has an account, and the form always shows the same neutral confirmation. The template is English-only (one template per project) and must keep `{{ .ConfirmationURL }}` so the link returns to that page with the recovery session. Supabase's built-in sender is meant for testing: a few emails per hour across the whole project, delivered only to addresses on the Supabase organization's team; production needs custom SMTP (for example Resend's SMTP) for reset emails to arrive reliably |
| **Member welcome email** | Sent via Resend on sign-up / first sign-in (`POST /api/auth/welcome-email`); separate from Supabase confirmation email |
| **No member “request received” email (equipment/books/rooms)** | Members see Kimchi and the calendar status, then the request on `/account` (**Upcoming and pending reservations**, where they can withdraw it); admins get the Slack webhook. Expertise consultations do send a confirmation email |
| **Room access details** | Not sent by any email. The room approval email confirms the dates and the office address; anything else goes through a reply |
| **Zoom does not email invitations** | Zoom's API creates the meeting only; the invitation is our Resend email + `.ics` attachment (trigger 6) |
| **Consultation data-sharing link is a placeholder** | `CONSULTATION_DATA_FORM_URL` in `server.js` is `https://REPLACE-ME.example/participant-info` until the real YES Employment form URL is provided |
| **No i18n on emails** | All server email copy is English-only hardcoded strings in `server.js` |

---

## Source files

| File | Role |
|------|------|
| `server.js` | Resend client, `EMAIL_REPLY_TO`, member decision + team-cancellation + consultation payload builders (`buildConsultationEmail`, `buildConsultationIcs`, `buildReservationCancelledByTeamEmailPayload`), `formatReservationDates`, send functions (`sendEmailPayloads`, 10 s cap), `settleNotifications` (routes await emails + Slack), route hooks |
| `src/lib/email-brand.js` | Shared branded HTML + plain-text layout (`renderBrandedEmail`, `orgContact`) |
| `src/assets/brand/apathy-is-boring-logo-light.png` | English light wordmark, flattened onto Mint, attached inline on every email |
| `src/lib/zoom.js` | Zoom meeting create/delete used before scheduled/cancelled emails |
| `.env.example` | Env var template |
| `send-email.js` | One-off Resend test script |
| `scripts/cloud-build.sh` | Deploy-time `EMAIL_FROM` (and `EMAIL_REPLY_TO` when set) and Secret Manager binding for `RESEND_API_KEY` |
