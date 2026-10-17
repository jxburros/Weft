import test from 'node:test';
import assert from 'node:assert/strict';
import { pageItems } from '../src/pagination.js';

// Records created in the same millisecond must page in creation order, not by their random ids.
const at = '2026-10-17T21:00:00.000Z';
const created = ['task_f', 'task_a', 'task_d', 'task_b', 'task_e', 'task_c'].map((id, n) => ({ id, title: `Task ${n}`, createdAt: at }));
const all = (items, options, limit = 2) => {
  const seen = [];
  let cursor;
  do {
    const page = pageItems(items, { limit, cursor }, options);
    seen.push(...page.items.map(item => item.title));
    cursor = page.nextCursor;
  } while (cursor);
  return seen;
};

test('same-millisecond records page in creation order across cursors', () => {
  assert.deepEqual(all(created, { command: 'tasks.list' }), created.map(item => item.title));
});

test('newest-first lists keep their unpaged order for same-millisecond items', () => {
  const visits = created.map(item => ({ ...item, visitedAt: at, createdAt: undefined })).reverse();
  assert.deepEqual(all(visits, { command: 'history.list' }), visits.map(item => item.title));
  // downloads.list hands over creation order but pages newest first.
  assert.deepEqual(all(created, { command: 'downloads.list' }), created.map(item => item.title).reverse());
});

test('a deleted cursor item neither skips nor repeats later items', () => {
  const items = created.map((item, n) => ({ ...item, createdAt: `2026-10-17T21:00:00.00${n}Z` }));
  const first = pageItems(items, { limit: 2 }, { command: 'tasks.list' });
  const remaining = items.filter(item => item.id !== first.items.at(-1).id);
  const rest = pageItems(remaining, { limit: 10, cursor: first.nextCursor }, { command: 'tasks.list' });
  assert.deepEqual(rest.items.map(item => item.title), items.slice(2).map(item => item.title));
});
