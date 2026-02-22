$ErrorActionPreference = 'Stop'
docker compose -f docker-compose.e2e.yml run --rm e2e-browser
