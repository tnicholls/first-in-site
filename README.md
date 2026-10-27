# First In – website

The public website for **First In**: Telegram alerts for UK student nights. We tell students the moment tickets drop for their city's big student nights, so they can buy at face value before they sell out. It starts with Exeter ("First In Exeter"). Bristol and Bath are listed as coming soon.

It's a plain static site: HTML, one CSS file and one small script. No build step, no frameworks, nothing to install. Every path is relative, so it works on a GitHub Pages project URL and on a custom domain.

The account app (log in, free or member) is `app/`, with its backend in `supabase/`. It has its own guide: [ACCOUNTS.md](ACCOUNTS.md).

## What's where

| Path | What it is |
|---|---|
| `index.html` | Home: hero, how it works, the three uni cards |
| `exeter/index.html` | First In Exeter: free channel + instant alerts (bot) |
| `bristol/index.html`, `bath/index.html` | Coming-soon pages. No channel links on purpose. |
| `credits/index.html` | Photo and font credits (required by the licences) |
| `404.html` | Not-found page (GitHub Pages uses it automatically) |
| `assets/css/style.css` | All styles. Palettes are set per page with a body class. |
| `assets/js/main.js` | Pins the header, and fades sections in and out as you scroll (off for reduced motion). The site works without it. |
| `assets/fonts/` | Self-hosted League Gothic and Space Mono (Latin subset), plus their OFL licences |
| `assets/img/` | The three Exeter photos, plus the Bristol (Wills Memorial Building) and Bath (Bath Abbey) photos supplied by First In and free to use. Full size and `-900` versions for phones/cards, plus `credits.json` |
| `assets/favicon.svg` | The ticket-with-a-1 logo |
| `assets/apple-touch-icon.png` | 180×180 PNG of the logo for iOS "Add to Home Screen" |
| `tools/check_site.py` | Link, HTML and content checker (see below) |
| `app/` | The account app: log in with an email code, free or member. See [ACCOUNTS.md](ACCOUNTS.md) |
| `supabase/` | The account app's backend (database and functions), deployed to Supabase, not by GitHub Pages |
| `tests/`, `tools/test_db.py`, `tools/make_vectors.py` | The account app's tests |
| `tools/demo.html`, `tools/serve.py` | The account app on a pretend backend, and a local server that hides `supabase/` and dotfiles |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |
| `.gitignore` | Keeps `.claude/` (local preview config), `.DS_Store` and the account app's local test keys out of the repo. With `.nojekyll`, anything committed is served publicly. |

## Links used on the site

| Where | Link |
|---|---|
| Exeter free channel | `https://t.me/FirstInExeter` |
| Exeter instant alerts (bot) | `https://t.me/FirstInExeterBot?start=web_exeter` |

The home page only links to the uni pages, never straight to a channel or the bot. Bristol and Bath have no Telegram links until their channels exist.

## Preview locally

```bash
cd ~/first-in-site
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Use the server rather than double-clicking the files, because the links point at folders (`exeter/`) and a browser opening files directly won't turn those into `index.html`.

When you're testing the account app with its local test keys, use `python3 tools/serve.py` instead. It serves the same, at <http://127.0.0.1:8000>, but never `supabase/` (where the Stripe test key sits) or dotfiles.

## Check before publishing

```bash
python3 tools/check_site.py
```

It checks that every local link, image, font and stylesheet path exists, `#anchor` links point at real ids, the HTML is well formed, every image has alt text and a size, every photo used is credited, and the messaging rules hold (footer disclaimer on every page, no Telegram links on the home or coming-soon pages, both Exeter links present). It prints "All checks passed." or a list of problems.

## Publish with GitHub Pages

1. Create a GitHub repository (for example `first-in-site`) and push this folder to its `main` branch.
2. In the repo, go to **Settings > Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, then branch `main` and folder `/ (root)`. Save.
4. After a minute or two the site is live at `https://<your-username>.github.io/first-in-site/`.

## Point the Squarespace domain at it (later)

Do this once you're happy with the site. Don't add a `CNAME` file before then.

