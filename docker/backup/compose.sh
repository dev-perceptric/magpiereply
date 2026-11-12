#!/bin/sh
# Prints the docker-compose.yml for the magpie-backup project on the VPS, with backup.sh built in (a Hostinger Docker
# project can't mount files from this repo, and takes at most 8,192 characters, so the script goes in gzipped).
# Paste the output into hPanel, or send it with the Hostinger API.
#   sh docker/backup/compose.sh > /tmp/magpie-backup.yml
set -eu
script=$(gzip -9c "$(dirname "$0")/backup.sh" | base64 -w0)
cat <<YAML
services:
  backup:
    image: postgres:17-alpine
    restart: unless-stopped
    env_file: [.env]
    entrypoint: ["sh", "-c", "apk add --no-cache curl rclone >/dev/null && echo $script | base64 -d | gunzip > /backup.sh && sh /backup.sh"]
    mem_limit: 256m
    volumes:
      - backups:/backups
      - storage:/storage:ro
    networks: [database]
    logging:
      driver: json-file
      options:
        max-size: 5m
        max-file: '2'
networks:
  database:
    external: true
    name: sb-magpiereply
volumes:
  backups: {}
  storage:
    external: true
    name: magpiereply_storage-data
YAML
