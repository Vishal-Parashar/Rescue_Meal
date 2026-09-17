CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('Admin', 'NGO', 'FoodProducer', 'delivery partner')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS food_batches (
  id BIGSERIAL PRIMARY KEY,
  batch_code TEXT NOT NULL UNIQUE DEFAULT ('FP-' || LPAD(nextval('food_batches_id_seq')::TEXT, 3, '0')),
  producer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  food_description TEXT NOT NULL,
  food_category TEXT NOT NULL,
  quantity TEXT NOT NULL,
  quantity_value NUMERIC(10, 2) NOT NULL CHECK (quantity_value > 0),
  preparation_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Awaiting Pickup'
    CHECK (status IN ('Awaiting Pickup', 'Picked Up', 'Delivered')),
  release_otp CHAR(4) NOT NULL,
  delivery_otp CHAR(4),
  assigned_ngo_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  delivery_partner_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  pickup_verified_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE food_batches
  ADD COLUMN IF NOT EXISTS assigned_shelter TEXT;
ALTER TABLE food_batches DROP CONSTRAINT IF EXISTS food_batches_status_check;
UPDATE food_batches SET status = 'Awaiting Pickup' WHERE status = 'Driver En Route';
ALTER TABLE food_batches ADD CONSTRAINT food_batches_status_check
  CHECK (status IN ('Awaiting Pickup', 'Picked Up', 'Delivered'));
ALTER TABLE food_batches ADD COLUMN IF NOT EXISTS delivery_otp CHAR(4);
ALTER TABLE food_batches ADD COLUMN IF NOT EXISTS assigned_ngo_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE food_batches ADD COLUMN IF NOT EXISTS delivery_partner_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE food_batches ADD COLUMN IF NOT EXISTS pickup_verified_at TIMESTAMPTZ;
ALTER TABLE food_batches ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS producer_inventory (
  id BIGSERIAL PRIMARY KEY,
  producer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  category TEXT NOT NULL,
  barcode TEXT,
  quantity NUMERIC(10, 2) NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL,
  expires_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS food_requirements (
  id BIGSERIAL PRIMARY KEY,
  ngo_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  food_description TEXT NOT NULL,
  food_category TEXT NOT NULL,
  servings INTEGER NOT NULL CHECK (servings > 0),
  needed_by TIMESTAMPTZ NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'Open'
    CHECK (status IN ('Open', 'Fulfilled', 'Cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
