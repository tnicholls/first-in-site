/**
 * Where the functions keep each account's Stripe links and membership: the
 * project's own Postgres, over the direct connection Supabase gives every
 * function (SUPABASE_DB_URL, the postgres role). Writes that belong together
 * happen in one transaction. Tom's fields (manual_grant_until, banned) are
 * never written here.
 */
import postgres from "npm:postgres@3.4.9";
import type { Membership, Subscription } from "./entitlement.ts";
import type { StripeCustomer } from "./stripe.ts";

export interface Account {
  userId: string;
  email: string;
}

export interface StoredSubscription {
  status: string;
  pastDueSince: Date | null;
}

export interface Store {
  /**
   * Take this account's turn to ask Stripe: true if no attempt was made in the
   * last cooldownMs (0 always succeeds), and the attempt is recorded at once,
   * so requests sent in parallel can't all get through.
   */
  claimAttempt(userId: string, at: Date, cooldownMs: number): Promise<boolean>;
  linkedCustomers(userId: string): Promise<string[]>;
  customerOwners(customerIds: string[]): Promise<Map<string, string>>;
  storedSubscriptions(customerIds: string[]): Promise<Map<string, StoredSubscription>>;
  /**
   * Link the customers, replace their subscriptions, store the result: all or
   * nothing. False (and nothing written) if a reading newer than `at` is stored.
   */
  saveCheck(
    userId: string,
    customers: StripeCustomer[],
    subs: Subscription[],
    m: Membership | null,
    at: Date,
  ): Promise<boolean>;
  /** Stripe failed: note it, keep the last known membership. */
  saveFailure(userId: string, error: string, at: Date): Promise<void>;
  /**
   * The accounts the 6-hourly check re-reads: confirmed, with a Stripe customer
   * linked (others are found when they log in or press "Check again"), least
   * recently checked first, so a run cut short moves on next time.
   */
  accountsToReconcile(): Promise<Account[]>;
}

/** A customer turned out to belong to another account by the time it was saved. */
export class CustomerTaken extends Error {
  constructor(readonly customerIds: string[]) {
    super(`Stripe customer(s) linked to another account: ${customerIds.join(", ")}`);
    this.name = "CustomerTaken";
  }
}

export function connect(url: string): postgres.Sql {
  // prepare: false works through Supabase's transaction pooler too.
  return postgres(url, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 10 });
}

export class PgStore implements Store {
  constructor(private readonly sql: postgres.Sql) {}

  async claimAttempt(userId: string, at: Date, cooldownMs: number): Promise<boolean> {
    const since = new Date(at.getTime() - cooldownMs);
    const rows = await this.sql`
      insert into public.entitlements (user_id, last_attempt_at) values (${userId}, ${at})
      on conflict (user_id) do update set last_attempt_at = excluded.last_attempt_at
        where public.entitlements.last_attempt_at is null
           or public.entitlements.last_attempt_at <= ${since}
      returning user_id`;
    return rows.length === 1;
  }

  async linkedCustomers(userId: string): Promise<string[]> {
    const rows = await this.sql`
      select customer_id from public.stripe_customers where user_id = ${userId} order by customer_id`;
    return rows.map((r) => r.customer_id);
  }

  async customerOwners(customerIds: string[]): Promise<Map<string, string>> {
    if (customerIds.length === 0) return new Map();
    const rows = await this.sql`
      select customer_id, user_id from public.stripe_customers
      where customer_id = any(${this.sql.array(customerIds)})`;
    return new Map(rows.map((r) => [r.customer_id, r.user_id]));
  }

  async storedSubscriptions(customerIds: string[]): Promise<Map<string, StoredSubscription>> {
    if (customerIds.length === 0) return new Map();
    const rows = await this.sql`
      select subscription_id, status, past_due_since from public.subscriptions
      where customer_id = any(${this.sql.array(customerIds)})`;
    return new Map(rows.map((r) => [r.subscription_id, { status: r.status, pastDueSince: r.past_due_since }]));
  }

