-- Follow-up consultations: an expert books the next meeting from a meeting that has started.
-- follow_up_of points at the consultation it follows; NULL for consultations a member requested.
-- Apply in Supabase Dashboard → SQL Editor after 007_expertise_copy.sql.

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS follow_up_of TEXT;

ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_follow_up_of_fkey;
ALTER TABLE reservations ADD CONSTRAINT reservations_follow_up_of_fkey
  FOREIGN KEY (follow_up_of) REFERENCES reservations(id) ON DELETE SET NULL;
