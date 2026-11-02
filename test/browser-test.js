(async()=>{const LOG=[];
// End-to-end checks for every level of the spec.
// Usage: BASE_URL=http://localhost:3000/api API_KEY=... node test/test.js
// WARNING: calls /reset, which wipes all bookings.
const assert = (v, m) => { if (!v) throw new Error(m || "assertion failed"); };
assert.equal = (a, b, m) => { if (a !== b) throw new Error((m ? m + ": " : "") + `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
assert.ok = (v, m) => assert(v, m);
assert.deepEqual = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m ? m + ": " : "") + `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const BASE = "/api";
const KEY = API_KEY;

let uniq = 0;
const email = (tag) => `${tag}.${Date.now()}.${++uniq}@example.com`;

async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const iso = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const SLOTS = [
  { id: "s3", provider: "Dr Ade", start: iso(60 * 26), end: iso(60 * 26 + 30) },
  { id: "s1", provider: "Dr Ade", start: iso(60 * 24), end: iso(60 * 24 + 30) },
  { id: "s2", provider: "Dr Bello", start: iso(60 * 25), end: iso(60 * 25 + 30) },
  { id: "past", provider: "Dr Bello", start: iso(-120), end: iso(-90) },
  ...Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, provider: "Dr Page", start: iso(60 * 48 + i * 30), end: iso(60 * 48 + i * 30 + 30) })),
];
const reset = () => call("POST", "/reset", { slots: SLOTS });

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["PASS", name]); LOG.push("  ✓", name); }
  catch (e) { results.push(["FAIL", name]); LOG.push("  ✗", name, "\n     ", e.message); }
}