  async saveCheck(
    userId: string,
    customers: StripeCustomer[],
    subs: Subscription[],
    m: Membership | null,
    at: Date,
  ): Promise<boolean> {
    return await this.sql.begin(async (tx) => {
      // Locks the row, so two readings for one account are saved one after the other.
      const [current] = await tx`
        select checked_at from public.entitlements where user_id = ${userId} for update`;
      if (current?.checked_at && current.checked_at > at) return false; // a newer reading is stored
      const ids = customers.map((c) => c.id);
      for (const c of customers) {
        // A customer already linked to someone else is left alone (and caught below).
        await tx`
          insert into public.stripe_customers (customer_id, user_id, email)
          values (${c.id}, ${userId}, ${c.email})
          on conflict (customer_id) do update
            set email = coalesce(excluded.email, public.stripe_customers.email)
            where public.stripe_customers.user_id = excluded.user_id`;
      }
      if (ids.length > 0) {
        const owned = await tx`
          select customer_id from public.stripe_customers
          where customer_id = any(${tx.array(ids)}) and user_id = ${userId}`;
        if (owned.length !== ids.length) {
          const mine = new Set(owned.map((r) => r.customer_id));
          throw new CustomerTaken(ids.filter((id) => !mine.has(id)));
        }
        // These customers' subscriptions, exactly as Stripe listed them just now.
        await tx`
          delete from public.subscriptions
          where customer_id = any(${tx.array(ids)})
            and not (subscription_id = any(${tx.array(subs.map((s) => s.id))}))`;
      }
      for (const s of subs) {
        if (!ids.includes(s.customerId)) throw new Error(`subscription ${s.id} isn't for a linked customer`);
        await tx`
          insert into public.subscriptions (subscription_id, customer_id, status, current_period_start,
            current_period_end, trial_end, cancel_at, cancel_at_period_end, past_due_since, synced_at)
          values (${s.id}, ${s.customerId}, ${s.status}, ${s.periodStart}, ${s.periodEnd}, ${s.trialEnd},
            ${s.cancelAt}, ${s.cancelAtPeriodEnd}, ${s.pastDueSince}, ${at})
          on conflict (subscription_id) do update set
            status = excluded.status,
            current_period_start = excluded.current_period_start,
            current_period_end = excluded.current_period_end,
            trial_end = excluded.trial_end,
            cancel_at = excluded.cancel_at,
            cancel_at_period_end = excluded.cancel_at_period_end,
            past_due_since = excluded.past_due_since,
            synced_at = excluded.synced_at
          where public.subscriptions.customer_id = excluded.customer_id`;
      }
      const sub = m?.subscription;
      const endsAt = sub ? (sub.cancelAt ?? (sub.cancelAtPeriodEnd ? sub.periodEnd : null)) : null;
      await tx`
        insert into public.entitlements (user_id, stripe_until, reason, status, trial_end, period_end, ends_at,
          checked_at, check_error, updated_at)
        values (${userId}, ${m?.until ?? null}, ${m?.reason ?? null}, ${sub?.status ?? null},
          ${sub?.trialEnd ?? null}, ${sub?.periodEnd ?? null}, ${endsAt}, ${at}, null, now())
        on conflict (user_id) do update set
          stripe_until = excluded.stripe_until,
          reason = excluded.reason,
          status = excluded.status,
          trial_end = excluded.trial_end,
          period_end = excluded.period_end,
          ends_at = excluded.ends_at,
          checked_at = excluded.checked_at,
          check_error = null,
          updated_at = now()`;
      return true;
    });
  }

  async saveFailure(userId: string, error: string, at: Date): Promise<void> {
    await this.sql`
      insert into public.entitlements (user_id, check_error, updated_at)
      values (${userId}, ${`${at.toISOString()} ${error}`.slice(0, 500)}, now())
      on conflict (user_id) do update set check_error = excluded.check_error, updated_at = now()`;
  }

  async accountsToReconcile(): Promise<Account[]> {
    const rows = await this.sql`
      select a.user_id, a.email from public.accounts a
      join auth.users u on u.id = a.user_id
      left join public.entitlements e on e.user_id = a.user_id
      where u.email_confirmed_at is not null
        and exists (select 1 from public.stripe_customers c where c.user_id = a.user_id)
      order by e.checked_at nulls first, a.user_id`;
    return rows.map((r) => ({ userId: r.user_id, email: r.email }));
  }
}
