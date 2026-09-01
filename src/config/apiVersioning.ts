/**
 * Allowlist of intentionally divergent routes between API versions.
 *
 * Entries are path suffixes mounted under the API prefix (e.g. '/versioning/demo').
 * The parity test will ignore differences for any path on this list.
 */
const allowlist: string[] = [
  // Deliberate v2-only demo route used to prove intentional divergence handling
  '/versioning/demo',
];

export default allowlist;
