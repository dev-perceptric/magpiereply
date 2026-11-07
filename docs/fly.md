# Running MagpieReply on Fly.io

Two Fly apps in Tokyo (`nrt`), the same region as Claritia and Arrowsterr, both running the same Docker image:

| Piece | Where | Config | Size |
|---|---|---|---|
| App | Fly app `magpiereply-web` | `fly.toml` | shared-cpu-2x, 2 GB, always on |
| Background jobs (Sidekiq) | Fly app `magpiereply-worker` | `fly.worker.toml` | shared-cpu-2x, 2 GB, always on |
| Redis | Upstash on Fly, `magpiereply-redis` | | Fixed 250 MB |
| Postgres with pgvector | Supabase project in Tokyo | | |
| File attachments | Supabase Storage bucket (S3 protocol) | | |

## What's already done

- Fly apps `magpiereply-web` and `magpiereply-worker` exist in the `personal` org.
- Upstash Redis `magpiereply-redis` exists in `nrt` on the Fixed 250 MB plan.
- Both apps have the `REDIS_URL` and `SECRET_KEY_BASE` secrets set.

## What's left

### 1. Make the Supabase project

1. In Supabase, create a project named `magpiereply` in **Northeast Asia (Tokyo)**.
2. In **Database → Extensions**, turn on `vector`.
3. In **Storage**, create a private bucket named `magpiereply-files`.
4. In **Storage → S3 Connection**, create an access key.

### 2. Add the remaining secrets to both Fly apps

In the Fly dashboard, open each app (`magpiereply-web`, then `magpiereply-worker`), go to **Secrets** and add:

| Secret | Value |
|---|---|
| `DATABASE_URL` | Supabase **Connect → Session pooler** connection string (port 5432) |
| `STORAGE_BUCKET_NAME` | `magpiereply-files` |
| `STORAGE_ACCESS_KEY_ID` | from step 1.4 |
| `STORAGE_SECRET_ACCESS_KEY` | from step 1.4 |
| `STORAGE_REGION` | `ap-northeast-1` |
| `STORAGE_ENDPOINT` | `https://<project-ref>.supabase.co/storage/v1/s3` |
| `MAILER_SENDER_EMAIL` | `MagpieReply <hello@magpiereply.com>` |
| `SMTP_ADDRESS`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD` | your email provider (Resend works) |

Use the session pooler (port 5432), not the transaction pooler (6543); Rails needs session-level features.

### 3. Deploy

With [flyctl](https://fly.io/docs/flyctl/install/) installed, from the repo folder:

```bash
fly deploy --config fly.toml --ha=false
```

```bash
fly deploy --config fly.worker.toml --ha=false
```

The web deploy runs `rails db:chatwoot_prepare` first, which loads the schema on the first deploy and runs migrations after that. Check that `https://magpiereply-web.fly.dev` shows the login page.

### 4. Point app.magpiereply.com at it

```bash
fly certs add app.magpiereply.com --app magpiereply-web
```

Then in Namecheap, under **Domain List → Manage → Advanced DNS**, add a CNAME record with host `app` and value `magpiereply-web.fly.dev`. Fly issues the HTTPS certificate once DNS points to it.

## Running cost

Prices from Fly's and Upstash's pricing pages (November 2026) unless marked "check".

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| `magpiereply-web` | $13.39 (shared-cpu-2x, 2 GB) | $132 (2 × performance-2x, 4 GB) |
| `magpiereply-worker` | $13.39 (shared-cpu-2x, 2 GB) | $132 (2 × performance-2x, 4 GB) |
| Upstash Redis | $10 (Fixed 250 MB) | $20 (Fixed 1 GB) |
| Supabase project, Tokyo (check) | ~$10 compute on an existing Pro org, $25 more for a new org | ~$110 (larger compute) |
| Supabase Storage for attachments (check) | included up to 100 GB on Pro | ~$5 |
| Fly outbound data and SSL (check) | ~$1 | ~$10 |
| Claude tokens | $0 | $0 |
| **Monthly total** | **~$48** (or ~$73 with a new Supabase org) | **~$409** |

Email sending and the AI agent's Claude tokens are extra and the same on any host (see `docs/magpiereply.md`).
