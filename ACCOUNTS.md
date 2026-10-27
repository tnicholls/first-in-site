# First In accounts

The account side of the website: log in, free or member, and later each member's own instant alerts. The page is [app/](app/) (served at `firstinshop.co.uk/app/` once this is on `main`); its backend is [supabase/](supabase/) (the database and two functions, run by Supabase, not GitHub Pages). **Nothing here buys, reserves or touches anything on FIXR**, and nothing sends FIXR a single request.

The plan is the personal-alerts design, `docs/DESIGN.md` in the private `kolb-manu/automated-purchase-bot` repo. Its "Owner decisions, 2026-10-25" (no AI, nothing paid, open sign-up with a free tier) override the rest of it.

## What's built (2026-10-25): the login system

- **Log in or make an account** with an email and a 6-digit code (Supabase Auth). Anyone can make one; a new account is **free**. There are no passwords: the database drops any that Supabase is given, so nobody can claim an email by setting one.
- **Free or member**, worked out from Stripe (test mode) for the account's confirmed email, with the same rule as the member bot. Tom can also give someone membership by hand, or ban them.
- **The page** ([app/](app/)): email, code, then the account page, which looks different for free accounts and members. Free accounts see the member features locked and a subscribe box; members see their membership and the paid features (marked "coming next" until they're built).
- **Two Supabase Edge Functions**: `entitlement-refresh` (the page calls it after login and on "Check again") and `entitlement-reconcile` (every 6 hours, so renewals and lapses show up without anyone opening the page).
- **Optional bot check** on "Send me a code" (Cloudflare Turnstile, free), off until you add a site key.
- **Tests**: 73 Deno tests (the rule, Stripe, the functions, the database code against a real Postgres, the page) and 4 SQL test files (sign-up, who can read what, membership, passwords).
- **Reviewed**: an independent security review found 11 problems (two serious: a password set on someone's email before they first log in, and Stripe's word search matching a longer email). All are fixed, each with a test.

Not built yet: picking nights, the alerts themselves, push notifications, the billing page. See "Known gaps".

## How free or member is decided

An account is a **member** while it isn't banned and either Tom's grant or the time worked out from Stripe is still ahead. From Stripe, a subscription counts like this (the member bot's rule, kept in step by [tests/entitlement-vectors.json](tests/entitlement-vectors.json), which is generated from the bot's own function):

| Stripe says | Member until |
|---|---|
| `trialing` | the trial end + 72 h (if the first charge fails there's 72 h of grace); exactly the trial end if it's cancelled |
| `active` | the period end + 72 h (it renews then); exactly the cancellation if one is scheduled |
| `past_due` | 72 h after the first unpaid period began (kept even if Stripe starts new periods) |
| `canceled` during the free trial | the trial end |
| anything else (`unpaid`, `incomplete`, `paused`, ...) | not a member |

Two more rules the web adds, because the bot's checkout enforces them and a Stripe Payment Link can't:

- **Only First In's prices count** (`STRIPE_PRICE_IDS`), not anything else sold through the same Stripe account.
- **One free trial per person**: only the account's first subscription's trial counts. A later trial (a second checkout, or another Telegram account paying with the same email) only counts once it's paid for.

The web page asks Stripe at login, on "Check again" (at most every 30 seconds per account, failures included) and every 6 hours, so it stores that time rather than asking Stripe every time. Stripe customers are matched by the login email, exactly (ignoring case), which Supabase has confirmed with the code; a customer, once matched, stays with that account.

**Tom's controls**, in the Supabase dashboard (Table Editor > `entitlements`): `manual_grant_until` (member until then) and `banned` (never a member). The functions never change these two.

## What's where

| Path | What |
|---|---|
| `app/` | The page: `index.html`, `app.css` (on top of the site's `assets/css/style.css`), `app.js`, `mount.js`, `controller.js`, `ui.js`, and `vendor/` (supabase-js 2.118.0, MIT, checked against npm's hash) |
| `supabase/migrations/` | The tables, the access rules (the browser can only call `my_account()`), the sign-up trigger and the password drop |
| `supabase/functions/` | The two functions; `_shared/entitlement.ts` is the rule, `_shared/stripe.ts` the read-only Stripe client |
| `supabase/config.toml` | Local Supabase settings: email codes, 10-minute expiry, the code-only email template |
| `tools/demo.html` | The real page on a pretend backend (`demo.js`, `fake-client.js`), for trying it with no setup |
| `tools/serve.py` | The local web server: the whole site, except `supabase/`, `tests/` and dotfiles |
| `tools/test_db.py`, `tools/make_vectors.py` | The tests' runner, and the rule's test cases from the member bot |
| `tests/` | The SQL tests, the page tests, and the shared rule vectors |

## Try it now (no setup)

```bash
python3 tools/serve.py
```

Open <http://127.0.0.1:8000/tools/demo.html>. The code is always `123456`, and the part of the email before the `@` picks the account: `member@`, `trial@`, `cancelled@`, `grace@`, `grant@`, `lapsed@`, `banned@`, `stripedown@`, `ratelimited@`, or anything else for a free account.

## Tests

One-time setup ([Deno](https://deno.com) and [uv](https://docs.astral.sh/uv/)):

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python pgserver
```

Then:

```bash
.venv/bin/python tools/test_db.py --deno
```

It starts a throwaway Postgres (from the `pgserver` package, so no Docker), loads a small stand-in for Supabase's own tables and roles, applies the migrations, runs the SQL tests, then every Deno test, then deletes it all.

After any change to the member bot's rule (`ping-member-bot/first_in_bot/entitlement.py`), regenerate the shared test cases:

```bash
~/ping-member-bot/.venv/bin/python tools/make_vectors.py ~/ping-member-bot > tests/entitlement-vectors.json
```

## A real login, all on this Mac

Needs **Docker Desktop** (free for personal and small-business use), plus the Supabase CLI and Deno.

1. Start Docker Desktop, then `supabase start`. The first time it downloads Supabase (a few GB). It prints the API URL and the anon key.
2. `cp supabase/functions/.env.example supabase/functions/.env` and fill it in: `STRIPE_PRICE_IDS` is the member bot's `STRIPE_PRICE_ID`. The Stripe key is a **new restricted test key** with only Customers: Read and Subscriptions: Read (Stripe dashboard, test mode, Developers > API keys > Create restricted key). Never a live key: the functions refuse those.
3. `supabase functions serve` in a second Terminal window.
4. `cp app/config.example.js app/config.local.js` (git ignores it) and paste the anon key from `supabase status`.
5. `python3 tools/serve.py`, open <http://127.0.0.1:8000/app/> and log in. The code arrives in the local mailbox at <http://127.0.0.1:54324>, not a real inbox.
6. To be a member: subscribe through the test bot and type the **same email** at Stripe's checkout, then press "Check again". Or set `manual_grant_until` in the local dashboard (<http://127.0.0.1:54323>, Table Editor > `entitlements`).

## Going online later (all free)

1. A free Supabase project (London region). Then `supabase login`, `supabase link --project-ref <ref>`, `supabase db push`, `supabase functions deploy --use-api entitlement-refresh entitlement-reconcile` (`--use-api` builds them on Supabase's side, so this step needs no Docker), and `supabase secrets set --env-file supabase/functions/.env` (with `ALLOWED_ORIGINS=https://firstinshop.co.uk`).
2. Set Auth the same as `supabase/config.toml`, which only applies locally. Either run `supabase config push` after changing `site_url` there to `https://firstinshop.co.uk`, or set it in the dashboard: Authentication > Sign In / Providers > Email: **Confirm email on**, OTP length 6, expiry 600 seconds; and the two email templates (Confirm signup, Magic link) to `supabase/templates/code.html`. **Confirm email must stay on**: Supabase can't switch off password sign-ups, so without it anyone could sign up with someone else's email and get their membership.
3. Email for friends: Supabase's built-in email only reaches your own team. A free sender such as Resend (3,000 emails a month, 100 a day) needs a few DNS records on `firstinshop.co.uk`; then put its SMTP details under Authentication > Emails > SMTP.
4. Turn on the bot check, so nobody can script "Send me a code" and use up the day's emails: a free Cloudflare Turnstile widget for `firstinshop.co.uk`. Its site key goes in `config.js` (`turnstileSiteKey`), its secret key in Supabase (Authentication > Attack Protection > CAPTCHA, provider Turnstile). Try it in Safari or Chrome first: the code path is tested, but I couldn't see the widget itself working (the browser I test in doesn't load Cloudflare's frame).
5. Schedule the 6-hourly check (below).
6. Publish the page:
   1. Add `app/config.js`: a copy of `config.example.js` with the hosted project's URL and anon key, which are meant to be public. Commit it.
   2. In `app/index.html`'s security policy, replace `https://*.supabase.co` with the project's own URL.
   3. Run `python3 tools/check_site.py`.
   4. Merge to `main`, which is what publishes it.

   **GitHub Pages publishes everything on `main`**, so `supabase/`, `tests/` and `tools/` can be fetched from the site too. Nothing in them is secret. Delete `tools/demo.html` first if you don't want a pretend login page on the domain.

### Scheduling the 6-hourly check

Turn on the `pg_cron` and `pg_net` extensions (Database > Extensions), then run this once in the SQL editor, with your project URL and the `CRON_SECRET` from your `.env`:

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<CRON_SECRET>', 'cron_secret');
select cron.schedule('entitlement-reconcile', '17 */6 * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/entitlement-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000)
$$);
```

## Known gaps

- **The paid features themselves** (picking nights, the alerts, push) are next. The member page marks them "coming next".
- **Someone who pays on the web isn't let into the paid Telegram channel.** The member bot matches people by Telegram ID, not email.
- **Several emails, several trials.** The web only counts each email's first trial, so a shared Payment Link can still give one person a trial per email address (with a card each time). Keep `upgradeUrl` empty (people go through the bot) except for a friends pilot, or build a checkout function that also checks the card.
- **Payment disputes**: the member bot takes access away during a dispute; the web page doesn't look at disputes yet. Ban by hand if needed.
- **Several subscriptions at once**: the web takes whichever lasts longest; the bot picks one by status. In rare mixes (a cancelled trial next to a newer unpaid one) the web is a little more generous.
- **After paying**, the friend presses "Check again" (or waits up to 6 hours). There's no Stripe webhook yet (design Phase 3).
- Someone who types an email and never enters the code leaves an empty, unconfirmed free account behind. It can't be taken over (no passwords, and it's never looked up in Stripe), and could be cleaned up later.
- The 6-hourly check re-reads only accounts with a Stripe customer, least recently checked first, and stops after about 100 seconds (Supabase ends a function at 150). Anyone left waits for the next run. Before live mode, check Stripe's API limits: the bot's 5-minute sync and this check share them.

## Rules

- **Stripe test mode only**, like the member bot. The code refuses live keys.
- **No secrets in git.** `supabase/functions/.env` and `app/config.local.js` are ignored; `*.example` files show what goes in them. `app/config.js` (the live one) only ever holds the public URL and anon key.
- **Never "no card needed".** Before any Stripe link the page states the price, the trial, the first-charge date, that a card is needed, and that you can cancel.
- **Nothing touches FIXR.**
