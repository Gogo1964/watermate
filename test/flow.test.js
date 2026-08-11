import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSeries } from '../src/analysis/series.js';
import { advanceFlow, createInitialFlowState, FLOW_EVENT } from '../src/analysis/flow.js';
import { makeReadings, berlinSummer } from './helpers.js';

const ANALYSIS = {
  decreaseTolerance: 0.0005,
  maxPlausibleDelta: 1,
  maxGapMs: 30 * 60_000,
  flowThreshold: 0.001,
  expectedIntervalMs: 5 * 60_000,
};
const FLOW = { durationMs: 3 * 3_600_000, reAlertMs: 0 };
const START = berlinSummer(8, 0);

/** Runs the detector over a delta pattern, 5 minutes per entry. */
function run(deltas, { state = createInitialFlowState('main'), options = FLOW, analysis = ANALYSIS } = {}) {
  const readings = makeReadings({ startTs: START, start: 100, deltas });
  const { intervals } = analyzeSeries(readings, analysis);
  return advanceFlow(state, intervals, options);
}

const flowing = (count) => Array.from({ length: count }, () => 0.01);
const idle = (count) => Array.from({ length: count }, () => 0);

test('no alert while the flow is shorter than the configured duration', () => {
  // 35 intervals × 5 min = 2 h 55 min.
  const { state, events } = run(flowing(35));

  assert.equal(state.flowing, true);
  assert.equal(state.alerted, false);
  assert.equal(events.filter((event) => event.type === FLOW_EVENT.ALERT).length, 0);
  assert.equal(events.filter((event) => event.type === FLOW_EVENT.START).length, 1);
});

test('an alert fires once the flow exceeds three hours', () => {
  // 36 intervals × 5 min = exactly 3 h.
  const { state, events } = run(flowing(36));
  const alerts = events.filter((event) => event.type === FLOW_EVENT.ALERT);

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].durationMs, 3 * 3_600_000);
  assert.equal(alerts[0].volume, 0.36);
  assert.equal(alerts[0].repeat, false);
  assert.equal(state.alerted, true);
});

test('the alert is not repeated while the flow continues', () => {
  // Six hours of uninterrupted flow must still produce exactly one alert.
  const { events } = run(flowing(72));
  assert.equal(events.filter((event) => event.type === FLOW_EVENT.ALERT).length, 1);
});

test('processing in several batches still alerts only once', () => {
  // Mirrors real operation: the poller adds readings a few at a time.
  let state = createInitialFlowState('main');
  let alerts = 0;
  let value = 100;
  let ts = START;

  for (let batch = 0; batch < 20; batch += 1) {
    const readings = [{ tsUtc: ts, value }];
    for (let i = 0; i < 4; i += 1) {
      ts += 5 * 60_000;
      value = Math.round((value + 0.01) * 1e6) / 1e6;
      readings.push({ tsUtc: ts, value });
    }
    const { intervals } = analyzeSeries(readings, ANALYSIS);
    const result = advanceFlow(state, intervals, FLOW);
    state = result.state;
    alerts += result.events.filter((event) => event.type === FLOW_EVENT.ALERT).length;
  }

  assert.equal(alerts, 1);
  assert.equal(state.flowing, true);
});

test('the condition resets after the flow stops and can alert again', () => {
  const first = run([...flowing(40), ...idle(2)]);
  assert.equal(first.state.flowing, false);
  assert.equal(first.state.alerted, false);
  assert.equal(first.events.filter((event) => event.type === FLOW_EVENT.ALERT).length, 1);

  const ended = first.events.find((event) => event.type === FLOW_EVENT.END);
  assert.equal(ended.reason, 'flow_stopped');
  assert.equal(ended.durationMs, 40 * 5 * 60_000);

  // A second leak later on is a new episode and alerts again.
  const second = run(flowing(40), { state: first.state });
  assert.equal(second.events.filter((event) => event.type === FLOW_EVENT.ALERT).length, 1);
});

test('a short pause interrupts the episode, so a leak-free day never alerts', () => {
  // Twelve bursts of 50 minutes each, separated by a single idle interval.
  const pattern = [];
  for (let i = 0; i < 12; i += 1) pattern.push(...flowing(10), ...idle(1));

  const { events, state } = run(pattern);
  assert.equal(events.filter((event) => event.type === FLOW_EVENT.ALERT).length, 0);
  assert.equal(state.flowing, false);
});

