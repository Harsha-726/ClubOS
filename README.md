# Club OS

Roster, deadlines, dues, and announcements for a student club — officer tools
and a member view, with real sign-in via Clerk, real dues collection via
Stripe, and real persistent storage via Supabase Postgres. Multi-tenant: any
number of clubs can run on one deployment, each completely isolated with its
own invite code. Built to run on Vercel, Render, Railway, or anywhere else
that runs Node — nothing here depends on a local filesystem.

## How the pieces fit together

- **Clerk** owns identity — your password, email verification, all of it.
  Our server never sees a password.
- **Our app** owns club membership — which club(s) you belong to, and your
  role in each.
- **Supabase Postgres** is where all of that actually lives — one row per
  club, one row per active session. No local files anywhere, which is what
  makes this safe to run on serverless platforms.

## 1. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine to start).
2. In your project: **Project Settings → Database → Connection Pooling**.
3. Copy the **Connection string (URI)** — it looks like:
   ```
   postgresql://postgres.xxxxxxxx:[YOUR-PASSWORD]@aws-0-region.pooler.supabase.com:6543/postgres
   ```
4. Put it in `.env` as `DATABASE_URL` (replace `[YOUR-PASSWORD]` with your
   actual database password, set when you created the project).

**Use the pooler string (port 6543), not the direct connection (port 5432).**
The pooler (PgBouncer, in "Transaction" mode) is built for many short-lived
connections — exactly what a web app under real traffic looks like. The
direct connection has a low connection limit that a handful of concurrent
users can exhaust fast, especially on serverless hosts where every request
can spin up a new connection.

You don't need to create any tables by hand — `server.js` creates the
`clubs` table on boot if it's missing, and the session store creates its own
table the same way.

## 2. Install & run

```bash
cd club-os
npm install
```

A `.env` is already included with the Clerk keys you provided earlier — you
just need to add `DATABASE_URL` from step 1. Then:

```bash
npm start
```

You should see:
```
Club OS running at http://localhost:3000
Clerk: configured
Database: configured
Stripe: not configured yet (optional)
```

If it prints `Database: NOT configured` or exits with a connection error,
double check `DATABASE_URL` — copy-paste issues with the password (special
characters need URL-encoding) are the most common cause.

Open `http://localhost:3000`. Clerk's Sign In / Sign Up screen comes first,
then our "Create a Club" / "Join a Club" screen.

## 3. Turn on Stripe (real dues collection)

