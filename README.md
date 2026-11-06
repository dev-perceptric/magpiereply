<p align="center">
  <img src="./public/brand-assets/logo.svg" width="260" alt="MagpieReply">
</p>

# MagpieReply

Customer support with one inbox for every channel, and an AI agent that answers, acts and closes the loop.

MagpieReply is built on the open source core of [Chatwoot](https://github.com/chatwoot/chatwoot) (MIT). See [docs/magpiereply.md](docs/magpiereply.md) for what changed, how to pull in upstream updates and what it costs to run.

## What's inside

- **Channels:** website chat, email (Google, Microsoft or any mail server), WhatsApp, Facebook Messenger, Instagram, TikTok, Telegram, LINE, SMS, X and an API channel.
- **Shared inbox:** statuses, priorities, assignment, teams, labels, private notes, mentions, saved replies, macros and bulk actions.
- **Automations:** rules that route, label and reply when a conversation matches, plus auto-resolve.
- **Help center:** several portals, custom domains, categories and languages.
- **Contacts and companies:** custom fields, notes, merging and imports.
- **Reports:** overview, agents, inboxes, teams, labels, satisfaction surveys and live views.
- **Integrations:** webhooks, dashboard apps, agent bots, Slack, Linear, Notion, Shopify, Stripe and more.
- **APIs:** a full app API, a platform API for creating accounts and users, and a public API for the chat widget and help center.

The AI agent is in development. It plugs in through the agent bot hook, so the inbox works on its own today.

## Run it locally

You need Ruby (version in `.ruby-version`), Node (version in `.nvmrc`), pnpm, PostgreSQL with the `pgvector` extension, and Redis.

```bash
cp .env.example .env
```

```bash
bundle install && pnpm install
```

```bash
bundle exec rails db:chatwoot_prepare
```

```bash
pnpm dev
```

Open http://localhost:3000 and sign up for the first account.

## Self-host with Docker

```bash
cp .env.example .env
```

```bash
docker compose -f docker-compose.production.yaml run --rm rails bundle exec rails db:chatwoot_prepare
```

```bash
docker compose -f docker-compose.production.yaml up -d
```

The production compose file builds the MagpieReply image from this repository.

## Tests

```bash
pnpm test
```

```bash
bundle exec rspec
```

## Website

The marketing site lives in [`website/`](website/README.md). It's plain HTML and CSS with no build step.

## License

MIT, the same as the Chatwoot core it's built on. The original copyright notice is kept in [LICENSE](LICENSE). Chatwoot's paid `enterprise/` code is not included.
