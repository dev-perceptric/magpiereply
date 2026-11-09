# MagpieReply fork guide

MagpieReply is a fork of Chatwoot's open source core. This page covers what changed from upstream, how to bring in upstream updates, where new work goes, and what it costs to run.

## Upstream

- Source: https://github.com/chatwoot/chatwoot
- Imported at commit `2ecbeb2188f4afcdae6485bab25644f5942003d5` (November 6, 2026).
- The import was copied in as one commit, without Chatwoot's history, so every MagpieReply change shows up as its own commit after it.

## What changed from upstream

| Area | Change |
|---|---|
| Paid code | `enterprise/` and `spec/enterprise/` removed. They're under Chatwoot's commercial license. The app checks for the folder and runs as the community edition without it, the same way Chatwoot's own community build does. |
| CI | Removed workflows that only work in Chatwoot's org (Docker Hub publishing, Linear and Slack syncs, Heroku deploy checks, stale bots), plus `FUNDING.yml` and `CODEOWNERS`. |
| Name | Installation name and brand name default to MagpieReply (`config/installation_config.yml`). English text (`en.json`, `en.yml`) and server fallbacks say MagpieReply. |
| White-label | `replaceInstallationName` now swaps both "MagpieReply" and "Chatwoot" for a customer's own installation name. |
| Logo | New logo, dark logo, thumbnail, every favicon and app icon, the chat launcher bubble and the bot avatar. |
| Color | The blue scale behind buttons, links and focus rings centers on `#0943b0` in light and dark mode (`_next-colors.scss`, `theme/colors.js`), along with emails, the manifest and default widget and portal colors. |
| Font | Inter leads the default font stack in the app, widget, help center and emails. |
| UI style | The app follows the website's look: 1px inner rings and a soft lift on gray buttons, 6px button corners, 4px tags, 8px bubbles and cards with a card shadow, small uppercase group labels, a dot ground behind messages and one sticker on the empty conversation screen. Tokens live in `tailwind.config.js` (`shadow-ring`, `shadow-card`, `shadow-sticker`, `tracking-label`, `bg-dot-grid`) and `_next-colors.scss` (ring and dot colors for light and dark). |
| Docker | `docker-compose.production.yaml` builds the MagpieReply image from this repo instead of pulling `chatwoot/chatwoot`. |
| Website | New marketing site in `website/`. |

Technical names stay as they are: the `X-Chatwoot-*` headers, the `$chatwoot` widget SDK, `ChatwootApp`, Chatwoot Hub and Chatwoot Cloud config keys. Renaming those would break the mobile apps, the widget SDK and existing installs.

## Pulling in upstream updates

Because the import has no shared history with Chatwoot, bring updates over as patches:

```bash
git remote add upstream https://github.com/chatwoot/chatwoot
```

```bash
git fetch upstream develop
```

```bash
git log --oneline 2ecbeb2188f4afcdae6485bab25644f5942003d5..upstream/develop
```

```bash
git cherry-pick <commit>
```

After each sync:

- Drop any changes under `enterprise/` or `spec/enterprise/` from the picked commits.
- Search new English strings for "Chatwoot" and decide whether they should say MagpieReply.
- Update the commit hash in the Upstream section above to the last upstream commit you brought over.

## Where new work goes

- **AI agent:** build it as its own service, connected through the agent bot hook (`AgentBot` with an outgoing URL). Chatwoot sends each new customer message there, and the agent replies or hands off through the API. This keeps the agent out of the Rails app and makes upstream syncs easier.
- **Changes inside the app:** `prepend_mod_with` already looks for a `Custom::` module when a `custom/` folder exists (`ChatwootApp.extensions`). Only `enterprise/` is on the load path in `config/application.rb`, so add `custom/` there the same way before putting MagpieReply-only overrides in it. That keeps core files close to upstream.

## Still to do

- **Domain and email:** `https://www.magpiereply.com` and `hello@magpiereply.com` are placeholders in `config/installation_config.yml` and `website/`. The domain is registered, but check that you own it before launch.
- **Other languages:** only English was renamed. The other locale files still say Chatwoot in places.
- **Help links:** some help links still point to Chatwoot's docs (`chwt.app`). They're hidden for custom-branded installs, but MagpieReply needs its own docs to link to.
- **Mobile apps:** the iOS and Android apps are Chatwoot's. They work with this backend but carry Chatwoot's name.
- **Security contact:** `SECURITY.md` still describes Chatwoot's process.

## Running cost

What the fork costs to run before the AI agent ships: the app, Sidekiq, Postgres, Redis and file storage, all as containers on the Hostinger VPS (`docs/hostinger.md`), plus email. Hostinger prices come from its billing catalog (November 2026).

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Server (a fifth of the shared KVM 2 at Beta, its own KVM 8 at Growth) | ~$3 | $49.99 |
| Postgres with pgvector, Redis, file storage (containers on the server) | $0 | $0 |
| Off-site backups (check) | ~$1 | ~$5 |
| Email sending (Resend Pro at Beta, larger plan at Growth, check) | $20 | $90 |
| Claude tokens | $0 | $0 |
| **Monthly total** | **~$24** | **~$145** |

The AI agent adds its own cost when it ships: about $2,071 a month at Beta and $20,650 at Growth, assuming 1,000 conversations per team each month with about 2.5 agent replies each (`docs/ai-agent-plan.md`).
