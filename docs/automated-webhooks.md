# Automated webhooks

The ARL Online server posts to **one optional outbound webhook**: a Slack workflow trigger on new pending reservations. There are no other webhook integrations in the application codebase.

---

## Slack reservation webhook

| Field | Value |
|-------|-------|
| **Env var** | `SLACK_RESERVATION_WEBHOOK_URL` |
| **Required** | No — omitted or empty string disables the webhook entirely |
| **Function** | `notifySlackReservation()` in `server.js` |
| **Trigger** | Successful `POST /api/inventory/:id/reservations` |
| **HTTP method** | `POST` |
| **Content-Type** | `application/json` |
| **Timeout** | **5 seconds** (`AbortSignal.timeout(5000)`) |
| **Blocks API response?** | **No** — fire-and-forget; reservation returns 201 even if Slack fails |

### When it runs

1. Member submits valid reservation dates (authenticated JWT).
2. Reservation is persisted with `status: pending`.
3. `notifySlackReservation({ item, reservation })` is called without `await`.
4. If URL is unset, function returns immediately (no network call).

### Payload (JSON body)

All values are plain strings suitable for Slack workflow trigger variables:

| Field | Source | Example / notes |
|-------|--------|-----------------|
| `item_id` | `item.id` | Inventory item UUID or seed id |
| `item_title` | `item.title` | Display title |
| `item_body` | `item.body` | Description text |
| `item_tag` | `item.tag` | `equipment`, `books`, or `rooms` |
| `reservation_id` | `reservation.id` | New reservation UUID |
| `start_date` | `reservation.startDate` | `YYYY-MM-DD` |
| `end_date` | `reservation.endDate` | `YYYY-MM-DD` |
| `status` | `reservation.status` | `pending` on create |
| `user_email` | `reservation.userEmail` | Member email from JWT; empty string if missing |

**Example payload:**

```json
{
  "item_id": "myturn-12345",
  "item_title": "Megaphone",
  "item_body": "Battery-powered megaphone for rallies.",
  "item_tag": "equipment",
  "reservation_id": "550e8400-e29b-41d4-a716-446655440000",
  "start_date": "2026-06-17",
  "end_date": "2026-06-24",
  "status": "pending",
  "user_email": "member@example.com"
}
```

### Slack workflow setup

Configure the Slack workflow trigger URL (typically `https://hooks.slack.com/triggers/...`) to accept the variable names above. The app sends **text-only JSON** — no Slack Block Kit payload, no signing secret verification on the app side.

### Failure behavior

| Condition | Behavior |
|-----------|----------|
| URL not set | Silent no-op |
| HTTP non-2xx | `console.error` with status and response body |
| Network / timeout error | `console.error('Slack reservation webhook error:', error)` |
| Any failure | Reservation still succeeds normally |

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
| Reservation delete / patch | No Slack call |
| Add / remove inventory item | No Slack call |
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
| **Create-only** | Status changes (approve/refuse/delete) do not notify Slack |
| **No retry** | Failed POSTs are logged once; no queue or retry |
| **No authentication headers** | Relies on obscurity of the Slack trigger URL |

---

## Source files

| File | Role |
|------|------|
| `server.js` | `notifySlackReservation()`, route hook on reservation create |
| `.env.example` | Documents optional `SLACK_RESERVATION_WEBHOOK_URL` |
| `scripts/cloud-build.sh` | Cloud Run runtime env for webhook URL |
