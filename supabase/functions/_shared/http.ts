/**
 * The two HTTP entry points, kept free of Deno.serve and environment variables
 * so the tests can drive them with fakes.
 *
 * entitlement-refresh: the app calls it after login and on "Check again". The
 *   caller is whoever the access token says, checked with Supabase Auth, and
 *   only a confirmed email is ever looked up in Stripe.
 * entitlement-reconcile: pg_cron calls it every 6 hours with x-cron-secret, so
 *   renewals and lapses show up even for people who don't open the app.
 */
import type { Account } from "./store.ts";
import type { RefreshResult } from "./refresh.ts";

export interface AuthUser {
  id: string;
  email: string | null; // lowercased
  confirmed: boolean;
}

export type GetUser = (accessToken: string) => Promise<AuthUser | null>;

/** Looks the token up with Supabase Auth: the only trusted source of who's calling. */
export function authUserFetcher(supabaseUrl: string, apiKey: string, fetchFn: typeof fetch = fetch): GetUser {
  return async (accessToken) => {
    const res = await fetchFn(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${accessToken}`, apikey: apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) return null;
    if (!res.ok) throw new Error(`auth/v1/user: HTTP ${res.status}`);
    const user = await res.json();
    if (typeof user?.id !== "string") return null;
    return {
      id: user.id,
      email: typeof user.email === "string" && user.email.trim() ? user.email.trim().toLowerCase() : null,
      confirmed: Boolean(user.email_confirmed_at),
    };
  };
}

export function corsHeaders(req: Request, allowedOrigins: string[]): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !allowedOrigins.includes(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

export interface RefreshHandlerDeps {
  getUser: GetUser;
  refresh: (account: Account) => Promise<RefreshResult>;
  allowedOrigins: string[];
  log?: (message: string) => void;
}

export async function handleRefresh(req: Request, deps: RefreshHandlerDeps): Promise<Response> {
  const cors = corsHeaders(req, deps.allowedOrigins);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: cors["Access-Control-Allow-Origin"] ? 204 : 403, headers: cors });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);
  const token = bearerToken(req);
  if (!token) return json({ error: "not_logged_in" }, 401, cors);
  let user: AuthUser | null;
  try {
    user = await deps.getUser(token);
  } catch (e) {
    (deps.log ?? console.error)(`refresh: Supabase Auth unavailable: ${describe(e)}`);
    return json({ error: "auth_unavailable" }, 503, cors);
  }
  if (!user) return json({ error: "not_logged_in" }, 401, cors);
  // Logins are by email code only; the database drops passwords, and this is the second lock.
  if (signedInWithPassword(token)) return json({ error: "not_logged_in" }, 401, cors);
  if (!user.email || !user.confirmed) return json({ checked: false, reason: "email_not_confirmed" }, 200, cors);
  try {
    return json(await deps.refresh({ userId: user.id, email: user.email }), 200, cors);
  } catch (e) {
    (deps.log ?? console.error)(`refresh ${user.id}: failed: ${describe(e)}`);
    return json({ error: "refresh_failed" }, 500, cors);
  }
}

export interface ReconcileHandlerDeps {
  cronSecret: string;
  accounts: () => Promise<Account[]>;
  refresh: (account: Account) => Promise<RefreshResult>;
  log?: (message: string) => void;
  /** Stop starting new accounts after this long: Supabase ends a function at 150 s. */
  budgetMs?: number;
  now?: () => number;
}

export const RECONCILE_BUDGET_MS = 100_000;

/** Shortest CRON_SECRET accepted, so a weak or empty one can't open it up. */
export const MIN_CRON_SECRET_LENGTH = 32;

export async function handleReconcile(req: Request, deps: ReconcileHandlerDeps): Promise<Response> {
  const log = deps.log ?? console.log;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (deps.cronSecret.length < MIN_CRON_SECRET_LENGTH) {
    log("reconcile: CRON_SECRET isn't set (or is shorter than 32 characters); refusing to run");
    return json({ error: "not_configured" }, 500);
  }
  if (!(await sameSecret(req.headers.get("x-cron-secret") ?? "", deps.cronSecret))) {
    return json({ error: "forbidden" }, 401);
  }
  const now = deps.now ?? Date.now;
  const stopAt = now() + (deps.budgetMs ?? RECONCILE_BUDGET_MS);
  const accounts = await deps.accounts();
  let checked = 0;
  let failed = 0;
  let left = 0;
  for (const [i, account] of accounts.entries()) {
    if (now() >= stopAt) {
      // Least recently checked come first, so the next run starts with these.
      left = accounts.length - i;
      break;
    }
    try {
      const result = await deps.refresh(account);
      if (result.checked) checked++;
      else failed++;
    } catch (e) {
      failed++;
      log(`reconcile ${account.userId}: ${describe(e)}`);
    }
  }
  log(`reconcile: ${accounts.length} accounts, ${checked} checked, ${failed} not, ${left} left for next time`);
  return json({ accounts: accounts.length, checked, failed, left });
}

/** Whether the (already verified) access token came from a password login. */
export function signedInWithPassword(accessToken: string): boolean {
  try {
    const payload = accessToken.split(".")[1];
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=")));
    return Array.isArray(claims?.amr) && claims.amr.some((m: any) => m?.method === "password");
  } catch {
    return false; // Auth accepted it; not a token we can read amr from
  }
}

function bearerToken(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

/** Compares digests, so the time taken says nothing about the secret. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
