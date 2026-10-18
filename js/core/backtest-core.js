import { PHASE1_RULESET, REJECTION_CODES, evaluateRace, isRunner, rulesetHash } from './rules-core.js';
import { eachDate, isoNow } from './util.js';

export const BACKTEST_NOTES = [
  'Metrics are descriptive statistics about stored, validated historical records only.',
  'Money-related measures are out of scope for this project by design; see docs/RULES.md.',
  'Fixture datasets are synthetic and are never treated as production data.'
];

function outcomeOfRunner(runner) {
  if (!runner) return null;
  if (Number.isInteger(runner.finishPosition)) return { type: 'finished', position: runner.finishPosition };
  if (runner.resultStatus && runner.resultStatus !== 'unresolved' && runner.resultStatus !== 'finished') return { type: runner.resultStatus, position: null };
  return null;
}

export function runBacktest({ races, ruleset = PHASE1_RULESET, options = {} }) {
  const {
    from = '2026-08-01',
    to = '2026-08-15',
    includeTestData = false,
    requireValidationPassed = true,
    generatedAt = isoNow()
  } = options;

  let racesLoaded = 0;
  let racesWithoutValidDate = 0;
  let racesOutsideWindow = 0;
  let racesExcludedByTestDataFilter = 0;

  const source = (races || []).filter((race) => {
    racesLoaded += 1;
    if (!race || typeof race.date !== 'string') {
      racesWithoutValidDate += 1;
      return false;
    }
    if (race.date < from || race.date > to) {
      racesOutsideWindow += 1;
      return false;
    }
    if (!includeTestData && race.testData === true) {
      racesExcludedByTestDataFilter += 1;
      return false;
    }
    return true;
  });

  const included = [];
  const excluded = [];
  for (const race of source) {
    const validationStatus = race.validation && race.validation.status ? race.validation.status : 'unknown';
    if (requireValidationPassed && validationStatus !== 'passed') {
      excluded.push({ raceId: race.raceId, reason: `validation.status=${validationStatus}` });
      continue;
    }
    included.push(race);
  }

  const byRejectionCode = {};
  for (const code of Object.values(REJECTION_CODES)) byRejectionCode[code] = 0;

  const perRace = [];
  const evaluationMismatches = [];
  let qualifiedCount = 0;
  let resolvedQualified = 0;
  let unresolvedSelections = 0;
  let partialSelections = 0;
  let missingResults = 0;
  let candidateWins = 0;
  let favouriteWins = 0;
  let longshotWins = 0;
  let nonFinisherSelections = 0;
  const candidateFinishDistribution = {};

  for (const race of included) {
    let evaluation = race.evaluation;
    const isPhase1 = ruleset.id === 'phase1';
    if (!evaluation || evaluation.rulesetVersion !== ruleset.version) {
      evaluation = evaluateRace(race, ruleset);
    } else if (isPhase1) {
      const recomputed = evaluateRace(race, ruleset);
      if (recomputed.status !== evaluation.status || (recomputed.candidate && evaluation.candidate && recomputed.candidate.runnerNumber !== evaluation.candidate.runnerNumber)) {
        evaluationMismatches.push(race.raceId);
      }
    }

    const entry = {
      raceId: race.raceId,
      date: race.date,
      course: race.course,
      class: race.class,
      actualRunners: evaluation.actualRunners,
      status: evaluation.status,
      rejectionCode: evaluation.rejectionCode,
      testData: race.testData === true,
      resultStatus: race.resultStatus || 'unresolved'
    };

    if (evaluation.status === 'rejected') {
      if (evaluation.rejectionCode && byRejectionCode[evaluation.rejectionCode] !== undefined) byRejectionCode[evaluation.rejectionCode] += 1;
      perRace.push(entry);
      continue;
    }

    qualifiedCount += 1;
    const runners = race.runners || [];
    const findRunner = (number) => runners.find((r) => r.runnerNumber === number);
    const candidateRunner = evaluation.candidate ? findRunner(evaluation.candidate.runnerNumber) : null;
    const favouriteRunner = evaluation.favourite ? findRunner(evaluation.favourite.runnerNumber) : null;
    const candidateOutcome = outcomeOfRunner(candidateRunner);
    const favouriteOutcome = outcomeOfRunner(favouriteRunner);

    entry.candidateRunnerNumber = evaluation.candidate ? evaluation.candidate.runnerNumber : null;
    entry.candidateName = evaluation.candidate ? evaluation.candidate.name : null;
    entry.candidateDecimal = evaluation.candidate ? evaluation.candidate.decimal : null;
    entry.favouriteRunnerNumber = evaluation.favourite ? evaluation.favourite.runnerNumber : null;
    entry.favouriteDecimal = evaluation.favourite ? evaluation.favourite.decimal : null;
    entry.candidateTieBreak = evaluation.candidate ? evaluation.candidate.tieBreakApplied === true : false;

    if (race.resultStatus === 'resolved') {
      resolvedQualified += 1;
      if (candidateOutcome && candidateOutcome.type === 'finished') {
        const pos = candidateOutcome.position;
        entry.candidateFinishPosition = pos;
        candidateFinishDistribution[pos] = (candidateFinishDistribution[pos] || 0) + 1;
        if (pos === 1) {
          candidateWins += 1;
          longshotWins += 1;
        }
      } else {
        nonFinisherSelections += 1;
        entry.candidateNonFinishReason = candidateOutcome ? candidateOutcome.type : 'unknown';
      }
      if (favouriteOutcome && favouriteOutcome.type === 'finished' && favouriteOutcome.position === 1) favouriteWins += 1;
      entry.favouriteFinishPosition = favouriteOutcome && favouriteOutcome.type === 'finished' ? favouriteOutcome.position : null;
      entry.outcomeKnown = true;
      entry.won = entry.candidateFinishPosition === 1;
    } else if (race.resultStatus === 'partial') {
      partialSelections += 1;
      unresolvedSelections += 1;
      entry.outcomeKnown = false;
    } else {
      missingResults += 1;
      unresolvedSelections += 1;
      entry.outcomeKnown = false;
    }

    perRace.push(entry);
  }

  const days = eachDate(from, to);
  const coverageDays = days.map((day) => {
    const dayRaces = included.filter((r) => r.date === day);
    const dayQualified = dayRaces.filter((r) => {
      const evaluation = r.evaluation && r.evaluation.rulesetVersion === ruleset.version ? r.evaluation : evaluateRace(r, ruleset);
      return evaluation.status === 'qualified';
    });
    return {
      date: day,
      races: dayRaces.length,
      qualified: dayQualified.length,
      resolved: dayRaces.filter((r) => r.resultStatus === 'resolved').length,
      testData: dayRaces.some((r) => r.testData === true)
    };
  });

  const winRate = resolvedQualified > 0 ? candidateWins / resolvedQualified : null;
  const favouriteWinRate = resolvedQualified > 0 ? favouriteWins / resolvedQualified : null;

  return {
    generatedAt,
    ruleset: {
      id: ruleset.id,
      version: ruleset.version,
      label: ruleset.label,
      locked: ruleset.locked === true,
      hash: rulesetHash(ruleset),
      rules: ruleset.rules
    },
    window: { from, to },
    includeTestData,
    requireValidationPassed,
    coverage: {
      daysRequested: days.length,
      daysWithData: coverageDays.filter((d) => d.races > 0).length,
      daysWithoutData: coverageDays.filter((d) => d.races === 0).map((d) => d.date),
      days: coverageDays
    },
    totals: {
      racesLoaded,
      racesWithoutValidDate,
      racesOutsideWindow,
      racesExcludedByTestDataFilter,
      racesInWindow: included.length,
      racesExcludedByValidation: excluded.length,
      qualified: qualifiedCount,
      rejected: included.length - qualifiedCount,
      byRejectionCode,
      resolvedQualified,
      missingResults,
      partialResults: partialSelections,
      unresolvedSelections
    },
    outcomes: {
      candidateWins,
      candidateWinRate: winRate,
      candidateFinishDistribution,
      candidateNonFinishers: nonFinisherSelections,
      favouriteWins,
      favouriteWinRate,
      longshotWins
    },
    evaluationMismatches,
    excluded,
    perRace,
    notes: [...BACKTEST_NOTES]
  };
}

