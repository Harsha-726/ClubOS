const config = require('./config');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');
const path = require('path');
const { clerkMiddleware, getAuth, clerkClient } = require('@clerk/express');

const db = require('./data/db');
const store = require('./data/store');
const { generateJoinCode, uid, emptyClub, sampleAdditions } = require('./data/club-factory');
const { requireClerkAuth, requireLogin, requirePermission } = require('./middleware/auth');
const { sendNotificationEmail, sendFeedbackEmail } = require('./data/email');

const app = express();

// ── Stripe (only turns on if you've added a key to .env) ───────────────────
let stripe = null;
if (config.stripe.enabled) stripe = require('stripe')(config.stripe.secretKey);

// ── Helpers ──────────────────────────────────────────────────────────────
function publicMember(m) { const { ...rest } = m; return rest; } // nothing sensitive lives on a member anymore — Clerk holds credentials
function officerPerms(club, id) { return club.permissions[id] || { dashboard: true, members: false, payments: false, deadlines: false, announcements: false, roles: false }; }
function pushNotification(club, memberId, text, deadlineId) {
  if (!club.notifications[memberId]) club.notifications[memberId] = [];
  club.notifications[memberId].unshift({ id: uid('n'), text, date: new Date().toISOString(), read: false, deadlineId: deadlineId || null });
  // Fire-and-forget: email should never slow down or fail the actual action.
  const member = club.members.find(m => m.id === memberId);
  if (member) {
    sendNotificationEmail(member.email, club.name, text).catch(err => console.error('[email] notification send failed:', err.message));
  }
}
function attendancePct(club, memberId) {
  const total = club.attendanceDates.length;
  if (!total) return 0;
  const present = club.attendanceDates.reduce((sum, d) => sum + ((club.attendance[d.id] && club.attendance[d.id][memberId]) ? 1 : 0), 0);
  return Math.round((present / total) * 100);
}
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}
async function makeUniqueJoinCode() {
  let code, existing;
  do {
    code = generateJoinCode();
    existing = await store.findClubByJoinCode(code);
  } while (existing);
  return code;
}
async function persist(req) { await store.saveClub(req.club.id, req.club); }
function sendCsv(res, rows, filename) {
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}
// Clerk's own user object shape varies slightly by SDK version — this pulls
// a display name and primary email out of it defensively.
async function clerkProfile(clerkUserId) {
  const user = await clerkClient.users.getUser(clerkUserId);
  const primary = user.emailAddresses.find(e => e.id === user.primaryEmailAddressId) || user.emailAddresses[0];
  const email = primary ? primary.emailAddress : '—';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || email;
  return { name, email };
}
// Wraps an async route handler so a thrown/rejected error becomes a clean
// 500 response instead of an unhandled rejection that hangs the request.
function safe(handler) {
  return (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(next); };
}

// ── Stripe webhook — registered before express.json() so we keep the raw body
//    Stripe's signature check needs. Not tied to any session — the clubId
//    travels in the Checkout session's metadata instead. ────────────────────
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), safe(async (req, res) => {
  if (!stripe) return res.status(400).send('Stripe not configured');
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = config.stripe.webhookSecret
      ? stripe.webhooks.constructEvent(req.body, sig, config.stripe.webhookSecret)
      : JSON.parse(req.body); // local testing without the CLI's webhook secret
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { clubId, deadlineId, memberId } = session.metadata || {};
    const club = clubId ? await store.loadClub(clubId) : null;
    if (club && deadlineId && memberId && club.completion[deadlineId]) {
      club.completion[deadlineId][memberId] = 1;
      const deadline = club.deadlines.find(d => d.id === deadlineId);
      pushNotification(club, memberId, `Payment confirmed for "${deadline ? deadline.title : 'your dues'}". Thanks!`, deadlineId);
      await store.saveClub(clubId, club);
    }
  }
  res.json({ received: true });
}));

app.use(express.json());

// Clerk reads its own signed cookies/headers to establish req.auth — this
// must run before any route that calls getAuth(req).
app.use(clerkMiddleware({ secretKey: config.clerk.secretKey, publishableKey: config.clerk.publishableKey }));

