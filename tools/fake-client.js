// A pretend Supabase client for tools/demo.html: no network, nothing real, and
// never shipped. Any email "gets" a code, and the code is always 123456. The
// part before the @ picks what the account looks like:
//   member, trial, cancelled, grace, grant, lapsed, banned, stripedown, ratelimited
// Anything else is a free account.
const DAY = 24 * 60 * 60 * 1000;
const at = (days) => new Date(Date.now() + days * DAY).toISOString();

export function accountFor(email) {
  const base = {
    email,
    created_at: at(-3),
    is_member: false,
    member_until: null,
    reason: null,
    status: null,
    trial_end: null,
    period_end: null,
    ends_at: null,
    banned: false,
    checked_at: at(0),
    check_failed: false,
  };
  const member = { ...base, is_member: true };
  switch (email.split("@")[0]) {
    case "member":
      return { ...member, reason: "subscription", status: "active", period_end: at(18), member_until: at(21) };
    case "trial":
      return { ...member, reason: "trial", status: "trialing", trial_end: at(11), period_end: at(11), member_until: at(14) };
    case "cancelled":
      return { ...member, reason: "trial", status: "trialing", trial_end: at(11), ends_at: at(11), member_until: at(11) };
    case "grace":
      return { ...member, reason: "grace", status: "past_due", period_end: at(29), member_until: at(2) };
    case "grant":
      return { ...member, reason: "grant", member_until: at(30) };
    case "lapsed":
      return { ...base, reason: "subscription", status: "canceled", member_until: at(-4) };
    case "banned":
      return { ...base, banned: true };
    case "stripedown":
      return { ...base, check_failed: true };
    default:
      return base;
  }
}

export function fakeClient({ delayMs = 350, storage = globalThis.sessionStorage } = {}) {
  let session = JSON.parse(storage.getItem("demo-session") ?? "null");
  const listeners = [];
  const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), delayMs));
  const save = () => storage.setItem("demo-session", JSON.stringify(session));
  return {
    auth: {
      getSession: () => Promise.resolve({ data: { session } }),
      onAuthStateChange(fn) {
        listeners.push(fn);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      signInWithOtp: ({ email }) =>
        later({ error: email.startsWith("ratelimited@") ? { status: 429, message: "rate limited" } : null }),
      verifyOtp({ email, token }) {
        if (token !== "123456") return later({ data: {}, error: { status: 403, message: "Token has expired or is invalid" } });
        session = { user: { email } };
        save();
        return later({ data: { session }, error: null });
      },
      signOut() {
        session = null;
        save();
        for (const fn of listeners) fn("SIGNED_OUT", null);
        return Promise.resolve({ error: null });
      },
    },
    rpc: () => later({ data: session ? [accountFor(session.user.email)] : [], error: null, status: 200 }),
    functions: {
      invoke: () =>
        later({
          data: session?.user.email.startsWith("stripedown@") ? { checked: false, reason: "stripe_unavailable" } : { checked: true },
          error: null,
        }),
    },
  };
}
