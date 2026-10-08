# Automated webhooks

The ARL Online server posts to **one optional outbound webhook**: a Slack workflow trigger. It fires on new pending reservations and, as **staff alerts** with the same payload keys, when a member publishes or edits a mentor profile or cancels an approved equipment, book or room reservation from `/account`. There are no other webhook integrations in the application codebase.

---

## Slack reservation webhook

| Field | Value |
|-------|-------|
| **Env var** | `SLACK_RESERVATION_WEBHOOK_URL` |
| **Required** | No — omitted or empty string disables the webhook entirely |
| **Function** | `notifySlackReservation()` and `notifySlackAlert()` in `server.js`, both posting through `postSlackWorkflow()` |
| **Trigger** | Successful `POST /api/inventory/:id/reservations`; successful `POST /api/account/mentor-profile`; `PATCH /api/account/mentor-profile` that changed a field; `POST /api/account/reservations/:reservationId/cancel` on an approved booking; a new member's first `POST /api/auth/welcome-email` (see [Staff alerts](#staff-alerts)) |
| **HTTP method** | `POST` |
| **Content-Type** | `application/json` |
| **Timeout** | **5 seconds** (`AbortSignal.timeout(5000)`) |
| **Blocks API response?** | **Awaited, but never fails it** — the route waits for the post (at most 5 s) before returning 201, so it finishes while Cloud Run still gives the request CPU. The reservation returns 201 even if Slack fails or times out |

### When it runs

1. Member submits valid reservation dates, or time slots + summary for an expertise consultation (authenticated JWT).
2. Reservation is persisted with `status: pending`.
3. `notifySlackReservation({ item, reservation })` runs alongside the consultation emails (expertise only). The route waits for both through `settleNotifications()` before it responds. `notifySlackReservation` logs its own failures and never throws.
4. If URL is unset, function returns immediately (no network call).
5. Rejected creates post nothing: 400, 404, 409 (including `consultation_already_open`) and 429 (the IP limiter `reservation_rate_limited`, the 10-per-account daily cap `daily_request_limit`, or the 5-pending cap `pending_request_limit`). The daily cap is what stops a request → cancel loop from posting over and over. It counts a create once the reservation is saved (`countSavedReservationCreates()` in `server.js`), so a client that disconnects while the route waits for this post still uses one.

### Payload (JSON body)

All values are plain strings suitable for Slack workflow trigger variables:

| Field | Source | Example / notes |
|-------|--------|-----------------|
| `message` | Built by the server | The whole Slack message, ready to post: plain text with line breaks. New requests: `📚 New {equipment\|book\|room} request: {title}`, `From {email}`, the readable dates; consultations: `📚 New consultation request: {expert}`, `From {email}`, `Topic: …`, `Availability: …`. Staff alerts: the event's emoji and the `request_summary` sentence. Built by `reservationSlackMessage()` / `notifySlackAlert()` |
| `item_id` | `item.id` | Inventory item UUID or seed id |
| `item_title` | `item.title` | Display title |
| `item_body` | `item.body` | Description text. For expertise, this is the short list blurb (the long bio is not sent) |
| `item_tag` | `item.tag` | `equipment`, `books`, `rooms`, or `expertise` |
| `reservation_id` | `reservation.id` | New reservation UUID |
| `start_date` | `reservation.startDate` | `YYYY-MM-DD` (submission date for expertise requests) |
| `end_date` | `reservation.endDate` | `YYYY-MM-DD` (same as start for expertise requests) |
| `status` | `reservation.status` | `pending` on create. Staff alerts: `member_signed_up`, `mentor_profile_published`, `mentor_profile_updated`, `reservation_cancelled_by_member` or `consultation_follow_up` |
| `user_email` | `reservation.userEmail` | Member email from JWT; empty string if missing |
| `time_slots` | `reservation.timeSlots` | Member's free-text availability (expertise only; empty string otherwise) |
| `request_summary` | `reservation.requestSummary` | Member's consultation topic summary (expertise only; empty string otherwise). Staff alerts: one sentence describing the event |
| `expert_email` | `item.expertEmail` | Expert contact from the item (expertise only; empty string otherwise) |
| `admin_url` | `absoluteSiteUrl('/admin')` | Link to the admin page for reviewing the request |

**Example payload:**

```json
{
  "message": "📚 New equipment request: Megaphone\nFrom member@example.com\nWednesday, June 17, 2026 to Wednesday, June 24, 2026",
  "item_id": "myturn-12345",
  "item_title": "Megaphone",
  "item_body": "Battery-powered megaphone for rallies.",
  "item_tag": "equipment",
  "reservation_id": "550e8400-e29b-41d4-a716-446655440000",
  "start_date": "2026-06-17",
  "end_date": "2026-06-24",
  "status": "pending",
  "user_email": "member@example.com",
  "time_slots": "",
  "request_summary": "",
  "expert_email": "",
  "admin_url": "https://activistresourcelibrary.com/admin"
}
```

### Staff alerts

`notifySlackAlert({ status, item, userEmail, summary, reservation? })` sends an event that is not a new reservation through the **same** workflow trigger, with **exactly the same 14 keys** (unused ones are `''`). `status` names the event and `request_summary` carries a sentence for staff; `message` is that sentence after the event's emoji (👋 new member, 🧑‍🏫 published, ✏️ updated, ↩️ cancelled by member, 🔁 follow-up, `SLACK_ALERT_EMOJI` in `server.js`). Pass `reservation` when an alert is about one reservation or consultation: its id fills `reservation_id` and its dates fill `start_date` / `end_date` (without it, both dates are today's date key).

