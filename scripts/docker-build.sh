#!/usr/bin/env bash
# Build the production Docker image with Supabase credentials baked into the Vite bundle.
# Reads SUPABASE_URL and SUPABASE_API from .env in the repo root.
#
# Usage:
#   ./scripts/docker-build.sh
#   IMAGE=REGION-docker.pkg.dev/PROJECT/REPO/arl-online:latest ./scripts/docker-build.sh
#
# After building, push and deploy:
#   docker push "$IMAGE"
#   gcloud run deploy SERVICE_NAME --image "$IMAGE" --region REGION --project PROJECT

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_API:-}" ]]; then
  echo "Missing SUPABASE_URL or SUPABASE_API." >&2
  echo "Set both in .env (see .env.example), then re-run this script." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH." >&2
  echo "Install Docker Desktop, then re-run: ./scripts/docker-build.sh" >&2
  exit 1
fi

IMAGE="${IMAGE:-arl-online:latest}"

echo "Building ${IMAGE} with Supabase URL: ${SUPABASE_URL}"

docker build \
  --build-arg "SUPABASE_URL=${SUPABASE_URL}" \
  --build-arg "SUPABASE_API=${SUPABASE_API}" \
  --build-arg "SITE_URL=${SITE_URL:-}" \
  -t "${IMAGE}" \
  .

echo ""
echo "Built ${IMAGE}"
echo "Verify auth is baked in:"
echo "  docker run --rm --entrypoint node ${IMAGE} -e \"const fs=require('fs');const f=fs.readdirSync('dist/assets').find(x=>x.endsWith('.js'));console.log(fs.readFileSync('dist/assets/'+f,'utf8').includes('supabase.co')?'supabase: ok':'supabase: MISSING')\""
echo ""
echo "Push and deploy to Cloud Run:"
echo "  docker push ${IMAGE}"
echo "  gcloud run deploy YOUR_SERVICE --image ${IMAGE} --region YOUR_REGION --project YOUR_PROJECT"
