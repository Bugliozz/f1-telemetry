# MongoDB Dump — F1 Telemetry

Dump del database `f1_telemetry` esportato con `mongodump --archive` durante una gara simulata di 5 giri (10 auto, 5 team).

## Contenuto

| Collection | Documenti |
|---|---|
| `telemetry` | ~14 000 (stream 2–5 Hz) |
| `events` | ~282 |
| `states` | 10 (uno per auto) |
| `race_control` | 2 |
| `classifications` | 1 |

## Ripristinare il dump (con Docker attivo)

```bash
# avvia solo MongoDB
docker compose up -d mongodb

# ripristina
docker exec -i f1-final-mongodb mongorestore \
  --db f1_telemetry \
  --drop \
  --archive < mongo/dump/f1_telemetry.archive

# verifica
docker exec f1-final-mongodb mongosh --quiet \
  --eval "db.getSiblingDB('f1_telemetry').telemetry.countDocuments()"
```

## Rigenerare il dump

Con i container attivi (`docker compose up -d`):

```bash
docker exec f1-final-mongodb mongodump \
  --db f1_telemetry --archive --quiet \
  > mongo/dump/f1_telemetry.archive
```
