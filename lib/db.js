// Postgres connection pool and schema setup.
const { Pool } = require("pg");

// Neon's Vercel integration may name the variable DATABASE_URL or POSTGRES_URL.
const connectionString =
  process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.STORAGE_URL || "";

const isLocal = /localhost|127\.0\.0\.1|\/tmp|host=\//.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  // Serverless: keep each instance's footprint small. Neon's pooled endpoint
  // handles fan-out across instances.
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 10_000,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id        TEXT PRIMARY KEY,
  provider  TEXT NOT NULL,
  start_raw TEXT NOT NULL,
  end_raw   TEXT NOT NULL,
  start_at  TIMESTAMPTZ NOT NULL,
  end_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  seq        BIGSERIAL UNIQUE,
  id         TEXT PRIMARY KEY,
  slot_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Level 3: the database itself guarantees at most one confirmed booking per
-- slot, so simultaneous requests can never double-book.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_by_email ON bookings (email, seq);

-- Level 4: stored responses for Idempotency-Key replays.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status_code  INT  NOT NULL,
  response     JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Level 5: booking attempts per email, for the sliding-window rate limit.
CREATE TABLE IF NOT EXISTS booking_attempts (
  id    BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS booking_attempts_by_email ON booking_attempts (email, at);
`;

let ready;
function ensureSchema() {
  if (!connectionString) return Promise.reject(new Error("DATABASE_URL is not set"));
  if (!ready) {
    ready = (async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Serialise schema creation across cold-starting instances.
        await client.query("SELECT pg_advisory_xact_lock(727001)");
        await client.query(SCHEMA);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        ready = undefined;
        throw err;
      } finally {
        client.release();
      }
    })();
  }
  return ready;
}

module.exports = { pool, ensureSchema };
