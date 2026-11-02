// Clinic booking API: request routing and business logic.
// Spec: https://koyaacademy.com/assessment-api
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pool, ensureSchema } = require("./db");

const API_KEY = process.env.API_KEY || "";
const RATE_LIMIT = 5; // attempts per email...
const RATE_WINDOW_SECONDS = 60; // ...per minute
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- small helpers ----------

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Idempotency-Key",
  "Access-Control-Expose-Headers": "Retry-After",
};

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Works both on plain Node (stream) and on Vercel (which pre-parses req.body).
async function readJson(req) {
  let raw;
  if ("body" in req) {
    let b;
    try {
      b = req.body;
    } catch {
      return { ok: false, raw: "<invalid>" };
    }
    if (b === undefined || b === null) raw = "";
    else if (Buffer.isBuffer(b)) raw = b.toString("utf8");
    else if (typeof b === "string") raw = b;
    else return { ok: true, value: b, raw: canonical(b) };
  } else {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    raw = Buffer.concat(chunks).toString("utf8");
  }
  if (!raw.trim()) return { ok: true, value: undefined, raw: "" };
  try {
    const value = JSON.parse(raw);
    return { ok: true, value, raw: canonical(value) };
  } catch {
    return { ok: false, raw };
  }
}

// Stable JSON (sorted keys) so the same body always hashes the same way.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

const encodeCursor = (seq) => Buffer.from(`seq:${seq}`).toString("base64url");
function decodeCursor(cursor) {
  const m = /^seq:(\d{1,18})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!m) throw new HttpError(400, "invalid cursor");
  return m[1];
}

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

// ---------- handlers ----------

// POST /reset (level 1)
async function reset(req, res) {
  const body = await readJson(req);
  if (!body.ok) throw new HttpError(400, "invalid JSON body");
  const slots = body.value && body.value.slots;
  if (!Array.isArray(slots)) throw new HttpError(400, "slots must be an array");

  const seen = new Set();
  const rows = slots.map((s, i) => {
    if (!s || typeof s !== "object") throw new HttpError(400, `slots[${i}] must be an object`);
    for (const f of ["id", "provider", "start", "end"]) {
      if (!isNonEmptyString(s[f])) throw new HttpError(400, `slots[${i}].${f} is required`);
    }
    if (Number.isNaN(Date.parse(s.start)) || Number.isNaN(Date.parse(s.end))) {
      throw new HttpError(400, `slots[${i}] has an invalid start or end`);
    }
    if (seen.has(s.id)) throw new HttpError(400, `duplicate slot id ${s.id}`);
    seen.add(s.id);
    return s;
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE slots, bookings IN ACCESS EXCLUSIVE MODE");
    await client.query("DELETE FROM bookings");
    await client.query("DELETE FROM slots");
    await client.query("DELETE FROM idempotency_keys");
    await client.query("DELETE FROM booking_attempts");
    if (rows.length) {
      await client.query(
        `INSERT INTO slots (id, provider, start_raw, end_raw, start_at, end_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $3::timestamptz[], $4::timestamptz[])`,
        [rows.map((s) => s.id), rows.map((s) => s.provider), rows.map((s) => s.start), rows.map((s) => s.end)]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  send(res, 200, { ok: true, slots: rows.length });
}

// GET /slots (level 1)
async function listSlots(req, res, url) {
  const provider = url.searchParams.get("provider");
  const { rows } = await pool.query(
    `SELECT s.id, s.provider, s.start_raw, s.end_raw,
            NOT EXISTS (SELECT 1 FROM bookings b
                        WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
       FROM slots s
      WHERE $1::text IS NULL OR s.provider = $1
      ORDER BY s.start_at, s.id`,
    [provider]
  );
  send(res, 200, {
    slots: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      start: r.start_raw,
      end: r.end_raw,
      available: r.available,
    })),
  });
}

// GET /bookings/{id} (level 1)
async function getBooking(req, res, id) {
  const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [id]);
  if (!rows.length) throw new HttpError(404, "booking not found");
  send(res, 200, toBooking(rows[0]));
}

