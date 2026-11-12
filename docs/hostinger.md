# Running MagpieReply on the Hostinger VPS

MagpieReply runs on a Hostinger VPS with Docker and Traefik. Today it shares one server with Arrowsterr, Claritia, Omniscient and Capybaroar.

| Server | Plan | Size | Where |
|---|---|---|---|
| `srv2139771.hstgr.cloud` (45.90.109.7) | KVM 2 | 2 vCPU, 8 GB, 100 GB disk | Phoenix, US |

Each piece is a Docker Compose project in `/docker/<name>/docker-compose.yml`.

| Project | Containers | Address | Memory limit |
|---|---|---|---|
| `magpiereply` | `web` (Rails), `worker` (Sidekiq), `redis` | `app.magpiereply.com` | 1.5 GB, 1.25 GB, 256 MB |
| `magpiereply` | `agent-api`, `agent-worker` (`agent/`) | `agent.magpiereply.com` | 256 MB each |
| `sb-magpiereply` | Self-hosted Supabase: Postgres 17 with pgvector, auth, REST, storage. The app, the agent and the gateway use its `db` container over the `sb-magpiereply` network | `db.magpiereply.com` | about 1.4 GB in all |
| `magpie-brain` | The Magpie AI brain (`brain/`): the Magpie engine on Claude, Voyage for search, Stripe over MCP in test mode | inside Docker only, `http://brain:8800` on `magpiereply_default` | 768 MB |
| `magpie-reader` | The reader (`brain/magpie_reader`): websites with Crawl4AI and files with Docling, for Magpie's knowledge. On its own `magpie-reader` network; only `agent-worker` joins it | inside Docker only, `http://reader:8810` | 2.5 GB |
| `magpie-gateway` | ContextForge MCP gateway, made but stopped (profile `trial`) | none yet | 1 GB |
| `traefik` | HTTPS and routing for every app (Let's Encrypt) | | |
| `autodeploy` | Pulls new images every 5 minutes and restarts what changed | | 64 MB |
| `magpie-backup` | Nightly database and attachments backups, off-site copy and monthly restore check (`docker/backup/`) | | 256 MB |
| `uptime` | Gatus, with alerts to ntfy | | 96 MB |

**Database and files.** Since November 8, 2026 the app (`postgres` login), the agent (`magpie_agent`) and the gateway (`magpie_gateway`) connect to `db:5432` in `sb-magpiereply`, so every query stays on the server. File attachments are on the `storage-data` volume (`ACTIVE_STORAGE_SERVICE=local`, mounted at `/app/storage` in `web` and `worker`). The old hosted Supabase project in Tokyo (`jxsddbtdpypwfcjogxym`) is no longer used and can be paused, then deleted after a week.

## How a change goes live

1. Push to `claude/brave-mayer-66phgz`.
2. `.github/workflows/build-images.yml` builds `ghcr.io/dev-perceptric/magpiereply`, `magpie-agent`, `magpie-brain` and `magpie-reader` and tags them `latest`.
3. Within 5 minutes, `autodeploy` pulls the new images and restarts `web`, `worker`, `agent-api`, `agent-worker`, `brain` and `reader`.
4. Rails runs its migrations on start (`docker/entrypoints/rails.sh`). The agent runs its own on start of `agent-api` and `agent-worker`.

Gatus checks `https://app.magpiereply.com/api` (database and queue both `ok`) and `https://agent.magpiereply.com/health` every 2 minutes and sends an ntfy alert after 3 misses.

## Everyday commands

Run these on the server over SSH.

Logs:

```bash
cd /docker/magpiereply && docker compose logs -f --tail 200 web worker agent-worker
```

Rails console:

```bash
cd /docker/magpiereply && docker compose exec web bundle exec rails c
```

Connect a team to the agent (asks for an administrator API key from Profile settings → Access token):

```bash
cd /docker/magpiereply && docker compose exec agent-worker node dist/enable-team.js --account <id> --inboxes <id,id>
```

Database shell:

```bash
docker exec -it sb-magpiereply-db-1 psql -U postgres
```

## Secrets

Secrets live in `/docker/<project>/.env` on the server and never in this repo. The brain's `.env` holds `BRAIN_API_KEY` (made for it), `ANTHROPIC_API_KEY` (the key the other apps share), `VOYAGE_API_KEY`, `STRIPE_MODE` and, for Stripe through the gateway, `GATEWAY_URL` and `GATEWAY_TOKEN`. The app reads `DATABASE_URL`, `REDIS_URL`, `SECRET_KEY_BASE`, the `STORAGE_*` keys and `MAILER_SENDER_EMAIL`. The agent reads `AGENT_DATABASE_URL` and `AGENT_ENCRYPTION_KEY`, passed in as `DATABASE_URL` and `ENCRYPTION_KEY`. Keys for later phases (Anthropic, Voyage) go in `/docker/magpie-brain/.env`.

## Backups

The database and attachments live on this one server, so they need copies off it. The `magpie-backup` project (`docker/backup/backup.sh`) does this.

- **Nightly at 03:20 UTC:** a `pg_dump` of the whole `sb-magpiereply` database and a tar of the attachments volume, checked with SHA-256 sums. The newest 7 stay on the server, in the project's `backups` volume.
- **Off-site:** once `BACKUP_S3_*` is set, each night's copy goes to S3-compatible storage, encrypted with `BACKUP_PASSPHRASE` (rclone crypt), and copies older than 30 days are deleted there.
- **Restore check:** on the first start and on the 1st of each month, the newest dump is restored into a scratch database, and the check fails unless every app and agent table comes back with its accounts. First run, November 12, 2026: 1.3 MB, 126 tables back.
- **Alerts:** a failed backup or restore check sends an ntfy alert on the same topic as Gatus.
- **Before each upgrade:** a Hostinger snapshot from hPanel (VPS → Snapshots & Backups).

To set up off-site storage, make a bucket at Cloudflare R2 or Backblaze B2, plus a key that can read and write only that bucket. Then add these in hPanel → Docker Manager → `magpie-backup` → Environment and redeploy:

- `BACKUP_S3_ENDPOINT` (for example `https://<account>.r2.cloudflarestorage.com`)
- `BACKUP_S3_BUCKET`
- `BACKUP_S3_ACCESS_KEY`
- `BACKUP_S3_SECRET_KEY`

Copy `BACKUP_PASSPHRASE` from the same screen into a password manager. Without it, the off-site copies can't be opened if this server is lost.

To restore: `pg_restore -h db -U supabase_admin -d postgres --clean <dump>` from a container on the `sb-magpiereply` network, and untar `storage.tar.gz` into the `magpiereply_storage-data` volume. To change the backup script, edit `docker/backup/backup.sh`, run `sh docker/backup/compose.sh`, and paste the output as the project's compose file.

## When to give MagpieReply its own server

The shared server uses about 3.9 GB of its 8 GB. The phase 0 brain trial fits in what's left (512 MB for `magpie-brain`, 1 GB for `magpie-gateway`).

Move MagpieReply to its own **KVM 4** (4 vCPU, 16 GB) before phase 1, when Docling, Crawl4AI and FlashRank join the brain, or sooner if the shared server's memory stays above 75% for a day. The move:

1. Buy the KVM 4 with the same "Ubuntu 24.04 with Docker and Traefik" template, in Phoenix.
2. Copy `/docker/traefik`, `/docker/autodeploy` (listing only MagpieReply's projects), `/docker/magpiereply`, `/docker/sb-magpiereply`, `/docker/magpie-gateway`, `/docker/magpie-brain` and `/docker/magpie-reader`.
3. Stop `magpiereply` on the old server, dump and restore the database and storage volume, then start it on the new one.
4. Point `app`, `agent` and `db` for `magpiereply.com` at the new IP in DNS. Traefik gets new certificates on its own.
5. Remove MagpieReply's projects from the old server and from its `autodeploy` list.

At Growth (500 teams) it splits across two **KVM 8** servers (8 vCPU, 32 GB each): one for the app and database, one for the brain, gateway and search.

## Running cost

Hostinger prices are the renewal prices on a 2-year term, from Hostinger's own billing catalog (November 2026).

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Server | ~$3 (a fifth of the shared $14.99 KVM 2) | $49.99 (KVM 8 for the app and database) |
| Postgres, Redis, file storage, Gatus | $0 (containers on the server) | $0 |
| Off-site backups: R2 or B2 keep the first 10 GB free; the database is about 1.3 MB today (check) | ~$0 | ~$1 |
| Email sending (Resend Pro at Beta, larger plan at Growth, check) | $20 | $90 |
| Claude tokens | $0 | $0 |
| **Monthly total** | **~$23** | **~$141** |

The AI agent adds its own servers and tokens (see `docs/ai-agent-plan.md`).
