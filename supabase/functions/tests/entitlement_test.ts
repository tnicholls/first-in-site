import { assertEquals } from "jsr:@std/assert@1";
import {
  firstSubscription,
  forPrices,
  freeRide,
  membership,
  PAST_DUE_GRACE_MS,
  pastDueSince,
  type Subscription,
  subscriptionUntil,
} from "../_shared/entitlement.ts";
import { at, DAY, PRICES, sub, T0 } from "./fakes.ts";

const vectors = JSON.parse(
  await Deno.readTextFile(new URL("../../../tests/entitlement-vectors.json", import.meta.url)),
);
const date = (v: string | null) => (v ? new Date(v) : null);

Deno.test("agrees with the member bot on every vector", () => {
  assertEquals(vectors.grace_hours * 60 * 60 * 1000, PAST_DUE_GRACE_MS);
  let checks = 0;
  for (const c of vectors.cases) {
    const s: Subscription = {
      id: "sub_vector",
      customerId: "cus_vector",
      status: c.subscription.status,
      created: null,
      priceIds: ["price_firstin"],
      periodStart: date(c.subscription.period_start),
      periodEnd: date(c.subscription.period_end),
      trialEnd: date(c.subscription.trial_end),
      cancelAt: date(c.subscription.cancel_at),
      cancelAtPeriodEnd: c.subscription.cancel_at_period_end,
      pastDueSince: date(c.subscription.past_due_since),
    };
    const m = subscriptionUntil(s);
    for (const check of c.checks) {
      assertEquals(m !== null && new Date(check.at) < m.until, check.member, `${c.name}, at ${check.at}`);
      checks++;
    }
  }
  assertEquals(checks > 40, true, "the vectors file has its checks");
});

Deno.test("a trial lasts to its end plus the grace, unless it's cancelled", () => {
  const trial = sub({ status: "trialing", trialEnd: at(14 * DAY), periodEnd: at(14 * DAY) });
  assertEquals(subscriptionUntil(trial), { until: at(14 * DAY + PAST_DUE_GRACE_MS), reason: "trial" });
  assertEquals(subscriptionUntil({ ...trial, cancelAtPeriodEnd: true })?.until, at(14 * DAY));
  assertEquals(subscriptionUntil({ ...trial, cancelAt: at(3 * DAY) })?.until, at(3 * DAY));
});

Deno.test("a subscription lasts to its period end plus the grace, or its cancellation", () => {
  const paying = sub();
  assertEquals(subscriptionUntil(paying), { until: at(30 * DAY + PAST_DUE_GRACE_MS), reason: "subscription" });
  assertEquals(subscriptionUntil({ ...paying, cancelAtPeriodEnd: true })?.until, at(30 * DAY));
  // cancel_at inside the grace after the period: that's when it ends
  assertEquals(subscriptionUntil({ ...paying, cancelAt: at(31 * DAY) })?.until, at(31 * DAY));
  // cancel_at far ahead: the renewal at the period end comes first
  assertEquals(subscriptionUntil({ ...paying, cancelAt: at(90 * DAY) })?.until, at(30 * DAY + PAST_DUE_GRACE_MS));
});

Deno.test("past due: the grace runs from the stored anchor, else the period start", () => {
  const pastDue = sub({ status: "past_due", periodStart: T0 });
  assertEquals(subscriptionUntil(pastDue), { until: at(PAST_DUE_GRACE_MS), reason: "grace" });
  assertEquals(subscriptionUntil({ ...pastDue, pastDueSince: at(-30 * DAY) })?.until, at(-30 * DAY + PAST_DUE_GRACE_MS));
});

Deno.test("statuses that never count", () => {
  for (const status of ["unpaid", "incomplete", "incomplete_expired", "paused", "", "something_new"]) {
    assertEquals(subscriptionUntil(sub({ status })), null, status);
  }
  assertEquals(subscriptionUntil(sub({ status: "canceled", trialEnd: null })), null);
  assertEquals(subscriptionUntil(sub({ status: "active", periodEnd: null })), null);
});

Deno.test("several subscriptions: the one that lasts longest wins, even if it has passed", () => {
  const old = sub({ id: "sub_old", status: "canceled", trialEnd: at(-5 * DAY) });
  const trial = sub({ id: "sub_trial", status: "trialing", trialEnd: at(10 * DAY), periodEnd: at(10 * DAY) });
  const paying = sub({ id: "sub_pay" });
  assertEquals(membership([old, trial, paying])?.subscription.id, "sub_pay");
  assertEquals(membership([old])?.until, at(-5 * DAY));
  assertEquals(membership([sub({ status: "unpaid" })]), null);
  assertEquals(membership([]), null);
});

Deno.test("the past-due anchor is kept while it stays past due", () => {
  const fresh = { status: "past_due", periodStart: T0 };
  assertEquals(pastDueSince(fresh, undefined), T0);
  assertEquals(pastDueSince(fresh, { status: "past_due", pastDueSince: at(-30 * DAY) }), at(-30 * DAY));
  assertEquals(pastDueSince(fresh, { status: "active", pastDueSince: null }), T0);
  assertEquals(pastDueSince({ status: "active", periodStart: T0 }, { status: "past_due", pastDueSince: T0 }), null);
});

Deno.test("one free trial per person: only the first subscription's trial counts", () => {
  const first = sub({ id: "sub_1", created: at(-40 * DAY), status: "canceled", trialEnd: at(-26 * DAY) });
  const again = sub({ id: "sub_2", created: at(-DAY), status: "trialing", trialEnd: at(13 * DAY), periodEnd: at(13 * DAY) });
  assertEquals(firstSubscription([again, first])?.id, "sub_1");
  assertEquals(freeRide(again, first), true);
  assertEquals(freeRide(first, first), false);
  assertEquals(membership([first, again])?.subscription.id, "sub_1", "the second trial is ignored");
  // its first charge failing doesn't count either...
  const failedFirstCharge = { ...again, status: "past_due", periodStart: at(13 * DAY) };
  assertEquals(freeRide({ ...failedFirstCharge, periodStart: again.trialEnd }, first), true);
  // ...but once it's paid, it does, and so does a later renewal's grace
  assertEquals(freeRide({ ...again, status: "active" }, first), false);
  assertEquals(freeRide({ ...again, status: "past_due", periodStart: at(43 * DAY) }, first), false);
  // a later subscription with no trial always counts
  assertEquals(freeRide(sub({ id: "sub_3", created: at(-DAY), trialEnd: null }), first), false);
});

Deno.test("only First In's prices count", () => {
  const mine = sub({ id: "sub_mine" });
  const theirs = sub({ id: "sub_theirs", priceIds: ["price_other"] });
  const mixed = sub({ id: "sub_mixed", priceIds: ["price_other", "price_firstin"] });
  assertEquals(forPrices([mine, theirs, mixed], PRICES).map((s) => s.id), ["sub_mine", "sub_mixed"]);
});