// Our own lightweight session — holds ONLY which club is "active" for this
// browser. Never used for identity; requireLogin always re-verifies against
// the actual Clerk user on every request. Stored in the same Postgres
// database as club data, so it survives restarts/redeploys/multiple instances
// (a serverless-safe session store, unlike the default in-memory one).
app.use(session({
  store: new pgSession({ pool: db.pool, tableName: 'session', createTableIfMissing: true }),
  secret: config.session.secret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 30 }
}));

// Loads the active club fresh from the database on every request, if one is selected.
app.use(safe(async (req, res, next) => {
  if (req.session && req.session.clubId) {
    req.club = await store.loadClub(req.session.clubId);
    if (!req.club) req.session.clubId = null;
  } else {
    req.club = null;
  }
  next();
}));

app.use(express.static(path.join(__dirname, 'public')));

// ── RATE LIMITING ────────────────────────────────────────────────────────
// General ceiling on the whole API — generous enough that normal use (even
// with the 7s polling the frontend does) never comes close, but stops a
// runaway script or an abusive client from hammering the server/database.
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down and try again in a moment.' }
}));

// Join codes are 6 characters — not brute-forceable in a reasonable window
// by a human, but worth specifically slowing down scripted guessing since
// it's the one endpoint that checks a secret against a large search space.
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many join attempts — wait a few minutes and try again.' }
});

// ── PUBLIC CONFIG (safe to expose — publishable keys are meant to be public) ─
app.get('/api/config', (req, res) => {
  res.json({ clerkPublishableKey: config.clerk.publishableKey, clerkEnabled: config.clerk.enabled });
});

// ── ME (graceful — never errors, just reports what's true) ─────────────────
app.get('/api/me', (req, res) => {
  const { userId } = getAuth(req);
  if (!userId) return res.json({ signedIn: false, club: null, member: null });
  if (!req.club) return res.json({ signedIn: true, club: null, member: null });
  const member = req.club.members.find(m => m.clerkUserId === userId);
  if (!member) return res.json({ signedIn: true, club: null, member: null });
  res.json({
    signedIn: true,
    club: { id: req.club.id, name: req.club.name, joinCode: req.club.joinCode },
    member: publicMember(member),
    permissions: member.officerRole ? officerPerms(req.club, member.id) : null
  });
});

// ── CLUB SELECTION (Clerk tells us WHO, this tells us WHICH CLUB) ──────────
app.get('/api/my-clubs', requireClerkAuth, safe(async (req, res) => {
  const all = await store.listClubs();
  const mine = all
    .filter(c => c.members.some(m => m.clerkUserId === req.clerkUserId))
    .map(c => ({ id: c.id, name: c.name }));
  res.json({ clubs: mine });
}));

app.post('/api/clubs', requireClerkAuth, safe(async (req, res) => {
  const { clubName, year } = req.body || {};
  if (!clubName || !clubName.trim()) return res.status(400).json({ error: 'Club name is required.' });
  const { name, email } = await clerkProfile(req.clerkUserId);
  const id = uid('c');
  const joinCode = await makeUniqueJoinCode();
  const president = { id: uid('m'), clerkUserId: req.clerkUserId, name, email, phone: '—', year: year || '—', officerRole: 'President', emergency: '—' };
  const club = emptyClub({ id, name: clubName.trim(), joinCode, president });
  await store.saveClub(id, club);
  req.session.clubId = id;
  res.json({ club: { id, name: club.name, joinCode } });
}));

