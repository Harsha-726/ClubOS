// The ONE file that reads process.env directly. Every other file in this app
// imports `config` from here instead of touching process.env itself.

require('dotenv').config();

function bool(v) { return v === 'true' || v === '1'; }

const isProduction = process.env.NODE_ENV === 'production';

const config = {
  port: Number(process.env.PORT) || 3000,
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  isProduction,

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
    from: process.env.EMAIL_FROM || 'Club OS <onboarding@resend.dev>'
  },

  feedback: {
    toAddress: process.env.FEEDBACK_EMAIL || null
  }
};

// Computed feature flags
config.clerk.enabled = !!(config.clerk.publishableKey && config.clerk.secretKey);
config.database.enabled = !!config.database.url;
config.stripe.enabled = !!config.stripe.secretKey;
config.email.enabled = !!config.email.apiKey;

// --- VALIDATION & WARNINGS ---

// 1. HARD BLOCK: Database is mandatory. Halt startup immediately with a clear error.
if (!config.database.enabled) {
  console.error('[config FATAL] DATABASE_URL is missing in .env!');
  process.exit(1);
}

// 2. HARD BLOCK: Prevent insecure session secrets in Production
if (isProduction && config.session.secret === 'dev-only-secret-change-me') {
  console.error('[config FATAL] SESSION_SECRET must be set to a secure string in production!');
  process.exit(1);
}

// 3. OPTIONAL WARNINGS: Features that degrade gracefully if keys are missing
if (!config.clerk.enabled) {
  console.warn('[config] Clerk keys are missing — authentication routes will be disabled.');
}

if (!config.email.enabled) {
  console.warn('[config] RESEND_API_KEY is missing — emails will log to console instead of sending.');
}

if (!isProduction && config.session.secret === 'dev-only-secret-change-me') {
  console.warn('[config] SESSION_SECRET is using the fallback dev key.');
}

module.exports = config;
