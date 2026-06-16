# Automated emails (Resend)

Production emails are sent from `server.js` via the [Resend](https://resend.com) SDK. Emails are **fire-and-forget**: API responses succeed even if email delivery fails (errors are logged).

**Recipients are always the member who made the reservation** (`userEmail` from the JWT at create time, stored on the reservation row). There is no admin `EMAIL_TO` or env-based fallback recipient.

New pending reservation requests do **not** send email — admins are notified via the [Slack webhook](automated-webhooks.md) only.

---

## Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `RESEND_API_KEY` | Yes (at send time) | — | Resend API key. Server starts without it (warning logged); `getResend()` throws when sending if unset |
| `EMAIL_FROM` | No | `noreply@activistresourcelibrary.com` | Sender address on all app emails |
| `SITE_URL` | Recommended (prod) | Falls back to `https://activistresourcelibrary.com` | Base origin for email links (`SITE_URL` or `VITE_SITE_URL`, trailing slash stripped) |

**Cloud Run:** `RESEND_API_KEY` is mounted from Secret Manager (`resend-api-key`) when set in `.env` during `npm run cloud:build`. `EMAIL_FROM` is always set on deploy (default `noreply@activistresourcelibrary.com`; legacy `onboarding@resend.dev` in `.env` is migrated automatically).

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
| Pickup | Pickups and drop offs are between 10am and 5pm on Tuesdays at 5310 Saint-Laurent, Montreal QC H2T 1S1 |
| Closing | We look forward to seeing you at pickup. |
| Signature | — Apathy is Boring / Activist Resource Library |
| Links | Item page (`/{tag}/{slug}`) and library home (`/`) using `SITE_URL` (or production fallback) |

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
| Signature | — Apathy is Boring / Activist Resource Library |
| Links | Item page and library home (same as approval email) |

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
| **Timing** | Client fire-and-forget after `signUpWithEmail` (when session exists) or on `SIGNED_IN` / initial session when `user_metadata.welcome_email_sent` is unset |
| **Auth** | Member JWT (`requireAuth`); IP rate-limited (10 / 15 min) |

**Content summary:**

| Part | Text |
|------|------|
| Intro | Welcome + thanks for creating a member account |
| CTA | Read **How it works** to get started (browse, reserve, pickup) |
| Pickup | Equipment reservations are typically on Tuesdays at 5310 Boul. Saint-Laurent, Montréal, QC H2T 1S1 |
| Contact | Questions? Contact us on the **About** page |
| Links | `/howthisworks`, `/about`, library home (`/`) using `SITE_URL` (or production fallback) |
| Signature | — Apathy is Boring / Activist Resource Library |

**Dedup / eligibility:**

- Skips when `user_metadata.welcome_email_sent` is already `true` (set via Supabase admin after send)
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
| Signature | — Apathy is Boring / Activist Resource Library |

**Failure behavior:**

- Missing `RESEND_API_KEY` or Resend error: logged (`Contact form email failed: …`); client receives 500
- Honeypot filled: returns `{ success: true }` without sending (anti-spam)

---

## What does **not** send email

| Action | Notes |
|--------|-------|
| `POST /api/inventory/:id/reservations` (new pending request) | Slack webhook only — see [automated-webhooks.md](automated-webhooks.md) |
| `DELETE /api/inventory/:id/reservations/:reservationId` | No email to member |
| `PATCH /api/inventory/:id/reservations/:reservationId` | No email |
| `POST /api/inventory` (add item) | No email |
| `DELETE /api/inventory/:id` (remove item) | No email |
| Reservation create failure / collision | No email |

---

## Dev-only script

`send-email.js` (`npm run send-email`) is a standalone Resend smoke test:

| Field | Value |
|-------|-------|
| From | Hardcoded `noreply@activistresourcelibrary.com` |
| To | Hardcoded test address in script (not used by the web app) |
| Subject | `Hello World` |
| Body | HTML congratulatory message |

Exits with error if `RESEND_API_KEY` is missing. **Not invoked by the web app.**

---

## Gaps / external email

| Source | Notes |
|--------|-------|
| **Supabase Auth** | Sign-up confirmation, magic links, and password reset emails are configured in the Supabase dashboard — not in this codebase; recipients are always the registering user's email |
| **Member welcome email** | Sent via Resend on sign-up / first sign-in (`POST /api/auth/welcome-email`); separate from Supabase confirmation email |
| **No member “request received” email** | Members see in-app Kimchi + card status only; admins get the Slack webhook |
| **No i18n on emails** | All server email copy is English-only hardcoded strings in `server.js` |

---

## Source files

| File | Role |
|------|------|
| `server.js` | Resend client, member decision payload builders, send functions, route hooks |
| `.env.example` | Env var template |
| `send-email.js` | One-off Resend test script |
| `scripts/cloud-build.sh` | Deploy-time `EMAIL_FROM` and Secret Manager binding for `RESEND_API_KEY` |
