#!/bin/sh
set -eu
mkdir -p /data/backups
if psql -Atqc "SELECT to_regclass('public.\"Project\"') IS NOT NULL" | grep -q t; then
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  pg_dump -Fc -f "/data/backups/pre-update-$stamp.dump"
fi
