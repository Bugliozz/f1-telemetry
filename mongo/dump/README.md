# MongoDB Dump — F1 Telemetry

Dump of the `f1_telemetry` database exported with `mongodump --archive` during a simulated 5-lap race (10 cars, 5 teams).

## Contents

| Collection | Documents |
|---|---|
| `telemetry` | ~14 000 (stream 2–5 Hz) |
| `events` | ~282 |
| `states` | 10 (one per car) |
| `race_control` | 2 |
| `classifications` | 1 |

## Restore the dump (with Docker running)

```bash
# start MongoDB only
docker compose up -d mongodb

# restore
docker exec -i f1-final-mongodb mongorestore \
  --db f1_telemetry \
  --drop \
  --archive < mongo/dump/f1_telemetry.archive

# verify
docker exec f1-final-mongodb mongosh --quiet \
  --eval "db.getSiblingDB('f1_telemetry').telemetry.countDocuments()"
```

## Regenerate the dump

With containers running (`docker compose up -d`):

```bash
docker exec f1-final-mongodb mongodump \
  --db f1_telemetry --archive --quiet \
  > mongo/dump/f1_telemetry.archive
```
