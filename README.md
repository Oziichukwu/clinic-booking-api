# Clinic Booking API

An API that lets patients book clinic appointment slots, plus a web page that uses it. Built for Task 1 of the Koya Cohort 4 assessment and follows the [technical spec](https://koyaacademy.com/assessment-api).

- **Stack:** Node.js (no framework) + PostgreSQL, deployed on Vercel with a Neon database.
- **API base URL:** `https://<deployment>/api`
- **Web page:** `https://<deployment>/`

## Endpoints

Every API request needs the `X-API-Key` header; a missing or wrong key returns `401`. Errors are always `{"error": "<message>"}`.

| Method | Path | Level | What it does |
| --- | --- | --- | --- |
| POST | `/reset` | 1 | Deletes every booking and replaces all slots |
| GET | `/slots?provider=` | 1 | Every slot, earliest first, with `available` |
| POST | `/bookings` | 1–5 | Books a slot (`201`) |
| GET | `/bookings/{id}` | 1 | One booking (`404` if unknown) |
| DELETE | `/bookings/{id}` | 3 | Cancels it and frees the slot (`409` if already cancelled) |
| GET | `/bookings?email=&limit=&cursor=` | 4 | A person's bookings, oldest first, cursor-paginated |

## How each level is handled

**Level 1: list, book and look up.** Slots keep the exact `start`/`end` strings they were created with and are sorted by their parsed timestamps. `available` is false while the slot has a confirmed booking.

**Level 2: API key and validation.** One key, compared in constant time, guards every endpoint. `slot_id`, `name` and `email` must be non-empty strings; `name` and `email` are trimmed and `email` is stored in lower case. Unknown slot gives `404`; a slot that has already started (checked with the database clock) gives `400`.

**Level 3: no double booking, even at the same instant.** A *partial unique index* — `UNIQUE (slot_id) WHERE status = 'confirmed'` — lets the database guarantee one confirmed booking per slot. Concurrent inserts race on the index; one commits and the rest get a unique violation, which becomes `409`. Cancelling sets `status = 'cancelled'`, which takes the row out of the index and frees the slot. The test suite fires 30 simultaneous requests at one slot and expects exactly one `201`.

**Level 4: idempotent retries and pagination.** With an `Idempotency-Key` header the request takes a Postgres advisory lock on that key, so concurrent retries queue instead of racing. The final status and body are stored with a SHA-256 hash of the (canonicalised) request body. A repeat with the same body gets the stored response — same status and same booking `id` — and never inserts again. The same key with a different body gets `422`. Bookings are paginated by an opaque cursor built from a monotonically increasing sequence number, so pages never skip or repeat even as new bookings arrive. `limit` must be 1–50 (default 10), anything else is `400`. The last page has `next_cursor: null`.

**Level 5: rate limiting.** Each email gets at most 5 booking attempts per sliding 60 seconds, failed attempts included. Attempts are recorded in Postgres (so the limit holds across serverless instances) under a per-email advisory lock (so a burst can't sneak past the count). The 6th attempt gets `429` with `Retry-After` set to the whole seconds until the oldest attempt leaves the window. Idempotent replays aren't counted as new attempts, and other emails aren't affected.

## Project layout

```
api/index.js      Vercel function entry (all routes are rewritten here)
lib/app.js        Router, validation and booking logic
lib/db.js         Postgres pool and schema (created automatically on first request)
web/index.html    The web page (the API key is injected at request time, never committed)
server.js         Run locally as a normal Node server
scripts/seed.js   Load demo slots
test/test.js      End-to-end tests for all five levels
```

## Run locally

```bash
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/clinic
export API_KEY=choose-a-key
npm start                      # http://localhost:3000 (page) and /api (API)
API_KEY=$API_KEY npm test      # runs every level's checks (wipes data via /reset)
```

## Deploy (Vercel + Neon)

1. Import the repo into Vercel (framework preset: Other).
2. Add a Neon Postgres database from Vercel's Storage tab; it sets `DATABASE_URL`.
3. Add an `API_KEY` environment variable and deploy.
4. Optionally load demo slots: `BASE_URL=https://<deployment>/api API_KEY=... node scripts/seed.js`.

## A note on the key in the web page

The page has to send `X-API-Key`, so whoever opens it can see the key in the page source. It is kept out of the repository and injected by the server from an environment variable. In a real product the browser would authenticate patients instead of holding a shared key; per-email rate limiting limits the damage in the meantime.