| `status` | When | Other fields |
|----------|------|--------------|
| `mentor_profile_published` | After a successful `POST /api/account/mentor-profile` (the profile is public at once) | `item_*` from the new expertise item; `user_email` and `expert_email` = the account email; `start_date` = `end_date` = today's date key; `reservation_id` and `time_slots` empty; `admin_url` |
| `mentor_profile_updated` | After a successful `PATCH /api/account/mentor-profile` that changed the name, short text, long text or photo. A save with no changes sends nothing | Same as above, from the updated item |
| `consultation_follow_up` | After an expert (or admin) books a follow-up with `POST /api/consultations/:reservationId/follow-up`. The follow-up is already scheduled with a Zoom meeting, so this is for information only | `item_*` from the expertise item; `reservation_id`, `start_date`, `end_date` from the new follow-up (dates = the booking day); `user_email` = the member; `expert_email` from the item; `time_slots` empty. `request_summary`: `Follow-up consultation "{title}" with {member} booked by the expert for {meeting time}.` (the expert's note is not sent) |
| `member_signed_up` | Once per account, when `sendWelcomeEmailIfNeeded()` claims the welcome email (`POST /api/auth/welcome-email`, which the client calls on the first sign-in). The claim in `user_metadata.welcome_email_sent` keeps it to one post; it posts even if Resend then fails. Not sent for accounts that first sign in more than 7 days after creation (the welcome window), or that never sign in. `request_summary`: `New member account: {email}.` | `user_email` = the new member; every `item_*`, `reservation_id`, `time_slots` and `expert_email` empty; dates today |
| `reservation_cancelled_by_member` | After a member cancels an **approved** (`reserved`) equipment, book or room reservation from `/account` (`POST /api/account/reservations/:reservationId/cancel`). Withdrawing a still-pending request sends nothing | `item_*` from the item; `reservation_id`, `start_date`, `end_date` from the reservation; `user_email` = the member; `time_slots` and `expert_email` empty |

**`request_summary` examples:**

```
New mentor profile "Jane Doe" published by jane@example.com (https://activistresourcelibrary.com/expertise/jane-doe). Review it in /admin > Mentors.
Mentor profile "Jane D." (previously "Jane Doe") updated by jane@example.com, changed: name, photo (https://activistresourcelibrary.com/expertise/jane-doe). Review it in /admin > Mentors.
member@example.com cancelled their approved reservation of "Projector" (Tuesday, October 13, 2026 to Tuesday, October 20, 2026) from their account. Those dates are free again (https://activistresourcelibrary.com/equipment/projector).
```

Like the reservation post, the route waits for the alert (at most 5 s) inside `settleNotifications()`, and a Slack failure or timeout never fails the save or the cancellation.

### Slack workflow setup

Configure the Slack workflow trigger URL (typically `https://hooks.slack.com/triggers/...`) to accept the variable names above (at least `message`). The app sends **text-only JSON** — no Slack Block Kit payload, no signing secret verification on the app side.

**The workflow's message is just `{message}`.** The server writes the wording for every event, so changing it is a code change, not a Slack edit. Keep the **Review** button linked to `{admin_url}`. The other keys stay in the payload for older templates and for any workflow step that branches on them.

### Failure behavior

| Condition | Behavior |
|-----------|----------|
| URL not set | Silent no-op |
| HTTP non-2xx | `console.error` with status and response body |
| Network / timeout error | `console.error('Slack reservation webhook error:', error)`; a timeout delays the 201 by at most 5 s |
| Any failure | Reservation or mentor profile save still succeeds normally (Slack never affects the response's `emailSent`) |

### Startup log

When the Express server starts, if the URL is configured:

```
Slack reservation webhook → configured
```

---

## What does **not** send webhooks

| Event | Notes |
|-------|-------|
| Reservation approve / refuse | No Slack call |
| Reservation delete / patch (admin) | No Slack call |
| Member withdraws a pending request from `/account` | No Slack call (cancelling an approved booking does send `reservation_cancelled_by_member`) |
| Consultation schedule / cancel | No Slack call (booking a follow-up does send `consultation_follow_up`) |
| Add / remove inventory item, admin **Mentors** edits | No Slack call (only member mentor-profile saves send an alert) |
| Mentor profile `PATCH` that changed nothing | No Slack call |
| Client-side actions | Kimchi bubbles are in-browser only |

---

## Deployment

| Context | Configuration |
|---------|---------------|
| Local dev | Set `SLACK_RESERVATION_WEBHOOK_URL` in `.env` (see `.env.example`) |
| Cloud Run | `scripts/cloud-build.sh` passes `SLACK_RESERVATION_WEBHOOK_URL` as runtime env when set in `.env` |

---

## Gaps

| Gap | Notes |
|-----|-------|
| **Single webhook only** | No Discord, Teams, Zapier, or generic webhook abstraction |
| **Few events** | New reservations, new members, mentor profile saves, follow-ups and member cancellations of approved bookings only. Approve, refuse, admin deletes and consultation schedule/cancel do not notify Slack |
| **No retry** | Failed POSTs are logged once; no queue or retry |
| **No authentication headers** | Relies on obscurity of the Slack trigger URL |

---

## Source files

| File | Role |
|------|------|
| `server.js` | `postSlackWorkflow()`, `notifySlackReservation()`, `notifySlackAlert()`, `notifyMentorProfileChange()`, `notifyMemberReservationCancelled()`; hooks on reservation create, mentor-profile `POST`/`PATCH` and the member reservation cancel |
| `.env.example` | Documents optional `SLACK_RESERVATION_WEBHOOK_URL` |
| `scripts/cloud-build.sh` | Cloud Run runtime env for webhook URL |
