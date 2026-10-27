import { assert, assertEquals } from "jsr:@std/assert@1";
import { createApp, RESEND_SECONDS } from "../../app/controller.js";

/** A scripted Supabase client that records every call. */
function fakeClient({ session = null, account = { email: "a@b.co", is_member: false } } = {}) {
  const calls = [];
  const listeners = [];
  const client = {
    calls,
    otpError: null,
    verifyOk: true,
    rpcResult: () => ({ data: [account], error: null, status: 200 }),
    invokeResult: () => ({ data: { checked: true }, error: null }),
    emit: (event) => listeners.forEach((fn) => fn(event, null)),
    auth: {
      getSession: () => Promise.resolve({ data: { session } }),
      onAuthStateChange: (fn) => listeners.push(fn),
      signInWithOtp: (args) => {
        calls.push(["otp", args]);
        return Promise.resolve({ error: client.otpError });
      },
      verifyOtp: (args) => {
        calls.push(["verify", args]);
        return Promise.resolve(client.verifyOk ? { data: { session: {} }, error: null } : { data: {}, error: { message: "bad" } });
      },
      signOut: () => {
        calls.push(["signOut"]);
        return Promise.resolve({ error: null });
      },
    },
    rpc: (name) => {
      calls.push(["rpc", name]);
      return Promise.resolve(client.rpcResult());
    },
    functions: {
      invoke: (name) => {
        calls.push(["invoke", name]);
        return Promise.resolve(client.invokeResult());
      },
    },
  };
  return client;
}

function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m };
}

function setup(opts = {}) {
  const client = fakeClient(opts);
  const storage = memoryStorage(opts.storage);
  const shown = [];
  const timers = new Map();
  let nextTimer = 1;
  const app = createApp({
    client,
    storage,
    captcha: opts.captcha ?? null,
    show: (s) => shown.push(s),
    setInterval: (fn) => {
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    clearInterval: (id) => timers.delete(id),
  });
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) for (const fn of [...timers.values()]) fn();
  };
  return { app, client, storage, shown, timers, tick };
}

Deno.test("no session: the email screen; a pending email: straight to the code", async () => {
  const fresh = setup();
  await fresh.app.start();
  assertEquals(fresh.app.state.view, "email");
  const pending = setup({ storage: { "first-in-pending-email": "a@b.co" } });
  await pending.app.start();
  assertEquals([pending.app.state.view, pending.app.state.email], ["code", "a@b.co"]);
});

Deno.test("logged in: load the account, check Stripe, load it again", async () => {
  const { app, client } = setup({ session: {}, account: { email: "a@b.co", is_member: true } });
  await app.start();
  assertEquals(client.calls.map((c) => c[0] + ":" + (c[1] ?? "")), [
    "rpc:my_account",
    "invoke:entitlement-refresh",
    "rpc:my_account",
  ]);
  assertEquals([app.state.view, app.state.checking, app.state.checkProblem], ["account", false, null]);
  assertEquals(app.state.account.is_member, true);
});

Deno.test("a bad email never reaches Supabase", async () => {
  const { app, client } = setup();
  await app.start();
  await app.submitEmail("nope");
  assertEquals(app.state.error, "That doesn't look like an email address.");
  assertEquals(client.calls, []);
});

Deno.test("an email gets a code: tidied, remembered, with a countdown", async () => {
  const { app, client, storage, timers, tick } = setup();
  await app.start();
  await app.submitEmail("  Sam@Exeter.AC.uk ");
  assertEquals(client.calls, [["otp", { email: "sam@exeter.ac.uk", options: { shouldCreateUser: true } }]]);
  assertEquals([app.state.view, app.state.resendIn], ["code", RESEND_SECONDS]);
  assertEquals(storage.m.get("first-in-pending-email"), "sam@exeter.ac.uk");
  await app.resend(); // too soon
  assertEquals(client.calls.length, 1);
  tick(RESEND_SECONDS);
  assertEquals(app.state.resendIn, 0);
  assertEquals(timers.size, 0, "the countdown stops at 0");
  await app.resend();
  assertEquals(client.calls.length, 2);
  assertEquals(app.state.resendIn, RESEND_SECONDS);
});

