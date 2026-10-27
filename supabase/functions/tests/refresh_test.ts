import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { COOLDOWN_MS, refreshAccount } from "../_shared/refresh.ts";
import { StripeError } from "../_shared/stripe.ts";
import { CustomerTaken } from "../_shared/store.ts";
import { PAST_DUE_GRACE_MS } from "../_shared/entitlement.ts";
import { at, DAY, FakeStore, FakeStripe, PRICES, sub, T0 } from "./fakes.ts";

const ME = { userId: "u-me", email: "me@example.com" };
const quiet = () => {};

function setup() {
  const stripe = new FakeStripe();
  const store = new FakeStore();
  const logs: string[] = [];
  const deps = { stripe, store, priceIds: PRICES, now: () => T0, log: (m: string) => logs.push(m) };
  return { stripe, store, deps, logs };
}

Deno.test("finds the customers by email, reads their subscriptions, saves the result", async () => {
  const { stripe, store, deps } = setup();
  stripe.customers.set(ME.email, [{ id: "cus_1", email: ME.email }]);
  stripe.subs.set("cus_1", [sub()]);
  assertEquals(await refreshAccount(deps, ME), { checked: true });
  const saved = store.saved[0];
  assertEquals(saved.customers.map((c) => c.id), ["cus_1"]);
  assertEquals(saved.m?.until, at(30 * DAY + PAST_DUE_GRACE_MS));
  assertEquals(saved.m?.reason, "subscription");
  assertEquals(store.owners.get("cus_1"), ME.userId);
});

Deno.test("no customer for the email: saved as free", async () => {
  const { store, deps } = setup();
  assertEquals(await refreshAccount(deps, ME), { checked: true });
  assertEquals(store.saved[0].m, null);
  assertEquals(store.saved[0].customers, []);
});

Deno.test("a customer linked to someone else is left alone", async () => {
  const { stripe, store, deps, logs } = setup();
  store.owners.set("cus_theirs", "u-other");
  stripe.customers.set(ME.email, [{ id: "cus_theirs", email: ME.email }]);
  stripe.subs.set("cus_theirs", [sub({ customerId: "cus_theirs" })]);
  await refreshAccount(deps, ME);
  assertEquals(store.saved[0].customers, []);
  assertEquals(store.saved[0].m, null);
  assertEquals(stripe.calls.includes("subscriptions:cus_theirs"), false);
  assertEquals(logs.some((l) => l.includes("linked to another account")), true);
});

Deno.test("a customer linked earlier still counts after its email changes in Stripe", async () => {
  const { stripe, store, deps } = setup();
  store.owners.set("cus_old", ME.userId);
  stripe.subs.set("cus_old", [sub({ customerId: "cus_old" })]);
  await refreshAccount(deps, ME);
  assertEquals(store.saved[0].customers, [{ id: "cus_old", email: null }]);
  assertEquals(store.saved[0].m?.reason, "subscription");
});

Deno.test("Stripe is asked at most every 30 seconds, unless forced", async () => {
  const { stripe, store, deps } = setup();
  store.attempts.set(ME.userId, new Date(T0.getTime() - COOLDOWN_MS + 1000));
  assertEquals(await refreshAccount(deps, ME), { checked: false, reason: "cooldown" });
  assertEquals(stripe.calls, []);
  assertEquals(await refreshAccount(deps, ME, { force: true }), { checked: true });
  store.attempts.set(ME.userId, new Date(T0.getTime() - COOLDOWN_MS));
  assertEquals(await refreshAccount(deps, ME), { checked: true });
});

Deno.test("Stripe down: the failure is noted, the last result kept, and the 30 s still applies", async () => {
  const { stripe, store, deps } = setup();
  stripe.failWith = new StripeError("Stripe /customers: TimeoutError");
  assertEquals(await refreshAccount(deps, ME), { checked: false, reason: "stripe_unavailable" });
  assertEquals(store.saved, []);
  assertEquals(store.failures, ["u-me: Stripe /customers: TimeoutError"]);
  stripe.calls = [];
  assertEquals(await refreshAccount(deps, ME), { checked: false, reason: "cooldown" });
  assertEquals(stripe.calls, [], "a failure doesn't let the next request straight through");
});

Deno.test("only First In's prices count", async () => {
  const { stripe, store, deps } = setup();
  stripe.customers.set(ME.email, [{ id: "cus_1", email: ME.email }]);
  stripe.subs.set("cus_1", [sub({ id: "sub_other", priceIds: ["price_someone_else"] })]);
  await refreshAccount(deps, ME);
  assertEquals(store.saved[0].m, null);
  assertEquals(store.saved[0].subs, [], "other products' subscriptions aren't stored either");
});

Deno.test("a second free trial doesn't count; paying for it does", async () => {
  const { stripe, store, deps } = setup();
  const firstTrial = sub({
    id: "sub_a", status: "canceled", created: at(-90 * DAY), trialEnd: at(-76 * DAY), periodEnd: at(-76 * DAY),
  });
  const secondTrial = sub({
    id: "sub_b", status: "trialing", created: at(-DAY), trialEnd: at(13 * DAY), periodEnd: at(13 * DAY),
  });
  stripe.customers.set(ME.email, [{ id: "cus_1", email: ME.email }]);
  stripe.subs.set("cus_1", [firstTrial, secondTrial]);
  await refreshAccount(deps, ME);
  assertEquals(store.saved[0].m?.until, at(-76 * DAY), "only the first trial's (past) end counts");
  stripe.subs.set("cus_1", [firstTrial, { ...secondTrial, status: "active", periodStart: at(13 * DAY), periodEnd: at(43 * DAY) }]);
  await refreshAccount(deps, ME, { force: true });
  assertEquals(store.saved[1].m?.reason, "subscription");
});

Deno.test("the stored past-due anchor is carried into the new reading", async () => {
  const { stripe, store, deps } = setup();
  stripe.customers.set(ME.email, [{ id: "cus_1", email: ME.email }]);
  stripe.subs.set("cus_1", [sub({ status: "past_due", periodStart: T0 })]);
  store.owners.set("cus_1", ME.userId);
  store.stored.set("sub_1", { status: "past_due", pastDueSince: at(-30 * DAY) });
  await refreshAccount(deps, ME);
  assertEquals(store.saved[0].subs[0].pastDueSince, at(-30 * DAY));
  assertEquals(store.saved[0].m?.until, at(-30 * DAY + PAST_DUE_GRACE_MS));
});

Deno.test("a customer taken while saving is an error, not a silent skip", async () => {
  const { stripe, store } = setup();
  stripe.customers.set(ME.email, [{ id: "cus_race", email: ME.email }]);
  store.customerOwners = () => Promise.resolve(new Map()); // looked free...
  store.owners.set("cus_race", "u-other"); // ...but someone else got it first
  await assertRejects(() => refreshAccount({ stripe, store, priceIds: PRICES, now: () => T0, log: quiet }, ME), CustomerTaken);
});
