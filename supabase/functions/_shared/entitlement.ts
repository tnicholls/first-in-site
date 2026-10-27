/**
 * Is a First In account a member, according to Stripe? Until when?
 *
 * The rule is the member bot's (ping-member-bot, first_in_bot/entitlement.py):
 * a subscription that is active or trialing, past_due within 72 hours of its
 * first unpaid period starting, or cancelled during its free trial (until the
 * trial would have ended). Tom's manual grants and bans are applied in the
 * database, by my_account(), not here.
 *
 * The bot re-reads Stripe every 5 minutes, so it can ask "is it active right
 * now?". The web app reads Stripe less often (at login, on "Check again" and
 * every 6 hours), so it stores a time instead: how long this subscription keeps
 * the account a member even if Stripe moves on before the next read. An active
 * subscription renews at its period end, and if that payment fails the 72-hour
 * grace starts then, so it lasts until period end + grace, unless a cancellation
 * comes first. tests/entitlement-vectors.json, made from the bot's own function,
 * checks the two agree.
 */

export const PAST_DUE_GRACE_MS = 72 * 60 * 60 * 1000;

export type Reason = "trial" | "subscription" | "grace" | "cancelled_in_trial";

export interface Subscription {
  id: string;
  customerId: string;
  status: string;
  created: Date | null;
  priceIds: string[]; // the items' prices
  periodStart: Date | null; // earliest item current_period_start
  periodEnd: Date | null; // latest item current_period_end
  trialEnd: Date | null;
  cancelAt: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Start of the first unpaid period while past_due: see pastDueSince(). */
  pastDueSince: Date | null;
}

export interface Membership {
  until: Date;
  reason: Reason;
  subscription: Subscription;
}

/** When a scheduled cancellation ends the subscription, if one is scheduled. */
export function scheduledEnd(sub: Subscription): Date | null {
  if (sub.cancelAt) return sub.cancelAt;
  return sub.cancelAtPeriodEnd ? sub.periodEnd : null;
}

/** How long one subscription keeps the account a member, or null if it doesn't. */
export function subscriptionUntil(
  sub: Subscription,
  graceMs = PAST_DUE_GRACE_MS,
): { until: Date; reason: Reason } | null {
  const ends = scheduledEnd(sub);
  switch (sub.status) {
    case "trialing": {
      const trialEnd = sub.trialEnd ?? sub.periodEnd;
      if (!trialEnd) return null;
      // The first charge happens at the trial end; if it fails, the grace runs from then.
      return { until: earlier(plus(trialEnd, graceMs), ends), reason: "trial" };
    }
    case "active": {
      if (!sub.periodEnd) return null;
      return { until: earlier(plus(sub.periodEnd, graceMs), ends), reason: "subscription" };
    }
    case "past_due": {
      const anchor = sub.pastDueSince ?? sub.periodStart ?? sub.periodEnd;
      if (!anchor) return null;
      return { until: earlier(plus(anchor, graceMs), ends), reason: "grace" };
    }
    case "canceled":
      // Cancelled during the free trial: they keep it until the trial would have ended.
      return sub.trialEnd ? { until: sub.trialEnd, reason: "cancelled_in_trial" } : null;
    default:
      return null; // unpaid, incomplete, incomplete_expired, paused
  }
}

/** Only subscriptions to First In's own prices count (STRIPE_PRICE_IDS). */
export function forPrices(subs: Subscription[], priceIds: ReadonlySet<string>): Subscription[] {
  return subs.filter((s) => s.priceIds.some((id) => priceIds.has(id)));
}

/**
 * First In gives one free trial per person, and only to someone who never had a
 * subscription: the member bot checks that before its checkout. A Payment Link,
 * or a second Telegram account paying with the same email, can't, so it's
 * enforced here. A trial on anything but the account's first subscription
 * doesn't count, and nor does the grace after that trial's first charge fails.
 * Once it's paid for (active, or a later renewal past due) it counts as usual.
 */
export function freeRide(sub: Subscription, first: Subscription | null): boolean {
  if (sub === first || !sub.trialEnd) return false;
  if (sub.status === "trialing" || sub.status === "canceled") return true;
  if (sub.status === "past_due") {
    const anchor = sub.pastDueSince ?? sub.periodStart;
    return !anchor || anchor <= sub.trialEnd;
  }
  return false;
}

/** The account's oldest subscription: the only one whose trial counts. */
export function firstSubscription(subs: Subscription[]): Subscription | null {
  let first: Subscription | null = null;
  for (const s of subs) {
    const t = s.created?.getTime() ?? Infinity;
    const f = first ? (first.created?.getTime() ?? Infinity) : Infinity;
    if (!first || t < f || (t === f && s.id < first.id)) first = s;
  }
  return first;
}

/**
 * The subscription that keeps the account a member longest. The time may be in
 * the past. Pass only First In's subscriptions (forPrices).
 */
export function membership(subs: Subscription[], graceMs = PAST_DUE_GRACE_MS): Membership | null {
  const first = firstSubscription(subs);
  let best: Membership | null = null;
  for (const subscription of subs) {
    if (freeRide(subscription, first)) continue;
    const m = subscriptionUntil(subscription, graceMs);
    if (m && (!best || m.until > best.until)) best = { ...m, subscription };
  }
  return best;
}

/**
 * The past-due anchor to store with a subscription just read from Stripe. Stripe
 * starts each new period when it creates the renewal invoice, paid or not, so
 * while past_due the period start is when the unpaid period began. If Stripe is
 * set to leave a subscription past_due, it keeps starting new periods, so the
 * first anchor is kept for as long as it stays past_due (as the member bot does).
 */
export function pastDueSince(
  fresh: Pick<Subscription, "status" | "periodStart">,
  stored: { status: string; pastDueSince: Date | null } | undefined,
): Date | null {
  if (fresh.status !== "past_due") return null;
  if (stored?.status === "past_due" && stored.pastDueSince) return stored.pastDueSince;
  return fresh.periodStart;
}

function plus(t: Date, ms: number): Date {
  return new Date(t.getTime() + ms);
}

function earlier(t: Date, other: Date | null): Date {
  return other && other < t ? other : t;
}
