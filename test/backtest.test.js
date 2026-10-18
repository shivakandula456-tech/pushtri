import test from 'node:test';
import assert from 'node:assert/strict';
import { backtestToCsv, runBacktest } from '../js/core/backtest-core.js';
import { PHASE1_RULESET, makeExperimentalRuleset } from '../js/core/rules-core.js';
import { addDays, eachDate } from '../js/core/util.js';

function buildRace({ raceId, date, candidatePosition, favouritePosition, resultStatus = 'resolved', rejectionOverride = null, testData = false, validationStatus = 'passed' }) {
  const runners = [
    { runnerNumber: 1, name: 'Favourite', status: 'runner', odds: { fractional: '6/4', decimal: 2.5 }, finishPosition: favouritePosition ?? null, resultStatus: favouritePosition ? 'finished' : null },
    { runnerNumber: 2, name: 'Mid', status: 'runner', odds: { fractional: '6/1', decimal: 7 }, finishPosition: null, resultStatus: null },
    { runnerNumber: 3, name: 'Candidate', status: 'runner', odds: { fractional: '12/1', decimal: 13 }, finishPosition: candidatePosition ?? null, resultStatus: candidatePosition ? 'finished' : null },
    { runnerNumber: 4, name: 'Other', status: 'runner', odds: { fractional: '8/1', decimal: 9 }, finishPosition: null, resultStatus: null },
    { runnerNumber: 5, name: 'Longshot', status: 'runner', odds: { fractional: '16/1', decimal: 17 }, finishPosition: null, resultStatus: null },
    { runnerNumber: 6, name: 'Extra', status: 'runner', odds: { fractional: '20/1', decimal: 21 }, finishPosition: null, resultStatus: null }
  ];
  if (rejectionOverride === 'NO_LONGSHOT') {
    runners.forEach((r) => {
      if (r.odds.decimal >= 11) r.odds = { fractional: '9/1', decimal: 10 };
    });
  }
  const race = {
    raceId,
    dataset: testData ? 'test-fixture' : 'published',
    testData,
    source: testData ? 'test-fixture-generator' : 'atr',
    sourceUrl: null,
    retrievedAt: '2026-08-01T17:00:00.000Z',
    parserVersion: 'test',
    date,
    time: '14:00',
    course: 'Backtestville',
    courseRegion: 'GB',
    raceType: 'Flat',
    isHandicap: true,
    class: 4,
    name: 'Backtest Handicap',
    declaredRunners: runners.length,
    actualRunners: runners.length,
    resultStatus,
    validation: { status: validationStatus, checks: [] },
    runners
  };
  return race;
}

test('backtest evaluates only stored validated data inside the window', () => {
  const races = [
    buildRace({ raceId: 'BT-1', date: '2026-08-01', candidatePosition: 1, favouritePosition: 2 }),
    buildRace({ raceId: 'BT-2', date: '2026-08-02', candidatePosition: null, favouritePosition: null, resultStatus: 'unresolved' }),
    buildRace({ raceId: 'BT-3', date: '2026-08-03', rejectionOverride: 'NO_LONGSHOT', candidatePosition: 1, favouritePosition: 2 }),
    buildRace({ raceId: 'BT-4', date: '2026-09-01', candidatePosition: 1, favouritePosition: 2 }),
    buildRace({ raceId: 'BT-5', date: '2026-08-04', candidatePosition: 1, favouritePosition: 2, validationStatus: 'failed' })
  ];
  const report = runBacktest({ races, options: { from: '2026-08-01', to: '2026-08-15' } });
  assert.equal(report.totals.racesInWindow, 3);
  assert.equal(report.totals.racesExcludedByValidation, 1);
  assert.equal(report.totals.qualified, 2);
  assert.equal(report.totals.rejected, 1);
  assert.equal(report.totals.byRejectionCode.NO_LONGSHOT, 1);
  assert.equal(report.totals.resolvedQualified, 1);
  assert.equal(report.totals.missingResults, 1);
  assert.equal(report.totals.unresolvedSelections, 1);
  assert.equal(report.outcomes.candidateWins, 1);
  assert.equal(report.outcomes.candidateWinRate, 1);
  assert.equal(report.outcomes.favouriteWins, 0);
  assert.equal(report.coverage.daysWithoutData.length, 12);
  assert.ok(report.coverage.daysWithData >= 3);
});

