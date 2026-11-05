-- Moves an account's records when its email address changes. The app ties them to the address,
-- not the account id: the mentor profile (inventory_items.expert_email, which carries every
-- consultation addressed to them as the expert) and their own reservations and consultation
-- requests (reservations.user_email, including staff bookings made for that address). Without
-- this they stay with the old address and drop off the account page.
-- It runs inside the email update, so it covers every way the address changes (the Supabase
-- dashboard, the Auth admin API, a member confirming a change). If it fails, the email change
-- fails with it, so the account and its records never disagree.
-- Only an account whose old address was confirmed moves anything: records under an address it
-- never proved it owned stay where they are.
-- Apply in Supabase Dashboard → SQL Editor after 013_staff_booking_ga_events.sql. No app deploy
-- is needed for it. A mentor's address changed in /admin → Mentors (not the account's) is handled
-- by the app instead: the consultations follow the item, and the new address is emailed them.

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

  UPDATE public.reservations
  SET user_email = btrim(NEW.email)
  WHERE lower(btrim(user_email)) = lower(btrim(OLD.email));

  RETURN NEW;
END;
$$;

-- No REVOKE as in 009: a trigger function can't be called on its own, only fired.

DROP TRIGGER IF EXISTS move_records_to_new_account_email ON auth.users;
CREATE TRIGGER move_records_to_new_account_email
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW
  WHEN (OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION public.move_records_to_new_account_email();
