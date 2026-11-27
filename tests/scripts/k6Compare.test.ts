const { compareResults } = require('../../scripts/k6/compare-ci-results') as {
  compareResults: (
    baseline: { metrics: Record<string, { values: Record<string, number> }> },
    candidate: { metrics: Record<string, { values: Record<string, number> }> },
    budgets: {
      maxP95RegressionPercent: number;
      maxP95RegressionMs: number;
      maxErrorRateIncrease: number;
      maxBaselineErrorRate: number;
      maxScenarioErrors: number;
      scenarios: Record<string, { errorCounter?: string; requiredCounter?: string }>;
    },
  ) => string[];
};

function summary(p95: number, errorRate: number, scenarioErrors = 0, keepalives = 1) {
  return {
    metrics: {
      'http_req_duration{scenario:player_list}': { values: { 'p(95)': p95 } },
      'http_req_failed{scenario:player_list}': { values: { rate: errorRate } },
      'player_list_errors{scenario:player_list}': { values: { count: scenarioErrors } },
      'http_req_duration{scenario:sse_stream}': { values: { 'p(95)': p95 } },
      'http_req_failed{scenario:sse_stream}': { values: { rate: errorRate } },
      'sse_connect_errors{scenario:sse_stream}': { values: { count: 0 } },
      'sse_keepalive_received{scenario:sse_stream}': { values: { count: keepalives } },
    },
  };
}

const budgets = {
  maxP95RegressionPercent: 25,
  maxP95RegressionMs: 15,
  maxErrorRateIncrease: 0.005,
  maxBaselineErrorRate: 0.01,
  maxScenarioErrors: 0,
  scenarios: {
    player_list: { errorCounter: 'player_list_errors' },
    sse_stream: { errorCounter: 'sse_connect_errors', requiredCounter: 'sse_keepalive_received' },
  },
};

describe('k6 CI performance comparison', () => {
  it('accepts latency within relative budget and requires a successful SSE keepalive', () => {
    expect(compareResults(summary(100, 0), summary(125, 0), budgets)).toEqual([]);
  });

  it('reports latency and error-counter regressions', () => {
    const failures = compareResults(summary(100, 0), summary(140, 0.01, 1), budgets);
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('player_list p95 exceeds'),
        expect.stringContaining('player_list scenario check errors exceed'),
        expect.stringContaining('player_list error-rate regression exceeds'),
      ]),
    );
  });

  it('fails closed when a per-scenario metric is missing', () => {
    const missingMetrics = { metrics: {} };
    expect(() => compareResults(missingMetrics, missingMetrics, budgets)).toThrow(
      'Missing http_req_duration metric for scenario "player_list"',
    );
  });

  it('rejects a candidate that does not observe an SSE keepalive', () => {
    const failures = compareResults(summary(100, 0), summary(100, 0, 0, 0), budgets);
    expect(failures).toEqual([
      expect.stringContaining('sse_stream did not record sse_keepalive_received'),
    ]);
  });
});
