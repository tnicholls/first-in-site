// POST from pg_cron every 6 hours, with x-cron-secret: re-read every account with a Stripe customer.
// See _shared/http.ts and README "Scheduling the 6-hourly check".
import { handleReconcile } from "../_shared/http.ts";
import { refreshAccount } from "../_shared/refresh.ts";
import { connect, PgStore } from "../_shared/store.ts";
import { Stripe } from "../_shared/stripe.ts";

const env = (name: string) => Deno.env.get(name) ?? "";
const store = new PgStore(connect(env("SUPABASE_DB_URL")));
const stripe = new Stripe(env("STRIPE_API_KEY"));
// First In's own prices: a subscription to anything else in the Stripe account doesn't count.
const priceIds = new Set(env("STRIPE_PRICE_IDS").split(",").map((p) => p.trim()).filter(Boolean));
if (priceIds.size === 0) throw new Error("STRIPE_PRICE_IDS must list First In's Stripe price IDs");

Deno.serve((req) =>
  handleReconcile(req, {
    cronSecret: env("CRON_SECRET"),
    accounts: () => store.accountsToReconcile(),
    refresh: (account) => refreshAccount({ stripe, store, priceIds }, account, { force: true }),
  })
);
