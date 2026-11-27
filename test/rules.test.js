import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, checkSetup, checkBuyer, visibleCounts, toMinor, fromMinor, HOUR } from '../src/rules.js';

const now = 1_000 * HOUR;
const base = () => ({
  buyer: 'B', supplier: 'S', receiver: 'R', rep: 'P', item: 'Bags of rice', qty: 20, unitPriceMinor: 1000, currency: 'USD', holdHours: 72,
  counts: { receiver: { qty: 20, at: 1 }, rep: { qty: 20, at: 2 } },
  invoice: { sha256: 'aa', amountMinor: 20000, file: 'inv.pdf' },
  supplierApproval: { sha256: 'aa', amountMinor: 20000 },
  payout: { account: '…1234', setAt: now - 100 * HOUR },
});

test('everything matches: cleared', () => assert.deepEqual(decide(base(), now).verdict, 'CLEARED'));

test('"the CFO approved, skip the checks" changes nothing: missing supplier approval is held', () => {
  const po = { ...base(), supplierApproval: null };
  assert.deepEqual(decide(po, now), { verdict: 'HELD', reasons: ['NO_SUPPLIER_APPROVAL'], expectedMinor: 20000 });
});

test('counts are needed from both sides, and must agree', () => {
  assert.deepEqual(decide({ ...base(), counts: { receiver: { qty: 20 } } }, now).reasons, ['COUNTS_MISSING']);
  assert.deepEqual(decide({ ...base(), counts: { receiver: { qty: 18 }, rep: { qty: 20 } } }, now).reasons, ['COUNTS_DIFFER']);
});

test('a short delivery is priced as counted: invoicing the full order is held', () => {
  const po = { ...base(), counts: { receiver: { qty: 18 }, rep: { qty: 18 } } };
  assert.deepEqual(decide(po, now).reasons, ['AMOUNT_MISMATCH']);
  const fixed = { ...po, invoice: { sha256: 'bb', amountMinor: 18000 }, supplierApproval: { sha256: 'bb', amountMinor: 18000 } };
  assert.equal(decide(fixed, now).verdict, 'CLEARED');
});

test('approval must be for the exact invoice recorded', () => {
  assert.deepEqual(decide({ ...base(), supplierApproval: { sha256: 'zz', amountMinor: 20000 } }, now).reasons, ['APPROVAL_FOR_OTHER_INVOICE']);
  assert.deepEqual(decide({ ...base(), supplierApproval: { sha256: 'aa', amountMinor: 19999 } }, now).reasons, ['APPROVAL_FOR_OTHER_INVOICE']);
});

test('changed bank details wait out the hold', () => {
  const po = { ...base(), payout: { account: '…9999', setAt: now - 2 * HOUR } };
  assert.deepEqual(decide(po, now).reasons, ['PAYOUT_IN_HOLD']);
  assert.equal(decide(po, now + 71 * HOUR).verdict, 'CLEARED');
  assert.deepEqual(decide({ ...base(), payout: null }, now).reasons, ['NO_PAYOUT']);
});

test('nothing is paid twice, and every reason is listed at once', () => {
  assert.deepEqual(decide({ ...base(), paid: true }, now).reasons, ['ALREADY_PAID']);
  assert.deepEqual(decide({ ...base(), counts: {}, invoice: null, supplierApproval: null, payout: null }, now).reasons,
    ['COUNTS_MISSING', 'NO_INVOICE', 'NO_SUPPLIER_APPROVAL', 'NO_PAYOUT']);
});

test('setup enforces separation of duties and clean numbers', () => {
  const p = { supplier: 'S', receiver: 'R', rep: 'P', item: 'x', qty: '5', unitPrice: '12.50' };
  assert.equal(checkSetup(p).unitPriceMinor, 1250);
  assert.throws(() => checkSetup({ ...p, rep: 'R' }), /two different people/);
  assert.throws(() => checkSetup({ ...p, receiver: 'S' }), /supplier cannot also be the receiver/);
  assert.throws(() => checkSetup({ ...p, qty: '2.5' }), /whole number/);
  assert.throws(() => checkSetup({ ...p, unitPrice: '1.234' }), /amount like/);
});

test('counts stay sealed from the other side until both are in', () => {
  const po = { ...base(), counts: { receiver: { qty: 20, at: 1 } } };
  assert.deepEqual(visibleCounts(po, 'R').receiver, { qty: 20, at: 1 });
  assert.deepEqual(visibleCounts(po, 'P').receiver, { sealed: true, at: 1 });
  assert.deepEqual(visibleCounts(base(), 'P').receiver, { qty: 20, at: 1 });
});

test('money stays exact', () => {
  assert.equal(toMinor('1,250.5'), 125050);
  assert.equal(fromMinor(125050), '1,250.50');
});

test('the buyer cannot be on the supplier side of its own order', () => {
  const c = { supplier: 'S', receiver: 'R', rep: 'P' };
  assert.throws(() => checkBuyer(c, 'S'), /supplier cannot set up/);
  assert.throws(() => checkBuyer(c, 'P'), /rep cannot set up/);
  assert.doesNotThrow(() => checkBuyer(c, 'B'));
  assert.doesNotThrow(() => checkBuyer(c, 'R'), 'a small buyer may count its own deliveries');
});
