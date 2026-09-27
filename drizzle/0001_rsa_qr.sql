PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  open_id TEXT NOT NULL UNIQUE,
  name TEXT,
  email TEXT,
  login_method TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_signed_in INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT,
  address TEXT,
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  notes TEXT,
  google_review_url TEXT,
  description TEXT,
  logo_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS customers_business_name_idx ON customers(business_name);
CREATE INDEX IF NOT EXISTS customers_phone_idx ON customers(phone);

CREATE TABLE IF NOT EXISTS qr_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial_number INTEGER NOT NULL UNIQUE,
  public_code TEXT NOT NULL UNIQUE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'STOCK' CHECK(status IN ('STOCK','RESERVED','ACTIVE','INACTIVE')),
  mode TEXT NOT NULL DEFAULT 'GOOGLE_REVIEW' CHECK(mode IN ('GOOGLE_REVIEW','LANDING_PAGE')),
  destination_url TEXT,
  scan_count INTEGER NOT NULL DEFAULT 0,
  last_scan_at INTEGER,
  created_at INTEGER NOT NULL,
  reserved_at INTEGER,
  activated_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS qr_status_idx ON qr_codes(status);
CREATE INDEX IF NOT EXISTS qr_customer_idx ON qr_codes(customer_id);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'link',
  position INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS links_customer_idx ON links(customer_id, position);

CREATE TABLE IF NOT EXISTS scan_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  qr_id INTEGER NOT NULL REFERENCES qr_codes(id) ON DELETE CASCADE,
  timestamp INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS scan_events_qr_idx ON scan_events(qr_id, timestamp);
CREATE INDEX IF NOT EXISTS scan_events_time_idx ON scan_events(timestamp);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  admin_open_id TEXT
);
CREATE INDEX IF NOT EXISTS audit_logs_time_idx ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_number INTEGER NOT NULL UNIQUE,
  quantity INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  created_at INTEGER NOT NULL,
  manifest_json TEXT NOT NULL
);
