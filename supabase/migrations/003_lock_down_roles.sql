-- Defense in depth: revoke direct table access from anon and authenticated roles.
-- Express uses the service_role key (bypasses RLS); client auth must never query these tables directly.
-- Apply in Supabase Dashboard → SQL Editor after 001_inventory.sql and 002_reservation_approval.sql.

REVOKE ALL ON public.inventory_items FROM anon, authenticated;
REVOKE ALL ON public.reservations FROM anon, authenticated;
