#!/usr/bin/env bash
# Build and push the production image via Google Cloud Build (no local Docker required).
# Reads Supabase vars from .env, deploys Cloud Run service arl-online in us-east1
# (https://activistresourcelibrary.com). Override with GCP_REGION / SITE_URL.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROJECT="${GCP_PROJECT:-activist-resource-library}"
REGION="${GCP_REGION:-us-east1}"
SERVICE="${CLOUD_RUN_SERVICE:-arl-online}"
ARTIFACT_REGION="${GCP_ARTIFACT_REGION:-us-east1}"
REGISTRY="${ARTIFACT_REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/arl-online/arl-online"
TAG="${IMAGE_TAG:-supabase-$(date +%Y%m%d%H%M%S)}"
IMAGE="${IMAGE:-${REGISTRY}:${TAG}}"

# One-time Google Secret Manager setup (run locally before first deploy with --set-secrets):
#
#   gcloud secrets create supabase-service-role-key --replication-policy=automatic --project="${PROJECT}"
#   printf '%s' "${SUPABASE_SERVICE_ROLE_KEY}" | gcloud secrets versions add supabase-service-role-key --data-file=- --project="${PROJECT}"
#
#   gcloud secrets create resend-api-key --replication-policy=automatic --project="${PROJECT}"
#   printf '%s' "${RESEND_API_KEY}" | gcloud secrets versions add resend-api-key --data-file=- --project="${PROJECT}"
#
# Grant the Cloud Run runtime service account access (replace PROJECT_NUMBER):
#
#   gcloud secrets add-iam-policy-binding supabase-service-role-key \
#     --project="${PROJECT}" \
#     --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
#     --role="roles/secretmanager.secretAccessor"
#
#   gcloud secrets add-iam-policy-binding resend-api-key \
#     --project="${PROJECT}" \
#     --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
#     --role="roles/secretmanager.secretAccessor"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Re-resolve after .env (SITE_URL may be set there)
PRODUCTION_URL="${SITE_URL:-https://activistresourcelibrary.com}"

if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_API:-}" ]]; then
  echo "Missing SUPABASE_URL or SUPABASE_API in .env" >&2
  exit 1
fi

if [[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  echo "Missing SUPABASE_SERVICE_ROLE_KEY in .env (required for inventory on Cloud Run)" >&2
  exit 1
fi

echo "Target: ${SERVICE} (${REGION}) → ${PRODUCTION_URL}"
echo "Cloud Build → ${IMAGE}"
gcloud builds submit \
  --project "${PROJECT}" \
  --config cloudbuild.yaml \
  --substitutions="_SUPABASE_URL=${SUPABASE_URL},_SUPABASE_API=${SUPABASE_API},_SITE_URL=${PRODUCTION_URL},_IMAGE=${IMAGE}"

echo ""
echo "Deploying ${SERVICE} in ${REGION}..."
RUNTIME_ENV="SUPABASE_URL=${SUPABASE_URL},SUPABASE_API=${SUPABASE_API},SITE_URL=${PRODUCTION_URL}"
if [[ -n "${EMAIL_FROM:-}" ]]; then
  RUNTIME_ENV+=",EMAIL_FROM=${EMAIL_FROM}"
fi
if [[ -n "${EMAIL_TO:-}" ]]; then
  RUNTIME_ENV+=",EMAIL_TO=${EMAIL_TO}"
fi
if [[ -n "${RESERVE_INVENTORY_EMAIL_TO:-}" ]]; then
  RUNTIME_ENV+=",RESERVE_INVENTORY_EMAIL_TO=${RESERVE_INVENTORY_EMAIL_TO}"
fi
if [[ -n "${SLACK_RESERVATION_WEBHOOK_URL:-}" ]]; then
  RUNTIME_ENV+=",SLACK_RESERVATION_WEBHOOK_URL=${SLACK_RESERVATION_WEBHOOK_URL}"
fi

SECRET_BINDINGS="SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest"
if [[ -n "${RESEND_API_KEY:-}" ]]; then
  SECRET_BINDINGS+=",RESEND_API_KEY=resend-api-key:latest"
fi

gcloud run deploy "${SERVICE}" \
  --project "${PROJECT}" \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --set-env-vars "${RUNTIME_ENV}" \
  --set-secrets "${SECRET_BINDINGS}"

echo ""
echo "Done. Open: ${PRODUCTION_URL}"
echo "Header should show Log in / Register after a hard refresh."
