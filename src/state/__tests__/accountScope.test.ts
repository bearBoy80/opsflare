import {
  getAccountScope,
  reconcileAccountScope,
  resetAccountScope,
  setAccountScope,
} from '../accountScope';

beforeEach(() => resetAccountScope());

test('keeps a scope whose account is still reachable', () => {
  setAccountScope('acc-1');
  reconcileAccountScope(['acc-1', 'acc-2']);
  expect(getAccountScope()).toBe('acc-1');
});

test('falls back to all accounts when the scoped account is gone', () => {
  setAccountScope('acc-gone');
  reconcileAccountScope(['acc-1']);
  expect(getAccountScope()).toBeNull();
});

test('leaves "All accounts" alone', () => {
  reconcileAccountScope([]);
  expect(getAccountScope()).toBeNull();
});
