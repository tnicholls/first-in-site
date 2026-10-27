// Fakes for the tests: an in-memory Store and a scripted Stripe.
import type { Membership, Subscription } from "../_shared/entitlement.ts";
import { type StripeApi, type StripeCustomer, StripeError } from "../_shared/stripe.ts";
import { type Account, CustomerTaken, type Store, type StoredSubscription } from "../_shared/store.ts";

export const T0 = new Date("2026-11-01T12:00:00Z");
export const DAY = 24 * 60 * 60 * 1000;
export const at = (ms: number) => new Date(T0.getTime() + ms);
export const PRICE = "price_firstin";
export const PRICES: ReadonlySet<string> = new Set([PRICE]);

export function sub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub_1",
    customerId: "cus_1",
    status: "active",
    created: at(-60 * DAY),
    priceIds: [PRICE],
    periodStart: T0,
    periodEnd: at(30 * DAY),
    trialEnd: null,
    cancelAt: null,
    cancelAtPeriodEnd: false,
    pastDueSince: null,
    ...over,
  };
}

export class FakeStripe implements StripeApi {
  customers = new Map<string, StripeCustomer[]>(); // by email
  subs = new Map<string, Subscription[]>(); // by customer
  calls: string[] = [];
  failWith: StripeError | null = null;

  customersByEmail(email: string): Promise<StripeCustomer[]> {
    this.calls.push(`customers:${email}`);
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.customers.get(email) ?? []);
  }

  subscriptions(customerId: string): Promise<Subscription[]> {
    this.calls.push(`subscriptions:${customerId}`);
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.subs.get(customerId) ?? []);
  }
}

export interface Saved {
  customers: StripeCustomer[];
  subs: Subscription[];
  m: Membership | null;
  at: Date;
}

export class FakeStore implements Store {
  owners = new Map<string, string>(); // customer -> user
  stored = new Map<string, StoredSubscription>();
  attempts = new Map<string, Date>();
  saved: Saved[] = [];
  failures: string[] = [];
  toReconcile: Account[] = [];

  claimAttempt(userId: string, at: Date, cooldownMs: number) {
    const last = this.attempts.get(userId);
    if (last && last.getTime() > at.getTime() - cooldownMs) return Promise.resolve(false);
    this.attempts.set(userId, at);
    return Promise.resolve(true);
  }
  linkedCustomers(userId: string) {
    return Promise.resolve([...this.owners].filter(([, u]) => u === userId).map(([c]) => c).sort());
  }
  customerOwners(ids: string[]) {
    return Promise.resolve(new Map(ids.filter((id) => this.owners.has(id)).map((id) => [id, this.owners.get(id)!])));
  }
  storedSubscriptions(ids: string[]) {
    const out = new Map<string, StoredSubscription>();
    for (const [id, s] of this.stored) out.set(id, s);
    void ids;
    return Promise.resolve(out);
  }
  saveCheck(userId: string, customers: StripeCustomer[], subs: Subscription[], m: Membership | null, at: Date) {
    const taken = customers.filter((c) => this.owners.has(c.id) && this.owners.get(c.id) !== userId);
    if (taken.length) return Promise.reject(new CustomerTaken(taken.map((c) => c.id)));
    for (const c of customers) this.owners.set(c.id, userId);
    this.saved.push({ customers, subs, m, at });
    return Promise.resolve(true);
  }
  saveFailure(userId: string, error: string) {
    this.failures.push(`${userId}: ${error}`);
    return Promise.resolve();
  }
  accountsToReconcile() {
    return Promise.resolve(this.toReconcile);
  }
}
