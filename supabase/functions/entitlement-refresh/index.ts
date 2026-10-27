// POST from the app, with the user's access token: re-read their membership from Stripe.
// See _shared/http.ts. Secrets: supabase/functions/.env.example.
import { authUserFetcher, handleRefresh } from "../_shared/http.ts";
import { refreshAccount } from "../_shared/refresh.ts";
import { connect, PgStore } from "../_shared/store.ts";
import { Stripe } from "../_shared/stripe.ts";

const env = (name: string) => Deno.env.get(name) ?? "";
const store = new PgStore(connect(env("SUPABASE_DB_URL")));
// Throws at start-up, so the logs say why, if the key isn't a test-mode one.
const stripe = new Stripe(env("STRIPE_API_KEY"));
// First In's own prices: a subscription to anything else in the Stripe account doesn't count.
const priceIds = new Set(env("STRIPE_PRICE_IDS").split(",").map((p) => p.trim()).filter(Boolean));
if (priceIds.size === 0) throw new Error("STRIPE_PRICE_IDS must list First In's Stripe price IDs");
const allowedOrigins = env("ALLOWED_ORIGINS").split(",").map((o) => o.trim()).filter(Boolean);
const getUser = authUserFetcher(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"));

Deno.serve((req) =>
  handleRefresh(req, {
    getUser,
    refresh: (account) => refreshAccount({ stripe, store, priceIds }, account),
    allowedOrigins,
  })
);
