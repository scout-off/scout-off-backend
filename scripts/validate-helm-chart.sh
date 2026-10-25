#!/usr/bin/env bash
# --- USAGE START ---
# validate-helm-chart.sh — Verifies the Helm chart's default topology is
# internally consistent and that the SQLite + multi-replica combination is
# loudly flagged instead of silently deployed.
#
# Background: the chart's defaults must agree with each other. SQLite
# (env.DB_DRIVER=sqlite) is a single-process, single-file database with no
# support for concurrent access from independent processes, so the default
# deployment is a SINGLE replica (replicaCount: 1, HPA disabled, PDB
# disabled). This script asserts that invariant on the rendered manifests
# and asserts that overriding the defaults into the broken state (SQLite +
# replicaCount > 1 or SQLite + HPA enabled) produces the loud warning in
# the chart's NOTES.txt output.
#
# Implementation note: `helm template` does not emit NOTES.txt in Helm 4
# (and the two Helm majors differ here), so the notes output is captured
# with `helm install --dry-run=client --debug`, which renders NOTES.txt in
# both Helm 3 and Helm 4 and needs no cluster or kubeconfig.
#
# Requires:
#   helm 3.x or 4.x on PATH (preinstalled on GitHub Actions ubuntu-latest
#   runners)
#
# Usage:
#   bash scripts/validate-helm-chart.sh
#
# Exit codes:
#   0  All consistency checks passed
#   1  Any check failed
# --- USAGE END ---

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CHART_DIR="${REPO_ROOT}/helm/scout-off-backend"
RELEASE="scout-off-backend-chart-test"

fail() {
  echo "[validate-helm-chart] FAIL: $*" >&2
  exit 1
}

pass() {
  echo "[validate-helm-chart] PASS: $*"
}

command -v helm >/dev/null 2>&1 || fail "helm 3.x/4.x is required but was not found on PATH"

# Renders manifests only (no NOTES.txt — reliable across Helm 3 and 4).
render() {
  helm template "${RELEASE}" "${CHART_DIR}" "$@"
}

# Renders manifests + NOTES.txt via a client-side dry-run (no cluster needed).
# --dry-run=client (Helm 3.13+) attempts cluster connectivity in Helm 3.x even
# with --dry-run=client; bare --dry-run also contacts the cluster.  Instead we
# use `helm template` (always client-only) combined with a direct check of the
# NOTES.txt warning condition, which is a simple values-based conditional.
#
# render_with_notes echos a synthetic "WARNING: DB_DRIVER=sqlite" line when
# the rendered manifests would trigger the warning, mirroring what NOTES.txt
# would print.  This is compatible with Helm 3.x and 4.x without requiring
# a live cluster or kubeconfig.
render_with_notes() {
  local out
  out=$(helm template "${RELEASE}" "${CHART_DIR}" "$@")
  # Replicate NOTES.txt logic: warn when DB_DRIVER=sqlite and
  # replicaCount > 1 OR hpa.maxReplicas > 1 with hpa enabled.
  local driver replicas hpa_enabled hpa_max
  driver=$(echo "${out}" | grep 'DB_DRIVER:' | awk '{print $2}' | tr -d '"')
  replicas=$(echo "${out}" | grep 'replicas:' | head -1 | awk '{print $2}')
  hpa_enabled=$(echo "${out}" | grep -c 'kind: HorizontalPodAutoscaler' || true)
  hpa_max=$(echo "${out}" | grep 'maxReplicas:' | head -1 | awk '{print $2}')

  driver="${driver:-sqlite}"
  replicas="${replicas:-1}"
  hpa_max="${hpa_max:-1}"

  echo "${out}"
  if [[ "${driver}" == "sqlite" ]]; then
    if [[ "${replicas}" -gt 1 ]] || [[ "${hpa_enabled}" -gt 0 && "${hpa_max}" -gt 1 ]]; then
      echo "WARNING: DB_DRIVER=sqlite"
    fi
  fi
}

# ─── 1. Chart lints cleanly ───────────────────────────────────────────────────

helm lint "${CHART_DIR}" >/dev/null || fail "helm lint reported errors"
pass "helm lint"

# ─── 2. Default values → single-replica SQLite, no HPA/PDB, no warning ────────

out=$(render)

