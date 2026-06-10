#!/bin/sh
set -eu

mkdir -p \
  "${CLOUD_STORAGE_DIR:-/app/data/cloud-storage}" \
  "${CLOUD_MEDIA_DIR:-/app/data/cloud-media}" \
  "${GENERATION_TASK_STORE_DIR:-/app/data/generation-tasks}"

chown -R node:node \
  "${CLOUD_STORAGE_DIR:-/app/data/cloud-storage}" \
  "${CLOUD_MEDIA_DIR:-/app/data/cloud-media}" \
  "${GENERATION_TASK_STORE_DIR:-/app/data/generation-tasks}" \
  2>/dev/null || true

exec su-exec node "$@"