1. Create a free account at dashboard.stripe.com if you don't have one.
2. Grab your **test** secret key from dashboard.stripe.com/apikeys (starts `sk_test_`).
3. Put it in `.env` as `STRIPE_SECRET_KEY`.
4. For webhook testing locally, install the [Stripe CLI](https://docs.stripe.com/stripe-cli),
   then run:
   ```bash
   stripe listen --forward-to localhost:3000/api/payments/webhook
   ```
   It prints a `whsec_...` value — put that in `.env` as `STRIPE_WEBHOOK_SECRET`,
   then restart `npm start`.
5. Test a payment with card `4242 4242 4242 4242`, any future expiry, any CVC.
6. Going live: switch to **live** keys on your production server, and add a
   webhook endpoint in Stripe Dashboard → Developers → Webhooks pointing at
   `https://yourdomain.com/api/payments/webhook`.

Until `STRIPE_SECRET_KEY` is set, officers can still mark dues paid manually.

## 4. Turn on real email (Resend)

This is the one that matters most for the app to actually do its job — without it, a "reminder" only exists if someone happens to open the app. With it, reminders, new announcements, payment confirmations, and officer promotions all send a real email too.

1. Sign up free at [resend.com](https://resend.com), grab an API key.
2. Put it in `.env` as `RESEND_API_KEY`.
3. Leave `EMAIL_FROM` as the default (`Club OS <onboarding@resend.dev>`) to start — it works with zero setup, **but Resend only lets that test sender deliver to the email address your own Resend account is registered with.** Everyone else's email will silently fail to send (it won't error the app, it just won't arrive).
4. Before other real people need email to actually work: verify your own domain in the Resend dashboard, then set `EMAIL_FROM` to something like `Club OS <hello@yourdomain.com>`.

Without `RESEND_API_KEY` set at all, the app runs fine — everything just stays in-app-only, same as before.

## 5. Feedback, rate limiting, and legal pages

- **"Send Feedback"** is in the sidebar (and on the pre-club screen, for testers who get stuck before joining anything) — emails whatever's typed to `FEEDBACK_EMAIL` in `.env`. Leave it blank and feedback just logs to the server console instead of erroring.
- **Rate limiting** is on by default: a general ceiling across the whole API, plus a tighter one specifically on club-join attempts (guards against scripted guessing of invite codes).
- **`/terms.html` and `/privacy.html`** are real, linked from the sign-in screen — but written as honest beta-period drafts, not lawyer-reviewed final terms. Get real legal review before this is used by clubs you don't personally run, especially given school clubs may involve minors.

## 6. Project layout

```
club-os/
  config.js                 — the ONLY file that reads process.env
  app.js                     — the Express app itself: all routes, middleware, Stripe webhook
  server.js                   — entrypoint for Render/Railway/local (`npm start` runs this)
  api/index.js                — entrypoint for Vercel (serverless — see "Deploying to Vercel")
  vercel.json                  — tells Vercel to route everything through api/index.js
  middleware/auth.js         — Clerk-based route guards (requireLogin, requirePermission)
  data/
    db.js                     — shared Postgres pool + table creation
    club-factory.js            — creates blank clubs + optional sample content
    store.js                    — club data reads/writes (loadClub, saveClub, etc.)
    email.js                    — Resend wrapper (notification + feedback emails)
  public/
    index.html                   — the whole frontend (Clerk SDK + our API calls)
    terms.html / privacy.html      — beta-period legal pages, linked from sign-in
  .env / .env.example
  package.json
```

## 7. Deploying

This app has no local filesystem dependency anymore, so it's genuinely
portable — Vercel, Render, Railway, Fly.io, a VPS, all work the same way:

1. Set every variable from `.env` as an environment variable on the host —
   especially `DATABASE_URL`, both Clerk keys, and `APP_URL` (your real
   public URL — Clerk and Stripe both use it for redirects).
2. In the Clerk Dashboard, add your production domain under **Domains**
   once you deploy, or sign-in redirects will fail.
3. Serve over HTTPS (required for Stripe's live mode, Clerk, and for
   cookies to behave well in production).

### Deploying to Vercel specifically

The app has two entrypoints that share the exact same application code
(`app.js`) — only how they boot differs:

- **`server.js`** — for Render/Railway/Fly/a VPS/local dev. Runs a normal
  long-lived process, calls `app.listen()`. This is what `npm start` runs.
- **`api/index.js`** + **`vercel.json`** — for Vercel. Wraps the same app as
  a serverless function instead of a persistent server, since that's the
  model Vercel expects. You don't run this manually — Vercel's build system
  picks it up automatically because of `vercel.json`.

To deploy: push to GitHub, import the repo in Vercel, and add the same
environment variables as everywhere else (`DATABASE_URL`, `CLERK_PUBLISHABLE_KEY`,
`CLERK_SECRET_KEY`, `SESSION_SECRET`, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`
if using Stripe, and `APP_URL` set to your actual `*.vercel.app` URL — or your
custom domain — since Stripe and session cookies both depend on it being
correct). Vercel handles the rest; no build command changes needed.

One Vercel-specific quirk worth knowing: because there's no single "boot"
moment, the database-readiness check in `api/index.js` runs lazily on the
first request to a given serverless instance rather than once before any
traffic arrives (server.js's model). It's cached per warm instance after
that, and `CREATE TABLE IF NOT EXISTS` is safe to re-run if two cold starts
ever race each other, so this doesn't cause real problems — just don't be
surprised if the very first request after a deploy is a bit slower than the
rest while that check runs.

**Same honesty note as the rest of this build**: I wrote this against Vercel's
documented `@vercel/node` builder pattern but couldn't deploy it myself to
confirm end-to-end (no internet access in my sandbox). If the first deploy
doesn't route correctly, paste me the exact error from Vercel's deployment
log and I'll fix the specific thing rather than re-guess the whole setup.

## 8. What changed in the latest audit pass

A few real gaps got fixed after a full code audit:

- **Attendance actually works now.** It used to be a fixed 5-slot array set
  once at signup and frozen forever. Now it's a real dated record — Members
  → **Attendance** page lets an officer take attendance for any date, and it
  can grow indefinitely.
- **Everything is editable, not just add/delete.** Members, deadlines, and
  announcements all have an **Edit** button now — previously fixing a typo
  meant deleting and recreating, which for a deadline also wiped everyone's
  payment status.
- **Grade/year is fixed properly.** You can set it when creating a club, and
  change it any time from Profile — it used to be permanently stuck.
- **Leave a club** (Profile page) and **delete a club entirely** (Reports,
  President only) both exist now — previously joining was one-way.
- Smaller fixes: duplicate-email protection when officers add members,
  negative deadline amounts get rejected, and "Load Sample Data" can't be
  clicked twice to silently duplicate everything.

## 9. No filler data

A brand-new club starts completely empty except for whoever created it. The
demo roster only appears if an officer clicks **Load Sample Data** in
Reports — additive, never touches the real account, removable any time
(**Erase All Club Data**, same page).

## 10. Scaling beyond this

- **Finding a club by join code** is now an indexed Postgres lookup
  (`join_code` has a `UNIQUE` constraint), so this scales fine well beyond
  what the old file-scan approach could handle.
- **`/api/my-clubs`** still pulls every club's full JSON to check membership
  in JavaScript. Fine at hundreds of clubs; past that, a real `members` table
  with a `clerk_user_id` column and an index would replace the in-JS filter.
  `data/store.js` is still the only file that would need to change.
- **Concurrent officer edits within one club**: last write wins — the whole
  club is one JSON blob updated as a unit. Fine at club scale; a busy club
  with many officers editing simultaneously would want per-field updates
  instead.

## 11. Before this handles real money or clubs you don't personally run

Good for free testing right now. Not yet good for charging money or onboarding
clubs you don't control. In roughly the order I'd tackle them:

1. **Stripe Connect.** Right now every club's dues flow into one Stripe
   account — fine while it's your own club, a real liability the moment
   it's someone else's money. This is the one that actually blocks charging
   people or onboarding outside clubs, more than anything else on this list.
2. **Real error monitoring** (Sentry or similar) — right now, a crash at 2am
   is invisible until someone tells you.
3. **A real Terms of Service / Privacy Policy review** — what's here is
   honest, not legally reviewed. Matters more once real money or non-friends
   are involved.
4. **Automated backups** — confirm what Supabase's plan you're on actually
   gives you, don't assume.
5. **Some kind of test suite** — there isn't one. Fine solo; risky once
   other people depend on this not breaking.
6. If you do want to charge for it: Stripe Billing (subscriptions) is a
   separate integration from the dues-collection Checkout flow already
   built — happy to scope that out whenever you're ready to think about
   pricing.