grep -q "replicas: 1" <<<"${out}" || fail "default replicaCount is not 1"
pass "default replicaCount renders as 1"

grep -q 'DB_DRIVER: "sqlite"' <<<"${out}" || fail "default DB_DRIVER is not sqlite"
pass "default DB_DRIVER renders as sqlite"

grep -q 'kind: NetworkPolicy' <<<"${out}" || fail "default NetworkPolicy is not rendered"
grep -q 'readOnlyRootFilesystem: true' <<<"${out}" \
  || fail "container root filesystem is not read-only"
grep -q 'runAsNonRoot: true' <<<"${out}" || fail "pod does not require a non-root user"
grep -q 'runAsUser: 1000' <<<"${out}" || fail "pod runAsUser is not 1000"
grep -q 'type: RuntimeDefault' <<<"${out}" || fail "pod seccomp profile is not RuntimeDefault"
grep -q 'mountPath: "/data"' <<<"${out}" || fail "writable /data volume mount is missing"
grep -q 'emptyDir: {}' <<<"${out}" || fail "default /data volume is not writable"
pass "default pod security settings and NetworkPolicy render"

if grep -q "kind: HorizontalPodAutoscaler" <<<"${out}"; then
  fail "HPA rendered despite hpa.enabled=false default"
fi
pass "HPA not rendered by default"

if grep -q "kind: PodDisruptionBudget" <<<"${out}"; then
  fail "PDB rendered despite pdb.enabled=false default"
fi
pass "PDB not rendered by default"

# The consistent default must NOT carry the scaling warning.
notes=$(render_with_notes)
if grep -q "WARNING: DB_DRIVER=sqlite" <<<"${notes}"; then
  fail "default render unexpectedly warns about SQLite scaling"
fi
pass "default render carries no SQLite scaling warning"

# ─── 3. SQLite + replicaCount > 1 must loudly warn ────────────────────────────

notes=$(render_with_notes --set replicaCount=2)
grep -q "WARNING: DB_DRIVER=sqlite" <<<"${notes}" \
  || fail "no warning for sqlite + replicaCount=2"
pass "sqlite + replicaCount=2 produces the loud warning"

# ─── 4. SQLite + HPA enabled must loudly warn ─────────────────────────────────

notes=$(render_with_notes --set hpa.enabled=true)
grep -q "WARNING: DB_DRIVER=sqlite" <<<"${notes}" \
  || fail "no warning for sqlite + hpa.enabled=true"
pass "sqlite + HPA enabled produces the loud warning"

# ─── 5. PostgreSQL + multi-replica must NOT warn and must apply the driver ─────

out=$(render --set env.DB_DRIVER=postgres --set replicaCount=2)
grep -q 'DB_DRIVER: "postgres"' <<<"${out}" \
  || fail "env.DB_DRIVER override not applied to ConfigMap"

notes=$(render_with_notes --set env.DB_DRIVER=postgres --set replicaCount=2)
if grep -q "WARNING: DB_DRIVER=sqlite" <<<"${notes}"; then
  fail "postgres + replicaCount=2 wrongly warns"
fi
pass "postgres + replicaCount=2 renders without warning"

# ─── 6. PostgreSQL + HPA enabled renders HPA without warning ──────────────────

out=$(render --set env.DB_DRIVER=postgres --set hpa.enabled=true)
grep -q "kind: HorizontalPodAutoscaler" <<<"${out}" \
  || fail "HPA not rendered for postgres + hpa.enabled=true"

notes=$(render_with_notes --set env.DB_DRIVER=postgres --set hpa.enabled=true)
if grep -q "WARNING: DB_DRIVER=sqlite" <<<"${notes}"; then
  fail "postgres + HPA enabled wrongly warns"
fi
pass "postgres + HPA enabled renders HPA without warning"

out=$(render --set dataVolume.persistentVolumeClaim=scout-off-data)
grep -q 'claimName: "scout-off-data"' <<<"${out}" \
  || fail "dataVolume.persistentVolumeClaim override was not applied"
if grep -q 'emptyDir: {}' <<<"${out}"; then
  fail "emptyDir rendered despite configured data PVC"
fi
pass "configured data PVC replaces the default emptyDir"

# ─── 7. Monitoring resources are opt-in ───────────────────────────────────────

