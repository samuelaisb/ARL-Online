-- A conversation on each booking (rooms, equipment, books and mentor meetings) between the member
-- who booked and the host (itemOwnerEmail: the mentor, else the item's owner). Messages are
-- written and read on /account; the other side gets one email that points there, then no more
-- until they have opened the conversation. Nobody's email address is in a message or its email.
-- reservation_messages: one row per message. `sender` is the side that wrote it; `by_staff` marks
-- a host-side message from a library admin (shown as the library team). `kind` 'new_time' is a
-- member's "Suggest a new time".
-- reservation_message_state: per booking and side, when that side last opened the conversation
-- (`read_at`) and when we last emailed them about it (`notified_at`). A new message emails the
-- other side only when they have read the conversation since our last email (or never got one).
-- Deleting a member's account deletes the conversations on their bookings.
-- Apply in Supabase Dashboard → SQL Editor after 015_item_owners_and_reminders.sql, before
-- deploying the code that uses it (the agenda still loads without it, but messages can't be sent).
-- Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS reservation_messages (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  by_staff BOOLEAN NOT NULL DEFAULT false,
  kind TEXT NOT NULL DEFAULT 'message',
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE reservation_messages DROP CONSTRAINT IF EXISTS reservation_messages_sender_check;
ALTER TABLE reservation_messages ADD CONSTRAINT reservation_messages_sender_check
  CHECK (sender IN ('member', 'host'));
ALTER TABLE reservation_messages DROP CONSTRAINT IF EXISTS reservation_messages_kind_check;
ALTER TABLE reservation_messages ADD CONSTRAINT reservation_messages_kind_check
  CHECK (kind IN ('message', 'new_time'));
ALTER TABLE reservation_messages DROP CONSTRAINT IF EXISTS reservation_messages_body_check;
ALTER TABLE reservation_messages ADD CONSTRAINT reservation_messages_body_check
  CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000);

CREATE INDEX IF NOT EXISTS reservation_messages_reservation_idx
  ON reservation_messages (reservation_id, created_at);

CREATE TABLE IF NOT EXISTS reservation_message_state (
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  side TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  notified_at TIMESTAMPTZ,
  PRIMARY KEY (reservation_id, side)
);

ALTER TABLE reservation_message_state DROP CONSTRAINT IF EXISTS reservation_message_state_side_check;
ALTER TABLE reservation_message_state ADD CONSTRAINT reservation_message_state_side_check
  CHECK (side IN ('member', 'host'));

ALTER TABLE reservation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_message_state ENABLE ROW LEVEL SECURITY;

-- Same lockdown as 003, 009 and 010: only the service role (Express) reads or writes them.
GRANT ALL ON public.reservation_messages TO service_role;
GRANT ALL ON public.reservation_message_state TO service_role;
REVOKE ALL ON public.reservation_messages FROM anon, authenticated;
REVOKE ALL ON public.reservation_message_state FROM anon, authenticated;

COMMIT;