app.post('/api/clubs/join', joinLimiter, requireClerkAuth, safe(async (req, res) => {
  const { joinCode } = req.body || {};
  if (!joinCode) return res.status(400).json({ error: 'Club code is required.' });
  const club = await store.findClubByJoinCode(joinCode);
  if (!club) return res.status(404).json({ error: 'No club found with that code. Double check it with an officer.' });

  if (club.members.some(m => m.clerkUserId === req.clerkUserId)) {
    req.session.clubId = club.id;
    return res.json({ club: { id: club.id, name: club.name, joinCode: club.joinCode }, alreadyMember: true });
  }

  const { name, email } = await clerkProfile(req.clerkUserId);

  // If an officer already added this person by email (a "placeholder" with no
  // clerkUserId yet), claim that existing seat instead of creating a duplicate.
  const placeholder = club.members.find(m => !m.clerkUserId && m.email.toLowerCase() === email.toLowerCase());
  if (placeholder) {
    placeholder.clerkUserId = req.clerkUserId;
  } else {
    const member = { id: uid('m'), clerkUserId: req.clerkUserId, name, email, phone: '—', year: 'Freshman', officerRole: null, emergency: '—' };
    club.members.push(member);
    club.deadlines.forEach(d => { if (club.completion[d.id]) club.completion[d.id][member.id] = 0; });
  }
  await store.saveClub(club.id, club);
  req.session.clubId = club.id;
  res.json({ club: { id: club.id, name: club.name, joinCode: club.joinCode } });
}));

app.post('/api/clubs/select', requireClerkAuth, safe(async (req, res) => {
  const { clubId } = req.body || {};
  const club = await store.loadClub(clubId);
  if (!club || !club.members.some(m => m.clerkUserId === req.clerkUserId)) {
    return res.status(403).json({ error: 'You are not a member of that club.' });
  }
  req.session.clubId = club.id;
  res.json({ club: { id: club.id, name: club.name, joinCode: club.joinCode } });
}));

app.post('/api/session/clear-club', (req, res) => {
  if (req.session) req.session.clubId = null;
  res.json({ ok: true });
});

app.post('/api/clubs/leave', requireClerkAuth, safe(async (req, res) => {
  if (!req.club) return res.status(400).json({ error: 'No club selected.' });
  const member = req.club.members.find(m => m.clerkUserId === req.clerkUserId);
  if (!member) return res.status(403).json({ error: 'You are not a member of this club.' });

  const otherOfficers = req.club.members.some(m => m.id !== member.id && m.officerRole);
  if (member.officerRole && !otherOfficers) {
    return res.status(400).json({ error: 'You\'re the only officer — promote someone else first, or delete the club instead of leaving it.' });
  }

  req.club.members = req.club.members.filter(m => m.id !== member.id);
  delete req.club.permissions[member.id];
  delete req.club.notifications[member.id];
  Object.keys(req.club.completion).forEach(dId => { delete req.club.completion[dId][member.id]; });
  Object.keys(req.club.rsvp).forEach(dId => { delete req.club.rsvp[dId][member.id]; });
  Object.keys(req.club.attendance).forEach(tId => { delete req.club.attendance[tId][member.id]; });
  await store.saveClub(req.club.id, req.club);
  req.session.clubId = null;
  res.json({ ok: true });
}));

// ── STATE ────────────────────────────────────────────────────────────────
app.get('/api/state', requireLogin, (req, res) => {
  res.json({
    club: { id: req.club.id, name: req.club.name, joinCode: req.club.joinCode },
    members: req.club.members.map(publicMember),
    deadlines: req.club.deadlines,
    completion: req.club.completion,
    rsvp: req.club.rsvp,
    announcements: req.club.announcements,
    attendanceDates: req.club.attendanceDates,
    attendance: req.club.attendance,
    permissions: req.club.permissions,
    myNotifications: req.club.notifications[req.member.id] || [],
    stripeEnabled: !!stripe
  });
});

// ── MEMBERS ──────────────────────────────────────────────────────────────
app.post('/api/members', requirePermission('members'), safe(async (req, res) => {
  const { name, email, phone, year } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (email && !isValidEmail(email)) return res.status(400).json({ error: 'That email address doesn\'t look right.' });
  if (email && req.club.members.some(m => m.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'Someone with that email is already on the roster.' });
  }
  const member = { id: uid('m'), clerkUserId: null, name, email: email || '—', phone: phone || '—', year: year || 'Freshman', officerRole: null, emergency: '—' };
  req.club.members.push(member);
  req.club.deadlines.forEach(d => { if (req.club.completion[d.id]) req.club.completion[d.id][member.id] = 0; });
  await persist(req);
  res.json({ member: publicMember(member) });
}));