Deno.test("too many tries says so", async () => {
  const { app, client } = setup();
  await app.start();
  client.otpError = { status: 429 };
  await app.submitEmail("a@b.co");
  assertEquals([app.state.view, app.state.error], ["email", "Too many tries. Wait a minute, then try again."]);
  client.otpError = { status: 500 };
  await app.submitEmail("a@b.co");
  assertEquals(app.state.error, "We couldn't send a code just now. Try again in a minute.");
});

Deno.test("the code: 6 digits, a wrong one says so, a right one logs in", async () => {
  const { app, client, storage, timers } = setup();
  await app.start();
  await app.submitEmail("a@b.co");
  await app.submitCode("12345");
  assertEquals(app.state.error, "The code is the 6 digits in the email.");
  client.verifyOk = false;
  await app.submitCode("123 456");
  assertEquals(client.calls.at(-1), ["verify", { email: "a@b.co", token: "123456", type: "email" }]);
  assertEquals(app.state.error, "That code didn't work. Check it, or send a new one.");
  client.verifyOk = true;
  await app.submitCode("123456");
  assertEquals(app.state.view, "account");
  assertEquals(storage.m.has("first-in-pending-email"), false);
  assertEquals(timers.size, 0);
});

Deno.test("what the Stripe check reports is shown", async () => {
  for (const [result, problem] of [
    [{ data: { checked: false, reason: "stripe_unavailable" }, error: null }, "stripe"],
    [{ data: { checked: false, reason: "cooldown" }, error: null }, "cooldown"],
    [{ data: { checked: false, reason: "email_not_confirmed" }, error: null }, "error"],
    [{ data: null, error: { message: "FunctionsHttpError" } }, "error"],
  ]) {
    const { app, client } = setup({ session: {} });
    client.invokeResult = () => result;
    await app.start();
    assertEquals(app.state.checkProblem, problem, JSON.stringify(result));
    assertEquals(app.state.checking, false);
  }
});

Deno.test("an expired login goes back to the email screen", async () => {
  const { app, client } = setup({ session: {} });
  client.rpcResult = () => ({ data: null, error: { message: "JWT expired" }, status: 401 });
  await app.start();
  assertEquals(app.state.view, "email");
  assert(client.calls.some((c) => c[0] === "signOut"));
});

Deno.test("the account failing to load leaves a way to try again", async () => {
  const { app, client } = setup({ session: {} });
  client.rpcResult = () => ({ data: null, error: { message: "boom" }, status: 500 });
  await app.start();
  assertEquals([app.state.view, app.state.account, app.state.checking], ["account", null, false]);
  client.rpcResult = () => ({ data: [{ email: "a@b.co", is_member: false }], error: null, status: 200 });
  await app.check();
  assertEquals(app.state.account.email, "a@b.co");
});

Deno.test("log out, and Supabase signing us out, both go back to the email screen", async () => {
  const one = setup({ session: {} });
  await one.app.start();
  await one.app.logout();
  assertEquals(one.app.state.view, "email");
  assert(one.client.calls.some((c) => c[0] === "signOut"));
  const two = setup({ session: {} });
  await two.app.start();
  two.client.emit("SIGNED_OUT");
  assertEquals(two.app.state.view, "email");
});

Deno.test("using a different email forgets the pending one", async () => {
  const { app, storage } = setup();
  await app.start();
  await app.submitEmail("a@b.co");
  app.changeEmail();
  assertEquals([app.state.view, storage.m.has("first-in-pending-email")], ["email", false]);
});

Deno.test("with Turnstile on, no code is sent until the check has passed, and each check is used once", async () => {
  let token = null;
  let resets = 0;
  const captcha = { token: () => token, reset: () => { token = null; resets++; } };
  const { app, client } = setup({ captcha });
  await app.start();
  await app.submitEmail("a@b.co");
  assertEquals(client.calls, []);
  assertEquals(app.state.error, "Wait for the security check under the button to finish, then try again.");
  token = "tok-1";
  await app.submitEmail("a@b.co");
  assertEquals(client.calls, [["otp", { email: "a@b.co", options: { shouldCreateUser: true, captchaToken: "tok-1" } }]]);
  assertEquals([app.state.view, resets], ["code", 1]);
  client.otpError = { status: 400 };
  token = "tok-2";
  app.changeEmail();
  await app.submitEmail("a@b.co");
  assertEquals(resets, 2, "reset after a failed send too");
});
