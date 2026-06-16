# Automated emails (Resend)

All production emails are sent from `server.js` via the [Resend](https://resend.com) SDK. Emails are **fire-and-forget**: API responses succeed even if email delivery fails (errors are logged).

---

## Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `RESEND_API_KEY` | Yes (at send time) | — | Resend API key. Server starts without it (warning logged); `getResend()` throws when sending if unset |
| `EMAIL_FROM` | No | `noreply@activistresourcelibrary.com` | Sender address on all app emails |
| `EMAIL_TO` | No | `samuel@apathyisboring.com` | Fallback admin recipient |
| `RESERVE_INVENTORY_EMAIL_TO` | No | Falls back to `EMAIL_TO` | Admin recipient for new pending reservation notifications |
| `SITE_URL` | Recommended (prod) | Falls back to `https://activistresourcelibrary.com` | Base origin for all email links and path-based inventory images (`SITE_URL` or `VITE_SITE_URL`, trailing slash stripped) |

**Cloud Run:** `RESEND_API_KEY` is mounted from Secret Manager (`resend-api-key`) when set in `.env` during `npm run cloud:build`. `EMAIL_FROM` is always set on deploy (default `noreply@activistresourcelibrary.com`; legacy `onboarding@resend.dev` in `.env` is migrated automatically). Other `EMAIL_*` vars are passed when set in `.env`.

**Local smoke test:** `npm run send-email` runs `send-email.js` (not part of the web app — see [Dev-only script](#dev-only-script)).

---

## Emails by trigger

### 1. New pending reservation (admin notification)

| Field | Value |
|-------|-------|
| **Trigger** | Successful `POST /api/inventory/:id/reservations` (member creates pending reservation) |
| **Function** | `sendReservationNotificationEmail()` → `buildReservationEmailPayload()` |
| **From** | `EMAIL_FROM` |
| **To** | `RESERVE_INVENTORY_EMAIL_TO` → `EMAIL_TO` → `samuel@apathyisboring.com` |
| **Subject** | `Reservation request (pending reservation): {item title}` |
| **Timing** | Fire-and-forget after DB write; does not block HTTP 201 response |
| **Auth** | Requires member JWT (`requireAuth`); email address taken from JWT, not client body |

**Plain-text body includes:**

- Intro: member submitted a pending request
- Item title, description, image reference, item ID, created timestamp
- Member email (from reservation)
- Date range (`startDate` to `endDate`)

**HTML body includes:**

- Heading: “Reservation Request (Pending Reservation)”
- Bulleted list of the same fields
- Image preview: inline CID attachment for uploaded `data:image/*` items; absolute `<img>` or link for path-based seed images (uses `SITE_URL`, else production origin)
- Links: item page (`/{tag}/{slug}`) and admin panel (`/admin`) use the same origin

**Failure behavior:**

- Missing `RESEND_API_KEY`: error logged (`Reservation notification email failed: …`); reservation still created
- Resend API error: same — logged, reservation unaffected

---

### 2. Reservation approved (member notification)

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
| Closing | We look forward to seeing you at pickup. |
| Signature | — Apathy is Boring / Activist Resource Library |
| Links | Item page (`/{tag}/{slug}`) and library home (`/`) using `SITE_URL` (or production fallback) |

**Failure behavior:**

- No `userEmail` on reservation: skipped with console warning (`Skipping approved email: no member email…`); approve still succeeds
- Missing `RESEND_API_KEY` or Resend error: logged (`Reservation approval email failed: …`); approve still succeeds

---

### 3. Reservation refused (member notification)

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

## What does **not** send email

| Action | Notes |
|--------|-------|
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
| To | Hardcoded `samuel@apathyisboring.com` |
| Subject | `Hello World` |
| Body | HTML congratulatory message |

Exits with error if `RESEND_API_KEY` is missing. **Not invoked by the web app.**

---

## Gaps / external email

| Source | Notes |
|--------|-------|
| **Supabase Auth** | Sign-up confirmation, magic links, and password reset emails are configured in the Supabase dashboard — not in this codebase |
| **No member “request received” email** | Members see in-app Kimchi + card status only; admin gets the Resend notification |
| **No i18n on emails** | All server email copy is English-only hardcoded strings in `server.js` |

---

## Source files

| File | Role |
|------|------|
| `server.js` | Resend client, payload builders, send functions, route hooks |
| `.env.example` | Env var template |
| `send-email.js` | One-off Resend test script |
| `scripts/cloud-build.sh` | Deploy-time `EMAIL_*` and Secret Manager binding for `RESEND_API_KEY` |