app.patch('/api/members/:id', requirePermission('members'), safe(async (req, res) => {
  const member = req.club.members.find(m => m.id === req.params.id);
  if (!member) return res.status(404).json({ error: 'Not found' });
  const { name, email, phone, year } = req.body || {};
  if (name && !name.trim()) return res.status(400).json({ error: 'Name can\'t be blank.' });
  if (email && !isValidEmail(email)) return res.status(400).json({ error: 'That email address doesn\'t look right.' });
  if (email && req.club.members.some(m => m.id !== member.id && m.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'Someone else on the roster already has that email.' });
  }
  if (name) member.name = name.trim();
  if (email) member.email = email;
  if (phone) member.phone = phone;
  if (year) member.year = year;
  await persist(req);
  res.json({ member: publicMember(member) });
}));

app.delete('/api/members/:id', requirePermission('members'), safe(async (req, res) => {
  const member = req.club.members.find(m => m.id === req.params.id);
  if (!member) return res.status(404).json({ error: 'Not found' });
  if (member.officerRole) return res.status(400).json({ error: 'Remove their officer role first.' });
  req.club.members = req.club.members.filter(m => m.id !== req.params.id);
  delete req.club.notifications[member.id];
  Object.keys(req.club.completion).forEach(dId => { delete req.club.completion[dId][member.id]; });
  Object.keys(req.club.rsvp).forEach(dId => { delete req.club.rsvp[dId][member.id]; });
  Object.keys(req.club.attendance).forEach(tId => { delete req.club.attendance[tId][member.id]; });
  await persist(req);
  res.json({ ok: true });
}));

app.post('/api/members/:id/remind', requirePermission('payments'), safe(async (req, res) => {
  const member = req.club.members.find(m => m.id === req.params.id);
  const deadline = req.club.deadlines.find(d => d.id === req.body.deadlineId);
  if (!member || !deadline) return res.status(404).json({ error: 'Not found' });
  pushNotification(req.club, member.id, `Nudge from an officer: don't forget "${deadline.title}".`, deadline.id);
  await persist(req);
  res.json({ ok: true });
}));

// ── DEADLINES ────────────────────────────────────────────────────────────
app.post('/api/deadlines', requirePermission('deadlines'), safe(async (req, res) => {
  const { title, type, amount, dueDate, ackRequired } = req.body || {};
  if (!title || !dueDate) return res.status(400).json({ error: 'Title and due date are required.' });
  const id = uid('d');
  const deadline = { id, title, type: type || 'fee', amount: (type === 'event' || type === 'form') ? 0 : Math.max(0, Number(amount || 0)), dueDate, ackRequired: !!ackRequired };
  req.club.deadlines.push(deadline);
  if (deadline.type !== 'event') {
    const map = {}; req.club.members.forEach(m => { map[m.id] = 0; });
    req.club.completion[id] = map;
  } else { req.club.rsvp[id] = {}; }
  await persist(req);
  res.json({ deadline });
}));

app.patch('/api/deadlines/:id', requirePermission('deadlines'), safe(async (req, res) => {
  const deadline = req.club.deadlines.find(d => d.id === req.params.id);
  if (!deadline) return res.status(404).json({ error: 'Not found' });
  const { title, amount, dueDate, ackRequired } = req.body || {};
  // Type is intentionally not editable — changing fee/competition/form/event
  // after creation would leave completion/rsvp data in an inconsistent shape.
  if (title && title.trim()) deadline.title = title.trim();
  if (dueDate) deadline.dueDate = dueDate;
  if (typeof ackRequired === 'boolean') deadline.ackRequired = ackRequired;
  if (amount !== undefined && deadline.type !== 'event' && deadline.type !== 'form') {
    deadline.amount = Math.max(0, Number(amount || 0));
  }
  await persist(req);
  res.json({ deadline });
}));

app.delete('/api/deadlines/:id', requirePermission('deadlines'), safe(async (req, res) => {
  req.club.deadlines = req.club.deadlines.filter(d => d.id !== req.params.id);
  delete req.club.completion[req.params.id];
  delete req.club.rsvp[req.params.id];
  await persist(req);
  res.json({ ok: true });
}));

