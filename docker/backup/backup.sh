#!/bin/sh
# Nightly backups for MagpieReply (docs/hostinger.md, Backups). Runs as the magpie-backup project on the VPS, on the
# sb-magpiereply network, with the attachments volume mounted read-only at /storage and its own volume at /backups.
#
# Each night at 03:20 UTC:
#   1. pg_dump of the whole sb-magpiereply database (app, agent, auth, storage), and a tar of the attachments.
#   2. Keep the last 7 on the server.
#   3. When off-site storage is set (BACKUP_S3_*), copy them there encrypted (rclone crypt) and delete off-site
#      copies older than 30 days.
#   4. On the 1st of each month, and on the first start: restore the newest dump into a scratch database and check
#      that every app and agent table came back with its rows.
# Any failure sends one ntfy alert (NTFY_TOPIC, the same topic Gatus uses).
#
# Settings: POSTGRES_PASSWORD (sb-magpiereply), NTFY_TOPIC, and for off-site BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET,
# BACKUP_S3_ACCESS_KEY, BACKUP_S3_SECRET_KEY and BACKUP_PASSPHRASE. Keep a copy of BACKUP_PASSPHRASE somewhere other
# than this server: without it the off-site copies can't be opened.
set -eu

DIR=/backups
KEEP_LOCAL=7
KEEP_DAYS=30
RUN_AT=0320
export PGHOST=db PGUSER=supabase_admin PGDATABASE=postgres PGPASSWORD="$POSTGRES_PASSWORD"

log() {
  echo "$(date -u +%FT%TZ) [backup] $1"
}

alert() {
  log "ALERT: $1"
  if [ -n "${NTFY_TOPIC:-}" ]; then
    curl -fsS -m 20 -H "Title: MagpieReply backup failed" -H "Priority: high" -d "$1" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null || true
  fi
}

offsite_ready() {
  [ -n "${BACKUP_S3_ENDPOINT:-}" ] && [ -n "${BACKUP_S3_BUCKET:-}" ] && [ -n "${BACKUP_S3_ACCESS_KEY:-}" ] &&
    [ -n "${BACKUP_S3_SECRET_KEY:-}" ] && [ -n "${BACKUP_PASSPHRASE:-}" ]
}

setup_offsite() {
  export RCLONE_CONFIG_OFFSITE_TYPE=s3 RCLONE_CONFIG_OFFSITE_PROVIDER=Other
  export RCLONE_CONFIG_OFFSITE_ENDPOINT="$BACKUP_S3_ENDPOINT"
  export RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY"
  export RCLONE_CONFIG_SAFE_TYPE=crypt RCLONE_CONFIG_SAFE_REMOTE="offsite:$BACKUP_S3_BUCKET/magpiereply"
  RCLONE_CONFIG_SAFE_PASSWORD=$(rclone obscure "$BACKUP_PASSPHRASE")
  export RCLONE_CONFIG_SAFE_PASSWORD
}

# Each step checks itself: set -e doesn't apply inside a function that's called from an if.
backup_once() {
  stamp=$(date -u +%Y%m%d-%H%M%S)
  work="$DIR/$stamp"
  mkdir -p "$work" || return 1
  pg_dump -Fc -Z 6 -f "$work/database.dump" || return 1
  tar -C /storage -czf "$work/storage.tar.gz" . || return 1
  (cd "$work" && sha256sum database.dump storage.tar.gz > SHA256SUMS) || return 1
  log "saved $stamp: database $(du -h "$work/database.dump" | cut -f1), files $(du -h "$work/storage.tar.gz" | cut -f1)"

  # Only folders this script made (named by date) are ever removed, oldest first, keeping the newest ones.
  ls -1d "$DIR"/20[0-9][0-9][0-9][0-9][0-9][0-9]-* 2>/dev/null | sort |
    awk -v keep="$KEEP_LOCAL" '{ seen[NR] = $0 } END { for (i = 1; i <= NR - keep; i++) print seen[i] }' |
    while read -r old; do
      rm -r -- "$old"
    done

  if offsite_ready; then
    setup_offsite || return 1
    rclone copy "$work" "safe:$stamp" || return 1
    rclone delete --min-age "${KEEP_DAYS}d" safe: || return 1
    rclone rmdirs --leave-root safe: || return 1
    log "copied $stamp off-site"
  else
    log "off-site copy skipped: off-site storage isn't set up yet (BACKUP_S3_*)"
  fi
}

table_count() {
  psql -d "$1" -tAc "select count(*) from information_schema.tables where table_schema in ('public', 'agent') and table_type = 'BASE TABLE'"
}

# Restores the newest dump into a scratch database and compares it with the live one: same tables in the app (public)
# and agent schemas, and at least as many accounts and conversations as when it was taken.
restore_check() {
  latest=$(ls -1d "$DIR"/20[0-9][0-9][0-9][0-9][0-9][0-9]-* | sort | tail -n 1)
  (cd "$latest" && sha256sum -c SHA256SUMS >/dev/null) || return 1
  tar -tzf "$latest/storage.tar.gz" >/dev/null || return 1
  psql -q -c "drop database if exists restore_check" -c "create database restore_check" || return 1
  psql -q -d restore_check -c "create schema extensions" -c "create extension vector schema extensions" \
    -c "create extension pgcrypto schema extensions" -c "create extension pg_trgm schema public" \
    -c "create schema agent" || return 1
  pg_restore -d restore_check -n public -n agent --no-owner --no-privileges "$latest/database.dump" 2>/tmp/restore.log || true
  live_tables=$(table_count postgres)
  restored_tables=$(table_count restore_check)
  restored_accounts=$(psql -d restore_check -tAc "select count(*) from public.accounts" 2>/dev/null || echo 0)
  restored_conversations=$(psql -d restore_check -tAc "select count(*) from public.conversations" 2>/dev/null || echo 0)
  live_accounts=$(psql -tAc "select count(*) from public.accounts")
  psql -q -c "drop database restore_check"
  if [ "$restored_tables" = "$live_tables" ] && [ "$restored_accounts" -ge 1 ] && [ "$restored_accounts" -le "$live_accounts" ]; then
    log "restore check passed for $(basename "$latest"): $restored_tables tables, $restored_accounts accounts, $restored_conversations conversations"
  else
    alert "Restore check failed for $(basename "$latest"): $restored_tables of $live_tables tables, $restored_accounts accounts."
    tail -n 20 /tmp/restore.log
  fi
}

run() {
  if ! backup_once; then
    alert "The nightly backup failed. See the magpie-backup logs."
    return
  fi
  if [ "$(date -u +%d)" = "01" ] || [ "${1:-}" = "first" ]; then
    restore_check || alert "The restore check stopped with an error. See the magpie-backup logs."
  fi
}

seconds_until_next_run() {
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) ${RUN_AT%??}:${RUN_AT#??}:00" +%s)
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  echo $((next - now))
}

log "started; runs daily at ${RUN_AT%??}:${RUN_AT#??} UTC"
run first
while true; do
  sleep "$(seconds_until_next_run)"
  run
done
