#!/bin/sh
# Installed as `cli`: the operator commands (apps/server/src/cli.ts) in any
# container of the image, e.g. `docker compose exec web cli settings list`.
# `docker compose run --rm -T migrate cli …` reaches them through the
# entrypoint instead.
exec docker-entrypoint.sh cli "$@"
