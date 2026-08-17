---
title: Upgrading
description: Moving Parley forward, and why rolling back is not always safe.
---

## Parley

Pull the new tag and `docker compose up -d`. Migrations run automatically at
boot.

Rolling *back* an image is only safe if the newer version didn't add
migrations. If it did, Parley refuses to start and says so, rather than running
against a schema it doesn't understand. Restore from a
[backup](/guides/backups/) instead.

## Postgres

The compose file pins `postgres:16-alpine` on purpose. Major Postgres upgrades
(16 → 17) are not automatic:

1. `pg_dump` with the old version
2. start fresh with the new one
3. restore

Never just change the tag on an existing volume — the data directory is not
readable across major versions.
