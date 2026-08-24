# Hindsight deployment

Copy `.env.example` to `.env`, replace every value, and put the same
`HINDSIGHT_API_KEY` in `apps/starlight/.env`.

```sh
docker compose \
  -f docker-compose.yaml \
  -f docker-compose.hindsight.yaml \
  --env-file hindsight/.env \
  up -d
```

Starlight requires this overlay because Hindsight is its memory backend.
