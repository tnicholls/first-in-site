// Starts the real app: reads the config and makes the Supabase client (from
// vendor/, loaded before this). The logic is in controller.js and ui.js.
//
// The config is config.js, the live one, committed when the app goes live. When
// the page is opened from this Mac (127.0.0.1 or localhost), config.local.js
// comes first if it exists: git ignores it, so local test keys never reach the site.
import { mountApp } from "./mount.js";
import { render } from "./ui.js";

const root = document.getElementById("app");
const onThisMachine = ["127.0.0.1", "localhost"].includes(location.hostname);
const config = await (onThisMachine ? import("./config.local.js").catch(() => import("./config.js")) : import("./config.js"))
  .then((m) => m.default)
  .catch(() => null);

if (globalThis.top !== globalThis.self) {
  // Never inside someone else's page (GitHub Pages can't send frame-ancestors).
  root.innerHTML = render({ view: "broken", message: "Open First In in its own tab." }, {});
} else if (!config?.supabaseUrl || !config?.supabaseAnonKey || !globalThis.supabase?.createClient) {
  root.innerHTML = render({ view: "broken", message: "The app's config is missing or incomplete (see app/config.example.js)." }, {});
} else {
  const client = globalThis.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  mountApp(root, { client, config, captchaBox: document.getElementById("captcha") });
}
