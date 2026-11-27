#!/usr/bin/env node
'use strict';

const fs = require('fs');

function metricValues(summary, metricName, scenario) {
  const taggedName = Object.keys(summary.metrics ?? {}).find(
    (name) => name.startsWith(`${metricName}{`) && name.includes(`scenario:${scenario}`),
  );
  const metric = taggedName ? summary.metrics[taggedName] : undefined;
  if (!metric?.values) {
    throw new Error(`Missing ${metricName} metric for scenario "${scenario}"`);
  }
  return metric.values;
}

function finiteMetricValue(values, key, metricName, scenario) {
  const value = Number(values[key]);
  if (!Number.isFinite(value)) {
    throw new Error(`Missing or invalid ${key} in ${metricName} metric for scenario "${scenario}"`);
  }
  return value;
}

function compareResults(baseline, candidate, budgets) {
  const failures = [];

  for (const [scenario, scenarioBudget] of Object.entries(budgets.scenarios)) {
    const baselineP95 = finiteMetricValue(
      metricValues(baseline, 'http_req_duration', scenario),
      'p(95)',
      'http_req_duration',
      scenario,
    );
    const candidateP95 = finiteMetricValue(
      metricValues(candidate, 'http_req_duration', scenario),
      'p(95)',
      'http_req_duration',
      scenario,
    );
    const baselineErrorRate = finiteMetricValue(
      metricValues(baseline, 'http_req_failed', scenario),
      'rate',
      'http_req_failed',
      scenario,
    );
    const candidateErrorRate = finiteMetricValue(
      metricValues(candidate, 'http_req_failed', scenario),
      'rate',
      'http_req_failed',
      scenario,
    );
    const p95Percent = scenarioBudget.maxP95RegressionPercent ?? budgets.maxP95RegressionPercent;
    const p95Ms = scenarioBudget.maxP95RegressionMs ?? budgets.maxP95RegressionMs;
    const errorIncrease = scenarioBudget.maxErrorRateIncrease ?? budgets.maxErrorRateIncrease;
    const baselineErrorLimit = scenarioBudget.maxBaselineErrorRate ?? budgets.maxBaselineErrorRate;
    const p95Limit = Math.max(baselineP95 * (1 + p95Percent / 100), baselineP95 + p95Ms);

    console.log(
      `${scenario}: p95 ${baselineP95.toFixed(1)}ms -> ${candidateP95.toFixed(1)}ms ` +
        `(budget ${p95Limit.toFixed(1)}ms); errors ${(baselineErrorRate * 100).toFixed(2)}% -> ` +
        `${(candidateErrorRate * 100).toFixed(2)}% ` +
        `(budget ${((baselineErrorRate + errorIncrease) * 100).toFixed(2)}%)`,
    );

    if (candidateP95 > p95Limit) {
      failures.push(
        `${scenario} p95 exceeds its relative budget (${candidateP95}ms > ${p95Limit}ms)`,
      );
    }
    if (baselineErrorRate > baselineErrorLimit) {
      failures.push(
        `${scenario} main baseline error rate is already above budget ` +
          `(${baselineErrorRate} > ${baselineErrorLimit})`,
      );
    }
    if (candidateErrorRate > baselineErrorRate + errorIncrease) {
      failures.push(
        `${scenario} error-rate regression exceeds budget ` +
          `(${candidateErrorRate} > ${baselineErrorRate + errorIncrease})`,
      );
    }

    if (scenarioBudget.errorCounter) {
      const baselineErrors = finiteMetricValue(
        metricValues(baseline, scenarioBudget.errorCounter, scenario),
        'count',
        scenarioBudget.errorCounter,
        scenario,
      );
      const candidateErrors = finiteMetricValue(
        metricValues(candidate, scenarioBudget.errorCounter, scenario),
        'count',
        scenarioBudget.errorCounter,
        scenario,
      );
      if (
        baselineErrors > budgets.maxScenarioErrors ||
        candidateErrors > budgets.maxScenarioErrors
      ) {
        failures.push(
          `${scenario} scenario check errors exceed budget ` +
            `(main ${baselineErrors}, candidate ${candidateErrors}, max ${budgets.maxScenarioErrors})`,
        );
      }
    }

    if (scenarioBudget.requiredCounter) {
      const baselineRequiredCount = finiteMetricValue(
        metricValues(baseline, scenarioBudget.requiredCounter, scenario),
        'count',
        scenarioBudget.requiredCounter,
        scenario,
      );
      const candidateRequiredCount = finiteMetricValue(
        metricValues(candidate, scenarioBudget.requiredCounter, scenario),
        'count',
        scenarioBudget.requiredCounter,
        scenario,
      );
      if (baselineRequiredCount <= 0 || candidateRequiredCount <= 0) {
        failures.push(
          `${scenario} did not record ${scenarioBudget.requiredCounter} ` +
            `(main ${baselineRequiredCount}, candidate ${candidateRequiredCount})`,
        );
      }
    }
  }

  return failures;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

if (require.main === module) {
  const [baselinePath, candidatePath, budgetsPath] = process.argv.slice(2);
  if (!baselinePath || !candidatePath || !budgetsPath) {
    console.error(
      'Usage: compare-ci-results.js <main-summary.json> <candidate-summary.json> <budgets.json>',
    );
    process.exit(2);
  }
  try {
    const failures = compareResults(
      readJson(baselinePath),
      readJson(candidatePath),
      readJson(budgetsPath),
    );
    if (failures.length > 0) {
      console.error('\nK6 performance regression budget failed:');
      for (const failure of failures) console.error(`- ${failure}`);
      process.exitCode = 1;
    } else {
      console.log('\nAll scenario latency and error-rate budgets passed.');
    }
  } catch (err) {
    console.error(
      `Unable to compare k6 summaries: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}

module.exports = { compareResults };
