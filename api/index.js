// Entrypoint for Vercel specifically. Vercel doesn't run a long-lived process
// — every request can hit a fresh (or reused "warm") serverless invocation,
// so there's no single "boot once" moment like there is in server.js.
//
// This does the same database readiness check server.js does, just adapted
// to that model: the first request to a cold container runs it, and the
// resulting promise is cached in module scope so any other requests that
// reuse the same warm container skip straight past it. CREATE TABLE IF NOT
// EXISTS is cheap and idempotent either way, so even a rare double-run from
// two cold starts racing each other is harmless.

const db = require('../data/db');
const app = require('../app');

let dbReady = null;
function ensureDb() {
  if (!dbReady) dbReady = db.init();
  return dbReady;
}

module.exports = async (req, res) => {
  try {
    await ensureDb();
  } catch (err) {
    console.error('[vercel] Database not ready:', err.message);
    res.status(500).json({ error: 'Database is not configured correctly. Check DATABASE_URL.' });
    return;
  }
  app(req, res);
};
