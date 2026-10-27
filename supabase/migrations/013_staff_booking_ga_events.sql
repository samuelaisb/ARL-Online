-- Holds staff bookings' Google Analytics event until it is clear they aren't tests. The server
-- sends GA's booking_request_sent for a booking made in /admin → Create Reservation about an hour
-- after it was made (Measurement Protocol), only if it is still there and wasn't cancelled within
-- the hour, the same tests /admin Stats leaves out.
-- Apply in Supabase Dashboard → SQL Editor after 012_staff_bookings.sql. Safe to re-run. The app
-- works before it is applied: Create Reservation then sends the event from the browser at once,
-- as before.

-- null: not sent by the server (members' requests, and staff bookings made before this, whose
-- event went from the browser). pending: waiting for its hour. sending: claimed by a pass.
-- sent / skipped (a test) / expired (past GA's 72-hour backdating limit): settled.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS ga_event TEXT;
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_ga_event_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_ga_event_check
  CHECK (ga_event IS NULL OR ga_event IN ('pending', 'sending', 'sent', 'skipped', 'expired'));

-- When the server settled the event (sent, skipped or expired).
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS ga_event_at TIMESTAMPTZ;

-- The server looks for pending rows every few minutes; there are only ever a handful.
CREATE INDEX IF NOT EXISTS reservations_ga_event_pending_idx
  ON reservations (created_at)
  WHERE ga_event = 'pending';

-- Let PostgREST see the new columns without a restart.
NOTIFY pgrst, 'reload schema';
