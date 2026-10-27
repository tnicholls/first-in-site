// What the app shows in each state, as HTML. No DOM and no network here, so
// the tests can check every state (tests/app/ui_test.js). Anything that comes
// from outside (emails, dates, config) goes through esc().

const TZ = "Europe/London";

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

/** "Sat 8 Nov", in UK time. */
export function day(value) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TZ })
    .format(new Date(value));
}

/** "Sat 8 Nov, 18:00", in UK time. */
export function dayTime(value) {
  const d = new Date(value);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ }).format(d);
  return `${day(d)}, ${time}`;
}

export function render(state, config, now = new Date()) {
  switch (state.view) {
    case "email":
      return emailView(state);
    case "code":
      return codeView(state);
    case "account":
      return accountView(state, config, now);
    case "broken":
      return panel(`
        <h1 class="app-title">Not set up yet</h1>
        <p class="app-lede">${esc(state.message ?? "This page can't reach First In.")}</p>`);
    default:
      return `<p class="app-status" role="status">Loading…</p>`;
  }
}

function panel(inner, extraClass = "") {
  return `<section class="app-panel ${extraClass}">${inner}</section>`;
}

function errorLine(error) {
  return error ? `<p class="app-error" role="alert">${esc(error)}</p>` : "";
}

function emailView(state) {
  return panel(`
    <p class="app-kicker">First In Exeter</p>
    <h1 class="app-title">Log in or make an account</h1>
    <p class="app-lede">Type your email and we'll send you a 6-digit code. New here? The same code makes your free account.</p>
    <form data-form="email" novalidate>
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required
        autocapitalize="off" spellcheck="false" value="${esc(state.email)}" data-autofocus>
      ${errorLine(state.error)}
      <button class="btn btn--solid btn--block" type="submit"${state.busy ? " disabled" : ""}>
        ${state.busy ? "Sending…" : "Send me a code"}</button>
    </form>
    <p class="app-small">Paying for First In? Use the email you paid with, so we can find your subscription.</p>`);
}

function codeView(state) {
  const wait = state.resendIn > 0;
  return panel(`
    <p class="app-kicker">First In Exeter</p>
    <h1 class="app-title">Check your email</h1>
    <p class="app-lede">We've sent a 6-digit code to <strong>${esc(state.email)}</strong>. It works for 10 minutes.</p>
    <form data-form="code" novalidate>
      <label for="code">Code</label>
      <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"
        pattern="[0-9]*" maxlength="6" required data-autofocus>
      ${errorLine(state.error)}
      <button class="btn btn--solid btn--block" type="submit"${state.busy ? " disabled" : ""}>
        ${state.busy ? "Checking…" : "Log in"}</button>
    </form>
    <p class="app-small">No email after a minute? Check your spam folder.</p>
    <div class="app-row">
      <button class="btn btn--quiet btn--small" type="button" data-action="resend"${wait ? " disabled" : ""}>
        ${wait ? `New code in ${esc(state.resendIn)}s` : "Send a new code"}</button>
      <button class="btn btn--quiet btn--small" type="button" data-action="change-email">Use a different email</button>
    </div>`);
}

function accountView(state, config, now) {
  const a = state.account;
  if (!a) {
    if (state.checking) return `<p class="app-status" role="status">Loading your account…</p>`;
    return panel(`
      <h1 class="app-title">Something's wrong</h1>
      <p class="app-lede">We couldn't load your account. Try again in a minute.</p>
      <div class="app-row"><button class="btn btn--small" type="button" data-action="check">Try again</button></div>
      ${footer(state)}`);
  }
  return a.is_member ? memberView(state, a, config) : freeView(state, a, config, now);
}

function memberView(state, a, config) {
  return panel(`
    <p class="status status--live">Member</p>
    <h1 class="app-title">You're a member</h1>
    <p class="app-lede">${esc(memberLine(a))}</p>
    <ul class="app-features" aria-label="What you get">
      <li class="is-soon">Pick your nights and your entry time, and get an instant alert on this phone
        the second their tickets drop <span class="app-tag">Coming next</span></li>
      <li class="is-soon">See every alert you've had, and when it reached you <span class="app-tag">Coming next</span></li>
      <li class="is-on">New events as they're listed, in the
        <a href="${esc(config.freeChannelUrl)}" rel="noopener">free Telegram channel</a></li>
    </ul>
    ${checkLine(state, a)}
    ${footer(state)}`, "app-panel--member");
}

