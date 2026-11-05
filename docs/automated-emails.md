# Automated emails (Resend)

Production emails are sent from `server.js` via the [Resend](https://resend.com) SDK. **Routes wait for their emails before they respond** (`settleNotifications()`): Cloud Run can throttle CPU once a response is out, which stalls sends still in flight. A failed email never turns a saved action into an error. The route still succeeds, logs the failure, and returns `emailSent: false` (see [`emailSent` in responses](#emailsent-in-responses)). Each send is capped at 10 seconds (`EMAIL_SEND_TIMEOUT_MS`). Resend's default rate limit is 2 requests per second per team: a send it refuses with 429 `rate_limit_exceeded` (nothing was sent) is retried once after 1 second (`EMAIL_RATE_LIMIT_RETRY_MS`). Nothing else is retried. Admin item deletes and member account deletes, which can email many people at once, send in paced rounds (see triggers 7 and 8).

**Reply-To:** every app email except two sets `Reply-To` to `EMAIL_REPLY_TO` (default `samuel@apathyisboring.com`). `activistresourcelibrary.com` has no MX record and receives no mail, so without it a member's reply to `noreply@` would be lost. The contact form sets `Reply-To` to the visitor instead, and a message about a booking sent from `/account` (triggers 13 and 14) to its sender, so a reply goes straight to the other person.

**Recipients are the member who made the reservation** (`userEmail` from the JWT at create time, stored on the reservation row) — plus, for expertise consultations, **the item's expert** (`inventory_items.expert_email`). The admin password reset (trigger 9) goes to the account's own email from Supabase Auth. A booking staff create in admin (trigger 10, or trigger 6 for a meeting with a mentor) stores, and emails, the address they typed, which may have no account yet. When staff give a mentor a new address, the new address gets the open consultations' expert emails again (trigger 11). There is no admin `EMAIL_TO` or env-based fallback recipient.

New pending reservation requests on equipment, books, and rooms do **not** send email — admins are notified via the [Slack webhook](automated-webhooks.md) only, and the member follows the request on the `/account` agenda (under **Coming up**). **Expertise consultations are the exception:** see triggers 5–7 (request received / new request, scheduled, cancelled). An admin deleting a member's upcoming equipment, book or room reservation (or its item) emails that member (trigger 8). In `/admin` → **Members**, deleting a member account cancels their active bookings and sends triggers 7 and 8 for them, and **Send password reset** sends trigger 9.

From the `/account` agenda (migration 015; the actions below sit in each entry's **More** menu, or are the one button of a **Needs you** card): every confirmed booking gets a reminder about a day before it starts (trigger 12); the person who booked can write to the item's host, or suggest a new time (trigger 13), and the host can write back (trigger 14); a mentor (or the owner of a mentor with no address) can move a meeting (trigger 15); the owner of a room, equipment or book can give a booking new dates (trigger 16), approve or decline a request (trigger 17, the admin emails 1 and 2) and cancel a booking (trigger 18, the team-cancel email 8). The host of an item is its effective owner (`itemOwnerEmail()`: a mentor's `expert_email`, else the item's `owner_email`).

Email dates are written out in English (`formatReservationDates()`: "Tuesday, October 13, 2026 to Tuesday, October 20, 2026", one date when a room is booked for a single day). Room hours are Montréal wall-clock times, written `6:00 p.m. to 9:00 p.m.` with no time-zone conversion (`formatRoomTimes()`).

---

## Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `RESEND_API_KEY` | Yes (at send time) | — | Resend API key. Server starts without it (warning logged); `getResend()` throws when sending if unset |
| `EMAIL_FROM` | No | `noreply@activistresourcelibrary.com` | Sender address on all app emails |
| `EMAIL_REPLY_TO` | No | `samuel@apathyisboring.com` (`CONTACT_TO`) | `Reply-To` on every app email except the contact form. One address (no commas: `cloud:build` passes it in a comma-separated list) |
| `SITE_URL` | Recommended (prod) | Falls back to `https://activistresourcelibrary.com` | Base origin for email links (`SITE_URL` or `VITE_SITE_URL`, trailing slash stripped). The header wordmark is text and does not depend on it |
| `ORG_ADDRESS` | No | `5310 Boulevard Saint-Laurent, Montréal QC H2T 1S1` | Footer street address (`orgContact` in `src/lib/email-brand.js`) and the welcome email's pickup line. An approved item's own address comes from `item_locations` (migration 010), not from this. `cloud:build` does not pass it — the comma breaks gcloud's env list |
| `ORG_PHONE` | No | `514.844.2472` | Footer phone. Passed by `cloud:build` when set in `.env` |
| `EMAIL_FUNDER_LOGO_URL` | No | unset | Absolute URL of a funder logo strip. When set, the member "consultation confirmed" email shows it above the footer |

**Cloud Run:** `RESEND_API_KEY` is mounted from Secret Manager (`resend-api-key`) when set in `.env` during `npm run cloud:build`. `EMAIL_FROM` is always set on deploy (default `noreply@activistresourcelibrary.com`; legacy `onboarding@resend.dev` in `.env` is migrated automatically). `EMAIL_REPLY_TO`, `ORG_PHONE` and `EMAIL_FUNDER_LOGO_URL` are set on the service when present in `.env` (a value set by hand in the Cloud Run console is wiped by the next deploy, because `--set-env-vars` replaces the list).

## Brand layout

All of the emails below share `renderBrandedEmail()` in `src/lib/email-brand.js` (HTML document + plain-text part):

| Piece | Treatment |
|-------|-----------|
| Header | Mint `#024238` band, live-text wordmark linking to apathyisboring.com (APATHY over a small IS and BORING, 48px bold uppercase Light, Helvetica Neue / Helvetica / Arial), tagline **GET INVOLVED, BECAUSE APATHY IS BORING** in Light |
| Body | Light `#FAF9F7` background, Dark `#231F20` 15px Inter (Helvetica, Arial fallback), 21px uppercase headline |
| Button | Lemon `#FFDD2A` fill, Dark text, uppercase |
| Links | Grape `#473198`, bold, no underline |
| Footer | Dark background, Light 13px text: Apathy is Boring · office address · phone · apathyisboring.com, then why the person received it. No unsubscribe link (transactional) |

Ringold and P22 Mackinac Pro are not loaded. The wordmark is text rather than an image so it shows the moment the email opens: email clients load images after the HTML (and Outlook blocks them by default), and Gmail and Outlook don't show SVG. It uses system fonts only, since a webfont would also swap in after open. Emails are English-only, so the wordmark is English. The only image left is the optional funder strip.

**Local smoke test:** `npm run send-email` runs `send-email.js` (not part of the web app — see [Dev-only script](#dev-only-script)).

---

## Emails by trigger

### 1. Reservation approved (member notification)

| Field | Value |
|-------|-------|
| **Trigger** | Successful `POST /api/inventory/:id/reservations/:reservationId/approve`, or the item's owner approving on `/account` (`POST /api/account/hosted-reservations/:reservationId/approve`, trigger 17) |
| **Function** | `sendMemberDecisionEmail(item, reservation, 'approved')` → `buildMemberDecisionEmailPayload()` |
| **From** | `EMAIL_FROM` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | Reservation `userEmail` (from DB, originally from member JWT at create time) |
| **Subject** | `Reservation confirmed: {item title}` |
| **Timing** | Awaited after the approval is saved, before the HTTP 200 (`emailSent` in the response) |
| **Auth** | Admin only (`requireAuth` + `requireAdmin`), or the item's confirmed owner on `/account` |

**Content summary:**

| Part | Equipment and books | Rooms |
|------|---------------------|-------|
| Intro | Your reservation request has been approved by Apathy is Boring. | Same |
| Details | **Item** (linked) + **Dates** + **Where** + **Getting there** | **Room** (linked) + **Dates** + **Times** + **Where** + **Getting there**. **Times** is the hours the member asked for (`formatRoomTimes()`: "6:00 p.m. to 9:00 p.m.", "…, each day" over several days); left out when the request has none (older requests). The purpose they gave is not repeated |
| Where | The item's own place (`item.location`, from `item_locations`; the office for every current item), on three lines: place name, street, `Montréal QC H2T 1S1` | Same |
| Getting there | The place's English transit note (`transit_note_en`; the row is left out when empty). Office: "Bus 55 stops about 60 m away at Saint-Laurent / Maguire (northbound) and about 200 m away at Saint-Urbain / Fairmount (southbound). Laurier metro station (Orange line) is about 750 m away." | Same |
| Message | **Message from the library team**: the optional note staff typed under **Approve** (body `message`, max 1000; the row is left out when empty) | Same |
| Pickup | Pickups and drop offs are between 10am and 5pm on Tuesdays at the address above. | None (rooms can be booked on any day) |
| Closing | We look forward to seeing you at pickup. | If anything changes, just reply to this email. |
| Button | **View your item** (Lemon), then **Get directions** (Google Maps directions to the street address, transit selected: `https://www.google.com/maps/dir/?api=1&destination=…&travelmode=transit`) and **Browse the library** links; both URLs are in the plain-text part too | **View the room**, then **Get directions** and **Browse the library** |
| Footer | Apathy is Boring office line, then why this email was sent | Same |

If the item points at a place the server can't find (an id other than the office's that isn't in `item_locations`, even after a forced reload of the cache), the email has no **Where**, **Getting there** or **Get directions** rather than naming an address that may be wrong: equipment and books say "Pickups and drop offs are between 10am and 5pm on Tuesdays. Reply to this email and we will send you the address.", and rooms add "Reply to this email and we will send you the room's address." before the changes line. The office itself always resolves (from the built-in copy of its row when the table can't be read). The same full address is on the member's `/account` row while the reservation is confirmed and not over; the public site shows only the city, province and postal code.

No room email promises access details (entrance, hours, on-site contact); the FAQ no longer does either. Members reply to the email (Reply-To) for anything else.

**Expertise items:** approve schedules the consultation instead and sends the **Consultation scheduled** emails (trigger 6) to both member and expert. `buildMemberDecisionEmailPayload()` returns `null` for approved expertise items.

**Failure behavior:**

- No `userEmail` on reservation: skipped with console warning (`Skipping approved email: no member email…`); approve still succeeds with `emailSent: false`
- Missing `RESEND_API_KEY`, Resend error or 10 s timeout: logged (`Reservation approval email failed: …`); approve still succeeds with `emailSent: false`

---

### 2. Reservation refused (member notification)

| Field | Value |
|-------|-------|
| **Trigger** | Successful `POST /api/inventory/:id/reservations/:reservationId/refuse`, or the item's owner declining on `/account` (`POST /api/account/hosted-reservations/:reservationId/refuse`, trigger 17) |
| **Function** | `sendMemberDecisionEmail(item, reservation, 'refused')` |
| **From** | `EMAIL_FROM` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | Reservation `userEmail` |
| **Subject** | `Reservation update: {item title}` |
| **Timing** | Awaited after the refusal is saved, before the HTTP 200 (`emailSent` in the response) |
| **Auth** | Admin only, or the item's confirmed owner on `/account` |

**Content summary:**

| Part | Text |
|------|------|
| Intro | Unfortunately, the item you requested is not available for those dates. |
| Body | Item (or **Room**) title + date range (+ **Times** for a room request with hours) |
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
| Expert | The intro (also the inbox preview) says to log in **with the expert email** to view the request, and names that address. Member email, time slots, summary; a "No account yet?" line to register with that email and confirm it (expert requests only show to confirmed accounts); schedule from `/account`; link to `/account` |

**Failure behavior:** Missing member or expert email skips that email (missing expert email logs a warning — only admins can schedule such requests); Resend errors logged (`Consultation request email failed: …`); request still succeeds with `emailSent: false`. Equipment/books/rooms requests never trigger these emails.

---

### 6. Consultation scheduled (member + expert — expertise only)

| Field | Value |
|-------|-------|
| **Trigger** | Successful `POST /api/consultations/:reservationId/schedule` (expert, the owner of a mentor with no `expert_email`, or admin), admin `POST /api/inventory/:id/reservations/:reservationId/approve` on an expertise item, `POST /api/consultations/:reservationId/follow-up` (expert, owner or admin books a follow-up, from the day of the meeting; the new reservation has `followUpOf`), **or** `/admin` → **Create Reservation** on a mentor (`POST /api/admin/inventory/:id/reservations` with `meetingAt`: staff book the meeting for any address, member or not) |
| **Function** | `runScheduleConsultation()` → `sendConsultationScheduledEmails()` → `buildConsultationScheduledEmailPayloads(item, reservation, { message, messageFrom, account })`; the follow-up and Create Reservation routes call `sendConsultationScheduledEmails()` directly |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | Member and expert (separate emails) |
| **Subject** | Member: `Consultation confirmed: {title}` · Expert: `Consultation scheduled: {title}`. Follow-ups: `Follow-up consultation confirmed: {title}` · `Follow-up consultation scheduled: {title}` (heading and intro say "follow-up consultation" too) |
| **Attachment** | `consultation.ics` (`METHOD:REQUEST`, UID `{reservationId}@activistresourcelibrary.com`, 60 min, Zoom link as location; both people as attendees). `SEQUENCE` is the time the file was built in seconds since 1970 (`buildConsultationIcs`), so a later invite for the same UID (a move, trigger 15; a handover, trigger 11) or a cancellation always replaces this one in the calendar |
| **Timing** | Awaited after the Zoom meeting is created and the reservation is saved, before the response (`emailSent`). A failed email is logged (`Consultation scheduled email failed: …`, or `Consultation scheduled notifications failed: …` if it could not be built) and never undoes the schedule |

**Content summary:** meeting time (America/Toronto, labelled "Montreal time"), **Join Zoom** button + passcode (or "we will send you a meeting link" and an account-panel button when Zoom is not configured), note that anyone can join before the host and share their screen, how to cancel from `/account`. Member email also includes "This project is funded by YES Employment.", a **Share your information** link (**placeholder `https://REPLACE-ME.example/participant-info` — update `CONSULTATION_DATA_FORM_URL` in `server.js`**), and the funder logo strip when `EMAIL_FUNDER_LOGO_URL` is set. Expert email includes the member email and request summary. For a follow-up, the expert's optional note is shown as **Follow-up note** in both emails (it replaces the request summary row in the expert's), and the `.ics` `SUMMARY` reads `Follow-up consultation: {title}`. The follow-up route logs failures as `Follow-up consultation notifications failed: …`. When whoever scheduled it typed the optional message (body `message` on schedule or approve, max 1000, never stored), the member's email shows it as **Message from {title}** (the expert) or **Message from the library team** (staff), and the expert's as **Your message to the member** or **Message from the library team to the member**; with no message the row is left out. Who is speaking is `consultationHostVoice()`: the expert, and an owner who isn't staff, speak as the mentor; staff, including an admin who owns a mentor with no address, as the library team. Follow-ups don't take a message (their note does that job).

**Booked by staff (Create Reservation):** the route passes `account` (`member`, `new` or `unknown`, from the same Supabase Auth lookup as trigger 10; a suspended account is refused with 409 `reservation_account_suspended` before anything is saved). Subjects, `.ics`, Zoom rows, funder lines and the cancel notice are as above. The member's email changes in four places:

| Part | Text |
|------|------|
| Intro (also the preheader) | The Activist Resource Library team has booked you a consultation with {mentor's email, or the title when there is none} for {time}. Then trigger 10's account sentence with "To see or cancel it": `member` "…, log in with this email address: {email}"; `new` "… online, create a free account with this email address: {email}"; `unknown` "… online, log in or create a free account with this email address: {email}" |
| Details | **What you would like to discuss**: the topic staff typed (left out when empty), after **Message from the library team** |
| Account paragraph | After the room notice. `new`: Once you have confirmed your email address, the consultation will be on your account page. `unknown`: If you create an account, confirm your email address and the consultation will be on your account page. `member`: none |
| Account link | **Create your account** for `new` (the button too when there is no Zoom link), **Your account panel** otherwise. Footer `EMAIL_WHY.staffConsultation`: "You are receiving this because the Activist Resource Library team booked a consultation for this email address." |

The mentor's email opens with "The Activist Resource Library team has booked {member} a consultation with you for {time}." and shows the topic as **What they would like to discuss**, as for a member's request. A mentor with no email on file gets nothing (staff send the link). The route logs failures as `Consultation scheduled email failed: …`, and a failed email never undoes the booking (`emailSent: false`).

---

### 7. Consultation cancelled (member + expert — expertise only)

| Field | Value |
|-------|-------|
| **Trigger** | `POST /api/consultations/:reservationId/cancel` (member, expert, the owner of a mentor with no `expert_email`, or admin); admin `DELETE` of an active expertise reservation; admin `DELETE` of an expertise item with active reservations; admin `DELETE /api/admin/users/:id` (member account delete) for each of that member's pending or not-yet-held consultations (`cancelledBy: 'admin'`). **Never for a held meeting** (`reserved` and `meetingAt` + 60 min has passed, `isConsultationHeld()`): the cancel route answers 400 `consultation_already_held`, and admin deletes remove the row without a Zoom delete or email |
| **Function** | `handleConsultationCancelled()` → `buildConsultationCancelledEmailPayloads(item, reservation, previousStatus)` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | Member and expert (separate emails) |
| **Subject** | `Consultation cancelled: {title}` |
| **Timing** | Awaited after the Zoom meeting is deleted, before the response (`emailSent`). Deleting an expertise item, or a member account, cancels the active consultations in paced rounds (`settleNotificationRounds()`): one consultation per round, each round taking at least 1 s for its two emails, to stay under Resend's rate limit |
| **Attachment** | `consultation-cancelled.ics` (`METHOD:CANCEL`, same UID, `SEQUENCE` = seconds since 1970 as in trigger 6) — only when it had been scheduled |

**Content summary:** "You cancelled …" for the person who cancelled; "The member / The expert / The Activist Resource Library team cancelled …" for the other (an admin cancel, including a member account delete, says "The Activist Resource Library team" to both; the member is emailed before their address is stripped from the row). An owner's cancel is recorded and worded by `consultationHostVoice()`: `admin` (the library team) for staff, `expert` for a non-staff owner. Names the scheduled time when there was one and confirms the Zoom meeting was removed.

---

### 8. Reservation cancelled by the library team (member — equipment, books, rooms)

| Field | Value |
|-------|-------|
| **Trigger** | Admin `DELETE /api/inventory/:id/reservations/:reservationId`, or admin `DELETE /api/inventory/:id`, on an equipment, book or room item, for each deleted reservation that is `pending`, or `reserved` with `endDate` on or after today (`isUpcomingMemberReservation()`; "today" is Montréal's date, see below). Past bookings, refused, cancelled and legacy `available` rows are deleted without email. Also admin `DELETE /api/admin/users/:id` (member account delete): the same rows of that member are cancelled instead of deleted (`cancelReservationByAdmin`, `cancelled_by: 'admin'`, kept as history) and emailed, worded from their status before the cancel; that member's past-dated `pending` requests are cancelled without email. Also the item's owner cancelling a confirmed booking from `/account` (trigger 18, `cancelled_by: 'owner'`) |
| **Function** | `sendReservationCancelledByTeamEmail()` → `buildReservationCancelledByTeamEmailPayload(item, reservation, today, message = '')` |
| **From** | `EMAIL_FROM` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | Reservation `userEmail` |
| **Subject** | `Reservation cancelled: {item title}` |
| **Timing** | Awaited before the response (`emailSent`). An item delete emails its members, and a member account delete that member's bookings, in paced rounds (`settleNotificationRounds()`, at least 0.5 s per email) to stay under Resend's rate limit |
| **Auth** | Admin only, or the item's confirmed owner on `/account` |

**Content summary:**

| Part | Text |
|------|------|
| Intro | Your reservation (or, for `pending`, reservation request) for {item} ({dates}) was cancelled by the Activist Resource Library team. |
| Message | **Message from the library team**: the owner's optional note (body `message` on the `/account` cancel, max 1000; the `/account` page has no field for it yet). Staff deletes have none, and the row is left out when empty |
| Pickup | Approved equipment or book bookings only. Before the first day: Please do not come to pickup for this reservation. From the first day on (the member may already have the item): If you have already picked up the item, please reply to this email to arrange returning it. Otherwise, please do not come to pickup. Rooms and pending requests get neither line |
| Closing | You are welcome to choose other dates or another item from the library. If you have questions, just reply to this email. |
| Button | **Browse the library** → the item's category page (`/equipment`, `/books`, `/rooms`); the item itself may be gone |

"Today" is Montréal's date, `libraryTodayKey()` in `src/lib/calendar.js` (`America/Toronto` through `Intl`), not the container's UTC date, so a booking stays upcoming until midnight Montréal time on its last day. The admin panel's delete confirms use the same helper, so "the member will be emailed" matches what the server sends whatever the admin's browser time zone.

**Failure behavior:** No member email: skipped with a warning (`Skipping cancellation email…`), `emailSent: false`. Resend error or timeout: logged (`Reservation cancelled email failed: …`), `emailSent: false`; the delete still succeeds. For a member account delete, everyone whose booking was already cancelled is emailed even when a later step fails (500 `user_delete_incomplete`), because a retry won't see those rows as active again.

---

### 9. Password reset sent by staff (member)

| Field | Value |
|-------|-------|
| **Trigger** | `/admin` → **Members** → **Send password reset** → `POST /api/admin/users/:id/password-reset` |
| **Function** | `auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } })` with `redirectTo` = `${EMAIL_SITE_ORIGIN}/?password_reset=1` makes the link (Supabase sends nothing itself), then `buildPasswordResetEmailPayload(email, actionLink)` (`buildConsultationEmail` layout) → `sendEmailPayloads(…, 'Password reset')` |
| **From** | `EMAIL_FROM` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | The account's own email, read fresh from Supabase Auth (`getUserById`) |
| **Subject** | `Set a new password for the Activist Resource Library` |
| **Timing** | Awaited; the route answers 200 `{ emailSent: true }` only when Resend accepted it |
| **Auth** | Admin only. Only accounts with an email/password login that aren't suspended (else 400 `password_reset_unavailable`, nothing sent). At most 3 per target account per hour (`adminPasswordResetLimiter`, keyed by user id, own `MemoryStore`; only successful sends count), then 429 `password_reset_limited`. One action per account at a time (in-process lock) |

**Content summary:**

| Part | Text |
|------|------|
| Heading | Set a new password |
| Intro | The Activist Resource Library team sent you a link to choose a new password for your member account. |
| Body | The link works once and expires after a short while; if it has expired, choose "Forgot password?" when you log in to get a new one. If you weren't expecting this email, you can ignore it: your password stays the same until you choose a new one. |
| Button | **Choose a new password** → Supabase's one-time recovery link, which signs the member in and returns to the homepage with `?password_reset=1`, where **Set a new password** opens (an expired or used link opens the reset view with `auth.reset_link_expired`) |
| Footer | Office line, then `EMAIL_WHY.passwordReset`: "You are receiving this because the Activist Resource Library team sent a password reset link to your member account." |

The redirect (`https://activistresourcelibrary.com/?password_reset=1`, or `SITE_URL`'s origin) must be allowed in Supabase → **Authentication** → **URL Configuration** → Redirect URLs (`https://activistresourcelibrary.com/**` covers it); otherwise Supabase sends the member to the Site URL without the flag. Generating a link replaces the account's previous recovery link. Unlike **Forgot password?**, this email goes through Resend, so it arrives without Supabase's custom SMTP. Audit line `send_password_reset` (user id only).

**Failure behavior:** all three answer 502 `password_reset_failed` (`admin.users_reset_failed` in the UI) and send nothing: `RESEND_API_KEY` unset (checked first, so no link is made; logged `Password reset email not sent: RESEND_API_KEY is not configured.`), `generateLink` failing (logged `Password reset link failed: …`), or a Resend error or timeout (logged `Password reset email failed: …`).

---

### 10. Reservation booked by staff (member or not — equipment, books, rooms)

A meeting with a mentor booked in the same form sends trigger 6 instead (see **Booked by staff** there).

| Field | Value |
|-------|-------|
| **Trigger** | `/admin` → **Create Reservation** → `POST /api/admin/inventory/:id/reservations` (the booking is saved as `reserved` first) |
| **Function** | `sendStaffReservationEmail(item, reservation, { account, message, today })` → `buildStaffReservationEmailPayload()` (`buildConsultationEmail` layout; place, directions and pickup lines from `confirmedReservationEmailParts()`, shared with trigger 1) |
| **From** | `EMAIL_FROM` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | The address staff typed, trimmed and lower-cased |
| **Subject** | `Reservation confirmed: {item title}` |
| **Timing** | Awaited before the 201 (`emailSent`) |
| **Auth** | Admin only |

`account` comes from the Supabase Auth list (`findAuthUserByEmail`): `member` when a confirmed account uses the address, `new` when none does (or it was never confirmed), `unknown` when the lookup failed. A suspended account is refused before anything is saved (409 `reservation_account_suspended`).

**Content summary:**

| Part | Text |
|------|------|
| Heading | Reservation confirmed |
| Intro (also the preheader) | The Activist Resource Library team has booked {item} for you. Then, by `account`: `member` "To see or cancel it, log in with this email address: {email}"; `new` "To see or cancel it online, create a free account with this email address: {email}"; `unknown` "To see or cancel it online, log in or create a free account with this email address: {email}". When the booking starts today or earlier, "To see it" replaces "To see or cancel it" |
| Details | **Item** / **Room** (linked), **Dates**, **Where**, **Getting there**, **Message from the library team** (only when staff wrote one), as in trigger 1 |
| Account line | `new`: Once you have confirmed your email address, the reservation will be on your account page. `unknown`: If you create an account, confirm your email address and the reservation will be on your account page. `member`: none |
| Cancel line | Only when it starts after today (Montréal): You can cancel it there until the day before it starts. (the `/account` rule) |
| Pickup / room | Trigger 1's lines: the Tuesday pickup notice and "We look forward to seeing you at pickup." for equipment and books; "If anything changes, just reply to this email." for rooms (plus the reply-for-the-address line when the room has no address) |
| Button | `member` **See your reservation**, `new` **Create your account**, `unknown` **Go to your account**, all → `/account` (signed out, it offers **Log in** and **Register**) |
| Links | **Get directions** (when there is an address) · **View the item** / **View the room** |
| Footer | Office line, then `EMAIL_WHY.staffReservation`: "You are receiving this because the Activist Resource Library team made a reservation for this email address." |

**Failure behavior:** Resend error or timeout: logged (`Staff reservation email failed: …`), `emailSent: false`; the booking stays and the admin status line says the email didn't go out.

---

### 11. Mentor's address changed by staff (handover — expertise only)

No new template: the new address gets again the expert emails of triggers 5 and 6 that went to the old address (or to nobody, when the mentor had none).

| Field | Value |
|-------|-------|
| **Trigger** | `/admin` → **Mentors** → **Edit** → `PATCH /api/inventory/:id` saves a different expert email (compared trimmed and case-insensitive; clearing it sends nothing) while the mentor has open consultations |
| **Function** | `sendMentorEmailHandover(item, previousExpertEmail)`: for each `pending` request `buildExpertRequestEmailPayload()` (trigger 5's expert email), for each `reserved` meeting not yet held `buildConsultationScheduledEmailPayloads(…, { onlyExpert: true })` (trigger 6's expert email, Zoom link and `.ics` `METHOD:REQUEST` whose attendees are the member and the new address). One consultation per round (`settleNotificationRounds`), paced for Resend's rate limit |
| **From** | `EMAIL_FROM` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | The new expert email only. Members are not emailed (their meeting doesn't change) |
| **Subject** | As in triggers 5 and 6: `New consultation request: {title}`, `Consultation scheduled: {title}` or `Follow-up consultation scheduled: {title}` |
| **Timing** | Awaited before the 200; the response's `handover` is `{ count, emailSent }`, or null when nothing was sent |
| **Auth** | Admin only |

Not sent for held, cancelled or refused consultations. An account's own email change (Supabase, migration 014) moves the records without any email: it's the same person, who already had them.

**Failure behavior:** each failed send is logged (`Mentor email handover email failed: …`) and `handover.emailSent` is `false`; the edit stays saved, and Kimchi says only "Mentor details saved".

---

### 12. Day-before reminder (member; consultations: member + expert)

| Field | Value |
|-------|-------|
| **Trigger** | The reminder pass (`sendDueReservationReminders()` in `server.js`), started by the middleware on an incoming request at most every 10 minutes, for each `reserved` booking whose start is more than 1 hour and at most 24 hours away (`isReminderDue(reservationStartsAt(…))`: a consultation's `meetingAt`; a room's first day at its start time; a pickup, or a room without hours, its first day at 10:00 Montréal) and whose `reservations.reminder_email` is still null (migration 015). Deployed service only (`RESERVATION_REMINDERS_HERE`: `RESEND_API_KEY` set and `NODE_ENV=production` or `K_SERVICE`); never from local dev |
| **Function** | `buildReservationReminderEmailPayloads(item, reservation)`; each payload is sent on its own (`sendEmailPayloads([payload], 'Reservation reminder')`), 0.5 s apart (`EMAIL_PACING_MS_PER_EMAIL`) |
| **From** | `EMAIL_FROM` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | Rooms, equipment and books: the member (`userEmail`). Consultations: the member and the expert (`item.expertEmail`), separate emails. Each only with an address |
| **Subject** | `Your reservation is coming up: {title}`; consultations `Your consultation is coming up: {title}` (both people) |
| **Timing** | Not tied to anyone's action: the first request after the booking enters the window (the request waits for the pass for 3 s at most). If the site gets no request until less than an hour before the start, there is no reminder |
| **Auth** | None (server pass) |

**Content summary:**

| Part | Rooms, equipment and books | Consultations |
|------|----------------------------|---------------|
| Heading | Your reservation is coming up! | Your consultation is coming up! |
| Intro | Rooms: "Just a reminder: {title} is booked for you on {date}, {times}." ("from {dates}" over several days; one closing period even after "p.m."). Equipment and books: "Just a reminder: your pickup for {title} is on {start date}." | Member: "Just a reminder: your consultation (or follow-up consultation) with {title} is on {time}." Expert: "… with {member email, or 'a member'} is on {time}." |
| Details | **Room** / **Item** (linked), **Dates**, **Times**, **Where**, **Getting there** (as trigger 1) | **Consultation** (linked for the member), **When**, **Member** (expert only), **Passcode** |
| Body | Trigger 1's pickup or room lines without "If anything changes, just reply to this email.", then "Need to change something? From your account panel you can message the host, suggest a new time or cancel before the first day." | The Zoom notice (or "We will send you a meeting link…"), then member: "Need to change something? From your account panel you can message {title}, suggest a new time or cancel."; expert: "… message the member, choose a new time or cancel." |
| Button | **See your reservation** → `/account`, then **Get directions** and **Browse the library** | **Join Zoom** plus a **Your account panel** link, or just **Your account panel** when there is no Zoom link. No `.ics`: the invite went out when it was scheduled |
| Footer | `EMAIL_WHY.reservation`, or `staffReservation` for a staff booking | Member: `EMAIL_WHY.consultationMember` (`staffConsultation` for a staff booking) and the funder strip; expert: `consultationExpert` |

**Once only:** the pass claims each booking first (`reminder_email` null → `sending`), so two passes can't both send it. Any email accepted → `sent`; none accepted → back to null for the next pass; nobody to email, or already started → `skipped`. A claim older than 30 minutes (a pass that stopped) is handed back. A booking confirmed or moved less than a day before its start gets `skipped` at once, because that email (triggers 1, 6, 10, 15, 16) was its reminder, unless that email didn't all go out, in which case the reminder is due again. A move to a new time more than a day away makes it due again, even after a reminder for the old time.

**Failure behavior:** each failed send is logged (`Reservation reminder email failed: …`); a build or database error is logged (`[reminder] Could not send the reminder for reservation <id>, will retry: …`) and the claim released. Each reminder that went out logs `[reminder] Sent reminder for reservation <id>.`

---

### 13. Message to the host / new time suggested (member → host)

| Field | Value |
|-------|-------|
| **Trigger** | `/account` agenda → the entry's **More** → **Message the host** / **Suggest a new time** (rooms, equipment, books: `AgendaBookingCard`) or **Message the mentor** / **Suggest a new time** (consultations: `AgendaConsultationCard`) → **Send** → `POST /api/reservations/:reservationId/message { message, kind: 'message' \| 'new_time', as: 'member' }`. Only on the member's own `pending` or `reserved` booking; `new_time` only while it is pending or hasn't started |
| **Function** | `buildReservationMessageEmailPayload({ item, reservation, kind, from: 'member', senderEmail, to, message })` → `sendEmailPayloads([payload], 'Reservation message')` |
| **From** | `EMAIL_FROM` |
| **Reply-To** | The member's address (from the JWT) |
| **To** | The item's host: `itemOwnerEmail(item)` (a mentor's `expert_email`, else `owner_email`), or the library inbox (`CONTACT_TO`) when there is none (before migration 015) |
| **Subject** | `New message about {title}` · `New time suggested for {title}` |
| **Timing** | Awaited; the route answers 200 `{ emailSent: true }` only when Resend accepted it |
| **Auth** | The booking's member (`requireAuth`, email match); IP limit 60 / 15 min and 10 sent messages per account per hour (429 `message_rate_limited`) |

**Content summary:**

| Part | Text |
|------|------|
| Heading | New message from a member · A new time was suggested |
| Intro | "{member} sent you a message about their {consultation \| room reservation \| reservation}{when}." · "{member} would like a new time for their …{when}." `{when}`: a scheduled consultation " on {meeting time} (Montreal time)"; a pending one ", requested on {date}"; other bookings " for {dates}, {times}" (one closing period, even after "p.m.") |
| Details | **Consultation** / **Room** / **Item** (linked), **When** or **Requested on** (consultations) / **Dates** + **Times**, **Status** (Waiting for review, Scheduled or Confirmed), **From** (mailto link), **Message** or **Their suggestion** |
| Body | "Reply to this email to answer them directly." A suggestion adds "To move it, choose the new time from your account panel; they will get an email with it." (a pending consultation: "To schedule it, pick the time from your account panel; you will both get the invitation by email.") |
| Button | **Your account panel** → `/account` |
| Footer | `EMAIL_WHY.consultationExpert` when it goes to the mentor's own address, else `EMAIL_WHY.itemOwner`: "You are receiving this email because you are listed as the host of this item in the Activist Resource Library." |

Nothing is stored and the booking doesn't change: a suggested time only moves when the host acts (triggers 15 and 16). The message's text is escaped in the HTML, and the server log (`[reservation-message] { reservationId, kind, as }`) has no address or text.

**Failure behavior:** the email is the whole action, so a failed send is a 502 `message_send_failed` (logged `Reservation message email failed: …`) and doesn't count toward the hourly limit.

---

### 14. Message to the member (host → member)

| Field | Value |
|-------|-------|
| **Trigger** | `/account` agenda → the entry's **More** → **Message the member**, from the mentor or owner (`AgendaConsultationCard`), or from the owner of a room, equipment or book (`AgendaBookingCard`: a request under **Needs you**, or a booking marked **Your item**) → **Send** → `POST /api/reservations/:reservationId/message { message, kind: 'message', as: 'owner' }`. A `pending` or `reserved` booking (held meetings and ended loans too) |
| **Function** | `buildReservationMessageEmailPayload({ …, from: 'owner', senderIsExpert, senderIsStaff })` → `sendEmailPayloads([payload], 'Reservation message')` |
| **From** | `EMAIL_FROM` |
| **Reply-To** | The sender's address |
| **To** | The booking's `userEmail` (none, a deleted account: 400 `message_no_recipient`, nothing sent) |
| **Subject** | `Message about your {consultation \| room reservation \| reservation}: {title}` |
| **Timing** | Awaited; 200 `{ emailSent: true }` only when Resend accepted it |
| **Auth** | A confirmed account that hosts the item (`isItemOwner`); same limits as trigger 13 |

**Content summary:**

| Part | Text |
|------|------|
| Heading | Consultations from the mentor: "A message from {title}"; otherwise "A message about your {noun}" |
| Intro | "{sender} sent you a message about your {noun}{when}." (`{when}` as in trigger 13) `{sender}`: consultations, the mentor's name (the expert, or an owner who isn't staff) or "The Activist Resource Library team" (staff); other bookings, "The Activist Resource Library team" (staff) or "The host of {title}" |
| Details | The item, its time or dates (as in trigger 13), **Message** |
| Body | Reply to this email to answer them directly. |
| Button | **Your account panel** → `/account` |
| Footer | `EMAIL_WHY.consultationMember` / `reservation` (`staffConsultation` / `staffReservation` for a staff booking) |

**Failure behavior:** as trigger 13.

---

### 15. Consultation moved (member + expert — expertise only)

| Field | Value |
|-------|-------|
| **Trigger** | `/account` agenda → a scheduled meeting's **More** → **Choose a new time** → **Move meeting**, then Yes to the inline question → `POST /api/consultations/:reservationId/reschedule { meetingAt, message? }` (expert, the owner of a mentor with no `expert_email`, or admin), on a `reserved` meeting that hasn't started, after the Zoom meeting moved (or was replaced) and `meeting_at` was saved |
| **Function** | `sendConsultationRescheduledEmails()` → `buildConsultationRescheduledEmailPayloads(item, reservation, previousMeetingAt, { message, messageFrom })` |
| **From** | `EMAIL_FROM` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | Member and expert (separate emails; each only with an address) |
| **Subject** | `Consultation moved: {title}` · follow-ups `Follow-up consultation moved: {title}` (both people) |
| **Attachment** | `consultation.ics` (`METHOD:REQUEST`, the same UID with a later `SEQUENCE`, the new start), so calendars move the event instead of adding one |
| **Timing** | Awaited before the 200 (`emailSent`). A Zoom failure answers 502 `consultation_zoom_failed` before anything is saved or sent |
| **Auth** | Expert, owner or admin (`requireAuth`; 403 for the member) |

**Content summary:**

| Part | Member | Expert |
|------|--------|--------|
| Intro | "{title} moved your consultation to {new time}." (staff: "The Activist Resource Library team moved …") | "You moved your consultation with {member} to {new time}." (staff: "The Activist Resource Library team moved your consultation with {member} …") |
| Details | **Consultation** (linked), **New time**, **Was**, **Message from {title}** / **Message from the library team**, **Passcode** | **Consultation**, **New time**, **Was**, **Member**, **Your message to the member** / **Message from the library team to the member**, **Passcode** |
| Body | The Zoom notice, then "If the new time does not work for you, you can message them, suggest another time or cancel from your account panel." | The Zoom notice |
| Button | **Join Zoom** plus a **Your account panel** link, or just **Your account panel** when there is no Zoom link | Same |
| Footer | `EMAIL_WHY.consultationMember` (`staffConsultation` for a staff booking) and the funder strip | `consultationExpert` |

The Zoom link and passcode stay the same when Zoom moved the meeting in place; a new meeting (Zoom no longer had it, or there was none) gives new ones. The voice follows `consultationHostVoice()` (trigger 6).

**Failure behavior:** logged (`Consultation moved email failed: …`, or `Consultation moved notifications failed: …`); the move stays saved with `emailSent: false`, and the day-before reminder is due again.

---

### 16. New dates for a room, equipment or book booking (member)

| Field | Value |
|-------|-------|
| **Trigger** | `/account` agenda → a booking of the owner's item (a request under **Needs you**, or a booking marked **Your item**) → **More** → **Choose new dates** → **Save new dates**, then Yes to the inline question → `POST /api/account/hosted-reservations/:reservationId/reschedule { startDate, endDate, startTime?, endTime?, message? }`: the item's owner moves a `pending` request, or a `reserved` booking that hasn't ended, after the new dates (and a room's hours) are saved |
| **Function** | `sendReservationRescheduledEmail(item, reservation, previous, { message, today })` → `buildReservationRescheduledEmailPayload()` (`buildConsultationEmail` layout; place lines from `confirmedReservationEmailParts()`) |
| **From** | `EMAIL_FROM` |
| **Reply-To** | `EMAIL_REPLY_TO` |
| **To** | Reservation `userEmail` |
| **Subject** | `New {dates \| times \| dates and times} for your {reservation \| request}: {title}` (what changed; times only for rooms) |
| **Timing** | Awaited before the 200 (`emailSent`) |
| **Auth** | The item's confirmed owner (`owner_email`) |

**Content summary:**

| Part | Text |
|------|------|
| Heading | Your {reservation \| request} has new {dates \| times \| dates and times} |
| Intro | The Activist Resource Library team changed the {dates …} of your {reservation \| reservation request} for {title}. (Owners are staff today, so it speaks for the team.) |
| Details | **Room** / **Item** (linked), **New dates**, **New times** (rooms with hours), **Was** (the old dates and times), **Where** and **Getting there** (confirmed bookings only), **Message from the library team** (the owner's optional note, max 1000) |
| Body | A confirmed booking: trigger 1's pickup or room lines without "If anything changes, just reply to this email." (and, once a loan has started, without "We look forward to seeing you at pickup."; the Tuesday hours stay). Then: a request "If the new {dates} do not work for you, you can withdraw your request from your account panel or reply to this email."; a booking before its first day "… you can cancel from your account panel or reply to this email."; one already under way "… just reply to this email." |
| Button | **See your reservation** → `/account`, then **Get directions** (confirmed) and **Browse the library** |
| Footer | `EMAIL_WHY.reservation`, or `staffReservation` for a staff booking |

**Failure behavior:** no member email: skipped with a warning (`Skipping new dates email…`), `emailSent: false`. Resend error or timeout: logged (`Reservation moved email failed: …`), `emailSent: false`; the new dates stay, and a confirmed booking's reminder is due again.

---

### 17. Owner approves or declines a request on `/account` (member)

No new template: the member gets trigger 1 (approved, with the owner's optional **Message from the library team**) or trigger 2 (refused), exactly as when staff answer in `/admin`.

| Field | Value |
|-------|-------|
| **Trigger** | `/account` agenda → **Needs you** → the **Approve a booking for …** card → **Approve**, then Yes to the inline question (`POST /api/account/hosted-reservations/:reservationId/approve { message? }`), or its **More** → **Decline request**, then **Decline** (`…/refuse`), on a `pending` equipment, book or room request |
| **Function** | `sendMemberDecisionEmail(item, reservation, 'approved' \| 'refused', message)` |
| **To** | Reservation `userEmail` |
| **Subject** | `Reservation confirmed: {item title}` · `Reservation update: {item title}` |
| **Timing** | Awaited before the 200 (`emailSent`); approve sets the reminder state first (trigger 12) |
| **Auth** | The item's confirmed owner (`owner_email`); per-IP and per-account limits (429 `reservation_action_limit`) |

**Failure behavior:** as triggers 1 and 2.

---

### 18. Owner cancels a booking on `/account` (member)

No new template: trigger 8's team-cancel email, with the owner's optional message.

| Field | Value |
|-------|-------|
| **Trigger** | `/account` agenda → a confirmed booking marked **Your item** → **More** → **Cancel reservation**, then Yes to the inline question → `POST /api/account/hosted-reservations/:reservationId/cancel { message? }` on a `reserved` equipment, book or room booking whose `endDate` is today or later (a pending request is declined instead, trigger 17). Saved as `cancelled`, `cancelled_by: 'owner'` |
| **Function** | `sendReservationCancelledByTeamEmail(item, { …reservation, status: previousStatus }, today, message)` |
| **To** | Reservation `userEmail` |
| **Subject** | `Reservation cancelled: {item title}` |
| **Timing** | Awaited before the 200 (`emailSent`) |
| **Auth** | The item's confirmed owner |

The intro says the Activist Resource Library team cancelled it, and a loan already under way gets trigger 8's "reply to arrange returning it" line. The `/account` page sends no message yet (no field); the API takes `message` (max 1000) and shows it as **Message from the library team**.

**Failure behavior:** as trigger 8.

---

## `emailSent` in responses

Routes that send email add `emailSent` to their JSON. It is `true` only when there was at least one email and Resend accepted every one. It is `false` when any send failed, timed out, or threw while being built, and when there was nobody to email (for example a reservation with no member email). Failures are logged either way. The client reads it only to avoid claiming an email that didn't go out: `AdminPanel` (approve, refuse, deletes, follow-up), `AgendaConsultationCard` (schedule, cancel, follow-up, move) and `AgendaBookingCard` (the host's approve, decline, new dates, cancel) on the `/account` agenda show Kimchi's plain bubbles (`kimchi.*_plain`, or the bubble without "has been emailed") when it is `false`, and their hidden status lines add an "emailed" note only when it isn't (`AdminPanel`: only when it is `true`). There is no warning UI; see `docs/automated-notifications.md`.

| Route | `emailSent` covers |
|-------|--------------------|
| `POST /api/inventory/:id/reservations` | Expertise only: the member and expert request emails. Equipment/books/rooms responses have no `emailSent` (they only post to Slack) |
| `POST /api/inventory/:id/reservations/:reservationId/approve` | The approval email, or for expertise the two scheduled emails |
| `POST /api/inventory/:id/reservations/:reservationId/refuse` | The refusal email |
| `POST /api/admin/inventory/:id/reservations` | The staff booking email (trigger 10), or for a mentor the two scheduled emails (trigger 6; only the member's when the mentor has no email) |
| `POST /api/consultations/:reservationId/schedule` | The two scheduled emails |
| `POST /api/consultations/:reservationId/follow-up` | The two scheduled emails, worded as a follow-up |
| `POST /api/consultations/:reservationId/reschedule` | The two "moved" emails (trigger 15; only the member's when the mentor has no email) |
| `POST /api/account/hosted-reservations/:reservationId/approve` / `refuse` | The approval or refusal email (trigger 17) |
| `POST /api/account/hosted-reservations/:reservationId/reschedule` | The new-dates email (trigger 16) |
| `POST /api/account/hosted-reservations/:reservationId/cancel` | The team-cancel email (trigger 18) |
| `POST /api/reservations/:reservationId/message` | Always `true` on a 200: a failed send is a 502 `message_send_failed` instead (triggers 13 and 14) |
| `POST /api/consultations/:reservationId/cancel` | The cancellation emails. The response also has `otherPartyEmailed`: `emailSent` and the other side has an address on file (the trimmed `item.expertEmail` when the member cancels, the trimmed `reservation.userEmail` when anyone else does: the expert, an owner or an admin). A mentor with no address is skipped while the member's email still goes out, so `emailSent` alone can be `true` when the mentor wasn't told. Only the boolean is returned, never an address |
| `DELETE /api/inventory/:id/reservations/:reservationId` | Only when it cancelled an active consultation (not for a held one) or an upcoming equipment, book or room reservation (trigger 8) |
| `DELETE /api/inventory/:id` | Only when the item had active, not-yet-held consultations (expertise) or upcoming member reservations (other tags); `false` if any of their emails failed or a reservation had no member email |
| `DELETE /api/admin/users/:id` | Only when the member delete cancelled something it emails about (triggers 7 and 8); left out when nothing needed an email. The response's `cancelled` counts those bookings only, not the past-dated pending requests cancelled silently |
| `POST /api/admin/users/:id/password-reset` | Always `true` on a 200: a failed send is a 502 `password_reset_failed` instead |
| `PATCH /api/inventory/:id` | Not `emailSent` but `handover.emailSent`: the handover emails to a mentor's new address (trigger 11). `handover` is null when the address didn't change or nothing was open |

---

## What does **not** send email

| Action | Notes |
|--------|-------|
| `POST /api/inventory/:id/reservations` (new pending request, equipment/books/rooms) | Slack webhook only — see [automated-webhooks.md](automated-webhooks.md). Expertise items send trigger 5 |
| `DELETE /api/inventory/:id/reservations/:reservationId` | No email for a past equipment/book/room booking or a held consultation (upcoming ones send trigger 8; active consultations send trigger 7) |
| `PATCH /api/inventory/:id/reservations/:reservationId` | No email. A confirmed booking's reminder is reset (`setReminderState(…, { notified: false })`), so the day-before reminder (trigger 12) is the member's notice of new dates, even less than a day ahead |
| `POST /api/inventory` (add item) | No email |
| `DELETE /api/inventory/:id` (remove item) | No email for past or inactive rows (trigger 7 for active, not-yet-held consultations; trigger 8 for upcoming equipment/book/room reservations) |
| `POST /api/account/reservations/:reservationId/cancel` (member withdraws a request or cancels a booking) | No email to anyone. Cancelling an approved booking posts a Slack staff alert (`reservation_cancelled_by_member`, [automated-webhooks.md](automated-webhooks.md#staff-alerts)); withdrawing a pending request is silent |
| `POST` / `PATCH /api/account/mentor-profile` | No email; staff get a Slack alert ([automated-webhooks.md](automated-webhooks.md#staff-alerts)) |
| Rejected reservation create (409 `consultation_already_open`, 429 `daily_request_limit` / `pending_request_limit` / `reservation_rate_limited`) | No email |
| `/admin` → **Members**: rename (`PATCH /api/admin/users/:id`), **Suspend** / **Lift suspension** | No email; the member isn't told (a suspended member sees `auth.account_suspended` when signing in) |
| Member account delete: past-dated `pending` equipment, book or room requests, held consultations and past bookings | No email. The pending requests are cancelled silently; every row keeps its item, dates and status without the email (`anonymized_at` set) |
| `POST /api/inventory/:id/view` (item view counter) | No email |
| Rejected message (`POST /api/reservations/:id/message` with 400, 404 or 429) | No email. A suggested time (trigger 13) changes nothing by itself |
| Reminder pass in local dev, or before migration 015 | No email (`RESERVATION_REMINDERS_HERE` is off without `NODE_ENV=production` or `K_SERVICE`; before 015 the pass finds nothing and logs one warning) |
| Member account delete giving the member's own items to samuel@apathyisboring.com (`reassignItemsOwnedBy`) | No email |
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
| **Supabase Auth** | Sign-up confirmation, magic links, and password reset emails are configured in the Supabase dashboard (**Authentication → Email Templates**, sent through Supabase's mailer or the custom SMTP set under **Authentication → SMTP Settings**) — not in this codebase, and not through Resend; recipients are always the account's own email. Since 2026-10-05 the app **requests** the **Reset Password** email itself: **Forgot password?** in the login dialog calls `supabase.auth.resetPasswordForEmail(email, { redirectTo })` (`requestPasswordReset` in `src/lib/auth.js`), where `redirectTo` is the current page (item pages become their category, `?reserve` dropped) plus `?password_reset=1`. Supabase answers the same whether or not the address has an account, and the form always shows the same neutral confirmation. The template is English-only (one template per project) and must keep `{{ .ConfirmationURL }}` so the link returns to that page with the recovery session. Supabase's built-in sender is meant for testing: a few emails per hour across the whole project, delivered only to addresses on the Supabase organization's team; production needs custom SMTP (for example Resend's SMTP) for reset emails to arrive reliably. The staff-sent reset from `/admin` → **Members** (trigger 9) is ours, through Resend: only the link comes from Supabase |
| **Member welcome email** | Sent via Resend on sign-up / first sign-in (`POST /api/auth/welcome-email`); separate from Supabase confirmation email |
| **No member “request received” email (equipment/books/rooms)** | Members see Kimchi and the calendar status, then the request on the `/account` agenda (under **Coming up**, where **More** → **Withdraw request** withdraws it); admins get the Slack webhook. Expertise consultations do send a confirmation email |
| **Room access details** | Not sent by any email. The room approval email confirms the dates, the room's address and how to get there; anything else (entrance, on-site contact) goes through a reply |
| **Zoom does not email invitations** | Zoom's API creates the meeting only; the invitation is our Resend email + `.ics` attachment (trigger 6) |
| **Consultation data-sharing link is a placeholder** | `CONSULTATION_DATA_FORM_URL` in `server.js` is `https://REPLACE-ME.example/participant-info` until the real YES Employment form URL is provided |
| **No i18n on emails** | All server email copy is English-only hardcoded strings in `server.js` |
| **Reminders need traffic** | The reminder pass (trigger 12) runs on incoming requests, as the GA pass does. If nobody reaches the site between 24 h and 1 h before a start, that booking gets no reminder |
| **Owners speak as the library team** | Owners' emails about rooms, equipment and books (triggers 16–18) say "The Activist Resource Library team", because only admins create those items today. A non-staff owner of a mentor with no expert email (possible only when staff clear a member's own profile's address) gets no new-request, reminder or "moved" email: the mentor's emails go to `expert_email` only |

---

## Source files

| File | Role |
|------|------|
| `server.js` | Resend client, `EMAIL_REPLY_TO`, member decision + staff booking + team-cancellation + consultation + password reset payload builders (`buildConsultationEmail`, `buildConsultationIcs`, `buildStaffReservationEmailPayload`, `confirmedReservationEmailParts`, `buildReservationCancelledByTeamEmailPayload`, `buildPasswordResetEmailPayload`), the `/account` builders (`buildReservationReminderEmailPayloads`, `buildReservationMessageEmailPayload`, `buildConsultationRescheduledEmailPayloads`, `buildReservationRescheduledEmailPayload`, `emailSubject`, `endSentence`), the reminder pass (`sendDueReservationReminders`, `restoreReminderIfNotEmailed`), `EMAIL_WHY` (incl. `itemOwner`), the member delete (`deleteMemberAccount`), `formatReservationDates`, send functions (`sendEmailPayloads`, 10 s cap), `settleNotifications` (routes await emails + Slack), route hooks |
| `src/lib/email-brand.js` | Shared branded HTML + plain-text layout (`renderBrandedEmail`, `orgContact`) |
| `src/lib/item-location.js` | Item places for the approval email: `locationAreaLine`, `memberLocation(...).directionsUrl` (`itemPlaceLines` in `server.js` builds the Where row) |
| `src/lib/zoom.js` | Zoom meeting create/move/delete used before scheduled/moved/cancelled emails |
| `src/lib/reservation-rules.js` / `src/lib/inventory-store.js` | When a booking starts and when its reminder is due (`reservationStartsAt`, `isReminderDue`, `reminderStateFor`); the reminder state in `reservations.reminder_email` (`listReminderCandidates`, `claimReminder`, `settleReminder`, `releaseStaleReminderClaims`, `setReminderState`); the host (`itemOwnerEmail`) |
| `.env.example` | Env var template |
| `send-email.js` | One-off Resend test script |
| `scripts/cloud-build.sh` | Deploy-time `EMAIL_FROM` (and `EMAIL_REPLY_TO` when set) and Secret Manager binding for `RESEND_API_KEY` |
