// Run: node --test src/lib/__tests__/*.test.mts  (Node 22.6+ strips TS types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_SOURCES, NO_SOURCE, matchesSource, distinctSources, pickStaged, pickerToDeployFilter, sourceLabel } from '../leadSource.ts';

const leads = [
  { id: 'a', deployed: false, source: 'instagram' },
  { id: 'b', deployed: false, source: undefined },
  { id: 'c', deployed: true, source: 'new salon sourced by grok bot' },
  { id: 'd', deployed: false, source: 'new salon sourced by grok bot' },
  { id: 'e', deployed: false, source: 'new salon sourced by grok bot' },
  { id: 'f', deployed: false, source: '' },
];

test('matchesSource', () => {
  assert.ok(matchesSource(undefined, ALL_SOURCES));
  assert.ok(matchesSource(null, NO_SOURCE));
  assert.ok(matchesSource('', NO_SOURCE));
  assert.ok(!matchesSource('instagram', NO_SOURCE));
  assert.ok(matchesSource('instagram', 'instagram'));
  assert.ok(!matchesSource(undefined, 'instagram'));
});

test('distinctSources skips empty and labels', () => {
  assert.deepEqual(distinctSources(leads), ['instagram', 'new salon sourced by grok bot']);
  assert.equal(sourceLabel(null), 'No source');
  assert.equal(sourceLabel('weird'), 'weird');
});

test('pickStaged: unset filter keeps legacy oldest-first behavior', () => {
  assert.deepEqual(pickStaged(leads, 3, undefined), ['a', 'b', 'd']);
});

test('pickStaged: by source, capped at pool', () => {
  assert.deepEqual(pickStaged(leads, 10, 'new salon sourced by grok bot'), ['d', 'e']);
  assert.deepEqual(pickStaged(leads, 1, 'new salon sourced by grok bot'), ['d']);
});

test('pickStaged: no-source', () => {
  assert.deepEqual(pickStaged(leads, 10, pickerToDeployFilter(NO_SOURCE)), ['b', 'f']);
  assert.equal(pickerToDeployFilter(ALL_SOURCES), undefined);
});
