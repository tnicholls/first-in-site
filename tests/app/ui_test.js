import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { day, dayTime, esc, memberLine, render, upgradeLink } from "../../app/ui.js";

const NOW = new Date("2026-10-25T12:00:00Z");
const CONFIG = {
  upgradeUrl: "https://buy.stripe.com/test_abc",
  priceLabel: "£2.99 a month",
  trialDays: 14,
  botUrl: "https://t.me/FirstInExeterBot?start=web_app",
  freeChannelUrl: "https://t.me/FirstInExeter",
};
const FREE = {
  email: "sam@exeter.ac.uk",
  is_member: false,
  member_until: null,
  reason: null,
  status: null,
  trial_end: null,
  period_end: null,
  ends_at: null,
  banned: false,
  checked_at: "2026-10-25T11:59:00Z",
  check_failed: false,
};
const MEMBER = {
  ...FREE,
  is_member: true,
  reason: "subscription",
  status: "active",
  period_end: "2026-11-20T10:00:00Z",
  member_until: "2026-11-23T10:00:00Z",
};
const account = (a, extra = {}) => render({ view: "account", account: a, ...extra }, CONFIG, NOW);

Deno.test("esc escapes everything that matters in HTML", () => {
  assertEquals(esc(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assertEquals(esc(null), "");
});

Deno.test("dates are UK time, across the clock change", () => {
  assertEquals(day("2026-11-08T23:30:00Z"), "Sun 8 Nov"); // GMT
  assertEquals(dayTime("2026-10-24T23:30:00Z"), "Sun 25 Oct, 00:30"); // BST
});

Deno.test("what's typed and what comes back is never HTML", () => {
  const evil = `"><img src=x onerror=alert(1)>`;
  for (const html of [
    render({ view: "email", email: evil }, CONFIG, NOW),
    render({ view: "code", email: evil, resendIn: 0 }, CONFIG, NOW),
    account({ ...FREE, email: evil }),
    account({ ...MEMBER, email: evil }),
  ]) {
    assert(!html.includes("<img"), html);
  }
});

Deno.test("the code screen counts down to the resend button", () => {
  const waiting = render({ view: "code", email: "a@b.co", resendIn: 42 }, CONFIG, NOW);
  assertStringIncludes(waiting, "New code in 42s");
  assert(/data-action="resend" disabled/.test(waiting));
  const ready = render({ view: "code", email: "a@b.co", resendIn: 0 }, CONFIG, NOW);
  assertStringIncludes(ready, "Send a new code");
  assert(!/data-action="resend" disabled/.test(ready));
});

Deno.test("free and member accounts look different", () => {
  const free = account(FREE);
  const member = account(MEMBER);
  assertStringIncludes(free, `<p class="status">Free account</p>`);
  assertStringIncludes(free, "You're on the free plan");
  assertStringIncludes(free, `class="app-tag">Members</span>`);
  assert(!free.includes("app-panel--member"));
  assertStringIncludes(member, `<p class="status status--live">Member</p>`);
  assertStringIncludes(member, "app-panel--member");
  assertStringIncludes(member, "Your membership renews on Fri 20 Nov.");
  assert(!member.includes("app-upgrade"), "no subscribe box for members");
});

Deno.test("the subscribe box says price, trial, first charge, card and cancelling before the link", () => {
  const html = account(FREE);
  const box = html.slice(html.indexOf("app-upgrade"));
  const link = box.indexOf("<a ");
  for (const needed of ["2 weeks free", "£2.99 a month", "A card is needed", "cancel", "Sun 8 Nov"]) {
    assert(box.indexOf(needed) !== -1 && box.indexOf(needed) < link, `"${needed}" comes before the link`);
  }
  assertStringIncludes(box, "https://buy.stripe.com/test_abc?prefilled_email=sam%40exeter.ac.uk");
  assertStringIncludes(box, "Start my free 2 weeks");
});

Deno.test("without a Payment Link or price, the box sends people to the bot", () => {
  for (const config of [{ ...CONFIG, upgradeUrl: "" }, { ...CONFIG, priceLabel: "" }]) {
    const html = render({ view: "account", account: FREE }, config, NOW);
    assertStringIncludes(html, `href="https://t.me/FirstInExeterBot?start=web_app"`);
    assert(!html.includes("buy.stripe.com"));
  }
});

Deno.test("nothing ever says a card isn't needed", () => {
  const states = [
    render({ view: "email", email: "" }, CONFIG, NOW),
    render({ view: "code", email: "a@b.co", resendIn: 0 }, CONFIG, NOW),
    account(FREE),
    account(MEMBER),
    account({ ...MEMBER, reason: "trial", trial_end: "2026-11-05T12:00:00Z" }),
    render({ view: "account", account: FREE }, { ...CONFIG, upgradeUrl: "" }, NOW),
  ];
  for (const html of states) assert(!/no card/i.test(html));
});

Deno.test("banned: no subscribe box, no check button, a note", () => {
  const html = account({ ...FREE, banned: true, member_until: "2027-01-01T00:00:00Z", reason: "grant" });
  assert(!html.includes("app-upgrade"));
  assert(!html.includes(`data-action="check"`));
  assertStringIncludes(html, "can't have member features");
  assert(!html.includes("membership ended"));
});

Deno.test("a lapsed membership says when it ended", () => {
  assertStringIncludes(account({ ...FREE, reason: "subscription", member_until: "2026-10-20T09:00:00Z" }),
    "Your membership ended on Tue 20 Oct.");
});

Deno.test("each reason gets its own sentence", () => {
  const t = "2026-11-05T12:00:00Z";
  assertEquals(memberLine({ reason: "trial", trial_end: t }), "Your free trial runs until Thu 5 Nov. Your first payment is taken then.");
  assertEquals(memberLine({ reason: "trial", trial_end: t, ends_at: t }), "Your free trial ends on Thu 5 Nov, and you won't be charged.");
  assertEquals(memberLine({ reason: "subscription", ends_at: t }), "Your membership ends on Thu 5 Nov. You won't be charged again.");
  assertStringIncludes(memberLine({ reason: "grace", member_until: t }), "until Thu 5 Nov, 12:00");
  assertStringIncludes(memberLine({ reason: "cancelled_in_trial", trial_end: t }), "Membership ends on Thu 5 Nov.");
  assertEquals(memberLine({ reason: "grant", member_until: t }), "First In has given you membership until Thu 5 Nov.");
  assertEquals(memberLine({ reason: null }), "Your membership is active.");
});

Deno.test("the check line", () => {
  assertStringIncludes(account(FREE, { checking: true }), "Checking your subscription…");
  assertStringIncludes(account(FREE, { checkProblem: "stripe" }), "reach Stripe just now");
  assertStringIncludes(account({ ...FREE, check_failed: true }), "reach Stripe just now");
  assertStringIncludes(account(FREE, { checkProblem: "error" }), "Something went wrong");
  assertStringIncludes(account(FREE, { checkProblem: "cooldown" }), "Checked a moment ago.");
});

Deno.test("no account yet: loading, or a way to try again", () => {
  assertStringIncludes(render({ view: "account", account: null, checking: true }, CONFIG, NOW), "Loading your account");
  const failed = render({ view: "account", account: null, checking: false, email: "a@b.co" }, CONFIG, NOW);
  assertStringIncludes(failed, `data-action="check"`);
  assertStringIncludes(failed, `data-action="logout"`);
});

Deno.test("upgradeLink adds the email properly, or leaves a bad URL alone", () => {
  assertEquals(upgradeLink("https://buy.stripe.com/test_1?x=1", "a+b@c.co"), "https://buy.stripe.com/test_1?x=1&prefilled_email=a%2Bb%40c.co");
  assertEquals(upgradeLink("not a url", "a@b.co"), "not a url");
});