/** The one sentence under "You're a member": what's going on with their membership. */
export function memberLine(a) {
  switch (a.reason) {
    case "trial":
      return a.ends_at
        ? `Your free trial ends on ${day(a.ends_at)}, and you won't be charged.`
        : `Your free trial runs until ${day(a.trial_end ?? a.period_end)}. Your first payment is taken then.`;
    case "subscription":
      if (a.ends_at) return `Your membership ends on ${day(a.ends_at)}. You won't be charged again.`;
      return a.period_end ? `Your membership renews on ${day(a.period_end)}.` : "Your membership is active.";
    case "grace":
      return `Your last payment didn't go through. Your membership carries on until ${
        dayTime(a.member_until)
      }: update your card from Stripe's email to keep it.`;
    case "cancelled_in_trial":
      return `You cancelled during your free trial, so you won't be charged. Membership ends on ${
        day(a.trial_end ?? a.member_until)
      }.`;
    case "grant":
      return `First In has given you membership until ${day(a.member_until)}.`;
    default:
      return "Your membership is active.";
  }
}

function freeView(state, a, config, now) {
  const ended = a.member_until && new Date(a.member_until) <= now && !a.banned
    ? `<p class="app-lede">Your membership ended on ${esc(day(a.member_until))}.</p>`
    : "";
  return panel(`
    <p class="status">Free account</p>
    <h1 class="app-title">You're on the free plan</h1>
    ${ended}
    <ul class="app-features" aria-label="What you get">
      <li class="is-on">New events as they're listed, and how fast the last drop sold out, in the
        <a href="${esc(config.freeChannelUrl)}" rel="noopener">free Telegram channel</a></li>
      <li class="is-locked">An instant alert the second tickets drop for your nights
        <span class="app-tag">Members</span></li>
      <li class="is-locked">Your entry time named in every alert <span class="app-tag">Members</span></li>
    </ul>
    ${a.banned ? bannedNote() : upgradeBox(a, config, now)}
    ${a.banned ? "" : `<p class="app-small">Already paid?
      <button class="app-linkbutton" type="button" data-action="check">Check again</button></p>`}
    ${checkLine(state, a)}
    ${footer(state)}`);
}

function bannedNote() {
  return `<p class="app-notice">This account can't have member features. If you think that's a mistake, message First In.</p>`;
}

/**
 * The subscribe box. Like the member bot, it says the price, the trial length,
 * the first-charge date, that a card is needed and that they can cancel, before
 * the Stripe link. Without a price in the config it sends them to the bot,
 * which says all of that itself.
 */
function upgradeBox(a, config, now) {
  const days = Number(config.trialDays) || 14;
  const firstCharge = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const trialName = days === 14 ? "2 weeks" : `${days} days`;
  if (config.upgradeUrl && config.priceLabel) {
    return `
    <div class="app-upgrade">
      <h2>Be first in</h2>
      <p>${esc(trialName)} free, then ${esc(config.priceLabel)}. A card is needed, and you can cancel any time
        before your first payment on ${esc(day(firstCharge))}.</p>
      <a class="btn btn--solid btn--block" href="${esc(upgradeLink(config.upgradeUrl, a.email))}" rel="noopener">
        Start my free ${esc(trialName)}</a>
      <p class="app-small">Pay with ${esc(a.email)}, so we can match your subscription to this account.</p>
    </div>`;
  }
  return `
    <div class="app-upgrade">
      <h2>Be first in</h2>
      <p>Membership starts with ${esc(trialName)} free, in the First In bot on Telegram. It shows the price and
        your first-charge date before you pay.</p>
      <a class="btn btn--solid btn--block" href="${esc(config.botUrl)}" rel="noopener">Open the First In bot</a>
      <p class="app-small">At Stripe's checkout, use ${esc(a.email)}, so we can match your subscription to this account.</p>
    </div>`;
}

/** A Stripe Payment Link with the login email filled in, so the subscription matches. */
export function upgradeLink(url, email) {
  try {
    const u = new URL(url);
    u.searchParams.set("prefilled_email", email);
    return u.toString();
  } catch {
    return url;
  }
}

function checkLine(state, a) {
  let text = "";
  if (state.checking) text = "Checking your subscription…";
  else if (state.checkProblem === "stripe" || (a.check_failed && !state.checkProblem)) {
    text = "We couldn't reach Stripe just now, so this may be out of date. Try again in a minute.";
  } else if (state.checkProblem === "error") text = "Something went wrong checking your subscription. Try again in a minute.";
  else if (state.checkProblem === "cooldown") text = "Checked a moment ago.";
  return `<p class="app-status" role="status" aria-live="polite">${esc(text)}</p>`;
}

function footer(state) {
  const who = state.account?.email ?? state.email;
  return `<p class="app-small app-footer">${who ? `Logged in as ${esc(who)}. ` : ""}
    <button class="app-linkbutton" type="button" data-action="logout">Log out</button></p>`;
}
