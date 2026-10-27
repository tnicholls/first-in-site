// The app's steps: email, then code, then the account. It talks to Supabase only
// through the client it's given: the real one in app.js, a fake in the tests and
// in tools/demo.html. Every change of state goes to show(state).

const PENDING_EMAIL = "first-in-pending-email";
export const RESEND_SECONDS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createApp({
  client,
  show,
  captcha = null, // { token(), reset() } when Turnstile is on (mount.js), else null
  storage = globalThis.sessionStorage,
  setInterval: every = globalThis.setInterval.bind(globalThis),
  clearInterval: stop = globalThis.clearInterval.bind(globalThis),
}) {
  let state = { view: "loading" };
  let ticker = null;

  function set(patch) {
    state = { ...state, ...patch };
    show(state);
  }

  function remember(email) {
    try {
      if (email) storage?.setItem(PENDING_EMAIL, email);
      else storage?.removeItem(PENDING_EMAIL);
    } catch {
      // private browsing can refuse storage; only a reload loses the step
    }
  }

  function startCountdown() {
    stopCountdown();
    set({ resendIn: RESEND_SECONDS });
    ticker = every(() => {
      if (state.view !== "code" || state.resendIn <= 1) {
        stopCountdown();
        if (state.view === "code") set({ resendIn: 0 });
        return;
      }
      set({ resendIn: state.resendIn - 1 });
    }, 1000);
  }

  function stopCountdown() {
    if (ticker !== null) stop(ticker);
    ticker = null;
  }

  async function sendCode(email) {
    const captchaToken = captcha?.token() ?? null;
    if (captcha && !captchaToken) {
      return "Wait for the security check under the button to finish, then try again.";
    }
    const options = captchaToken ? { shouldCreateUser: true, captchaToken } : { shouldCreateUser: true };
    let error;
    try {
      ({ error } = await client.auth.signInWithOtp({ email, options }));
    } finally {
      captcha?.reset(); // each check works once
    }
    if (!error) return null;
    return error.status === 429
      ? "Too many tries. Wait a minute, then try again."
      : "We couldn't send a code just now. Try again in a minute.";
  }

  async function loadAccount() {
    const { data, error, status } = await client.rpc("my_account");
    if (error) {
      if (status === 401) {
        await logout();
        return false;
      }
      set({ account: null, checkProblem: "error" });
      return false;
    }
    const row = Array.isArray(data) ? data[0] : data;
    set({ account: row ?? null });
    return true;
  }

  async function runCheck() {
    set({ checking: true, checkProblem: null });
    let problem = null;
    try {
      const { data, error } = await client.functions.invoke("entitlement-refresh", { body: {} });
      if (error) problem = "error";
      else if (data?.checked === false) {
        problem = data.reason === "stripe_unavailable" ? "stripe" : data.reason === "cooldown" ? "cooldown" : "error";
      }
    } catch {
      problem = "error";
    }
    if (state.view !== "account") return;
    await loadAccount();
    if (state.view === "account") set({ checking: false, checkProblem: problem });
  }

  async function showAccount() {
    stopCountdown();
    remember(null);
    set({ view: "account", account: null, checking: true, checkProblem: null, error: null, busy: false });
    if (await loadAccount()) await runCheck();
    else if (state.view === "account") set({ checking: false });
  }

  async function logout() {
    stopCountdown();
    remember(null);
    try {
      await client.auth.signOut();
    } catch {
      // the local session is cleared either way
    }
    state = { view: "email" };
    show(state);
  }

  return {
    get state() {
      return state;
    },

    async start() {
      client.auth.onAuthStateChange?.((event) => {
        if (event === "SIGNED_OUT" && state.view === "account") {
          state = { view: "email" };
          show(state);
        }
      });
      const { data } = await client.auth.getSession();
      if (data?.session) return showAccount();
      let pending = null;
      try {
        pending = storage?.getItem(PENDING_EMAIL) ?? null;
      } catch {
        pending = null;
      }
      if (pending) set({ view: "code", email: pending, error: null, busy: false, resendIn: 0 });
      else set({ view: "email", email: "", error: null, busy: false });
    },

    async submitEmail(raw) {
      if (state.busy) return;
      const email = String(raw ?? "").trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return set({ email, error: "That doesn't look like an email address." });
      set({ email, busy: true, error: null });
      const problem = await sendCode(email);
      if (problem) return set({ busy: false, error: problem });
      remember(email);
      set({ view: "code", busy: false, error: null });
      startCountdown();
    },

    async submitCode(raw) {
      if (state.busy) return;
      const token = String(raw ?? "").replace(/\D/g, "");
      if (token.length !== 6) return set({ error: "The code is the 6 digits in the email." });
      set({ busy: true, error: null });
      const { data, error } = await client.auth.verifyOtp({ email: state.email, token, type: "email" });
      if (error || !data?.session) {
        return set({ busy: false, error: "That code didn't work. Check it, or send a new one." });
      }
      return showAccount();
    },

    async resend() {
      if (state.view !== "code" || state.busy || state.resendIn > 0) return;
      set({ busy: true, error: null });
      const problem = await sendCode(state.email);
      set({ busy: false, error: problem });
      if (!problem) startCountdown();
    },

    changeEmail() {
      stopCountdown();
      remember(null);
      set({ view: "email", error: null, busy: false });
    },

    check() {
      return state.view === "account" && !state.checking ? runCheck() : Promise.resolve();
    },

    logout,
  };
}
