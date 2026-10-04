#!/bin/sh
set -eu
dump=$(ls -t /data/backups/*.dump | head -n 1)
test -n "$dump"
name="restore_verify_$(date -u +%s)"
createdb -T template0 "$name"
trap 'dropdb "$name"' EXIT
pg_restore -d "$name" "$dump"
projects=$(psql -d "$name" -Atqc 'SELECT COUNT(*) FROM "Project"')
versions=$(psql -d "$name" -Atqc 'SELECT COUNT(*) FROM "VoiceVersion"')
keys=$(psql -d "$name" -Atqc 'SELECT COUNT(*) FROM "Credential"')
test "$projects" -gt 0
test "$versions" -gt 0
test "$keys" -gt 0
printf 'restore_verified projects=%s versions=%s credentials=%s\n' "$projects" "$versions" "$keys"
