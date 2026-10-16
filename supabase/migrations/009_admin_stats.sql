-- Admin stats: when each reservation was requested, which rows lost their member to an account
-- deletion, and daily view counts per item.
-- The server records a view through increment_item_view() (one call per counted overlay open)
-- and the /admin Stats section reads the aggregate functions below. All of it is service-role only.
-- reservations.anonymized_at is set by the server when a member account is deleted.
-- Apply in Supabase Dashboard → SQL Editor after 008_consultation_follow_up.sql, and before
-- deploying the code that uses it (deleting a member writes anonymized_at).

-- When the request was made. Rows from before this migration stay NULL (their request day is
-- unknown); new rows get now() from the default, so the app never writes it.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE reservations ALTER COLUMN created_at SET DEFAULT now();

-- When the member's account was deleted and the row lost its email, time slots and request
-- summary. NULL for every other row, so Stats can still count these as member requests
-- instead of mistaking them for old rows that never had a member.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

-- One row per item per Montréal day. Deleting an item deletes its counts.
CREATE TABLE IF NOT EXISTS item_views (
  item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT item_views_pkey PRIMARY KEY (item_id, day),
  CONSTRAINT item_views_count_check CHECK (count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_item_views_day ON item_views(day);

ALTER TABLE item_views ENABLE ROW LEVEL SECURITY;

-- Same lockdown as 001 and 003: only the service role (Express) reads or writes it.
GRANT ALL ON public.item_views TO service_role;
REVOKE ALL ON public.item_views FROM anon, authenticated;

-- Atomic +1 (a PostgREST upsert would overwrite the count). An unknown item fails the
-- foreign key (23503), which the server treats as "not counted".
CREATE OR REPLACE FUNCTION public.increment_item_view(p_item_id TEXT, p_day DATE)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO public.item_views (item_id, day, count)
  VALUES (p_item_id, p_day, 1)
  ON CONFLICT (item_id, day) DO UPDATE SET count = item_views.count + 1;
$$;

-- Per item: all-time views, and views on or after each of the two dates.
CREATE OR REPLACE FUNCTION public.item_view_summary(p_since_30 DATE, p_since_60 DATE)
RETURNS TABLE (item_id TEXT, views_total BIGINT, views_30 BIGINT, views_60 BIGINT)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    v.item_id,
    SUM(v.count)::BIGINT,
    COALESCE(SUM(v.count) FILTER (WHERE v.day >= p_since_30), 0)::BIGINT,
    COALESCE(SUM(v.count) FILTER (WHERE v.day >= p_since_60), 0)::BIGINT
  FROM public.item_views v
  GROUP BY v.item_id;
$$;

-- Views per day on or after p_since, all items together. Days without views are left out.
CREATE OR REPLACE FUNCTION public.item_view_daily(p_since DATE)
RETURNS TABLE (day DATE, views BIGINT)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT v.day, SUM(v.count)::BIGINT
  FROM public.item_views v
  WHERE v.day >= p_since
  GROUP BY v.day
  ORDER BY v.day;
$$;

-- The first day with a count (NULL before the first view).
CREATE OR REPLACE FUNCTION public.item_views_started()
RETURNS DATE
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT MIN(v.day) FROM public.item_views v;
$$;

-- Functions are executable by PUBLIC by default, and Supabase also grants anon and
-- authenticated directly, so revoke from all three. The anon key is public (/config.js).
REVOKE ALL ON FUNCTION public.increment_item_view(TEXT, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.item_view_summary(DATE, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.item_view_daily(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.item_views_started() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_item_view(TEXT, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.item_view_summary(DATE, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.item_view_daily(DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.item_views_started() TO service_role;

-- Let PostgREST see the new table, column and functions without a restart.
NOTIFY pgrst, 'reload schema';
