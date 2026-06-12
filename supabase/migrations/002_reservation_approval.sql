-- Reservation approval workflow: pending → reserved (approved) or refused
-- Apply in Supabase Dashboard → SQL Editor after 001_inventory.sql.

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS user_email TEXT;

ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_status_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
  CHECK (status IN ('pending', 'reserved', 'refused', 'available'));
