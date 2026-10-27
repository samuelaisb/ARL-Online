-- Marks the reservations staff make in /admin → Create Reservation, so /admin Stats can tell
-- them from members' own requests (its Requests tile splits Members and Staff, as GA's
-- booking_request_sent does with booking_source).
-- Apply in Supabase Dashboard → SQL Editor after 011_item_location_stations.sql. The app works
-- before it is applied: staff bookings are then saved unmarked and Stats counts them as members'.

-- Every existing row, member requests and staff blocks alike, starts as false.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booked_by_staff BOOLEAN NOT NULL DEFAULT false;

-- Staff bookings saved before this migration (Create Reservation went live on 2026-10-18) are
-- still false. Their ids are in the Cloud Run logs, on the `[admin-audit]` lines with
-- `action: 'create_reservation'`. To mark them:
--   UPDATE reservations SET booked_by_staff = true WHERE id IN ('<reservationId>', '<reservationId>');

-- Let PostgREST see the new column without a restart.
NOTIFY pgrst, 'reload schema';