1. **GitHub:** in **Settings > Pages > Custom domain**, enter the domain you bought on Squarespace (for example `www.example.co.uk`) and save. GitHub commits a `CNAME` file containing the domain to the repo. You can also add that file yourself: a file called `CNAME` in the repo root containing just the domain on one line.
2. **Squarespace:** open **Domains**, pick the domain, then **DNS settings**. Remove any Squarespace default records that clash, then add:
   - For the bare domain (`@`): four `A` records pointing to `185.199.108.153`, `185.199.109.153`, `185.199.110.153` and `185.199.111.153`. Optionally add `AAAA` records for `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153` and `2606:50c0:8003::153`.
   - For `www`: a `CNAME` record pointing to `<your-username>.github.io`.
3. Wait for DNS to update (minutes to a few hours). Then tick **Enforce HTTPS** in GitHub's Pages settings.
4. Recommended: verify the domain under your GitHub account settings (**Settings > Pages > Verified domains**) so nobody else can claim it.

Check GitHub's "Managing a custom domain for your GitHub Pages site" guide for the current IP addresses before you change DNS.

### Once the domain is live

Add these to each page's `<head>` so link previews (Telegram, iMessage, Instagram) show a picture. They need full URLs, which is why they aren't there yet:

```html
<meta property="og:url" content="https://YOUR-DOMAIN/exeter/">
<meta property="og:image" content="https://YOUR-DOMAIN/assets/img/exeter-cathedral-night-900.jpg">
```

## Design notes

- Inspired by the feel of Squarespace's "Singularity" template. No code or text is copied from it.
- **Type:** League Gothic (headings, always uppercase) stands in for Rama Gothic. It only comes in one weight, which is already heavy, so headings use it as is rather than faking a bolder weight. Space Mono is used for everything else.
- **Palettes:** the home page, coming-soon pages, credits and 404 are neutral black, `#171717`, `#dcdcdc`, `#fafafa` and white. The Exeter page uses forest green, brass and ivory, with green-tinted photos. Bristol gets a "Bristol blue" accent and Bath a spa-water accent. Each palette is a block of CSS variables at the top of `style.css` (`.theme-exeter`, `.theme-bristol`, `.theme-bath`). Text colours were picked to pass WCAG AA contrast, and the ratios are noted beside them in the CSS.
- **Hero word:** sized from the font's measured letter widths so each word runs about 5% past both edges of the screen. The size is purely width-driven and never shrinks to fit the height, so on wide, short screens the hero runs past the fold and the tagline sits just below it. The slow drift (±2vw) is smaller than the overflow, so both edges stay cropped throughout. It switches off for anyone with "reduce motion" turned on.
- **Photos:** three of Exeter (river at twilight, the cathedral, the quay), used under Creative Commons licences, and one each of Bristol (Wills Memorial Building) and Bath (Bath Abbey), supplied by First In. Greyscale on the home page apart from the uni cards, which are duotone in each city's colours like the city pages. The coming-soon pages use a photo band like Exeter's. All effects are CSS (`mix-blend-mode`), so the image files stay untouched apart from resizing.
- **Scroll fades:** like Squarespace's fade animation. Sections and photos fade up as they scroll into view and reset once they're well off screen, so they fade in again on the way back. The hero fades in on load. All of it switches off for "reduce motion" and for printing, and nothing is hidden if `main.js` doesn't load.

## Adding a new uni

1. Copy `bristol/` to a new folder, for example `leeds/`, and change the name, coordinates, text and `theme-…`/`page-…` classes. The copy includes Bristol's photo band, so swap in the new city's photo (full size and `-900`) and credit it (step 5).
2. Add a `.theme-leeds` palette block and a `.page-leeds { --hero-size: …vw; --hero-nudge: …em; }` line to `style.css`. For the size, roughly `110 / (letter width)`; the existing values are a good guide. The nudge (about `-0.015em` to `-0.035em`) centres the letters' ink so both edges crop equally.
3. Add a card to the "Choose your uni" list on `index.html`.
4. When the channel exists, switch the page to the Exeter layout and add the real Telegram links. Never add a placeholder link.
5. Credit any new photo in `assets/img/credits.json` and `credits/index.html`, then run `python3 tools/check_site.py`.

## Rules for copy

- Say we help students get tickets at face value before they sell out.
- Never mention reselling, never explain how alerts are found, and never suggest a link with any venue or ticketing company.
- Every page's footer says: "Not affiliated with FIXR, Fatsoma or any venue."
- The brand is "First In" ("First In Exeter" on the Exeter page).
- British English: short, confident, a little dry.
