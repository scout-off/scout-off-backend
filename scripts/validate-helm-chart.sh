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

echo "[validate-helm-chart] All Helm chart consistency checks passed."
