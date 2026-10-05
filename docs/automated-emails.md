# Automated emails (Resend)

Production emails are sent from `server.js` via the [Resend](https://resend.com) SDK. Emails are **fire-and-forget**: API responses succeed even if email delivery fails (errors are logged).

**Recipients are the member who made the reservation** (`userEmail` from the JWT at create time, stored on the reservation row) — plus, for expertise consultations, **the item's expert** (`inventory_items.expert_email`). There is no admin `EMAIL_TO` or env-based fallback recipient.

New pending reservation requests on equipment, books, and rooms do **not** send email — admins are notified via the [Slack webhook](automated-webhooks.md) only. **Expertise consultations are the exception:** see triggers 5–7 (request received / new request, scheduled, cancelled).

---

## Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `RESEND_API_KEY` | Yes (at send time) | — | Resend API key. Server starts without it (warning logged); `getResend()` throws when sending if unset |
| `EMAIL_FROM` | No | `noreply@activistresourcelibrary.com` | Sender address on all app emails |
| `SITE_URL` | Recommended (prod) | Falls back to `https://activistresourcelibrary.com` | Base origin for email links and the header logo (`SITE_URL` or `VITE_SITE_URL`, trailing slash stripped) |
| `ORG_ADDRESS` | No | `5310 Boulevard Saint-Laurent, Montréal QC H2T 1S1` | Footer street address (`orgContact` in `src/lib/email-brand.js`). `cloud:build` does not pass it — the comma breaks gcloud's env list |
| `ORG_PHONE` | No | `514.844.2472` | Footer phone. Passed by `cloud:build` when set in `.env` |
| `EMAIL_FUNDER_LOGO_URL` | No | unset | Absolute URL of a funder logo strip. When set, the member "consultation confirmed" email shows it above the footer |

**Cloud Run:** `RESEND_API_KEY` is mounted from Secret Manager (`resend-api-key`) when set in `.env` during `npm run cloud:build`. `EMAIL_FROM` is always set on deploy (default `noreply@activistresourcelibrary.com`; legacy `onboarding@resend.dev` in `.env` is migrated automatically). `ORG_PHONE` and `EMAIL_FUNDER_LOGO_URL` are set on the service when present in `.env`.

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
| **To** | Reservation `userEmail` (from DB, originally from member JWT at create time) |
| **Subject** | `Reservation confirmed: {item title}` |
| **Timing** | Fire-and-forget after approve; does not block HTTP 200 |
| **Auth** | Admin only (`requireAuth` + `requireAdmin`) |

**Content summary:**

| Part | Text |
|------|------|
| Intro | Your reservation request has been approved by Apathy is Boring. |
| Body | Item title + date range |
| Pickup | Pickups and drop offs are between 10am and 5pm on Tuesdays at the office address in `orgContact` |
| Closing | We look forward to seeing you at pickup. |
| Button | **View your item** (Lemon) plus a **Browse the library** link |
| Footer | Apathy is Boring office line, then why this email was sent |

**Expertise items:** approve schedules the consultation instead and sends the **Consultation scheduled** emails (trigger 6) to both member and expert. `buildMemberDecisionEmailPayload()` returns `null` for approved expertise items.

**Failure behavior:**

- No `userEmail` on reservation: skipped with console warning (`Skipping approved email: no member email…`); approve still succeeds
- Missing `RESEND_API_KEY` or Resend error: logged (`Reservation approval email failed: …`); approve still succeeds

---

### 2. Reservation refused (member notification)

| Field | Value |
|-------|-------|
| **Trigger** | Successful `POST /api/inventory/:id/reservations/:reservationId/refuse` |
| **Function** | `sendMemberDecisionEmail(item, reservation, 'refused')` |
| **From** | `EMAIL_FROM` |
| **To** | Reservation `userEmail` |
| **Subject** | `Reservation update: {item title}` |
| **Timing** | Fire-and-forget after refuse |
| **Auth** | Admin only |

**Content summary:**

| Part | Text |
|------|------|
| Intro | Unfortunately, the item you requested is not available for those dates. |
| Body | Item title + date range |
| Closing | Please choose different dates or another item from the library. |
| Button | **Choose different dates** (item page) plus a **Browse the library** link |
| Footer | Same office line as the approval email |

**Expertise variant:** subject `Consultation update: {title}`; intro "Unfortunately, we cannot accommodate your consultation request right now." with a closing inviting another request.

**Failure behavior:** Same skip/log pattern as approval (`refused` in log messages).

---

### 3. Member welcome (sign-up)

| Field | Value |
|-------|-------|
| **Trigger** | Successful `POST /api/auth/welcome-email` after sign-up or first sign-in within 7 days of account creation |
| **Function** | `sendWelcomeEmailIfNeeded(user)` → `buildWelcomeEmailPayload()` |
| **From** | `EMAIL_FROM` |
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
| **To** | Member (`userEmail`) and expert (`item.expertEmail`) — separate emails |
| **Subject** | Member: `Consultation request received: {title}` · Expert: `New consultation request: {title}` |
| **Timing** | Fire-and-forget after the pending reservation is saved; does not block HTTP 201 |
| **Auth** | Member JWT (`requireAuth`) |

**Content summary:**

| Recipient | Content |
|-----------|---------|
| Member | Thanks; the expert will pick a time and both get a Zoom invitation. Echoes their time slots + summary; links to `/account` (follow/cancel) and library home |
| Expert | Member email, time slots, summary; instructions to log in (or register) **with the expert email** and schedule from `/account`; link to `/account` |

**Failure behavior:** Missing member or expert email skips that email (missing expert email logs a warning — only admins can schedule such requests); Resend errors logged (`Consultation request email failed: …`); request still succeeds. Equipment/books/rooms requests never trigger these emails.

---

### 6. Consultation scheduled (member + expert — expertise only)

| Field | Value |
|-------|-------|
| **Trigger** | Successful `POST /api/consultations/:reservationId/schedule` (expert or admin) **or** admin `POST /api/inventory/:id/reservations/:reservationId/approve` on an expertise item |
| **Function** | `runScheduleConsultation()` → `buildConsultationScheduledEmailPayloads(item, reservation)` |
| **To** | Member and expert (separate emails) |
| **Subject** | Member: `Consultation confirmed: {title}` · Expert: `Consultation scheduled: {title}` |
| **Attachment** | `consultation.ics` (`METHOD:REQUEST`, UID `{reservationId}@activistresourcelibrary.com`, 60 min, Zoom link as location; both people as attendees) |
| **Timing** | Fire-and-forget after the Zoom meeting is created and the reservation is saved |

**Content summary:** meeting time (America/Toronto, labelled "Montreal time"), **Join Zoom** button + passcode (or "we will send you a meeting link" and an account-panel button when Zoom is not configured), note that anyone can join before the host and share their screen, how to cancel from `/account`. Member email also includes "This project is funded by YES Employment.", a **Share your information** link (**placeholder `https://REPLACE-ME.example/participant-info` — update `CONSULTATION_DATA_FORM_URL` in `server.js`**), and the funder logo strip when `EMAIL_FUNDER_LOGO_URL` is set. Expert email includes the member email and request summary.

---

### 7. Consultation cancelled (member + expert — expertise only)

| Field | Value |
|-------|-------|
| **Trigger** | `POST /api/consultations/:reservationId/cancel` (member, expert, or admin); admin `DELETE` of an active expertise reservation; admin `DELETE` of an expertise item with active reservations |
| **Function** | `handleConsultationCancelled()` → `buildConsultationCancelledEmailPayloads(item, reservation, previousStatus)` |
| **To** | Member and expert (separate emails) |
| **Subject** | `Consultation cancelled: {title}` |
| **Attachment** | `consultation-cancelled.ics` (`METHOD:CANCEL`, same UID) — only when it had been scheduled |

**Content summary:** "You cancelled …" for the person who cancelled; "The member / The expert / The Activist Resource Library team cancelled …" for the other. Names the scheduled time when there was one and confirms the Zoom meeting was removed.

---

## What does **not** send email

| Action | Notes |
|--------|-------|
| `POST /api/inventory/:id/reservations` (new pending request, equipment/books/rooms) | Slack webhook only — see [automated-webhooks.md](automated-webhooks.md). Expertise items send trigger 5 |
| `DELETE /api/inventory/:id/reservations/:reservationId` | No email for equipment/books/rooms (active expertise consultations send trigger 7) |
| `PATCH /api/inventory/:id/reservations/:reservationId` | No email |
| `POST /api/inventory` (add item) | No email |
| `DELETE /api/inventory/:id` (remove item) | No email (except trigger 7 for active consultations on an expertise item) |
| Reservation create failure / collision | No email |

---

## Dev-only script

`send-email.js` (`npm run send-email`) is a standalone Resend smoke test:

| Field | Value |
|-------|-------|
| From | Hardcoded `noreply@activistresourcelibrary.com` |
| To | Hardcoded test address in script (not used by the web app) |
| Subject | `Activist Resource Library email check` |
| Body | Branded smoke-test message from `renderBrandedEmail()` (HTML + plain text) |

Exits with error if `RESEND_API_KEY` is missing. **Not invoked by the web app.**

---

## Gaps / external email

| Source | Notes |
|--------|-------|
| **Supabase Auth** | Sign-up confirmation, magic links, and password reset emails are configured in the Supabase dashboard — not in this codebase; recipients are always the registering user's email |
| **Member welcome email** | Sent via Resend on sign-up / first sign-in (`POST /api/auth/welcome-email`); separate from Supabase confirmation email |
| **No member “request received” email (equipment/books/rooms)** | Members see in-app Kimchi + card status only; admins get the Slack webhook. Expertise consultations do send a confirmation email |
| **Zoom does not email invitations** | Zoom's API creates the meeting only; the invitation is our Resend email + `.ics` attachment (trigger 6) |
| **Consultation data-sharing link is a placeholder** | `CONSULTATION_DATA_FORM_URL` in `server.js` is `https://REPLACE-ME.example/participant-info` until the real YES Employment form URL is provided |
| **No i18n on emails** | All server email copy is English-only hardcoded strings in `server.js` |

---

## Source files

| File | Role |
|------|------|
| `server.js` | Resend client, member decision + consultation payload builders (`buildConsultationEmail`, `buildConsultationIcs`), send functions, route hooks |
| `src/lib/email-brand.js` | Shared branded HTML + plain-text layout (`renderBrandedEmail`, `orgContact`) |
| `src/assets/brand/apathy-is-boring-logo-light.png` | English light wordmark, flattened onto Mint, attached inline on every email |
| `src/lib/zoom.js` | Zoom meeting create/delete used before scheduled/cancelled emails |
| `.env.example` | Env var template |
| `send-email.js` | One-off Resend test script |
| `scripts/cloud-build.sh` | Deploy-time `EMAIL_FROM` and Secret Manager binding for `RESEND_API_KEY` |