return (async () => {
  LOG.push(`Testing ${BASE}\n\nLevel 1`);
  await test("reset returns 200", async () => assert.equal((await reset()).status, 200));
  await test("slots listed earliest first with availability", async () => {
    const r = await call("GET", "/slots");
    assert.equal(r.status, 200);
    const ids = r.body.slots.map((s) => s.id);
    assert.deepEqual(ids.slice(0, 4), ["past", "s1", "s2", "s3"]);
    const s1 = r.body.slots.find((s) => s.id === "s1");
    assert.deepEqual(Object.keys(s1).sort(), ["available", "end", "id", "provider", "start"]);
    assert.equal(s1.available, true);
    assert.equal(s1.start, SLOTS[1].start);
  });
  await test("provider filter is exact match", async () => {
    const r = await call("GET", "/slots?provider=" + encodeURIComponent("Dr Bello"));
    assert.deepEqual(r.body.slots.map((s) => s.id), ["past", "s2"]);
    const none = await call("GET", "/slots?provider=dr%20bello");
    assert.equal(none.body.slots.length, 0);
  });
  let booking;
  await test("book a slot -> 201 confirmed", async () => {
    const r = await call("POST", "/bookings", { slot_id: "s1", name: "Ada Obi", email: email("ada") });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    booking = r.body;
    assert.equal(booking.status, "confirmed");
    for (const f of ["id", "slot_id", "name", "email", "status", "created_at"]) assert.ok(f in booking, f);
  });
  await test("look up booking by id", async () => {
    const r = await call("GET", `/bookings/${booking.id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, booking);
  });
  await test("unknown booking -> 404 with error", async () => {
    const r = await call("GET", "/bookings/nope");
    assert.equal(r.status, 404);
    assert.equal(typeof r.body.error, "string");
  });
  await test("slot shows unavailable once booked", async () => {
    const r = await call("GET", "/slots");
    assert.equal(r.body.slots.find((s) => s.id === "s1").available, false);
  });

  LOG.push("\nLevel 2");
  await test("missing / wrong API key -> 401 on every endpoint", async () => {
    for (const [m, p] of [["GET", "/slots"], ["POST", "/reset"], ["POST", "/bookings"], ["GET", "/bookings?email=a@b.co"], ["GET", "/bookings/x"], ["DELETE", "/bookings/x"]]) {
      const none = await fetch(BASE + p, { method: m });
      assert.equal(none.status, 401, `${m} ${p} no key`);
      assert.equal(typeof (await none.json()).error, "string");
      const wrong = await fetch(BASE + p, { method: m, headers: { "X-API-Key": KEY + "x" } });
      assert.equal(wrong.status, 401, `${m} ${p} wrong key`);
    }
  });
  await test("missing / empty / invalid fields -> 400", async () => {
    const e = email("v");
    const bad = [
      {}, { name: "A", email: e }, { slot_id: "s2", email: e }, { slot_id: "s2", name: "A" },
      { slot_id: "", name: "A", email: e }, { slot_id: "s2", name: "   ", email: e },
      { slot_id: "s2", name: "A", email: "not-an-email" }, { slot_id: "s2", name: "A", email: "a@b" },
      { slot_id: 5, name: "A", email: e },
    ];
    for (const b of bad) {
      const r = await call("POST", "/bookings", b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(typeof r.body.error, "string");
    }
    assert.equal((await call("POST", "/bookings", "{not json")).status, 400);
  });
  await test("unknown slot -> 404", async () => {
    assert.equal((await call("POST", "/bookings", { slot_id: "zzz", name: "A", email: email("u") })).status, 404);
  });
  await test("slot already started -> 400", async () => {
    assert.equal((await call("POST", "/bookings", { slot_id: "past", name: "A", email: email("p") })).status, 400);
  });
  await test("name and email are trimmed, email lower-cased", async () => {
    const e = email("Trim");
    const r = await call("POST", "/bookings", { slot_id: "s2", name: "  Bola Ade ", email: `  ${e.toUpperCase()}  ` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.name, "Bola Ade");
    assert.equal(r.body.email, e.toLowerCase());
  });

  LOG.push("\nLevel 3");
  await reset();
  await test("30 simultaneous bookings for one slot -> exactly one 201, rest 409", async () => {
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      call("POST", "/bookings", { slot_id: "s3", name: `P${i}`, email: email("race") })));
    const codes = rs.map((r) => r.status);
    assert.equal(codes.filter((c) => c === 201).length, 1, codes.join(","));
    assert.equal(codes.filter((c) => c === 409).length, 29, codes.join(","));
  });
  let toCancel;
  await test("booked slot -> 409", async () => {
    const a = await call("POST", "/bookings", { slot_id: "s1", name: "A", email: email("c") });
    assert.equal(a.status, 201);
    toCancel = a.body;
    assert.equal((await call("POST", "/bookings", { slot_id: "s1", name: "B", email: email("c") })).status, 409);
  });
  await test("cancel -> 200 cancelled, slot freed, rebookable", async () => {
    const r = await call("DELETE", `/bookings/${toCancel.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "cancelled");
    assert.equal(r.body.id, toCancel.id);
    assert.equal((await call("GET", `/bookings/${toCancel.id}`)).body.status, "cancelled");
    assert.equal((await call("GET", "/slots")).body.slots.find((s) => s.id === "s1").available, true);
    assert.equal((await call("POST", "/bookings", { slot_id: "s1", name: "B", email: email("c") })).status, 201);
  });
  await test("cancel twice -> 409, unknown -> 404", async () => {
    assert.equal((await call("DELETE", `/bookings/${toCancel.id}`)).status, 409);
    assert.equal((await call("DELETE", "/bookings/nope")).status, 404);
  });

  LOG.push("\nLevel 4");
  await reset();
  await test("same Idempotency-Key + same body -> same response, one booking", async () => {
    const e = email("idem");
    const body = { slot_id: "s1", name: "Ada", email: e };
    const a = await call("POST", "/bookings", body, { "Idempotency-Key": "k-1" });
    const b = await call("POST", "/bookings", body, { "Idempotency-Key": "k-1" });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(a.body.id, b.body.id);
    const list = await call("GET", `/bookings?email=${encodeURIComponent(e)}`);
    assert.equal(list.body.bookings.length, 1);
  });
  await test("same key + different body -> 422", async () => {
    const r = await call("POST", "/bookings", { slot_id: "s2", name: "Ada", email: email("idem") }, { "Idempotency-Key": "k-1" });
    assert.equal(r.status, 422);
  });
  await test("simultaneous retries with one key -> one booking, same id", async () => {
    const body = { slot_id: "s2", name: "Kemi", email: email("idem") };
    const rs = await Promise.all(Array.from({ length: 10 }, () => call("POST", "/bookings", body, { "Idempotency-Key": "k-par" })));
    assert.ok(rs.every((r) => r.status === 201), rs.map((r) => r.status).join(","));
    assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
  });
  await test("error responses are replayed too", async () => {
    const body = { slot_id: "nope", name: "X", email: email("idem") };
    const a = await call("POST", "/bookings", body, { "Idempotency-Key": "k-404" });
    const b = await call("POST", "/bookings", body, { "Idempotency-Key": "k-404" });
    assert.equal(a.status, 404);
    assert.equal(b.status, 404);
  });
  const pe = email("Pager");
  await test("cursor pagination, oldest first, case-insensitive email", async () => {
    const made = [];
    for (let i = 0; i < 5; i++) {
      const r = await call("POST", "/bookings", { slot_id: `p${i}`, name: "Pager", email: pe });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      made.push(r.body.id);
    }
    const seen = [];
    let cursor = null, pages = 0;
    do {
      const q = `?email=${encodeURIComponent(pe.toUpperCase())}&limit=2` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const r = await call("GET", "/bookings" + q);
      assert.equal(r.status, 200);
      assert.ok(r.body.bookings.length <= 2);
      assert.ok("next_cursor" in r.body);
      seen.push(...r.body.bookings.map((b) => b.id));
      cursor = r.body.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    assert.deepEqual(seen, made);
    assert.equal(pages, 3);
  });
  await test("default limit and last page next_cursor null", async () => {
    const r = await call("GET", `/bookings?email=${encodeURIComponent(pe)}`);
    assert.equal(r.body.bookings.length, 5);
    assert.equal(r.body.next_cursor, null);
  });
  await test("invalid limit -> 400", async () => {
    for (const l of ["0", "51", "-1", "abc", "2.5", ""]) {
      assert.equal((await call("GET", `/bookings?email=${encodeURIComponent(pe)}&limit=${l}`)).status, 400, `limit=${l}`);
    }
    assert.equal((await call("GET", `/bookings?email=${encodeURIComponent(pe)}&limit=50`)).status, 200);
    assert.equal((await call("GET", `/bookings?email=${encodeURIComponent(pe)}&limit=1`)).status, 200);
  });

  LOG.push("\nLevel 5");
  await reset();
  await test("6th attempt in a minute for one email -> 429 + Retry-After; others unaffected", async () => {
    const e = email("spam");
    const codes = [];
    for (let i = 0; i < 5; i++) {
      // mix of successes and failures - all count
      const slot = i === 0 ? "s1" : i === 1 ? "s1" : "missing";
      codes.push((await call("POST", "/bookings", { slot_id: slot, name: "Spam", email: e })).status);
    }
    assert.deepEqual(codes, [201, 409, 404, 404, 404]);
    const sixth = await call("POST", "/bookings", { slot_id: "s2", name: "Spam", email: e.toUpperCase() });
    assert.equal(sixth.status, 429);
    assert.equal(typeof sixth.body.error, "string");
    const ra = sixth.headers.get("retry-after");
    assert.ok(/^\d+$/.test(ra) && Number(ra) >= 1 && Number(ra) <= 60, `Retry-After=${ra}`);
    const other = await call("POST", "/bookings", { slot_id: "s2", name: "Other", email: email("other") });
    assert.equal(other.status, 201);
  });
  await test("burst of 10 simultaneous attempts for one email -> at most 5 get through", async () => {
    const e = email("burst");
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      call("POST", "/bookings", { slot_id: `p${i}`, name: "B", email: e })));
    const codes = rs.map((r) => r.status);
    assert.equal(codes.filter((c) => c === 429).length, 5, codes.join(","));
  });

  const failed = results.filter((r) => r[0] === "FAIL").length;
  LOG.push(`\n${results.length - failed}/${results.length} passed`);
  await reset();
  return LOG.join("\n");
})();
})()