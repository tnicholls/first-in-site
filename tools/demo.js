// The real app (controller, ui, mount) on a pretend Supabase: see fake-client.js.
import { mountApp } from "../app/mount.js";
import { fakeClient } from "./fake-client.js";

const config = {
  upgradeUrl: "https://buy.stripe.com/test_demo",
  priceLabel: "£2.99 a month",
  trialDays: 14,
  botUrl: "https://t.me/FirstInExeterBot?start=web_app",
  freeChannelUrl: "https://t.me/FirstInExeter",
};
mountApp(document.getElementById("app"), { client: fakeClient(), config });
