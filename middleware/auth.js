// ── AUTH ──────────────────────────────────────────────────────────────────
// Identity ("who is this person") is handled entirely by Clerk now — no
// passwords, no bcrypt, nothing to get wrong there. What Clerk does NOT know
// about is "which club, as which member" — that's app-specific, so we track
// it ourselves: a plain (non-Clerk) session cookie holds `clubId`, and every
// protected route re-verifies that the signed-in Clerk user is actually a
// member of that specific club before doing anything. The clubId in the
// cookie is never trusted on its own — it's just "which club to check."
// ────────────────────────────────────────────────────────────────────────────

const { getAuth } = require('@clerk/express');

// Clerk-only check: is *someone* signed in, regardless of club.
function requireClerkAuth(req, res, next) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'Not signed in.' });
  req.clerkUserId = userId;
  next();
}

// Clerk signed in AND that person is a member of the currently-selected club
// (req.club is populated earlier in server.js from the session's clubId).
function requireLogin(req, res, next) {
  requireClerkAuth(req, res, () => {
    if (!req.club) return res.status(409).json({ error: 'No club selected.', code: 'NO_CLUB' });
    const member = req.club.members.find(m => m.clerkUserId === req.clerkUserId);
    if (!member) return res.status(403).json({ error: 'You are not a member of this club.' });
    req.member = member;
    next();
  });
}

// Officer-only route guard. `permKey` is one of:
// dashboard | members | payments | deadlines | announcements | roles
function requirePermission(permKey) {
  return (req, res, next) => {
    requireLogin(req, res, () => {
      if (!req.member.officerRole) return res.status(403).json({ error: 'Officers only.' });
      const perms = req.club.permissions[req.member.id] || {};
      if (!perms[permKey]) return res.status(403).json({ error: 'Your officer role doesn\'t have access to this.' });
      next();
    });
  };
}

module.exports = { requireClerkAuth, requireLogin, requirePermission };
