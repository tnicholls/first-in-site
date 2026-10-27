// The Postgres store against a real database with the migrations applied.
// Runs from tools/test_db.py --deno (which sets TEST_DATABASE_URL); skipped otherwise.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import postgres from "npm:postgres@3.4.9";
import { PAST_DUE_GRACE_MS } from "../_shared/entitlement.ts";
import { refreshAccount } from "../_shared/refresh.ts";
import { CustomerTaken, PgStore } from "../_shared/store.ts";
import { DAY, FakeStripe, PRICES, sub } from "./fakes.ts";

const url = Deno.env.get("TEST_DATABASE_URL");
const ignore = !url;
const quiet = () => {};
const rid = () => crypto.randomUUID().replaceAll("-", "").slice(0, 14);
const inDays = (n: number) => new Date(Date.now() + n * DAY);

async function withDb(fn: (sql: postgres.Sql, store: PgStore, made: string[]) => Promise<void>) {
  const sql = postgres(url!, { max: 1, onnotice: () => {} });
  const made: string[] = [];
  try {
    await fn(sql, new PgStore(sql), made);
  } finally {
    if (made.length) await sql`delete from auth.users where id = any(${sql.array(made)}::uuid[])`;
    await sql.end();
  }
}

async function newUser(sql: postgres.Sql, made: string[], email: string, confirmed = true) {
  const id = crypto.randomUUID();
  await sql`insert into auth.users (id, email, email_confirmed_at)
            values (${id}, ${email}, ${confirmed ? new Date() : null})`;
  made.push(id);
  return id;
}

/** my_account() exactly as the app calls it: as authenticated, with the user's JWT claims. */
async function myAccount(sql: postgres.Sql, userId: string) {
  return await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    await tx`set local role authenticated`;
    const rows = await tx`select * from public.my_account()`;
    return rows[0];
  });
}

Deno.test({ name: "a refresh links the customer and makes the account a member", ignore, fn: () =>
  withDb(async (sql, store, made) => {
    const email = `pay-${rid()}@example.com`;
    const userId = await newUser(sql, made, email);
    const cus = `cus_${rid()}`;
    const stripe = new FakeStripe();
    stripe.customers.set(email, [{ id: cus, email }]);
    const end = inDays(29);
    stripe.subs.set(cus, [sub({ id: `sub_${rid()}`, customerId: cus, periodStart: inDays(-1), periodEnd: end })]);
    assertEquals(await refreshAccount({ stripe, store, priceIds: PRICES, log: quiet }, { userId, email }), { checked: true });
    const me = await myAccount(sql, userId);
    assertEquals([me.email, me.is_member, me.reason, me.status, me.check_failed], [email, true, "subscription", "active", false]);
    assertEquals(me.period_end, end);
    assertEquals(me.member_until, new Date(end.getTime() + PAST_DUE_GRACE_MS));
    assertEquals(await store.linkedCustomers(userId), [cus]);
  }) });

Deno.test({ name: "a free account stays free, and shows as free", ignore, fn: () =>
  withDb(async (sql, store, made) => {
    const email = `free-${rid()}@example.com`;
    const userId = await newUser(sql, made, email);
    await refreshAccount({ stripe: new FakeStripe(), store, priceIds: PRICES, log: quiet }, { userId, email });
    const me = await myAccount(sql, userId);
    assertEquals([me.is_member, me.member_until, me.reason], [false, null, null]);
    assert(me.checked_at instanceof Date);
  }) });

Deno.test({ name: "re-checks replace the subscriptions and never touch Tom's fields", ignore, fn: () =>
  withDb(async (sql, store, made) => {
    const userId = await newUser(sql, made, `tom-fields-${rid()}@example.com`);
    const cus = `cus_${rid()}`;
    const s1 = sub({ id: `sub_${rid()}`, customerId: cus, periodEnd: inDays(10) });
    const s2 = sub({ id: `sub_${rid()}`, customerId: cus, status: "canceled", trialEnd: null });
    await store.saveCheck(userId, [{ id: cus, email: null }], [s1, s2], null, new Date());
    await sql`update public.entitlements set manual_grant_until = ${inDays(5)}, banned = true where user_id = ${userId}`;
    await store.saveCheck(userId, [{ id: cus, email: "new@example.com" }], [s2], null, new Date());
    const subs = await sql`select subscription_id from public.subscriptions where customer_id = ${cus}`;
    assertEquals(subs.map((r) => r.subscription_id), [s2.id]);
    const [e] = await sql`select manual_grant_until, banned, stripe_until from public.entitlements where user_id = ${userId}`;
    assertEquals([e.banned, e.stripe_until], [true, null]);
    assert(e.manual_grant_until instanceof Date);
    const [c] = await sql`select email from public.stripe_customers where customer_id = ${cus}`;
    assertEquals(c.email, "new@example.com");
    // No subscriptions left at all: they're all removed.
    await store.saveCheck(userId, [{ id: cus, email: null }], [], null, new Date());
    assertEquals((await sql`select 1 from public.subscriptions where customer_id = ${cus}`).length, 0);
    const [kept] = await sql`select email from public.stripe_customers where customer_id = ${cus}`;
    assertEquals(kept.email, "new@example.com", "a null email doesn't wipe the stored one");
  }) });

