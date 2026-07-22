// Every new club starts genuinely empty — just the person who created it, as
// President with full permissions. No filler roster, no filler deadlines.
// "Load Sample Data" (officer-only, in Reports) is the ONLY way demo content
// ever appears, and it's additive — it never overwrites anything real. It
// can only be used once per club (sampleDataLoaded flag) to avoid silently
// duplicating everything if someone clicks it twice.
//
// ATTENDANCE MODEL: attendance is NOT a fixed array on each member anymore —
// a fixed-length array can never grow, which meant there was no way to ever
// record a new practice date. Instead, attendance works exactly like
// deadlines/completion: `attendanceDates` is the list of recorded dates,
// `attendance` maps dateId -> { memberId: 1 | 0 }. Taking attendance for a
// new date is just adding one more entry to both.

const crypto = require('crypto');

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — easy to read aloud

function generateJoinCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return code;
}

function uid(prefix) { return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 10); }

function emptyClub({ id, name, joinCode, president }) {
  return {
    id,
    name,
    joinCode,
    createdAt: new Date().toISOString(),
    members: [president],
    deadlines: [],
    completion: {},
    rsvp: {},
    announcements: [],
    attendanceDates: [],
    attendance: {},
    permissions: {
      [president.id]: { dashboard: true, members: true, payments: true, deadlines: true, announcements: true, roles: true }
    },
    notifications: {},
    sampleDataLoaded: false
  };
}

// Additive sample content for a brand-new club that wants to see the app in
// action before entering real data. Never touches the person who clicked the button.
function sampleAdditions() {
  const demoMembers = [
    mk('Amara Osei', 'amara.osei@example.com', 'Junior'),
    mk('Leo Chen', 'leo.chen@example.com', 'Senior'),
    mk('Priya Nair', 'priya.nair@example.com', 'Sophomore'),
    mk('Marcus Webb', 'marcus.webb@example.com', 'Freshman'),
    mk('Sofia Delgado', 'sofia.delgado@example.com', 'Junior'),
    mk('Ethan Park', 'ethan.park@example.com', 'Sophomore'),
    mk('Nadia Hassan', 'nadia.hassan@example.com', 'Senior'),
    mk('Tyler Brooks', 'tyler.brooks@example.com', 'Freshman')
  ];
  function mk(name, email, year) {
    return { id: uid('m'), name, email, phone: '—', year, officerRole: null, emergency: '—', clerkUserId: null };
  }

  const today = new Date();
  function daysFromNow(n) { const d = new Date(today); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

  const deadlines = [
    { id: uid('d'), title: 'Equipment Deposit', type: 'fee', amount: 35, dueDate: daysFromNow(-4), ackRequired: false },
    { id: uid('d'), title: 'Spring Dues', type: 'fee', amount: 75, dueDate: daysFromNow(3), ackRequired: false },
    { id: uid('d'), title: 'Regionals Registration', type: 'competition', amount: 40, dueDate: daysFromNow(6), ackRequired: false },
    { id: uid('d'), title: 'State Tournament Waiver', type: 'form', amount: 0, dueDate: daysFromNow(10), ackRequired: true },
    { id: uid('d'), title: 'Fall Kickoff Social', type: 'event', amount: 0, dueDate: daysFromNow(18), ackRequired: false }
  ];

  const announcements = [
    { id: uid('a'), title: 'This is a sample announcement', body: 'Delete this any time from the Announcements page — it\'s just here so you can see what a posted update looks like.', date: new Date().toISOString().slice(0, 10), ackRequired: false, readBy: [] },
    { id: uid('a'), title: 'Sample: acknowledgment required', body: 'This one requires members to actively acknowledge it — useful for anything mandatory, like confirming a roster spot.', date: new Date().toISOString().slice(0, 10), ackRequired: true, readBy: [] }
  ];

  const attendanceDates = [
    { id: uid('t'), date: daysFromNow(-21), label: 'Practice' },
    { id: uid('t'), date: daysFromNow(-14), label: 'Practice' },
    { id: uid('t'), date: daysFromNow(-7), label: 'Practice' }
  ];

  return { demoMembers, deadlines, announcements, attendanceDates };
}

module.exports = { generateJoinCode, uid, emptyClub, sampleAdditions };
