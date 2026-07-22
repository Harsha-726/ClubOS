// Multi-tenant storage, now backed by Postgres (Supabase) instead of local
// files. Every club is one row: id, join_code (indexed, for fast invite-code
// lookups), and data (the same JSON shape the rest of the app already works
// with — members, deadlines, completion, rsvp, announcements, permissions,
// notifications). Every function here is now async — callers must await it.
//
// listClubs() still pulls every club's full data to search inside it (for
// "which clubs does this Clerk user belong to"). Fine at hundreds of clubs;
// past that, a real `members` table with a `clerk_user_id` column and an
// index would replace the in-JS filtering. This module is still the only
// place that knows how club data is stored — nothing else needs to change
// if you make that upgrade later.

const { pool } = require('./db');

async function loadClub(clubId) {
  const { rows } = await pool.query('SELECT data FROM clubs WHERE id = $1', [clubId]);
  return rows[0] ? rows[0].data : null;
}

async function saveClub(clubId, data) {
  await pool.query(
    `INSERT INTO clubs (id, join_code, data, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET join_code = $2, data = $3, updated_at = now()`,
    [clubId, data.joinCode, data]
  );
}

async function deleteClub(clubId) {
  await pool.query('DELETE FROM clubs WHERE id = $1', [clubId]);
}

async function listClubs() {
  const { rows } = await pool.query('SELECT data FROM clubs');
  return rows.map(r => r.data);
}

async function findClubByJoinCode(code) {
  if (!code) return null;
  const norm = String(code).trim().toUpperCase();
  const { rows } = await pool.query('SELECT data FROM clubs WHERE join_code = $1', [norm]);
  return rows[0] ? rows[0].data : null;
}

module.exports = { loadClub, saveClub, deleteClub, listClubs, findClubByJoinCode };