// DELETE /bookings/{id} (level 3)
async function cancelBooking(req, res, id) {
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'cancelled'
      WHERE id = $1 AND status = 'confirmed' RETURNING *`,
    [id]
  );
  if (rows.length) return send(res, 200, toBooking(rows[0]));
  const existing = await pool.query("SELECT 1 FROM bookings WHERE id = $1", [id]);
  if (!existing.rows.length) throw new HttpError(404, "booking not found");
  throw new HttpError(409, "booking already cancelled");
}

// GET /bookings?email=&limit=&cursor= (level 4)
async function listBookings(req, res, url) {
  const p = url.searchParams;
  const email = (p.get("email") || "").trim().toLowerCase();
  if (!email) throw new HttpError(400, "email is required");

  let limit = 10;
  if (p.has("limit")) {
    const raw = p.get("limit").trim();
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 50) {
      throw new HttpError(400, "limit must be an integer from 1 to 50");
    }
    limit = Number(raw);
  }
  const after = p.get("cursor") ? decodeCursor(p.get("cursor")) : "0";

  const { rows } = await pool.query(
    `SELECT * FROM bookings WHERE email = $1 AND seq > $2::bigint
      ORDER BY seq LIMIT $3`,
    [email, after, limit + 1]
  );
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null;
  send(res, 200, { bookings: page.map(toBooking), next_cursor: next });
}

// POST /bookings (levels 1-5)
async function createBooking(req, res) {
  const idemKey = req.headers["idempotency-key"];
  const body = await readJson(req);
  const requestHash = sha256(body.ok ? body.raw : `invalid:${body.raw}`);
  const input = body.ok && body.value && typeof body.value === "object" ? body.value : {};
  const rateEmail = isNonEmptyString(input.email) ? input.email.trim().toLowerCase() : null;

  // The whole transaction is rolled back on a deadlock / serialization
  // failure, so it is safe to simply run it again.
  for (let attempt = 1; ; attempt++) {
    try {
      return await createBookingTx(res, idemKey, requestHash, rateEmail, body, input);
    } catch (err) {
      if (attempt < 4 && (err.code === "40P01" || err.code === "40001")) {
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 30));
        continue;
      }
      throw err;
    }
  }
}

async function createBookingTx(res, idemKey, requestHash, rateEmail, body, input) {
  const client = await pool.connect();
  let result; // { status, body, headers }
  try {
    await client.query("BEGIN");

    // Level 4: replay a stored response for a repeated Idempotency-Key.
    // The advisory lock makes concurrent retries with the same key wait for
    // the first one to finish instead of racing it.
    if (idemKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [`idem:${idemKey}`]);
      const prev = await client.query(
        "SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1",
        [idemKey]
      );
      if (prev.rows.length) {
        const row = prev.rows[0];
        await client.query("COMMIT");
        if (row.request_hash !== requestHash) {
          return send(res, 422, { error: "Idempotency-Key was already used with a different request body" });
        }
        return send(res, row.status_code, row.response, { "Idempotent-Replayed": "true" });
      }
    }

    // Level 5: at most 5 attempts per email per sliding minute, failed ones included.
    if (rateEmail) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2))", [`rate:${rateEmail}`]);
      await client.query(
        `DELETE FROM booking_attempts
          WHERE email = $1 AND at <= clock_timestamp() - make_interval(secs => $2)`,
        [rateEmail, RATE_WINDOW_SECONDS]
      );
      const { rows } = await client.query(
        `SELECT count(*)::int AS n,
                ceil(extract(epoch FROM min(at) + make_interval(secs => $2) - clock_timestamp()))::int AS wait
           FROM booking_attempts WHERE email = $1`,
        [rateEmail, RATE_WINDOW_SECONDS]
      );
      if (rows[0].n >= RATE_LIMIT) {
        await client.query("COMMIT");
        const wait = Math.max(1, rows[0].wait || 1);
        return send(res, 429, { error: "too many booking attempts for this email, try again later" }, { "Retry-After": String(wait) });
      }
      await client.query("INSERT INTO booking_attempts (email) VALUES ($1)", [rateEmail]);
    }

    result = await attemptBooking(client, body, input);

    if (idemKey) {
      await client.query(
        `INSERT INTO idempotency_keys (key, request_hash, status_code, response)
         VALUES ($1, $2, $3, $4)`,
        [idemKey, requestHash, result.status, JSON.stringify(result.body)]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  send(res, result.status, result.body);
}

// Validation + insert. Runs inside createBooking's transaction.
async function attemptBooking(client, body, input) {
  const fail = (status, error) => ({ status, body: { error } });

  if (!body.ok) return fail(400, "invalid JSON body");
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return fail(400, "request body must be a JSON object");
  }
  for (const f of ["slot_id", "name", "email"]) {
    if (!isNonEmptyString(input[f])) return fail(400, `${f} is required`);
  }
  const slotId = input.slot_id.trim();
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return fail(400, "email is not valid");

  const slot = await client.query(
    "SELECT start_at <= now() AS started FROM slots WHERE id = $1",
    [slotId]
  );
  if (!slot.rows.length) return fail(404, "slot not found");
  if (slot.rows[0].started) return fail(400, "slot has already started");

  // Level 3: the partial unique index rejects a second confirmed booking,
  // even when requests arrive at the same moment.
  await client.query("SAVEPOINT book");
  try {
    const { rows } = await client.query(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed') RETURNING *`,
      [crypto.randomUUID(), slotId, name, email]
    );
    await client.query("RELEASE SAVEPOINT book");
    return { status: 201, body: toBooking(rows[0]) };
  } catch (err) {
    if (err.code === "23505") {
      await client.query("ROLLBACK TO SAVEPOINT book");
      return fail(409, "slot is already booked");
    }
    throw err;
  }
}

