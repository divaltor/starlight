# Hindsight deployment

Copy the root `.env.example` to `.env`, replace every value, and put the same
`HINDSIGHT_API_KEY` in `apps/starlight/.env`.

```sh
docker compose \
  --env-file .env \
  up -d
```

Hindsight is included in the main Compose stack because it is Starlight's memory backend.
