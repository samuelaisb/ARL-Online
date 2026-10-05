-- Expert-scheduled consultations with Zoom meetings + member/expert cancellation
-- Apply in Supabase Dashboard → SQL Editor after 005_expertise.sql.

ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_status_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
  CHECK (status IN ('pending', 'reserved', 'refused', 'cancelled', 'available'));

-- Zoom meeting created when the expert (or an admin) schedules the consultation.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS zoom_meeting_id TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS zoom_join_url TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS zoom_password TEXT;

-- Who cancelled ('member', 'expert', or 'admin') and when.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