export function explainEmptyWindow(report) {
  const totals = report && report.totals ? report.totals : {};
  if ((totals.racesInWindow || 0) > 0) return null;
  if (typeof totals.racesLoaded !== 'number') {
    return 'No races were evaluated in this window. This stored report predates the load counters, so it cannot say whether nothing was loaded or everything was filtered out.';
  }
  const loaded = totals.racesLoaded;
  if (loaded === 0) {
    return 'No race records were loaded at all. The published dataset is empty because collection has not started, and synthetic fixtures are only loaded when explicitly requested.';
  }
  const reasons = [];
  if (totals.racesOutsideWindow) reasons.push(`${totals.racesOutsideWindow} fall outside the selected window`);
  if (totals.racesExcludedByTestDataFilter) reasons.push(`${totals.racesExcludedByTestDataFilter} synthetic fixture(s) were excluded because "Include synthetic fixtures" was not ticked`);
  if (totals.racesExcludedByValidation) reasons.push(`${totals.racesExcludedByValidation} were excluded by validation.status ≠ passed`);
  if (totals.racesWithoutValidDate) reasons.push(`${totals.racesWithoutValidDate} have no usable date`);
  if (reasons.length === 0) {
    return `${loaded} race record(s) were loaded but none reached the evaluation stage.`;
  }
  return `${loaded} race record(s) were loaded, but none were evaluated: ${reasons.join('; ')}.`;
}

export function backtestToCsv(report) {
  const header = [
    'raceId', 'date', 'course', 'class', 'actualRunners', 'status', 'rejectionCode',
    'candidateRunnerNumber', 'candidateName', 'candidateDecimal', 'candidateFinishPosition',
    'favouriteRunnerNumber', 'favouriteDecimal', 'favouriteFinishPosition', 'resultStatus', 'outcomeKnown', 'won'
  ];
  const rows = report.perRace.map((r) => header.map((h) => {
    const v = r[h];
    if (v === undefined || v === null) return '';
    return typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v);
  }).join(','));
  return `${header.join(',')}\n${rows.join('\n')}\n`;
}