Deno.test({ name: "a customer linked to another account: nothing at all is saved", ignore, fn: () =>
  withDb(async (sql, store, made) => {
    const a = await newUser(sql, made, `a-${rid()}@example.com`);
    const b = await newUser(sql, made, `b-${rid()}@example.com`);
    const cus = `cus_${rid()}`;
    await store.saveCheck(a, [{ id: cus, email: null }], [], null, new Date());
    const err = await assertRejects(
      () => store.saveCheck(b, [{ id: cus, email: null }], [sub({ id: `sub_${rid()}`, customerId: cus })], null, new Date()),
      CustomerTaken,
    );
    assertEquals(err.customerIds, [cus]);
    const [owner] = await sql`select user_id from public.stripe_customers where customer_id = ${cus}`;
    assertEquals(owner.user_id, a);
    const [e] = await sql`select checked_at from public.entitlements where user_id = ${b}`;
    assertEquals(e.checked_at, null, "rolled back");
    assertEquals((await sql`select 1 from public.subscriptions where customer_id = ${cus}`).length, 0);
  }) });

Deno.test({ name: "a failed check keeps the last result; the next success clears the flag", ignore, fn: () =>
  withDb(async (sql, store, made) => {
    const userId = await newUser(sql, made, `fail-${rid()}@example.com`);
    const cus = `cus_${rid()}`;
    const s = sub({ id: `sub_${rid()}`, customerId: cus, periodEnd: inDays(20) });
    const m = { until: inDays(23), reason: "subscription" as const, subscription: s };
    await store.saveCheck(userId, [{ id: cus, email: null }], [s], m, new Date());
    await store.saveFailure(userId, "Stripe /customers: TimeoutError", new Date());
    let me = await myAccount(sql, userId);
    assertEquals([me.is_member, me.check_failed], [true, true]);
    await store.saveCheck(userId, [{ id: cus, email: null }], [s], m, new Date());
    me = await myAccount(sql, userId);
    assertEquals(me.check_failed, false);
  }) });

Deno.test({ name: "past-due anchors and check times read back as saved", ignore, fn: () =>
  withDb(async (sql, store, made) => {
    const userId = await newUser(sql, made, `anchor-${rid()}@example.com`);
    const cus = `cus_${rid()}`;
    const anchor = new Date("2026-10-01T00:00:00Z");
    const s = sub({ id: `sub_${rid()}`, customerId: cus, status: "past_due", pastDueSince: anchor });
    const when = new Date("2026-10-25T12:00:00Z");
    await store.saveCheck(userId, [{ id: cus, email: null }], [s], null, when);
    assertEquals(await store.storedSubscriptions([cus]), new Map([[s.id, { status: "past_due", pastDueSince: anchor }]]));
    assertEquals((await sql`select checked_at from public.entitlements where user_id = ${userId}`)[0].checked_at, when);
    assertEquals(await store.customerOwners([cus, "cus_nobody"]), new Map([[cus, userId]]));
  }) });

Deno.test({ name: "the 6-hourly check takes confirmed accounts with a customer, least recently checked first", ignore, fn: () =>
  withDb(async (sql, store, made) => {
    const stale = await newUser(sql, made, `stale-${rid()}@example.com`, true);
    const fresh = await newUser(sql, made, `fresh-${rid()}@example.com`, true);
    const never = await newUser(sql, made, `never-${rid()}@example.com`, true);
    const noCustomer = await newUser(sql, made, `nocus-${rid()}@example.com`, true);
    const unconfirmed = await newUser(sql, made, `unconf-${rid()}@example.com`, false);
    for (const u of [stale, fresh, never, unconfirmed]) {
      await sql`insert into public.stripe_customers (customer_id, user_id) values (${`cus_${rid()}`}, ${u})`;
    }
    await sql`update public.entitlements set checked_at = now() - interval '5 hours' where user_id = ${stale}`;
    await sql`update public.entitlements set checked_at = now() where user_id = ${fresh}`;
    const ids = (await store.accountsToReconcile()).map((a) => a.userId).filter((id) => made.includes(id));
    assertEquals(ids, [never, stale, fresh]);
    assert(!ids.includes(noCustomer) && !ids.includes(unconfirmed));
  }) });

Deno.test({ name: "parallel requests: only one gets to ask Stripe", ignore, fn: () =>
  withDb(async (sql, store, made) => {
    const userId = await newUser(sql, made, `burst-${rid()}@example.com`);
    const at = new Date();
    // Each claim on its own connection, all at once.
    const conns = Array.from({ length: 8 }, () => postgres(url!, { max: 1, onnotice: () => {} }));
    try {
      const results = await Promise.all(conns.map((c) => new PgStore(c).claimAttempt(userId, at, 30_000)));
      assertEquals(results.filter(Boolean).length, 1);
    } finally {
      await Promise.all(conns.map((c) => c.end()));
    }
    assertEquals(await store.claimAttempt(userId, new Date(at.getTime() + 29_000), 30_000), false);
    assertEquals(await store.claimAttempt(userId, new Date(at.getTime() + 30_000), 30_000), true);
    assertEquals(await store.claimAttempt(userId, new Date(at.getTime() + 30_001), 0), true, "forced");
  }) });

Deno.test({ name: "an older reading never overwrites a newer one", ignore, fn: () =>
  withDb(async (sql, store, made) => {
    const userId = await newUser(sql, made, `order-${rid()}@example.com`);
    const cus = `cus_${rid()}`;
    const s = sub({ id: `sub_${rid()}`, customerId: cus, periodEnd: inDays(20) });
    const member = { until: inDays(23), reason: "subscription" as const, subscription: s };
    const newer = new Date();
    const older = new Date(newer.getTime() - 5000);
    assertEquals(await store.saveCheck(userId, [{ id: cus, email: null }], [{ ...s, status: "canceled" }], null, newer), true);
    assertEquals(await store.saveCheck(userId, [{ id: cus, email: null }], [s], member, older), false);
    const [e] = await sql`select stripe_until, checked_at from public.entitlements where user_id = ${userId}`;
    assertEquals([e.stripe_until, e.checked_at], [null, newer]);
    const [row] = await sql`select status from public.subscriptions where subscription_id = ${s.id}`;
    assertEquals(row.status, "canceled");
  }) });
