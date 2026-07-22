// The ONE file that reads process.env directly. Every other file in this app
// imports `config` from here instead of touching process.env itself — that
// way there's exactly one place to look when you're adding a key, rotating a
// secret, or checking what's configured.

require('dotenv').config();

function bool(v) { return v === 'true' || v === '1'; }

const config = {
  port: Number(process.env.PORT) || 3000,
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  isProduction: process.env.NODE_ENV === 'production',

  session: {
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me'
  },

  clerk: {
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY || null,
    secretKey: process.env.CLERK_SECRET_KEY || null
  },

  database: {
    url: process.env.DATABASE_URL || null
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || null,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null
  },

  email: {
    apiKey: process.env.RESEND_API_KEY || null,
    // resend.dev works with zero setup for testing — anyone can receive mail
    // from it, but it clearly says "sent via Resend" and can only send to
    // the email the API key's account is registered with until you verify
    // your own domain. Fine for a beta; see README before real users rely on it.
    from: process.env.EMAIL_FROM || 'Club OS <onboarding@resend.dev>'
  },

  feedback: {
    // Where "Send Feedback" in the app actually goes. Falls back to no-op
    // (logs to console, doesn't error) if unset.
    toAddress: process.env.FEEDBACK_EMAIL || null
  }
};

config.clerk.enabled = !!(config.clerk.publishableKey && config.clerk.secretKey);
config.database.enabled = !!config.database.url;
config.stripe.enabled = !!config.stripe.secretKey;
config.email.enabled = !!config.email.apiKey;

if (!config.clerk.enabled) {
  console.warn('[config] Clerk keys are missing — sign-in will not work until CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY are set in .env');
}
if (!config.database.enabled) {
  console.warn('[config] DATABASE_URL is missing — the app cannot start without a Supabase/Postgres connection string in .env');
}
if (!config.email.enabled) {
  console.warn('[config] RESEND_API_KEY is missing — reminders and announcements will only show up in-app, not by email, until it\'s set');
}
if (config.session.secret === 'dev-only-secret-change-me') {
  console.warn('[config] SESSION_SECRET is using the default value — set a real random string in .env before deploying anywhere public');
}

module.exports = config;
