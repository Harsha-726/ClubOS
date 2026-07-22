// One shared connection pool for the whole app — the club data store and the
// session store (connect-pg-simple) both use this same pool instead of each
// opening their own connections.
//
// Uses Supabase's CONNECTION POOLING string (port 6543, PgBouncer in
// "Transaction" mode), not the direct connection (port 5432). This matters:
// serverless/many-short-lived-request environments can exhaust Supabase's
// direct connection limit fast, and the pooler is built for exactly this.
// Get it from Supabase Dashboard → Project Settings → Database → Connection
// Pooling → Connection string (URI).

const { Pool } = require('pg');
const config = require('../config');

if (!config.database.enabled) {
  console.error('[db] DATABASE_URL is not set — see .env.example. The app cannot run without it.');
}

const pool = new Pool({
  connectionString: config.database.url,
  ssl: { rejectUnauthorized: false } // required for Supabase's hosted Postgres
});

pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle Postgres client:', err.message);
});

// Creates the clubs table if it doesn't exist yet. Safe to run on every boot.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clubs (
      id TEXT PRIMARY KEY,
      join_code TEXT UNIQUE NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // connect-pg-simple also needs a "session" table — it creates this itself
  // via createTableIfMissing, so nothing to do for that one here.
}

module.exports = { pool, init };
