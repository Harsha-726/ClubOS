// Entrypoint for any host that runs a long-lived Node process — Render,
// Railway, Fly.io, a VPS, or your own machine. `npm start` runs this file.
//
// Deploying to Vercel instead? Use api/index.js — Vercel runs serverless
// functions, not a process that calls app.listen(), so it needs a different
// entrypoint. Both files share the exact same app.js, so nothing about the
// actual application logic differs between the two — only how it boots.

const config = require('./config');
const db = require('./data/db');
const app = require('./app');

(async () => {
  try {
    await db.init();
  } catch (err) {
    console.error('[boot] Could not initialize the database. Check DATABASE_URL in .env.');
    console.error(err.message);
    process.exit(1);
  }
  app.listen(config.port, () => {
    console.log(`Club OS running at ${config.appUrl}`);
    console.log(config.clerk.enabled ? 'Clerk: configured' : 'Clerk: NOT configured — add CLERK keys to .env');
    console.log(config.database.enabled ? 'Database: configured' : 'Database: NOT configured — add DATABASE_URL to .env');
    console.log(config.stripe.enabled ? 'Stripe: configured' : 'Stripe: not configured yet (optional)');
  });
})();