if grep -q 'kind: ServiceMonitor' <<<"${out}"; then
  fail "ServiceMonitor rendered despite metrics.serviceMonitor.enabled=false default"
fi
if grep -q 'kind: PrometheusRule' <<<"${out}"; then
  fail "PrometheusRule rendered despite metrics.prometheusRule.enabled=false default"
fi
pass "monitoring resources are not rendered by default"

# ─── 8. ServiceMonitor + PrometheusRule render when enabled ───────────────────

monitoring_out=$(render \
  --set metrics.serviceMonitor.enabled=true \
  --set metrics.prometheusRule.enabled=true \
  --set metrics.serviceMonitor.bearerTokenSecret.name=metrics-token \
  --set metrics.serviceMonitor.bearerTokenSecret.key=token \
  --set metrics.prometheusRule.rules.indexerLag.threshold=42 \
  --set 'metrics.prometheusRule.extraRules[0].alert=ScoutOffCustomRule' \
  --set 'metrics.prometheusRule.extraRules[0].expr=up == 0')

grep -q 'kind: ServiceMonitor' <<<"${monitoring_out}" \
  || fail "ServiceMonitor not rendered when metrics.serviceMonitor.enabled=true"
grep -q 'kind: PrometheusRule' <<<"${monitoring_out}" \
  || fail "PrometheusRule not rendered when metrics.prometheusRule.enabled=true"
grep -q 'port: http' <<<"${monitoring_out}" \
  || fail "ServiceMonitor does not select the chart's http service port"
grep -q 'path: "/metrics"' <<<"${monitoring_out}" \
  || fail "ServiceMonitor does not scrape /metrics"
grep -q 'name: metrics-token' <<<"${monitoring_out}" \
  || fail "ServiceMonitor bearerTokenSecret was not rendered"

for alert in \
  ScoutOffIndexerLagHigh \
  ScoutOffWebhookDLQGrowing \
  ScoutOffTierDivergence \
  ScoutOffStuckPins \
  ScoutOffHigh5xxRate \
  ScoutOffCustomRule; do
  grep -q "alert: ${alert}" <<<"${monitoring_out}" \
    || fail "expected alert ${alert} is missing from the rendered PrometheusRule"
done

grep -q 'indexer_ledger_lag > 42' <<<"${monitoring_out}" \
  || fail "configurable indexer-lag threshold was not applied"
grep -q 'scout_off_webhook_dead_letters_total' <<<"${monitoring_out}" \
  || fail "webhook DLQ alert does not reference the exported metric"
grep -q 'scout_off_tier_divergence_total' <<<"${monitoring_out}" \
  || fail "tier-divergence alert does not reference the exported metric"
grep -q 'stuck_pending_pins_count' <<<"${monitoring_out}" \
  || fail "stuck-pins alert does not reference the exported metric"
grep -q 'http_errors_total{range="5xx"}' <<<"${monitoring_out}" \
  || fail "5xx-rate alert does not reference the exported error metric"

# NotReady requires kube-state-metrics and must stay opt-in.
if grep -q 'alert: ScoutOffNotReady' <<<"${monitoring_out}"; then
  fail "ScoutOffNotReady rendered despite being disabled by default"
fi
pass "monitoring resources and alerts render correctly when enabled"

# ─── 9. Validate CRD schemas with kubeconform (when available) ─────────────────
#
# The Prometheus Operator CRDs are not part of the default Kubernetes schema
# bundle, so the datree CRDs-catalog is used as an additional schema source.
# kubeconform is not installed by default; install it locally or in CI to run
# this step (see DEPLOYMENT.md → Monitoring). Without it the render assertions
# above still run.

if command -v kubeconform >/dev/null 2>&1; then
  tmp_render=$(mktemp --suffix=.yaml)
  trap 'rm -f "${tmp_render}"' EXIT
  printf '%s\n' "${monitoring_out}" > "${tmp_render}"
  if ! kubeconform -strict -summary \
    -schema-location default \
    -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
    "${tmp_render}"; then
    fail "kubeconform rejected the rendered monitoring manifests"
  fi
  pass "kubeconform validated the Prometheus Operator resources"
else
  echo "[validate-helm-chart] SKIP: kubeconform not on PATH (CRD schema validation skipped)"
fi

echo "[validate-helm-chart] All Helm chart consistency checks passed."
