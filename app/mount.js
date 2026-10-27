// Puts the app on the page: renders each state into root, keeps what's been
// typed across re-renders, and turns clicks and submits into controller calls.
// Used by app.js (real Supabase) and tools/demo.js (a pretend one).
import { createApp } from "./controller.js";
import { render } from "./ui.js";

export function mountApp(root, { client, config, captchaBox = null }) {
  const captcha = captchaBox && config.turnstileSiteKey ? turnstile(captchaBox, config.turnstileSiteKey) : null;

  function show(state) {
    captcha?.show(state.view === "email" || state.view === "code");
    // Re-rendering replaces the form, so keep what's been typed and where the focus was.
    const focused = document.activeElement?.id;
    const typed = new Map([...root.querySelectorAll("input[id]")].map((i) => [i.id, i.value]));
    const sameView = root.dataset.view === state.view;
    root.innerHTML = render(state, config);
    root.dataset.view = state.view;
    if (sameView) {
      for (const [id, value] of typed) {
        const input = document.getElementById(id);
        if (input && id !== "email") input.value = value; // the email field shows state.email
      }
    }
    const target = (focused && sameView && document.getElementById(focused)) ||
      root.querySelector("[data-autofocus]");
    if (target && !target.disabled) target.focus();
  }

  const app = createApp({ client, show, captcha });

  root.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    if (form.dataset.form === "email") app.submitEmail(form.elements.email.value);
    if (form.dataset.form === "code") app.submitCode(form.elements.code.value);
  });

  root.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "resend") app.resend();
    if (action === "change-email") app.changeEmail();
    if (action === "check") app.check();
    if (action === "logout") app.logout();
  });

  app.start();
  return { app, show };
}

/**
 * Cloudflare Turnstile (free), when config.turnstileSiteKey is set: the check
 * Supabase Auth asks for before it sends a code. It lives outside the part of
 * the page that re-renders, so it isn't reset every second by the countdown.
 */
function turnstile(box, siteKey) {
  let token = null;
  let widget = null;
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.onload = () => {
    widget = globalThis.turnstile.render(box, {
      sitekey: siteKey,
      theme: "dark",
      size: "flexible",
      callback: (t) => (token = t),
      "expired-callback": () => (token = null),
      "error-callback": () => (token = null),
    });
  };
  document.head.append(script);
  return {
    token: () => token,
    reset() {
      token = null;
      if (widget !== null) globalThis.turnstile.reset(widget);
    },
    show(visible) {
      box.hidden = !visible;
    },
  };
}