app.post('/api/deadlines/:id/complete', requirePermission('payments'), safe(async (req, res) => {
  const { memberId, value } = req.body || {};
  if (!req.club.completion[req.params.id]) return res.status(404).json({ error: 'Not found' });
  req.club.completion[req.params.id][memberId] = value ? 1 : 0;
  await persist(req);
  res.json({ ok: true });
}));

app.post('/api/deadlines/:id/remind', requirePermission('payments'), safe(async (req, res) => {
  const deadline = req.club.deadlines.find(d => d.id === req.params.id);
  const map = req.club.completion[req.params.id];
  if (!deadline || !map) return res.status(404).json({ error: 'Not found' });
  const ids = Object.keys(map).filter(id => !map[id]);
  ids.forEach(id => pushNotification(req.club, id, `Reminder: "${deadline.title}" needs your attention.`, deadline.id));
  await persist(req);
  res.json({ remindedCount: ids.length });
}));

app.post('/api/deadlines/:id/rsvp', requireLogin, safe(async (req, res) => {
  const { value } = req.body || {};
  if (!req.club.rsvp[req.params.id]) req.club.rsvp[req.params.id] = {};
  req.club.rsvp[req.params.id][req.member.id] = value;
  await persist(req);
  res.json({ ok: true });
}));
app.post('/api/deadlines/:id/acknowledge', requireLogin, safe(async (req, res) => {
  if (!req.club.completion[req.params.id]) return res.status(404).json({ error: 'Not found' });
  req.club.completion[req.params.id][req.member.id] = 1;
  await persist(req);
  res.json({ ok: true });
}));

// ── ATTENDANCE ───────────────────────────────────────────────────────────
// A "date" is one practice/meeting. Taking attendance for a new date is just
// creating one — there's no fixed limit like the old array-based model had.
app.post('/api/attendance', requirePermission('members'), safe(async (req, res) => {
  const { label, date } = req.body || {};
  if (!date) return res.status(400).json({ error: 'Date is required.' });
  const id = uid('t');
  req.club.attendanceDates.push({ id, date, label: (label && label.trim()) || 'Practice' });
  const map = {}; req.club.members.forEach(m => { map[m.id] = 0; });
  req.club.attendance[id] = map;
  await persist(req);
  res.json({ attendanceDate: { id, date, label: (label && label.trim()) || 'Practice' } });
}));

app.post('/api/attendance/:id/mark', requirePermission('members'), safe(async (req, res) => {
  const { memberId, present } = req.body || {};
  if (!req.club.attendance[req.params.id]) return res.status(404).json({ error: 'Not found' });
  req.club.attendance[req.params.id][memberId] = present ? 1 : 0;
  await persist(req);
  res.json({ ok: true });
}));

app.delete('/api/attendance/:id', requirePermission('members'), safe(async (req, res) => {
  req.club.attendanceDates = req.club.attendanceDates.filter(d => d.id !== req.params.id);
  delete req.club.attendance[req.params.id];
  await persist(req);
  res.json({ ok: true });
}));

// ── PAYMENTS (Stripe) ────────────────────────────────────────────────────
app.post('/api/payments/checkout', requireLogin, safe(async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe is not configured yet. Add STRIPE_SECRET_KEY to your .env file (see README).' });
  const deadline = req.club.deadlines.find(d => d.id === req.body.deadlineId);
  if (!deadline) return res.status(404).json({ error: 'Deadline not found.' });
  if (!deadline.amount || deadline.amount <= 0) return res.status(400).json({ error: 'This item has no fee attached.' });
  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'us_bank_account'],
      line_items: [{
        price_data: { currency: 'usd', product_data: { name: `${req.club.name}: ${deadline.title}` }, unit_amount: Math.round(deadline.amount * 100) },
        quantity: 1
      }],
      success_url: `${config.appUrl}/?paid=success`,
      cancel_url: `${config.appUrl}/?paid=cancelled`,
      client_reference_id: req.member.id,
      metadata: { clubId: req.club.id, deadlineId: deadline.id, memberId: req.member.id }
    });
    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Stripe error: ' + err.message });
  }
}));

