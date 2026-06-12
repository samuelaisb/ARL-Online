#!/usr/bin/env bash
# Build and push the production image via Google Cloud Build (no local Docker required).
# Reads Supabase vars from .env, deploys to the activist-resource-library Cloud Run service.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROJECT="${GCP_PROJECT:-activist-resource-library}"
REGION="${GCP_REGION:-northamerica-northeast1}"
SERVICE="${CLOUD_RUN_SERVICE:-arl-online}"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/arl-online/arl-online"
TAG="${IMAGE_TAG:-supabase-$(date +%Y%m%d%H%M%S)}"
IMAGE="${IMAGE:-${REGISTRY}:${TAG}}"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_API:-}" ]]; then
  echo "Missing SUPABASE_URL or SUPABASE_API in .env" >&2
  exit 1
fi

if [[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  echo "Missing SUPABASE_SERVICE_ROLE_KEY in .env (required for inventory on Cloud Run)" >&2
  exit 1
fi

echo "Cloud Build → ${IMAGE}"
gcloud builds submit \
  --project "${PROJECT}" \
  --config cloudbuild.yaml \
  --substitutions="_SUPABASE_URL=${SUPABASE_URL},_SUPABASE_API=${SUPABASE_API},_SITE_URL=${SITE_URL:-},_IMAGE=${IMAGE}"

echo ""
echo "Deploying ${SERVICE} in ${REGION}..."
gcloud run deploy "${SERVICE}" \
  --project "${PROJECT}" \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --set-env-vars "SUPABASE_URL=${SUPABASE_URL},SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}"

echo ""
echo "Done. Open: https://arl-online-123477413804.${REGION}.run.app"
echo "Header should show Log in / Register after a hard refresh."
