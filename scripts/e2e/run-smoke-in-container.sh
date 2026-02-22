#!/usr/bin/env sh
set -eu

docker compose -f docker-compose.e2e.yml run --rm e2e-smoke
