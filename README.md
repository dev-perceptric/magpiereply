# MagpieReply website

The marketing site: plain HTML, CSS and a small script, with no build step. It's served from the domain root, so links start with `/`.

## Pages

| Address | File |
|---|---|
| `/` | `index.html` |
| `/inbox/` | `inbox/index.html` |
| `/ai-agent/` | `ai-agent/index.html` |
| `/help-center/` | `help-center/index.html` |
| `/integrations/` | `integrations/index.html` |
| `/pricing/` | `pricing/index.html` |
| `/security/` | `security/index.html` |
| `/open-source/` | `open-source/index.html` |
| `/terms/`, `/privacy/` | `terms/index.html`, `privacy/index.html` |
| not found | `404.html` |

## Shared parts

- `styles.css`: all styles (brand blue `#0943b0`, Inter)
- `script.js`: pixel mosaics, tab groups, the phone menu, the pricing period switch and the integrations filter
- `assets/icons.svg`: every icon, used as `<svg><use href="/assets/icons.svg#i-NAME"/></svg>`
- `partials/nav.html` and `partials/footer.html`: the nav and footer on every page
- `partials/page-template.html`: start a new page from this
- `partials/product-template.html`: start a product page from this (hero, capability index, four showcases, proof, coming next, more, FAQ, CTA)
- The Product menu lives in `partials/nav.html`; its links point at product pages and their section ids
- `.htaccess`: Hostinger server settings

After editing the nav or footer, copy them into every page:

```bash
node tools/sync-chrome.mjs
```

The script also marks the current page's nav link.

## Keeping the site in step with the app

Features carry a state tag that matches the build plan in `docs/ai-agent-plan.md`:

- `state live`: works in the app today (the inbox and everything from the open source core)
- `state beta`, "Early access": phases 1 to 3 of Magpie AI
- `state soon`, "Coming": phases 4 to 9

When a phase ships, change its tags on `/ai-agent/`, `/integrations/` and `/pricing/`, and move it out of the "Coming next" row on each product page.

## Preview

```bash
cd website && python3 -m http.server 8080
```

Then open http://localhost:8080.

## Deploy

The site is hosted on Hostinger. Hostinger's Git deploy copies a whole branch into `public_html`, so the site's files are published to their own branch, `hostinger-site`, with `website/` as its top level.

After the site changes, publish the branch:

```bash
bash website/tools/publish-hostinger.sh
```

Hostinger deploys it on its own.

### First-time setup in hPanel

Add the site in hPanel as a Node.js project connected to GitHub, then use these build settings:

| Setting | Value |
|---|---|
| Repository | `dev-perceptric/magpiereply` |
| Branch | `hostinger-site` |
| Framework preset | Vite (or Other) |
| Root directory | `./` |
| Build command | `npm run build` (`npm run build:sdk` does the same, since hPanel may keep the app branch's command) |
| Package manager | npm |
| Output directory | `dist` |

The build only copies the public files into `dist/` (`tools/build.mjs`); there's nothing to compile and no packages to install. Hostinger deploys again on every push to `hostinger-site`.

magpiereply.com is registered elsewhere, so add the DNS records or nameservers hPanel shows at the domain's registrar, then turn on SSL in hPanel.

`.htaccess` sets the 404 page, forces HTTPS and hides the `partials/` and `tools/` folders.

## Before launch

- Prices on `/pricing/` and the homepage are early access prices. Starter is $49 ($44 yearly) and Growth is $149 ($134 yearly), at least 3 times the AI cost per team in `docs/ai-agent-plan.md`. Confirm them before launch.
- Have a lawyer review `/terms/` and `/privacy/`. They're plain-language drafts with no company name or governing law yet.
- Check the placeholder addresses: `hello@magpiereply.com`, `security@magpiereply.com`, `privacy@magpiereply.com` and `/app/login`.
- Book a demo and Get early access open an email. Swap in a form or a booking link when there is one.

## Running cost

Hostinger web hosting: $0 extra a month at Beta (50 teams) and Growth (500 teams) if it shares a plan already paid for. On its own, a Premium Web Hosting plan is about $3 to $12 a month depending on the term (check). Fonts load from Google Fonts at no cost.