test('test data is excluded unless explicitly requested and is always flagged', () => {
  const races = [buildRace({ raceId: 'BT-FIX', date: '2026-08-01', candidatePosition: 1, favouritePosition: 1, testData: true })];
  const without = runBacktest({ races, options: { from: '2026-08-01', to: '2026-08-15' } });
  assert.equal(without.totals.racesInWindow, 0);
  assert.equal(without.includeTestData, false);
  const withFixtures = runBacktest({ races, options: { from: '2026-08-01', to: '2026-08-15', includeTestData: true } });
  assert.equal(withFixtures.totals.racesInWindow, 1);
  assert.equal(withFixtures.includeTestData, true);
  assert.equal(withFixtures.perRace[0].testData, true);
});

test('stored evaluation mismatches are surfaced, not hidden', () => {
  const race = buildRace({ raceId: 'BT-MISMATCH', date: '2026-08-01', candidatePosition: 1, favouritePosition: 2 });
  race.evaluation = {
    rulesetId: 'phase1',
    rulesetVersion: PHASE1_RULESET.version,
    status: 'qualified',
    rejectionCode: null,
    candidate: { runnerNumber: 99, name: 'Ghost', decimal: 13 },
    favourite: { runnerNumber: 1, name: 'Favourite', decimal: 2.5 },
    actualRunners: 6,
    longshots: [],
    nonRunnerNumbers: []
  };
  const report = runBacktest({ races: [race], options: { from: '2026-08-01', to: '2026-08-15' } });
  assert.deepEqual(report.evaluationMismatches, ['BT-MISMATCH']);
});

test('experimental rulesets run in the same engine marked unlocked', () => {
  const race = buildRace({ raceId: 'BT-EXP', date: '2026-08-01', candidatePosition: 1, favouritePosition: 2 });
  race.runners[0].odds = { fractional: '3/1', decimal: 4 };
  const phase1 = runBacktest({ races: [race], options: { from: '2026-08-01', to: '2026-08-15' } });
  assert.equal(phase1.totals.qualified, 0);
  const experimental = makeExperimentalRuleset({ favouriteMode: 'ignore', label: 'No favourite rule' });
  const report = runBacktest({ races: [race], ruleset: experimental, options: { from: '2026-08-01', to: '2026-08-15' } });
  assert.equal(report.totals.qualified, 1);
  assert.equal(report.ruleset.locked, false);
  assert.ok(report.ruleset.hash.length > 0);
});

test('non-finisher selections are counted separately from wins', () => {
  const race = buildRace({ raceId: 'BT-NF', date: '2026-08-01', candidatePosition: null, favouritePosition: 1 });
  race.runners[2].resultStatus = 'pulled_up';
  race.resultStatus = 'resolved';
  const report = runBacktest({ races: [race], options: { from: '2026-08-01', to: '2026-08-15' } });
  assert.equal(report.outcomes.candidateNonFinishers, 1);
  assert.equal(report.outcomes.candidateWins, 0);
  assert.equal(report.outcomes.favouriteWins, 1);
  assert.equal(report.perRace[0].won, false);
});

test('backtest CSV export contains the per-race rows', () => {
  const races = [buildRace({ raceId: 'BT-CSV', date: '2026-08-01', candidatePosition: 1, favouritePosition: 2 })];
  const report = runBacktest({ races, options: { from: '2026-08-01', to: '2026-08-15' } });
  const csv = backtestToCsv(report);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('raceId,date,course'));
  assert.ok(lines[1].includes('BT-CSV'));
});