// ── ANNOUNCEMENTS ────────────────────────────────────────────────────────
app.post('/api/announcements', requirePermission('announcements'), safe(async (req, res) => {
  const { title, body, ackRequired } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Headline is required.' });
  const announcement = { id: uid('a'), title, body: body || '', date: new Date().toISOString().slice(0, 10), ackRequired: !!ackRequired, readBy: [] };
  req.club.announcements.unshift(announcement);
  req.club.members.forEach(m => { if (m.id !== req.member.id) pushNotification(req.club, m.id, (announcement.ackRequired ? 'Please acknowledge: ' : 'New announcement: ') + announcement.title, null); });
  await persist(req);
  res.json({ announcement });
}));

app.post('/api/announcements/:id/read', requireLogin, safe(async (req, res) => {
  const a = req.club.announcements.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (!a.readBy.includes(req.member.id)) a.readBy.push(req.member.id);
  await persist(req);
  res.json({ ok: true });
}));

app.patch('/api/announcements/:id', requirePermission('announcements'), safe(async (req, res) => {
  const a = req.club.announcements.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const { title, body, ackRequired } = req.body || {};
  if (title && title.trim()) a.title = title.trim();
  if (body !== undefined) a.body = body;
  if (typeof ackRequired === 'boolean') a.ackRequired = ackRequired;
  await persist(req);
  res.json({ announcement: a });
}));

// ── OFFICERS & PERMISSIONS ───────────────────────────────────────────────
app.post('/api/officers/:id/promote', requirePermission('roles'), safe(async (req, res) => {
  const member = req.club.members.find(m => m.id === req.params.id);
  const { title } = req.body || {};
  if (!member || !title) return res.status(400).json({ error: 'Pick a member and enter a title.' });
  member.officerRole = title;
  req.club.permissions[member.id] = { dashboard: true, members: false, payments: false, deadlines: false, announcements: false, roles: false };
  pushNotification(req.club, member.id, `You were promoted to ${title}. You start with Dashboard access only — ask the President to grant more from Officers & Roles.`, null);
  await persist(req);
  res.json({ member: publicMember(member) });
}));

app.post('/api/officers/:id/demote', requirePermission('roles'), safe(async (req, res) => {
  const member = req.club.members.find(m => m.id === req.params.id);
  if (!member) return res.status(404).json({ error: 'Not found' });
  member.officerRole = null;
  delete req.club.permissions[member.id];
  await persist(req);
  res.json({ ok: true });
}));

app.post('/api/officers/:id/permissions', requirePermission('roles'), safe(async (req, res) => {
  const { key, value } = req.body || {};
  const perms = officerPerms(req.club, req.params.id);
  perms[key] = !!value;
  req.club.permissions[req.params.id] = perms;
  await persist(req);
  res.json({ permissions: perms });
}));

// ── NOTIFICATIONS ────────────────────────────────────────────────────────
app.post('/api/notifications/:id/read', requireLogin, safe(async (req, res) => {
  const list = req.club.notifications[req.member.id] || [];
  const n = list.find(x => x.id === req.params.id);
  if (n) n.read = true;
  await persist(req);
  res.json({ ok: true });
}));
app.post('/api/notifications/read-all', requireLogin, safe(async (req, res) => {
  (req.club.notifications[req.member.id] || []).forEach(n => { n.read = true; });
  await persist(req);
  res.json({ ok: true });
}));

// ── PROFILE ──────────────────────────────────────────────────────────────
app.patch('/api/profile', requireLogin, safe(async (req, res) => {
  const { phone, emergency, year } = req.body || {};
  if (phone) req.member.phone = phone;
  if (emergency) req.member.emergency = emergency;
  if (year) req.member.year = year;
  await persist(req);
  res.json({ member: publicMember(req.member) });
}));

// ── FEEDBACK ─────────────────────────────────────────────────────────────
// Deliberately only requires Clerk auth, not club membership — a tester
// stuck on the club-picker screen with no club yet should still be able to
// report that.
const feedbackLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too much feedback at once — try again in a few minutes.' } });
app.post('/api/feedback', feedbackLimiter, requireClerkAuth, safe(async (req, res) => {
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'Say a little about what happened.' });
  const { name, email } = await clerkProfile(req.clerkUserId);
  const clubName = req.club ? req.club.name : '(no club selected)';
  await sendFeedbackEmail(config.feedback.toAddress, name, email, clubName, message.trim());
  res.json({ ok: true });
}));

