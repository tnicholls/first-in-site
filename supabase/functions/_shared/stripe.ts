/**
 * The little of Stripe the web app needs: find customers by email, list their
 * subscriptions. Read-only, over plain fetch, so a restricted key with
 * "Customers: Read" and "Subscriptions: Read" is enough.
 *
 * Test mode only, like the member bot (its CLAUDE.md): a live key is refused.
 */
import type { Subscription } from "./entitlement.ts";

/** The member bot's pinned API version, so both read Stripe the same way. */
export const STRIPE_API_VERSION = "2026-09-30.endive";
const API = "https://api.stripe.com/v1";
const MAX_PAGES = 5; // 500 items: far more than one person ever has

export interface StripeCustomer {
  id: string;
  email: string | null; // lowercased
}

export interface StripeApi {
  customersByEmail(email: string): Promise<StripeCustomer[]>;
  subscriptions(customerId: string): Promise<Subscription[]>;
}

/** Anything that went wrong talking to Stripe. The message never holds the key. */
export class StripeError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "StripeError";
  }
}

export class Stripe implements StripeApi {
  constructor(
    private readonly key: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    if (!/^(rk|sk)_test_[A-Za-z0-9]+$/.test(key)) {
      throw new StripeError("STRIPE_API_KEY must be a test-mode key (rk_test_ or sk_test_)");
    }
  }

  /**
   * Both ways of finding a customer: the list filter is exact and
   * case-sensitive (Stripe keeps the email as typed at Checkout), and search
   * ignores case but can lag about a minute behind a new customer. Search
   * matches words, so "doe@outlook.com" can also find "jane-doe@outlook.com":
   * only customers whose email is exactly this one (ignoring case) are kept.
   */
  async customersByEmail(email: string): Promise<StripeCustomer[]> {
    const want = email.trim().toLowerCase();
    const exact = await this.list("/customers", { email, limit: "100" });
    const found = await this.search("/customers/search", {
      query: `email:'${escapeSearchValue(email)}'`,
      limit: "100",
    });
    const byId = new Map<string, StripeCustomer>();
    for (const c of [...exact, ...found]) {
      if (c?.deleted || typeof c?.id !== "string" || typeof c.email !== "string") continue;
      const theirs = c.email.trim().toLowerCase();
      if (theirs === want) byId.set(c.id, { id: c.id, email: theirs });
    }
    return [...byId.values()];
  }

  async subscriptions(customerId: string): Promise<Subscription[]> {
    try {
      const items = await this.list("/subscriptions", { customer: customerId, status: "all", limit: "100" });
      return items.map(parseSubscription);
    } catch (e) {
      // A customer deleted in Stripe (test data gets wiped) has no subscriptions left.
      if (e instanceof StripeError && e.code === "resource_missing") return [];
      throw e;
    }
  }

  private async list(path: string, params: Record<string, string>): Promise<any[]> {
    const out: any[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.get(path, startingAfter ? { ...params, starting_after: startingAfter } : params);
      const data = listData(path, body);
      out.push(...data);
      if (!body?.has_more || data.length === 0) return out;
      startingAfter = data[data.length - 1].id;
    }
    throw new StripeError(`Stripe ${path}: more than ${MAX_PAGES} pages`);
  }

  private async search(path: string, params: Record<string, string>): Promise<any[]> {
    const out: any[] = [];
    let page: string | undefined;
    for (let n = 0; n < MAX_PAGES; n++) {
      const body = await this.get(path, page ? { ...params, page } : params);
      out.push(...listData(path, body));
      if (!body?.has_more || !body?.next_page) return out;
      page = body.next_page;
    }
    throw new StripeError(`Stripe ${path}: more than ${MAX_PAGES} pages`);
  }

  private async get(path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.key}`, "Stripe-Version": STRIPE_API_VERSION },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new StripeError(`Stripe ${path}: ${e instanceof Error ? e.name : "request failed"}`);
    }
    let body: any = null;
    try {
      body = await res.json();
    } catch (e) {
      // A cut-off or garbled answer must not read as "no customers" or "no subscriptions".
      if (res.ok) throw new StripeError(`Stripe ${path}: unreadable answer (${e instanceof Error ? e.name : "error"})`);
    }
    if (res.ok && (body === null || typeof body !== "object")) {
      throw new StripeError(`Stripe ${path}: unreadable answer`);
    }
    if (!res.ok) {
      const code = typeof body?.error?.code === "string" ? body.error.code : undefined;
      const label = code ?? (typeof body?.error?.type === "string" ? body.error.type : "error");
      throw new StripeError(`Stripe ${path}: HTTP ${res.status} ${label}`, res.status, code);
    }
    return body;
  }
}

/** A list's data, or an error if the answer doesn't have one: never a silent empty list. */
function listData(path: string, body: any): any[] {
  if (!Array.isArray(body?.data)) throw new StripeError(`Stripe ${path}: answer without a data list`);
  return body.data;
}

/** A subscription object as API version 2026-09-30 returns it. */
export function parseSubscription(obj: any): Subscription {
  // In this API version the current period only exists on the items.
  const items: any[] = Array.isArray(obj?.items?.data) ? obj.items.data : [];
  const starts = items.map((i) => i?.current_period_start).filter((v) => typeof v === "number");
  const ends = items.map((i) => i?.current_period_end).filter((v) => typeof v === "number");
  const customer = typeof obj?.customer === "string" ? obj.customer : obj?.customer?.id;
  const priceIds = items
    .map((i) => (typeof i?.price === "string" ? i.price : i?.price?.id))
    .filter((id): id is string => typeof id === "string");
  if (typeof obj?.id !== "string" || typeof customer !== "string") {
    throw new StripeError("Stripe returned a subscription without an id or customer");
  }
  return {
    id: obj.id,
    customerId: customer,
    status: typeof obj.status === "string" ? obj.status : "",
    created: fromUnix(obj.created),
    priceIds,
    periodStart: starts.length ? fromUnix(Math.min(...starts)) : null,
    periodEnd: ends.length ? fromUnix(Math.max(...ends)) : null,
    trialEnd: fromUnix(obj.trial_end),
    cancelAt: fromUnix(obj.cancel_at),
    cancelAtPeriodEnd: obj.cancel_at_period_end === true,
    pastDueSince: null,
  };
}

/** Quote a value for Stripe's search syntax: backslash-escape \ and '. */
export function escapeSearchValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function fromUnix(v: unknown): Date | null {
  return typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000) : null;
}
