// Local / long-running server: `node server.js` (needs DATABASE_URL and API_KEY).
const http = require("http");
const handler = require("./lib/app");

const port = Number(process.env.PORT || 3000);
http.createServer(handler).listen(port, () => {
  console.log(`Clinic booking API on http://localhost:${port} (API under /api)`);
});
