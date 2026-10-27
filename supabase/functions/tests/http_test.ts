import { assertEquals } from "jsr:@std/assert@1";
import {
  authUserFetcher,
  handleReconcile,
  handleRefresh,
  MIN_CRON_SECRET_LENGTH,
  signedInWithPassword,
} from "../_shared/http.ts";
import type { Account } from "../_shared/store.ts";
import type { RefreshResult } from "../_shared/refresh.ts";

const ORIGIN = "http://127.0.0.1:8000";
const quiet = () => {};

function refreshDeps(user: unknown = { id: "u-1", email: "me@example.com", confirmed: true }) {
  const calls: Account[] = [];
  return {
    calls,
    deps: {
      getUser: (token: string) =>
        token === "good" || token.startsWith("eyJ") ? Promise.resolve(user as never) : Promise.resolve(null),
      refresh: (a: Account) => {
        calls.push(a);
        return Promise.resolve({ checked: true } as RefreshResult);
      },
      allowedOrigins: [ORIGIN],
      log: quiet,
    },
  };
}

const post = (headers: Record<string, string> = {}, body = "{}") =>
  new Request("http://fn/entitlement-refresh", { method: "POST", headers, body });

Deno.test("preflight: allowed origins get CORS headers, others don't", async () => {
  const { deps } = refreshDeps();
  const ok = await handleRefresh(new Request("http://fn", { method: "OPTIONS", headers: { origin: ORIGIN } }), deps);
  assertEquals(ok.status, 204);
  assertEquals(ok.headers.get("access-control-allow-origin"), ORIGIN);
  const bad = await handleRefresh(
    new Request("http://fn", { method: "OPTIONS", headers: { origin: "https://evil.example" } }),
    deps,
  );
  assertEquals(bad.status, 403);
  assertEquals(bad.headers.get("access-control-allow-origin"), null);
});

Deno.test("only POST, only with a valid login", async () => {
  const { deps, calls } = refreshDeps();
  assertEquals((await handleRefresh(new Request("http://fn"), deps)).status, 405);
  assertEquals((await handleRefresh(post(), deps)).status, 401);
  assertEquals((await handleRefresh(post({ authorization: "Bearer wrong" }), deps)).status, 401);
  assertEquals(calls, []);
});

Deno.test("who to check comes from Supabase Auth, never from the request", async () => {
  const { deps, calls } = refreshDeps();
  const res = await handleRefresh(
    post({ authorization: "Bearer good", origin: ORIGIN }, JSON.stringify({ email: "victim@example.com" })),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { checked: true });
  assertEquals(res.headers.get("access-control-allow-origin"), ORIGIN);
  assertEquals(calls, [{ userId: "u-1", email: "me@example.com" }]);
});

Deno.test("an unconfirmed email is never looked up", async () => {
  const { deps, calls } = refreshDeps({ id: "u-1", email: "me@example.com", confirmed: false });
  const res = await handleRefresh(post({ authorization: "Bearer good" }), deps);
  assertEquals(await res.json(), { checked: false, reason: "email_not_confirmed" });
  assertEquals(calls, []);
});

Deno.test("Auth down is a 503, a failed refresh a 500", async () => {
  const { deps } = refreshDeps();
  const authDown = { ...deps, getUser: () => Promise.reject(new Error("timeout")) };
  assertEquals((await handleRefresh(post({ authorization: "Bearer good" }), authDown)).status, 503);
  const broken = { ...deps, refresh: () => Promise.reject(new Error("db down")) };
  const res = await handleRefresh(post({ authorization: "Bearer good" }), broken);
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "refresh_failed" });
});

