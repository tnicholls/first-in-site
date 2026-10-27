/**
 * Re-read one account's membership from Stripe and store it.
 *
 * The account's Stripe customers are the ones whose email matches its confirmed
 * login email (found fresh every time), plus any linked before: a link stays
 * by customer ID if the email later changes in Stripe. A customer already
 * linked to another account is never moved.
 */
import { forPrices, membership, pastDueSince, PAST_DUE_GRACE_MS, type Subscription } from "./entitlement.ts";
import { type StripeApi, type StripeCustomer, StripeError } from "./stripe.ts";
import { type Account, CustomerTaken, type Store } from "./store.ts";

/** Ask Stripe at most this often per account, however often the app asks (failures included). */
export const COOLDOWN_MS = 30_000;

export type RefreshResult =
  | { checked: true }
  | { checked: false; reason: "cooldown" | "stripe_unavailable" | "email_not_confirmed" };

export interface RefreshDeps {
  stripe: StripeApi;
  store: Store;
  /** First In's Stripe prices (STRIPE_PRICE_IDS): subscriptions to anything else don't count. */
  priceIds: ReadonlySet<string>;
  now?: () => Date;
  log?: (message: string) => void;
  graceMs?: number;
}

export async function refreshAccount(
  deps: RefreshDeps,
  account: Account,
  { force = false }: { force?: boolean } = {},
): Promise<RefreshResult> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? console.log;
  if (!(await deps.store.claimAttempt(account.userId, now, force ? 0 : COOLDOWN_MS))) {
    return { checked: false, reason: "cooldown" };
  }
  try {
    const found = await deps.stripe.customersByEmail(account.email);
    const linked = await deps.store.linkedCustomers(account.userId);
    const owners = await deps.store.customerOwners(found.map((c) => c.id));
    const customers = new Map<string, StripeCustomer>(linked.map((id) => [id, { id, email: null }]));
    for (const c of found) {
      const owner = owners.get(c.id);
      if (owner === undefined || owner === account.userId) {
        customers.set(c.id, c);
      } else {
        log(`refresh ${account.userId}: ${c.id} is linked to another account; left alone`);
      }
    }
    const subs: Subscription[] = [];
    for (const id of customers.keys()) subs.push(...await deps.stripe.subscriptions(id));
    const stored = await deps.store.storedSubscriptions([...customers.keys()]);
    const withAnchors = forPrices(subs.filter((s) => customers.has(s.customerId)), deps.priceIds)
      .map((s) => ({ ...s, pastDueSince: pastDueSince(s, stored.get(s.id)) }));
    const m = membership(withAnchors, deps.graceMs ?? PAST_DUE_GRACE_MS);
    await deps.store.saveCheck(account.userId, [...customers.values()], withAnchors, m, now);
    return { checked: true };
  } catch (e) {
    if (e instanceof StripeError) {
      log(`refresh ${account.userId}: ${e.message}`);
      await deps.store.saveFailure(account.userId, e.message, now);
      return { checked: false, reason: "stripe_unavailable" };
    }
    if (e instanceof CustomerTaken) log(`refresh ${account.userId}: ${e.message}`);
    throw e;
  }
}
