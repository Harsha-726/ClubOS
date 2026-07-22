// Sends real email for reminders, announcements, and payment confirmations —
// without this, "notifications" only ever show up if someone happens to open
// the app, which defeats the point of a deadline-tracking tool.
//
// Uses Resend (resend.com). Zero setup to try: their resend.dev sender works
// out of the box with no domain verification, but ONLY delivers to the email
// address the API key's account itself is registered with — everyone else's
// email will silently fail until you verify your own sending domain in the
// Resend dashboard. Fine for solo testing; see README before other people's
// reminders need to actually arrive.

const config = require('../config');

let client = null;
if (config.email.enabled) {
  const { Resend } = require('resend');
  client = new Resend(config.email.apiKey);
}

function wrapHtml(clubName, heading, message) {
  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <div style="font-size:12px;letter-spacing:0.05em;color:#9CA3AF;text-transform:uppercase;margin-bottom:8px;">${escapeHtml(clubName)}</div>
      <div style="font-size:16px;color:#18181B;line-height:1.6;">${escapeHtml(heading)}</div>
      ${message ? `<div style="font-size:14px;color:#6B7280;margin-top:10px;line-height:1.6;">${escapeHtml(message)}</div>` : ''}
      <div style="font-size:11px;color:#9CA3AF;margin-top:28px;border-top:1px solid #E8E8EC;padding-top:14px;">Sent by Club OS. Open the app to see everything at a glance.</div>
    </div>`;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Fire-and-forget by design — a slow or failed email should never hold up
// the actual action (marking a payment, posting an announcement, etc.).
// Callers don't await this; failures are logged, not thrown.
async function sendNotificationEmail(toEmail, clubName, heading, message) {
  if (!client) return { sent: false, reason: 'not_configured' };
  if (!toEmail || toEmail === '—') return { sent: false, reason: 'no_email' };
  try {
    const { data, error } = await client.emails.send({
      from: config.email.from,
      to: [toEmail],
      subject: `${clubName}: ${heading.length > 70 ? heading.slice(0, 67) + '...' : heading}`,
      html: wrapHtml(clubName, heading, message)
    });
    if (error) { console.error('[email] Resend rejected the send:', error); return { sent: false, error }; }
    return { sent: true, id: data && data.id };
  } catch (err) {
    console.error('[email] Send failed:', err.message);
    return { sent: false, error: err.message };
  }
}

async function sendFeedbackEmail(toEmail, fromName, fromEmail, clubName, message) {
  if (!client || !toEmail) {
    console.log('[feedback]', { fromName, fromEmail, clubName, message });
    return { sent: false, reason: 'not_configured' };
  }
  try {
    const { error } = await client.emails.send({
      from: config.email.from,
      to: [toEmail],
      subject: `Club OS feedback from ${fromName}`,
      html: wrapHtml('Club OS Feedback', `From ${escapeHtml(fromName)} (${escapeHtml(fromEmail)}) — ${escapeHtml(clubName)}`, message)
    });
    if (error) { console.error('[feedback] Resend rejected the send:', error); return { sent: false, error }; }
    return { sent: true };
  } catch (err) {
    console.error('[feedback] Send failed:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendNotificationEmail, sendFeedbackEmail };
