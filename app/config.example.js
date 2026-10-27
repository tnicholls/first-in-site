// The app's settings. For testing on this Mac, copy this to config.local.js (git
// ignores it). When going live, copy it to config.js with the hosted project's
// values and commit that: everything here is public anyway. The anon (or
// publishable) key is meant to be in the browser, and the database's rules, not
// the key, decide what it can do (supabase/migrations).
export default {
  // `supabase status` prints both for the local stack. For a hosted project:
  // Dashboard > Project Settings > API.
  supabaseUrl: "http://127.0.0.1:54321",
  supabaseAnonKey: "",

  // The subscribe box. With both set, "Start my free 2 weeks" opens this Stripe
  // Payment Link (test mode) with the login email filled in, after saying the
  // price, the trial and the first-charge date. Leave either empty to send people
  // to the Telegram bot instead. A shared link can't stop one person starting
  // trials with several emails (the functions only count each email's first
  // trial), so keep it for a friends pilot, or leave it empty.
  upgradeUrl: "",
  priceLabel: "£2.99 a month",
  trialDays: 14,

  // Optional and free: Cloudflare Turnstile, so nobody can script "Send me a code" and
  // use up the day's emails. The site key goes here, the secret key in Supabase
  // (Authentication > Attack Protection > CAPTCHA, provider Turnstile). Empty: off.
  // For trying it locally, Cloudflare's test key 1x00000000000000000000AA always passes.
  turnstileSiteKey: "",

  botUrl: "https://t.me/FirstInExeterBot?start=web_app",
  freeChannelUrl: "https://t.me/FirstInExeter",
};
