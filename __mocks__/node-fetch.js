/**
 * Manual Jest mock for node-fetch (v3 ESM-only).
 * Returns a successful response by default. Override per-test with jest.spyOn or jest.mock.
 */
const fetch = jest.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => '',
});

module.exports = fetch;
module.exports.default = fetch;
