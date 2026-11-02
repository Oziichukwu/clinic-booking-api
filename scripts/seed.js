// Loads demo slots (next 5 weekdays, two doctors) via POST /reset.
// Usage: BASE_URL=https://your-app.vercel.app/api API_KEY=... node scripts/seed.js
// WARNING: /reset deletes every booking.
const BASE = (process.env.BASE_URL || "http://localhost:3000/api").replace(/\/$/, "");
const KEY = process.env.API_KEY;
if (!KEY) throw new Error("set API_KEY");

const doctors = { "Dr Ade": [9, 10, 11], "Dr Bello": [13, 14, 15] }; // Lagos time (UTC+1)
const slots = [];
const day = new Date();
let n = 1;
while (slots.length < 30) {
  day.setUTCDate(day.getUTCDate() + 1);
  if ([0, 6].includes(day.getUTCDay())) continue;
  for (const [provider, hours] of Object.entries(doctors)) {
    for (const h of hours) {
      const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h - 1));
      const end = new Date(start.getTime() + 30 * 60_000);
      const fmt = (d) => d.toISOString().replace(".000Z", "Z");
      slots.push({ id: `s${n++}`, provider, start: fmt(start), end: fmt(end) });
    }
  }
}

fetch(`${BASE}/reset`, {
  method: "POST",
  headers: { "X-API-Key": KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ slots }),
})
  .then(async (r) => console.log(r.status, await r.text()))
  .catch((e) => { console.error(e); process.exit(1); });
