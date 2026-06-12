-- ARL Online: inventory items and reservations
-- Apply in Supabase Dashboard → SQL Editor, or via Supabase CLI.

CREATE TABLE IF NOT EXISTS inventory_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  image TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT 'equipment',
  created_at BIGINT NOT NULL,
  CONSTRAINT inventory_items_tag_check CHECK (tag IN ('equipment', 'books', 'rooms'))
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',
  CONSTRAINT reservations_status_check CHECK (status IN ('reserved', 'available')),
  CONSTRAINT reservations_date_order CHECK (start_date <= end_date)
);

CREATE INDEX IF NOT EXISTS idx_reservations_item_id ON reservations(item_id);
CREATE INDEX IF NOT EXISTS idx_reservations_item_dates ON reservations(item_id, start_date, end_date);

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;

-- Table privileges (required even for service_role when tables are created via SQL Editor)
GRANT ALL ON public.inventory_items TO service_role;
GRANT ALL ON public.reservations TO service_role;

-- No anon/authenticated policies: Express uses the service role key (bypasses RLS).