Deno.test("authUserFetcher asks Supabase Auth and reads the answer", async () => {
  const seen: Headers[] = [];
  const answer = (status: number, body: unknown) =>
    ((_: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as typeof fetch;
  const user = await authUserFetcher("http://sb", "anon-key", answer(200, {
    id: "u-1",
    email: " Me@Example.com ",
    email_confirmed_at: "2026-10-25T10:00:00Z",
  }))("tok");
  assertEquals(user, { id: "u-1", email: "me@example.com", confirmed: true });
  assertEquals(seen[0].get("authorization"), "Bearer tok");
  assertEquals(seen[0].get("apikey"), "anon-key");
  assertEquals(await authUserFetcher("http://sb", "k", answer(200, { id: "u-2", email: "x@y.z" }))("t"), {
    id: "u-2",
    email: "x@y.z",
    confirmed: false,
  });
  assertEquals(await authUserFetcher("http://sb", "k", answer(401, {}))("t"), null);
  let threw = false;
  try {
    await authUserFetcher("http://sb", "k", answer(500, {}))("t");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

const SECRET = "s".repeat(MIN_CRON_SECRET_LENGTH);

function reconcileDeps(secret = SECRET) {
  const done: string[] = [];
  return {
    done,
    deps: {
      cronSecret: secret,
      accounts: () =>
        Promise.resolve([{ userId: "u-1", email: "a@x" }, { userId: "u-2", email: "b@x" }, {
          userId: "u-3",
          email: "c@x",
        }]),
      refresh: (a: Account): Promise<RefreshResult> => {
        done.push(a.userId);
        if (a.userId === "u-2") return Promise.reject(new Error("boom"));
        if (a.userId === "u-3") return Promise.resolve({ checked: false, reason: "stripe_unavailable" });
        return Promise.resolve({ checked: true });
      },
      log: quiet,
    },
  };
}

const cron = (secret?: string) =>
  new Request("http://fn/entitlement-reconcile", {
    method: "POST",
    headers: secret === undefined ? {} : { "x-cron-secret": secret },
  });

Deno.test("reconcile needs the cron secret, and refuses to run without a proper one", async () => {
  const { deps, done } = reconcileDeps();
  assertEquals((await handleReconcile(cron(), deps)).status, 401);
  assertEquals((await handleReconcile(cron("wrong"), deps)).status, 401);
  assertEquals((await handleReconcile(cron(SECRET + "x"), deps)).status, 401);
  assertEquals((await handleReconcile(new Request("http://fn"), deps)).status, 405);
  const weak = reconcileDeps("short").deps;
  assertEquals((await handleReconcile(cron("short"), weak)).status, 500);
  assertEquals((await handleReconcile(cron(""), reconcileDeps("").deps)).status, 500);
  assertEquals(done, []);
});

Deno.test("reconcile checks everyone, carrying on past failures", async () => {
  const { deps, done } = reconcileDeps();
  const res = await handleReconcile(cron(SECRET), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { accounts: 3, checked: 1, failed: 2, left: 0 });
  assertEquals(done, ["u-1", "u-2", "u-3"]);
});

/** An unsigned JWT-shaped token with these claims (the signature is Auth's business, not ours). */
const tokenWith = (claims: unknown) => {
  const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
};

Deno.test("a session that came from a password is turned away", async () => {
  const password = tokenWith({ sub: "u-1", amr: [{ method: "password", timestamp: 1 }] });
  const code = tokenWith({ sub: "u-1", amr: [{ method: "otp", timestamp: 1 }] });
  assertEquals(signedInWithPassword(password), true);
  assertEquals(signedInWithPassword(code), false);
  assertEquals(signedInWithPassword("not-a-jwt"), false);
  const { deps, calls } = refreshDeps();
  assertEquals((await handleRefresh(post({ authorization: `Bearer ${password}` }), deps)).status, 401);
  assertEquals(calls, []);
  assertEquals((await handleRefresh(post({ authorization: `Bearer ${code}` }), deps)).status, 200);
});

Deno.test("reconcile stops starting accounts when its time is up, and says how many are left", async () => {
  const { deps, done } = reconcileDeps();
  let clock = 0;
  const timed = {
    ...deps,
    budgetMs: 100,
    now: () => clock,
    refresh: (a: Account): Promise<RefreshResult> => {
      done.push(a.userId);
      clock += 60; // each account takes 60 ms here
      return Promise.resolve({ checked: true });
    },
  };
  const res = await handleReconcile(cron(SECRET), timed);
  assertEquals(await res.json(), { accounts: 3, checked: 2, failed: 0, left: 1 });
  assertEquals(done, ["u-1", "u-2"]);
});
