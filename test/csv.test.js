import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseMeterTimestamp, parseMeterValue, splitCsvLine } from '../src/meter/csv.js';

const BERLIN = 'Europe/Berlin';
const OPTIONS = { timezone: BERLIN, channel: 'main' };

const SAMPLE = `2026-08-08T00:23:52+0200,main,00020.6286,20.6286,20.6286,0.000000,0.0000,no error,0.2,0.2,0.2,2.1,0.2,6.2,2.9,8.5,6.0
2026-08-08T00:28:52+0200,main,00020.6290,20.6290,20.6290,0.000000,0.0000,no error,0.2,0.2,0.2,2.1,0.2,6.2,2.8,8.4,6.0`;

test('parses the documented sample rows', () => {
  const { rows, invalid } = parseCsv(SAMPLE, OPTIONS);

  assert.equal(invalid.length, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].value, 20.6286);
  assert.equal(rows[0].channel, 'main');
  assert.equal(rows[0].localDate, '2026-08-08');
  assert.equal(rows[0].tsUtc, Date.UTC(2026, 7, 7, 22, 23, 52));
  assert.equal(rows[1].tsUtc - rows[0].tsUtc, 5 * 60_000);
});

test('leading zeros in the cumulative reading are handled', () => {
  assert.equal(parseMeterValue('00020.6286'), 20.6286);
  assert.equal(parseMeterValue('0000.0000'), 0);
  assert.equal(parseMeterValue('20,6286'), 20.6286);
  assert.equal(parseMeterValue('not a number'), null);
  assert.equal(parseMeterValue(''), null);
});

test('rows are only valid when column 8 is exactly "no error"', () => {
  const csv = [
    '2026-08-08T00:00:00+0200,main,00010.0000,10,10,0,0,no error,x,x,x,x,x,x,x,x,x',
    '2026-08-08T00:05:00+0200,main,00010.0100,10,10,0,0,sensor error,x,x,x,x,x,x,x,x,x',
    '2026-08-08T00:10:00+0200,main,00010.0200,10,10,0,0,error,x,x,x,x,x,x,x,x,x',
    '2026-08-08T00:15:00+0200,main,00010.0300,10,10,0,0,,x,x,x,x,x,x,x,x,x',
    '2026-08-08T00:20:00+0200,main,00010.0400,10,10,0,0,no error,x,x,x,x,x,x,x,x,x',
  ].join('\n');

  const { rows, invalid } = parseCsv(csv, OPTIONS);

  assert.equal(rows.length, 2);
  assert.equal(invalid.length, 3);
  assert.deepEqual(
    invalid.map((row) => row.reason),
    ['meter_error', 'meter_error', 'meter_error'],
  );
});

test('malformed rows are collected instead of throwing', () => {
  const csv = [
    'timestamp,channel,total,a,b,c,d,status',
    '2026-08-08T00:00:00+0200,main,00010.0000,10,10,0,0,no error',
    'garbage line without commas',
    '2026-08-08T00:05:00+0200,main',
    'not-a-timestamp,main,00010.0100,10,10,0,0,no error',
    '2026-08-08T00:10:00+0200,main,abc,10,10,0,0,no error',
    '2026-08-08T00:15:00+0200,main,-5.0,10,10,0,0,no error',
    '',
    '2026-08-08T00:20:00+0200,main,00010.0500,10,10,0,0,no error',
  ].join('\n');

  const { rows, invalid } = parseCsv(csv, OPTIONS);

  assert.equal(rows.length, 2);
  assert.deepEqual(
    invalid.map((row) => row.reason),
    ['bad_timestamp', 'too_few_columns', 'too_few_columns', 'bad_timestamp', 'bad_value', 'negative_value'],
  );
});

test('only the configured channel is kept', () => {
  const csv = [
    '2026-08-08T00:00:00+0200,main,00010.0000,10,10,0,0,no error',
    '2026-08-08T00:00:00+0200,garden,00003.0000,3,3,0,0,no error',
  ].join('\n');

  const { rows, skippedOtherChannel } = parseCsv(csv, OPTIONS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'main');
  assert.equal(skippedOtherChannel, 1);
});

test('rows are returned in chronological order regardless of file order', () => {
  const csv = [
    '2026-08-08T02:00:00+0200,main,00012.0000,12,12,0,0,no error',
    '2026-08-08T01:00:00+0200,main,00011.0000,11,11,0,0,no error',
  ].join('\n');

  const { rows } = parseCsv(csv, OPTIONS);
  assert.ok(rows[0].tsUtc < rows[1].tsUtc);
  assert.equal(rows[0].value, 11);
});

test('timestamp offsets are honoured in every accepted spelling', () => {
  const expected = Date.UTC(2026, 7, 7, 22, 23, 52);
  assert.equal(parseMeterTimestamp('2026-08-08T00:23:52+0200', BERLIN), expected);
  assert.equal(parseMeterTimestamp('2026-08-08T00:23:52+02:00', BERLIN), expected);
  assert.equal(parseMeterTimestamp('2026-08-07T22:23:52Z', BERLIN), expected);
  // Without an offset the configured timezone applies.
  assert.equal(parseMeterTimestamp('2026-08-08T00:23:52', BERLIN), expected);
  assert.equal(parseMeterTimestamp('2026-13-01T00:00:00+0200', BERLIN), null);
  assert.equal(parseMeterTimestamp('nonsense', BERLIN), null);
});

test('a winter timestamp uses the +01:00 offset written in the file', () => {
  const row = '2026-01-15T08:00:00+0100,main,00010.0000,10,10,0,0,no error';
  const { rows } = parseCsv(row, OPTIONS);
  assert.equal(rows[0].tsUtc, Date.UTC(2026, 0, 15, 7, 0, 0));
  assert.equal(rows[0].localDate, '2026-01-15');
});

test('a reading just after midnight belongs to the new local day', () => {
  // Written into data_2026-08-09.csv by a meter whose file rolls over late.
  const row = '2026-08-10T00:02:00+0200,main,00010.0000,10,10,0,0,no error';
  const { rows } = parseCsv(row, OPTIONS);
  assert.equal(rows[0].localDate, '2026-08-10');
});

test('quoted CSV fields are split correctly', () => {
  assert.deepEqual(splitCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepEqual(splitCsvLine('a,"say ""hi""",c'), ['a', 'say "hi"', 'c']);
  assert.deepEqual(splitCsvLine('a;b', ';'), ['a', 'b']);
});

test('an empty or missing file yields no rows and no crash', () => {
  assert.deepEqual(parseCsv('', OPTIONS).rows, []);
  assert.deepEqual(parseCsv(null, OPTIONS).rows, []);
  assert.deepEqual(parseCsv('\n\n  \n', OPTIONS).rows, []);
});
