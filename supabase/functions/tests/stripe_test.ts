import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { escapeSearchValue, parseSubscription, Stripe, STRIPE_API_VERSION, StripeError } from "../_shared/stripe.ts";

const KEY = "rk_test_51abcDEF";

/** A fetch that answers from a list of [path match, response body, status]. */
function fakeFetch(routes: Array<[RegExp, unknown, number?]>) {
  const requests: Array<{ url: URL; headers: Headers }> = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push({ url, headers: new Headers(init?.headers) });
    for (const [match, body, status] of routes) {
      if (match.test(url.pathname + url.search)) {
        return Promise.resolve(new Response(JSON.stringify(body), { status: status ?? 200 }));
      }
    }
    return Promise.resolve(new Response(JSON.stringify({ error: { type: "invalid_request_error" } }), { status: 404 }));
  };
  return { fn: fn as typeof fetch, requests };
}

const subPayload = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  object: "subscription",
  status: "trialing",
  customer: "cus_1",
  trial_end: 1_800_000_000,
  cancel_at: null,
  cancel_at_period_end: false,
  items: {
    data: [
      { current_period_start: 1_790_000_000, current_period_end: 1_800_000_000 },
      { current_period_start: 1_789_000_000, current_period_end: 1_801_000_000 },
    ],
  },
  ...over,
});

Deno.test("only a test-mode key is accepted", () => {
  for (const bad of ["", "sk_live_abc", "rk_live_abc", "pk_test_abc", "rk_test_", "rk_test_abc def"]) {
    assertThrows(() => new Stripe(bad), StripeError, "test-mode", bad);
  }
  new Stripe("sk_test_abc");
  new Stripe(KEY);
});

Deno.test("customers are found by exact email and by search, once each", async () => {
  const { fn, requests } = fakeFetch([
    [/^\/v1\/customers\?/, { data: [{ id: "cus_A", email: "O'Brien@Example.com" }], has_more: false }],
    [/^\/v1\/customers\/search/, {
      data: [
        { id: "cus_A", email: "O'Brien@Example.com" },
        { id: "cus_B", email: " o'brien@example.com " },
        { id: "cus_C", deleted: true },
        { id: "cus_D", email: null },
      ],
      has_more: false,
    }],
  ]);
  const found = await new Stripe(KEY, fn).customersByEmail("o'brien@example.com");
  assertEquals(found, [{ id: "cus_A", email: "o'brien@example.com" }, { id: "cus_B", email: "o'brien@example.com" }]);
  assertEquals(requests[0].url.searchParams.get("email"), "o'brien@example.com");
  assertEquals(requests[1].url.searchParams.get("query"), "email:'o\\'brien@example.com'");
  for (const r of requests) {
    assertEquals(r.headers.get("authorization"), `Bearer ${KEY}`);
    assertEquals(r.headers.get("stripe-version"), STRIPE_API_VERSION);
  }
});

Deno.test("search finds words, so a longer email that contains this one is dropped", async () => {
  const { fn } = fakeFetch([
    [/^\/v1\/customers\?/, { data: [], has_more: false }],
    [/^\/v1\/customers\/search/, {
      data: [{ id: "cus_jane", email: "jane-doe@outlook.com" }, { id: "cus_doe", email: "doe@outlook.com" }],
      has_more: false,
    }],
  ]);
  assertEquals(await new Stripe(KEY, fn).customersByEmail("doe@outlook.com"), [{ id: "cus_doe", email: "doe@outlook.com" }]);
});

Deno.test("an answer that can't be read is an error, never an empty list", async () => {
  const garbled = (() => Promise.resolve(new Response("{\"data\": [", { status: 200 }))) as typeof fetch;
  await assertRejects(() => new Stripe(KEY, garbled).subscriptions("cus_1"), StripeError, "unreadable");
  const noList = (() => Promise.resolve(new Response(JSON.stringify({ object: "list" }), { status: 200 }))) as typeof fetch;
  await assertRejects(() => new Stripe(KEY, noList).subscriptions("cus_1"), StripeError, "data list");
  const notObject = (() => Promise.resolve(new Response("null", { status: 200 }))) as typeof fetch;
  await assertRejects(() => new Stripe(KEY, notObject).customersByEmail("a@b.co"), StripeError, "unreadable");
});

Deno.test("lists follow has_more pages", async () => {
  const { fn, requests } = fakeFetch([
    [/starting_after=sub_2/, { data: [subPayload({ id: "sub_3" })], has_more: false }],
    [/^\/v1\/subscriptions\?/, { data: [subPayload({ id: "sub_1" }), subPayload({ id: "sub_2" })], has_more: true }],
  ]);
  const subs = await new Stripe(KEY, fn).subscriptions("cus_1");
  assertEquals(subs.map((s) => s.id), ["sub_1", "sub_2", "sub_3"]);
  assertEquals(requests[0].url.searchParams.get("status"), "all");
  assertEquals(requests[0].url.searchParams.get("customer"), "cus_1");
});

Deno.test("a subscription is read the 2026-09-30 way: periods come from the items", () => {
  const s = parseSubscription(subPayload({
    customer: { id: "cus_obj" },
    cancel_at: 1_795_000_000,
    created: 1_788_000_000,
    items: {
      data: [
        { current_period_start: 1_790_000_000, current_period_end: 1_800_000_000, price: { id: "price_A" } },
        { current_period_start: 1_789_000_000, current_period_end: 1_801_000_000, price: "price_B" },
      ],
    },
  }));
  assertEquals(s.customerId, "cus_obj");
  assertEquals(s.created, new Date(1_788_000_000_000));
  assertEquals(s.priceIds, ["price_A", "price_B"]);
  assertEquals(s.periodStart, new Date(1_789_000_000_000));
  assertEquals(s.periodEnd, new Date(1_801_000_000_000));
  assertEquals(s.trialEnd, new Date(1_800_000_000_000));
  assertEquals(s.cancelAt, new Date(1_795_000_000_000));
  assertEquals(s.pastDueSince, null);
  const bare = parseSubscription({ id: "sub_x", customer: "cus_x", status: "active" });
  assertEquals([bare.periodStart, bare.periodEnd, bare.trialEnd], [null, null, null]);
  assertThrows(() => parseSubscription({ id: "sub_x" }), StripeError);
});

Deno.test("a deleted customer just has no subscriptions", async () => {
  const { fn } = fakeFetch([[/^\/v1\/subscriptions/, { error: { code: "resource_missing" } }, 404]]);
  assertEquals(await new Stripe(KEY, fn).subscriptions("cus_gone"), []);
});

Deno.test("errors say what failed, never the key", async () => {
  const { fn } = fakeFetch([[/^\/v1\/customers/, { error: { type: "invalid_request_error", code: "api_key_expired" } }, 401]]);
  const err = await assertRejects(() => new Stripe(KEY, fn).customersByEmail("a@b.c"), StripeError);
  assertEquals(err.status, 401);
  assertEquals(err.code, "api_key_expired");
  assert(!err.message.includes(KEY));
  const down = (() => Promise.reject(new TypeError("network down"))) as typeof fetch;
  const net = await assertRejects(() => new Stripe(KEY, down).subscriptions("cus_1"), StripeError);
  assert(net.message.includes("TypeError"));
});

Deno.test("search values are escaped", () => {
  assertEquals(escapeSearchValue("a'b\\c"), "a\\'b\\\\c");
});