test('trickle below the detection threshold is not treated as flow', () => {
  // 0.0005 per interval stays under FLOW_DETECTION_THRESHOLD of 0.001.
  const { events, state } = run(Array.from({ length: 60 }, () => 0.0005));
  assert.equal(events.length, 0);
  assert.equal(state.flowing, false);
});

test('a data gap ends the episode instead of inventing continuous flow', () => {
  const readings = [
    ...makeReadings({ startTs: START, start: 100, deltas: flowing(6) }),
    // Two hour outage, then flow resumes.
    { tsUtc: START + 6 * 5 * 60_000 + 2 * 3_600_000, value: 101 },
    { tsUtc: START + 6 * 5 * 60_000 + 2 * 3_600_000 + 300_000, value: 101.01 },
  ];
  const { intervals } = analyzeSeries(readings, ANALYSIS);
  const { state, events } = advanceFlow(createInitialFlowState('main'), intervals, FLOW);

  const ended = events.find((event) => event.type === FLOW_EVENT.END);
  assert.equal(ended.reason, 'data_gap');
  // A new episode starts after the gap; it is only 5 minutes old.
  assert.equal(state.flowing, true);
  assert.equal(state.startedAt, START + 6 * 5 * 60_000 + 2 * 3_600_000);
  assert.equal(events.filter((event) => event.type === FLOW_EVENT.ALERT).length, 0);
});

test('an outage spanning more than the alert duration does not alert', () => {
  // Two readings four hours apart with a large delta: plenty of water, but
  // nothing proves it flowed continuously.
  const readings = [
    { tsUtc: START, value: 100 },
    { tsUtc: START + 4 * 3_600_000, value: 100.9 },
  ];
  const { intervals } = analyzeSeries(readings, ANALYSIS);
  const { events } = advanceFlow(createInitialFlowState('main'), intervals, FLOW);

  assert.equal(events.filter((event) => event.type === FLOW_EVENT.ALERT).length, 0);
});

test('a meter decrease does not count as flow', () => {
  const readings = [
    ...makeReadings({ startTs: START, start: 100, deltas: flowing(40) }),
  ];
  readings.push({ tsUtc: readings.at(-1).tsUtc + 300_000, value: 3 });
  const { intervals } = analyzeSeries(readings, ANALYSIS);
  const { state, events } = advanceFlow(createInitialFlowState('main'), intervals, FLOW);

  assert.equal(state.flowing, false);
  assert.equal(events.at(-1).type, FLOW_EVENT.END);
});

test('repeat alerts are sent when CONTINUOUS_FLOW_REALERT_HOURS is set', () => {
  const { events } = run(flowing(72), { options: { durationMs: 3 * 3_600_000, reAlertMs: 3_600_000 } });
  const alerts = events.filter((event) => event.type === FLOW_EVENT.ALERT);

  // Alert at 3 h, then reminders at 4 h, 5 h and 6 h.
  assert.equal(alerts.length, 4);
  assert.deepEqual(
    alerts.map((alert) => alert.repeat),
    [false, true, true, true],
  );
});

test('an episode survives a restart and alerts on the far side of it', () => {
  // Before the restart: 2 h 20 min of flow, no alert yet.
  const first = run(flowing(28));
  assert.equal(first.events.filter((event) => event.type === FLOW_EVENT.ALERT).length, 0);

  // The state is persisted as plain data, so a JSON round-trip stands in for
  // writing it to SQLite and reading it back after a restart.
  const restored = JSON.parse(JSON.stringify(first.state));
  assert.equal(restored.flowing, true);

  // After the restart the monitor anchors on the stored cursor and continues.
  const readings = makeReadings({
    startTs: restored.lastTs,
    start: restored.lastValue,
    deltas: flowing(12),
  });
  const { intervals } = analyzeSeries(readings, ANALYSIS);
  const { state, events } = advanceFlow(restored, intervals, FLOW);

  assert.equal(events.filter((event) => event.type === FLOW_EVENT.START).length, 0);
  assert.equal(state.startedAt, first.state.startedAt);
  const alerts = events.filter((event) => event.type === FLOW_EVENT.ALERT);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].durationMs, 3 * 3_600_000);
});
