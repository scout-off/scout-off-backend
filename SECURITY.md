# Security Policy

## Supported Versions

Security patches are released for the current major version line. Older
versions are supported for a grace period after a new major release, after
which they receive critical patches only at maintainer discretion.

| Version | Status            | Support ends     |
| ------- | ----------------- | ---------------- |
| 2.x     | ✅ Active support  | Current          |
| 1.x     | ⚠️ Security-only  | 2026-12-31       |
| < 1.0   | ❌ Unsupported    | —                |

### Disclosure SLA

We commit to the following response timelines for privately reported
security vulnerabilities:

| Severity | First response | Patch targeted | Disclosure coordinated |
| -------- | -------------- | -------------- | ---------------------- |
| Critical | 24 hours       | 72 hours       | After patch deployed   |
| High     | 48 hours       | 7 days         | After patch deployed   |
| Medium   | 5 days         | 30 days        | After patch deployed   |
| Low      | 10 days        | Next release   | Release notes          |

**Critical** vulnerabilities are those that allow unauthenticated remote code
execution, unrestricted data exfiltration, or total auth bypass with no
preconditions. **High** vulnerabilities require some preconditions (e.g. a
valid account) but still bypass core security boundaries.

These timelines are commitments to the *reporter*, not guarantees of a public
fix — the complexity of a fix and the need for ecosystem coordination (e.g.
coordinating with Stellar testnet reset windows) may extend the patch timeline.
When a delay beyond the targeted window is needed, we will communicate the
revised timeline to the reporter within the original response window.

## Reporting a Vulnerability

**Do NOT open a public GitHub Issue for security vulnerabilities.** GitHub
Issues are publicly visible — posting exploit details before a fix is deployed
puts all ScoutOff users at risk.

### Private Disclosure Process

1. **Email the maintainers** at the address listed on the
   [ScoutOff GitHub profile](https://github.com/scout-off) or in the repository's
   `package.json` `"author"` field.
2. **Include the following in your report:**
   - A clear description of the vulnerability and the affected component.
   - Steps to reproduce or a proof-of-concept (share only if it is safe to do
     so over email — do not attach live exploit code).
   - The potential impact (data exposure, auth bypass, denial of service, etc.).
   - Your suggested fix, if you have one.
3. **Allow 7 days** for an initial response before any public disclosure.
   We aim to acknowledge reports within 48 hours and provide a resolution
   timeline within 7 days.

### What to Expect

| Timeline     | Action                                                                    |
| ------------ | ------------------------------------------------------------------------- |
| 0–48 hours   | Acknowledgement of receipt                                                |
| 0–7 days     | Initial severity assessment and resolution timeline communicated to you   |
| 7–30 days    | Patch developed and reviewed (timeline depends on severity and complexity) |
| After patch  | Coordinated public disclosure with credit to the reporter (if desired)    |

We follow a coordinated disclosure model. We will credit reporters in the
release notes unless you prefer to remain anonymous.

## Scope

The following are **in scope** for security reports:

- Authentication and authorisation bypasses (SEP-10, JWT, role checks)
- SQL injection or data exposure in API endpoints
- Rate-limiting bypasses that could enable denial-of-service
- Privilege escalation (e.g. a player acting as a validator or admin)
- Secrets or sensitive data leaked in logs or API responses
- Supply-chain vulnerabilities in direct production dependencies

The following are **out of scope**:

- Vulnerabilities in the Stellar network or Soroban runtime itself (report
  those to the [Stellar Bug Bounty Program](https://www.stellar.org/bug-bounty-program))
- Issues requiring physical access to the server
- Social engineering attacks against maintainers or users
- Bugs in development-only dependencies (devDependencies) with no production impact

## Security Best Practices for Contributors

Before submitting a pull request:

```bash
npm audit              # check all dependencies
npm audit --omit=dev   # check production dependencies only
```

See [CONTRIBUTING.md — Security & Dependency Review](CONTRIBUTING.md#security--dependency-review)
for the full checklist.

## Acknowledgements

We thank all responsible security researchers who help keep ScoutOff safe.
Reporters who follow this policy will be credited in the relevant release notes
(unless they request anonymity).

## Supply chain: image signing and SBOM

Container images for staging and mainnet are built by the deploy workflows
(`.github/workflows/deploy-staging.yml`, `.github/workflows/deploy-mainnet.yml`)
with Docker Buildx, which produces SLSA provenance (`provenance: mode=max`) and
an SBOM attestation. The pushed digest is then signed **keyless** with cosign
using GitHub's OIDC token — there is no long-lived signing key to leak. An SPDX
SBOM is generated with Syft and attached with `cosign attest`; the same file is
uploaded as a workflow artifact.

The mainnet workflow verifies the signature (`cosign verify`) before the deploy
job is allowed to run, so an image that was not produced by this repository's
`main` branch cannot reach production through the pipeline.

### Verifying an image manually

```bash
IMAGE=ghcr.io/scout-off/scout-off-backend
DIGEST=sha256:<digest>

cosign verify \
  --certificate-identity-regexp '^https://github.com/scout-off/scout-off-backend/\.github/workflows/deploy-mainnet\.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "${IMAGE}@${DIGEST}"

cosign verify-attestation --type spdxjson \
  --certificate-identity-regexp '^https://github.com/scout-off/scout-off-backend/\.github/workflows/deploy-mainnet\.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "${IMAGE}@${DIGEST}"
```

### Enforcing verification with Kyverno

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-scout-off-images
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: verify-keyless-signature-and-sbom
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces: [scout-off]
      verifyImages:
        - imageReferences:
            - "ghcr.io/scout-off/scout-off-backend*"
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/scout-off/scout-off-backend/.github/workflows/deploy-mainnet.yml@refs/heads/main"
                    issuer: "https://token.actions.githubusercontent.com"
          attestations:
            - predicateType: https://spdx.dev/Document
              attestors:
                - entries:
                    - keyless:
                        subject: "https://github.com/scout-off/scout-off-backend/.github/workflows/deploy-mainnet.yml@refs/heads/main"
                        issuer: "https://token.actions.githubusercontent.com"
```

Sigstore's policy-controller (`ClusterImagePolicy`) can express the same rules;
the important parts are the keyless issuer, the exact workflow identity, and
requiring the SPDX attestation rather than only the signature.

## Incident Response & Audit Trails

When a security incident or audit occurs, the platform provides a tamper-evident audit trail for investigation and compliance:

**See [docs/audit-log.md](docs/audit-log.md)** for:
- Complete audit schema and what actions are logged
- Hash-chain verification procedures to detect tampering
- Using `GET /api/admin/audit/verify` to validate chain integrity
- Interpreting verification failures and remediation steps

The audit log is designed for compliance workflows (SOC 2, GDPR incident response) and post-incident forensics.