// ---------- web page ----------

let pageTemplate;
function servePage(res) {
  if (!pageTemplate) {
    pageTemplate = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
  }
  // The page talks to this API, so it needs the key. It is injected at
  // request time from the environment so it never lives in the repo.
  const html = pageTemplate.replace("__API_KEY__", JSON.stringify(API_KEY).slice(1, -1));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

// ---------- router ----------

async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    let pathname = url.pathname;
    // Vercel rewrite fallback: original path passed as ?__path=
    if (url.searchParams.has("__path")) {
      if (pathname.startsWith("/api/index")) pathname = "/" + url.searchParams.get("__path");
      url.searchParams.delete("__path");
    }
    pathname = pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return servePage(res);
    }
    if (req.method === "OPTIONS") return send(res, 204);

    // All API routes live under /api.
    if (!(pathname === "/api" || pathname.startsWith("/api/"))) {
      throw new HttpError(404, "not found");
    }
    const route = pathname.slice(4) || "/";

    // Level 2: every API request needs the key.
    const key = req.headers["x-api-key"];
    if (!API_KEY || !key || !safeEqual(key, API_KEY)) {
      throw new HttpError(401, "missing or invalid API key");
    }

    await ensureSchema();

    if (route === "/reset" && req.method === "POST") return await reset(req, res);
    if (route === "/slots" && req.method === "GET") return await listSlots(req, res, url);
    if (route === "/bookings" && req.method === "POST") return await createBooking(req, res);
    if (route === "/bookings" && req.method === "GET") return await listBookings(req, res, url);

    const m = /^\/bookings\/([^/]+)$/.exec(route);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (req.method === "GET") return await getBooking(req, res, id);
      if (req.method === "DELETE") return await cancelBooking(req, res, id);
      throw new HttpError(405, "method not allowed");
    }
    if (["/reset", "/slots", "/bookings"].includes(route)) throw new HttpError(405, "method not allowed");
    throw new HttpError(404, "not found");
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message }, err.headers);
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: "internal server error" });
  }
}

module.exports = handler;