// ── CLUB SETTINGS (invite code, rename, sample data, wipe) ──────────────
app.patch('/api/club', requirePermission('roles'), safe(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Club name is required.' });
  req.club.name = name.trim();
  await persist(req);
  res.json({ club: { id: req.club.id, name: req.club.name, joinCode: req.club.joinCode } });
}));

app.post('/api/club/regenerate-code', requirePermission('roles'), safe(async (req, res) => {
  req.club.joinCode = await makeUniqueJoinCode();
  await persist(req);
  res.json({ joinCode: req.club.joinCode });
}));

app.post('/api/club/load-sample', requirePermission('roles'), safe(async (req, res) => {
  if (req.club.sampleDataLoaded) {
    return res.status(409).json({ error: 'Sample data was already loaded once. Erase club data first if you want to load it again.' });
  }
  const { demoMembers, deadlines, announcements, attendanceDates } = sampleAdditions();
  demoMembers.forEach(m => req.club.members.push(m));
  deadlines.forEach(d => {
    req.club.deadlines.push(d);
    if (d.type !== 'event') {
      const map = {};
      req.club.members.forEach(m => { map[m.id] = Math.random() > 0.4 ? 1 : 0; });
      req.club.completion[d.id] = map;
    } else {
      req.club.rsvp[d.id] = {};
    }
  });
  attendanceDates.forEach(t => {
    req.club.attendanceDates.push(t);
    const map = {};
    req.club.members.forEach(m => { map[m.id] = Math.random() > 0.3 ? 1 : 0; });
    req.club.attendance[t.id] = map;
  });
  announcements.forEach(a => req.club.announcements.unshift(a));
  req.club.sampleDataLoaded = true;
  await persist(req);
  res.json({ ok: true, added: { members: demoMembers.length, deadlines: deadlines.length, announcements: announcements.length, attendanceDates: attendanceDates.length } });
}));

app.post('/api/club/erase', requirePermission('roles'), safe(async (req, res) => {
  const president = { ...req.member, officerRole: req.member.officerRole || 'President' };
  const fresh = emptyClub({ id: req.club.id, name: req.club.name, joinCode: req.club.joinCode, president });
  await store.saveClub(req.club.id, fresh);
  res.json({ ok: true });
}));

app.post('/api/club/delete', requirePermission('roles'), safe(async (req, res) => {
  if (req.member.officerRole !== 'President') {
    return res.status(403).json({ error: 'Only the President can permanently delete a club.' });
  }
  await store.deleteClub(req.club.id);
  req.session.clubId = null;
  res.json({ ok: true });
}));

// ── EXPORTS ──────────────────────────────────────────────────────────────
app.get('/api/export/members.csv', requirePermission('payments'), (req, res) => {
  const rows = [['Name', 'Email', 'Phone', 'Year', 'Officer Role', 'Attendance %']];
  req.club.members.forEach(m => rows.push([m.name, m.email, m.phone, m.year, m.officerRole || '', attendancePct(req.club, m.id) + '%']));
  sendCsv(res, rows, `${req.club.name.replace(/[^a-z0-9]/gi, '-')}-members.csv`);
});
app.get('/api/export/payments.csv', requirePermission('payments'), (req, res) => {
  const rows = [['Member', 'Deadline', 'Amount', 'Status']];
  req.club.deadlines.filter(d => d.type !== 'event').forEach(d => {
    req.club.members.forEach(m => {
      const done = req.club.completion[d.id] ? req.club.completion[d.id][m.id] : 0;
      rows.push([m.name, d.title, d.amount ? '$' + d.amount : '—', done ? 'Complete' : 'Outstanding']);
    });
  });
  sendCsv(res, rows, `${req.club.name.replace(/[^a-z0-9]/gi, '-')}-payments.csv`);
});

// ── ERROR HANDLER (catches anything safe() passed to next()) ──────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

module.exports = app;
