import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PHASE1_RULESET, evaluateRace, rulesetHash } from '../js/core/rules-core.js';
import { explainEmptyWindow, runBacktest } from '../js/core/backtest-core.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(rootDir, 'data', 'fixtures');

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const manifest = readJson(path.join(fixturesDir, 'fixtures-manifest.json'));
const fixtures = manifest.races.map((entry) => readJson(path.join(fixturesDir, entry.file)));

const window = { from: '2026-08-01', to: '2026-08-15' };
const earlyFixtures = fixtures.filter((race) => race.date === '2026-08-06' || race.date === '2026-08-07');

test('precondition: every stored fixture sits in 1-7 August, is flagged and validation-passed', () => {
  assert.ok(fixtures.length > 0, 'fixtures must exist for this regression suite');
  for (const race of fixtures) {
    assert.equal(race.testData, true, `${race.raceId} must be flagged as test data`);
    assert.equal(race.validation.status, 'passed', `${race.raceId} must pass validation`);
    assert.ok(race.date >= '2026-08-01' && race.date <= '2026-08-07', `${race.raceId} date ${race.date} outside 1-7 August`);
  }
  assert.ok(earlyFixtures.length > 0, '6-7 August fixtures must exist');
});

test('regression: August fixtures are included in Backtest A when fixtures are requested', () => {
  const report = runBacktest({ races: fixtures, options: { ...window, includeTestData: true } });

  assert.equal(report.includeTestData, true);
  assert.equal(report.totals.racesLoaded, fixtures.length);
  assert.equal(report.totals.racesOutsideWindow, 0);
  assert.equal(report.totals.racesExcludedByTestDataFilter, 0);
  assert.equal(report.totals.racesExcludedByValidation, 0);
  assert.equal(report.totals.racesInWindow, fixtures.length);

  for (const race of fixtures) {
    assert.ok(
      report.perRace.some((row) => row.raceId === race.raceId),
      `${race.raceId} must appear in the report`
    );
  }

  const daysWithRaces = report.coverage.days.filter((day) => day.races > 0).map((day) => day.date);
  for (const date of new Set(earlyFixtures.map((race) => race.date))) {
    assert.ok(daysWithRaces.includes(date), `${date} must be a day with data`);
  }
  assert.ok(report.coverage.daysWithData > 0, 'the report must not claim 0 days with data');
});

test('regression: with fixtures off the run reports zero races but proves the fixtures were loaded and filtered', () => {
  const report = runBacktest({ races: fixtures, options: { ...window } });

  assert.equal(report.includeTestData, false);
  assert.equal(report.totals.racesInWindow, 0);
  assert.equal(report.coverage.daysWithData, 0);

  assert.equal(report.totals.racesLoaded, fixtures.length, 'fixtures were loaded into the engine');
  assert.equal(report.totals.racesExcludedByTestDataFilter, fixtures.length, 'every fixture was excluded by the test-data filter');
});

test('regression: the empty-report explanation separates "nothing loaded" from "loaded but filtered"', () => {
  const nothingLoaded = runBacktest({ races: [] });
  assert.equal(nothingLoaded.totals.racesLoaded, 0);
  assert.match(explainEmptyWindow(nothingLoaded), /No race records were loaded/);

  const fixturesFiltered = runBacktest({ races: fixtures, options: { ...window } });
  const filteredExplanation = explainEmptyWindow(fixturesFiltered);
  assert.ok(filteredExplanation, 'a zero-race report must carry an explanation');
  assert.doesNotMatch(filteredExplanation, /No race records were loaded/);
  assert.match(filteredExplanation, new RegExp(String(fixtures.length)));
  assert.match(filteredExplanation, /synthetic fixture\(s\) were excluded because "Include synthetic fixtures" was not ticked/);

  const outsideWindow = runBacktest({ races: fixtures, options: { from: '2026-08-08', to: '2026-08-15', includeTestData: true } });
  assert.equal(outsideWindow.totals.racesInWindow, 0);
  assert.equal(outsideWindow.totals.racesOutsideWindow, fixtures.length);
  assert.match(explainEmptyWindow(outsideWindow), /fall outside the selected window/);

  const populated = runBacktest({ races: fixtures, options: { ...window, includeTestData: true } });
  assert.equal(explainEmptyWindow(populated), null, 'no explanation when races were evaluated');

  const legacyStoredReport = { totals: { racesInWindow: 0, qualified: 0 } };
  assert.match(explainEmptyWindow(legacyStoredReport), /predates the load counters/);
});

test('regression: fixtures run through the same locked Phase 1 ruleset, matching the manifest', () => {
  const report = runBacktest({ races: fixtures, options: { ...window, includeTestData: true } });

  assert.equal(report.ruleset.id, PHASE1_RULESET.id);
  assert.equal(report.ruleset.version, PHASE1_RULESET.version);
  assert.equal(report.ruleset.locked, true);
  assert.equal(report.ruleset.hash, rulesetHash(PHASE1_RULESET));
  assert.deepEqual(report.evaluationMismatches, []);

  for (const entry of manifest.races) {
    const race = fixtures.find((candidate) => candidate.raceId === entry.raceId);
    const row = report.perRace.find((candidate) => candidate.raceId === entry.raceId);
    assert.ok(row, `missing report row for ${entry.raceId}`);

    const evaluation = evaluateRace(race, PHASE1_RULESET);
    assert.equal(row.status, evaluation.status, `engine status mismatch for ${entry.raceId}`);
    assert.equal(row.rejectionCode ?? null, evaluation.rejectionCode ?? null, `engine rejection mismatch for ${entry.raceId}`);
    assert.equal(
      row.candidateRunnerNumber ?? null,
      evaluation.candidate ? evaluation.candidate.runnerNumber : null,
      `engine candidate mismatch for ${entry.raceId}`
    );

    assert.equal(row.status, entry.expected.status, `manifest status mismatch for ${entry.raceId}`);
    assert.equal(row.rejectionCode ?? null, entry.expected.rejectionCode ?? null, `manifest rejection mismatch for ${entry.raceId}`);
  }
});

test('regression: the 6-7 August window boundaries are inclusive and the filtered run stays explained', () => {
  const onSixth = fixtures.filter((race) => race.date === '2026-08-06').length;
  const onSeventh = fixtures.filter((race) => race.date === '2026-08-07').length;
  assert.ok(onSixth > 0 && onSeventh > 0, 'fixtures exist on both boundary dates');

  const upToSixth = runBacktest({ races: fixtures, options: { from: '2026-08-01', to: '2026-08-06', includeTestData: true } });
  assert.equal(upToSixth.totals.racesInWindow, fixtures.filter((race) => race.date <= '2026-08-06').length);

  const seventhOnly = runBacktest({ races: fixtures, options: { from: '2026-08-07', to: '2026-08-07', includeTestData: true } });
  assert.equal(seventhOnly.totals.racesInWindow, onSeventh, 'the final boundary date must be inclusive');

  const seventhOnlyWithoutFixtures = runBacktest({ races: fixtures, options: { from: '2026-08-07', to: '2026-08-07' } });
  assert.equal(seventhOnlyWithoutFixtures.totals.racesInWindow, 0);
  assert.equal(seventhOnlyWithoutFixtures.totals.racesExcludedByTestDataFilter, onSeventh);
  assert.match(explainEmptyWindow(seventhOnlyWithoutFixtures), /synthetic fixture\(s\) were excluded/);
});
