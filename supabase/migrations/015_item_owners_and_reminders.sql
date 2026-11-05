-- Gives every item an owner, and lets the server email a reminder the day before each booking.
-- inventory_items.owner_email: who hosts the item. They manage its bookings from /account and get
-- members' messages about them. For a mentor, their own address (expert_email) still comes first;
-- owner_email covers a mentor item that has none. Every item that has no owner yet goes to
-- samuel@apathyisboring.com; the app gives new items their creator's address (staff adding an
-- item in /admin, a member sharing their expertise).
-- reservations.reminder_email: whether the day-before reminder went out (rooms, equipment and book
-- pickups, mentor meetings). A pass in the deployed server sends it about a day before the start.
-- It also replaces 014's trigger function, so an account's email change moves owner_email too.
-- Apply in Supabase Dashboard → SQL Editor after 014_account_email_change.sql (it works whether or
-- not 014 was applied). Safe to re-run. If 014 is applied (or re-run) after this file, re-run this
-- file: 014 puts back its own function, which doesn't move owner_email. The app works before it
-- is applied: items read with no owner (nobody manages their bookings from /account, and members'
-- messages to a host go to the library inbox), no reminders are sent, and a new item is saved
-- without its owner (one warning).

ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS owner_email TEXT;

UPDATE inventory_items
SET owner_email = 'samuel@apathyisboring.com'
WHERE owner_email IS NULL OR btrim(owner_email) = '';

-- null: not sent yet (the server sends it once the start is less than a day away). sending:
-- claimed by a pass. sent. skipped: not needed (the booking was confirmed or moved less than a
-- day before its start, so that email was the reminder). Never in any API response.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS reminder_email TEXT;
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_reminder_email_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_reminder_email_check
  CHECK (reminder_email IS NULL OR reminder_email IN ('sending', 'sent', 'skipped'));

-- When a pass claimed the reminder (sending; a claim older than 30 minutes is handed back) or
-- settled it (sent or skipped).
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS reminder_email_at TIMESTAMPTZ;

-- The server looks for bookings starting soon every few minutes.
CREATE INDEX IF NOT EXISTS reservations_reminder_due_idx
  ON reservations (start_date)
  WHERE status = 'reserved' AND reminder_email IS NULL;

-- 014's function with a third update for owner_email (same match rule).
CREATE OR REPLACE FUNCTION public.move_records_to_new_account_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.email IS NULL
    OR NEW.email IS NULL
    OR btrim(NEW.email) = ''
    OR OLD.email_confirmed_at IS NULL
    OR lower(btrim(OLD.email)) = lower(btrim(NEW.email)) THEN
    RETURN NEW;
  END IF;

  -- Matched as the app does (emailsMatch): trimmed and case-insensitive.
  UPDATE public.inventory_items
  SET expert_email = btrim(NEW.email)
  WHERE lower(btrim(expert_email)) = lower(btrim(OLD.email));

  UPDATE public.inventory_items
  SET owner_email = btrim(NEW.email)
  WHERE lower(btrim(owner_email)) = lower(btrim(OLD.email));

  UPDATE public.reservations
  SET user_email = btrim(NEW.email)
  WHERE lower(btrim(user_email)) = lower(btrim(OLD.email));

  RETURN NEW;
END;
$$;

-- No REVOKE as in 009: a trigger function can't be called on its own, only fired.

-- Recreated as in 014, so this works whether or not 014 was applied.
DROP TRIGGER IF EXISTS move_records_to_new_account_email ON auth.users;
CREATE TRIGGER move_records_to_new_account_email
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW
  WHEN (OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION public.move_records_to_new_account_email();

-- Let PostgREST see the new columns without a restart.
NOTIFY pgrst, 'reload schema';