test('Backtest A defaults to the inclusive 2026-08-01 to 2026-08-15 window', () => {
  const races = [
    buildRace({ raceId: 'BT-BEFORE', date: '2026-07-31', candidatePosition: 1, favouritePosition: 2 }),
    buildRace({ raceId: 'BT-FIRST', date: '2026-08-01', candidatePosition: 1, favouritePosition: 2 }),
    buildRace({ raceId: 'BT-LAST', date: '2026-08-15', candidatePosition: 1, favouritePosition: 2 }),
    buildRace({ raceId: 'BT-AFTER', date: '2026-08-16', candidatePosition: 1, favouritePosition: 2 })
  ];
  const report = runBacktest({ races });
  assert.deepEqual(report.window, { from: '2026-08-01', to: '2026-08-15' });
  assert.equal(report.totals.racesInWindow, 2);
  assert.deepEqual(report.perRace.map((row) => row.raceId), ['BT-FIRST', 'BT-LAST']);
  assert.equal(report.coverage.daysRequested, 15);
});

test('window day arithmetic is UTC-safe and never shifts across timezones or DST', () => {
  const days = eachDate('2026-08-01', '2026-08-15');
  assert.equal(days.length, 15);
  assert.equal(days[0], '2026-08-01');
  assert.equal(days[14], '2026-08-15');
  assert.equal(addDays('2026-03-28', 1), '2026-03-29');
  assert.equal(addDays('2026-10-24', 1), '2026-10-25');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
});

test('a race starting at 23:59 on a boundary date stays inside the window', () => {
  const late = buildRace({ raceId: 'BT-LATE', date: '2026-08-15', candidatePosition: 1, favouritePosition: 2 });
  late.time = '23:59';
  const report = runBacktest({ races: [late] });
  assert.equal(report.totals.racesInWindow, 1);
  assert.equal(report.coverage.days.find((day) => day.date === '2026-08-15').races, 1);
});

test('totals are internally consistent so no count or denominator is invented', () => {
  const races = [
    buildRace({ raceId: 'BT-C1', date: '2026-08-01', candidatePosition: 1, favouritePosition: 2 }),
    buildRace({ raceId: 'BT-C2', date: '2026-08-02', candidatePosition: 2, favouritePosition: 1 }),
    buildRace({ raceId: 'BT-U1', date: '2026-08-03', candidatePosition: null, favouritePosition: null, resultStatus: 'unresolved' }),
    buildRace({ raceId: 'BT-U2', date: '2026-08-04', candidatePosition: null, favouritePosition: null, resultStatus: 'partial' }),
    buildRace({ raceId: 'BT-R1', date: '2026-08-05', rejectionOverride: 'NO_LONGSHOT', candidatePosition: null, favouritePosition: null })
  ];
  const report = runBacktest({ races });
  const totals = report.totals;
  assert.equal(totals.qualified + totals.rejected, totals.racesInWindow);
  assert.equal(Object.values(totals.byRejectionCode).reduce((sum, count) => sum + count, 0), totals.rejected);
  assert.equal(totals.resolvedQualified + totals.unresolvedSelections, totals.qualified);
  assert.equal(totals.missingResults + totals.partialResults, totals.unresolvedSelections);
  assert.ok(report.outcomes.candidateWins + report.outcomes.candidateNonFinishers <= totals.resolvedQualified);
  assert.equal(report.outcomes.candidateWinRate, report.outcomes.candidateWins / totals.resolvedQualified);
  assert.equal(report.outcomes.favouriteWinRate, report.outcomes.favouriteWins / totals.resolvedQualified);
  assert.equal(totals.missingResults, 1);
  assert.equal(totals.partialResults, 1);
});

test('empty windows report null win rates instead of invented numbers', () => {
  const report = runBacktest({ races: [] });
  assert.equal(report.totals.racesInWindow, 0);
  assert.equal(report.totals.qualified, 0);
  assert.equal(report.outcomes.candidateWinRate, null);
  assert.equal(report.outcomes.favouriteWinRate, null);
});

test('no staking, payout or ROI fields exist in the report payload', () => {
  const races = [buildRace({ raceId: 'BT-SCOPE', date: '2026-08-01', candidatePosition: 1, favouritePosition: 2 })];
  const report = runBacktest({ races, options: { from: '2026-08-01', to: '2026-08-15' } });
  const serialized = JSON.stringify(report).toLowerCase();
  for (const forbidden of ['stake', 'payout', 'roi', 'profit', 'return on investment', 'bet']) {
    assert.equal(serialized.includes(forbidden), false, `report must not mention ${forbidden}`);
  }
});
