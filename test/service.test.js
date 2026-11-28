// Service tests (A13): service.js against in-memory Forge storage and a stubbed Jira.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakes } from './fakes.js';

const f = makeFakes();
mock.module('@forge/kvs', { namedExports: { kvs: f.kvs } });
mock.module('@forge/api', { defaultExport: f.api, namedExports: { route: f.route } });
const svc = await import('../src/service.js');

const K = 'PO-1';
const order = { supplier: 'S', receiver: 'R', rep: 'P', item: 'Bags of rice', qty: '20', unitPrice: '10.00', currency: 'USD', holdHours: 24 };

beforeEach(() => { f.store.clear(); f.calls.length = 0; f.files.clear(); });

async function readyToPay() {
  await svc.setup(K, 'B', order);
  await svc.submitCount(K, 'R', 20);
  await svc.submitCount(K, 'P', 20);
  f.files.set(K, [{ id: '10', filename: 'inv.pdf', bytes: 'invoice 200.00' }]);
  await svc.recordInvoice(K, 'B', { attachmentId: '10', amount: '200.00' });
  await svc.approveInvoice(K, 'S');
  await svc.setPayout(K, 'S', '0123456789');
  const po = f.store.get(`po:${K}`);
  po.payout.setAt -= 25 * 3_600_000; // the hold has passed
  f.store.set(`po:${K}`, po);
}

test('A3: two counts sealed at the same moment are both kept', async () => {
  await svc.setup(K, 'B', order);
  await Promise.all([svc.submitCount(K, 'R', 20), svc.submitCount(K, 'P', 20)]);
  const po = await svc.load(K);
  assert.equal(po.counts.receiver.qty, 20);
  assert.equal(po.counts.rep.qty, 20);
});

test('A3: two payment requests at the same moment clear exactly once', async () => {
  await readyToPay();
  const [a, b] = await Promise.all([svc.requestPayment(K, 'B'), svc.requestPayment(K, 'B')]);
  assert.deepEqual([a.verdict, b.verdict].sort(), ['CLEARED', 'HELD']);
  assert.deepEqual((a.verdict === 'HELD' ? a : b).reasons, ['ALREADY_PAID']);
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 1, 'one label write');
});

test('A3: the lock is released after a change, even one that fails', async () => {
  await svc.setup(K, 'B', order);
  await assert.rejects(svc.submitCount(K, 'X', 20), /Only the named receiver/);
  assert.equal(f.store.has(`lock:${K}`), false);
});

test('A1: a zero invoice cannot be recorded', async () => {
  await svc.setup(K, 'B', order);
  f.files.set(K, [{ id: '10', filename: 'inv.pdf', bytes: 'x' }]);
  await assert.rejects(svc.recordInvoice(K, 'B', { attachmentId: '10', amount: '0' }), /above zero/);
});

test('A4: a 2-minute hold is refused unless a Jira admin turned on demo mode', async () => {
  await assert.rejects(svc.setup(K, 'B', { ...order, holdHours: 2 / 60 }), /at least 24 hours/);
  await svc.setDemoMode('ADMIN', true);
  await svc.setup(K, 'B', { ...order, holdHours: 2 / 60 });
  assert.equal((await svc.load(K)).holdHours, 2 / 60);
});

test('A10: if Jira refuses the comment after payment, the payment still reads as cleared', async () => {
  await readyToPay();
  const real = f.api.asApp;
  f.api.asApp = () => ({ requestJira: async (url, init) => { if (init?.method === 'POST') throw new Error('Jira is down'); return real().requestJira(url, init); } });
  try {
    const d = await svc.requestPayment(K, 'B');
    assert.equal(d.verdict, 'CLEARED');
    assert.match(d.note, /comment could not be added/);
    assert.ok((await svc.load(K)).paid);
  } finally { f.api.asApp = real; }
});

test('duplicate: the same invoice file on a second order is held', async () => {
  await readyToPay();
  await svc.requestPayment(K, 'B');
  await svc.setup('PO-2', 'B', order);
  f.files.set('PO-2', [{ id: '11', filename: 'copy.pdf', bytes: 'invoice 200.00' }]);
  await svc.recordInvoice('PO-2', 'B', { attachmentId: '11', amount: '200.00' });
  assert.equal((await svc.load('PO-2')).duplicate.sameFile, K);
});

// ---------- A6: who may record, claim on approval, withdraw, admin release ----------

test('A6: the supplier’s rep cannot record the invoice', async () => {
  await svc.setup(K, 'B', order);
  f.files.set(K, [{ id: '10', filename: 'inv.pdf', bytes: 'x' }]);
  await assert.rejects(svc.recordInvoice(K, 'P', { attachmentId: '10', amount: '200.00' }), /Only the buyer, the receiver or the supplier/);
  await svc.recordInvoice(K, 'R', { attachmentId: '10', amount: '200.00' });
});

test('A6: recording a copy does not lock the real order out; only an approval claims the file', async () => {
  await svc.setup('PO-9', 'B', order); // a stray order records a copy first
  f.files.set('PO-9', [{ id: '90', filename: 'copy.pdf', bytes: 'the invoice' }]);
  await svc.recordInvoice('PO-9', 'B', { attachmentId: '90', amount: '200.00' });
  await svc.setup(K, 'B', order);
  f.files.set(K, [{ id: '10', filename: 'inv.pdf', bytes: 'the invoice' }]);
  await svc.recordInvoice(K, 'B', { attachmentId: '10', amount: '200.00' });
  assert.equal((await svc.load(K)).duplicate.sameFile, null);
  await svc.approveInvoice(K, 'S');
  await assert.rejects(svc.approveInvoice('PO-9', 'S'), /already approved on PO-1/);
});

test('A6: the buyer can withdraw an invoice before approval, not after', async () => {
  await svc.setup(K, 'B', order);
  f.files.set(K, [{ id: '10', filename: 'inv.pdf', bytes: 'x' }]);
  await svc.recordInvoice(K, 'B', { attachmentId: '10', amount: '200.00' });
  await assert.rejects(svc.withdrawInvoice(K, 'R'), /Only the buyer/);
  await svc.withdrawInvoice(K, 'B');
  assert.equal((await svc.load(K)).invoice, null);
  await svc.recordInvoice(K, 'B', { attachmentId: '10', amount: '200.00' });
  await svc.approveInvoice(K, 'S');
  await assert.rejects(svc.withdrawInvoice(K, 'B'), /already approved/);
});

test('A6: an admin can release a file held by an unpaid order, never one already paid', async () => {
  await svc.setup('PO-9', 'B', order);
  f.files.set('PO-9', [{ id: '90', filename: 'copy.pdf', bytes: 'the invoice' }]);
  await svc.recordInvoice('PO-9', 'B', { attachmentId: '90', amount: '200.00' });
  await svc.approveInvoice('PO-9', 'S');
  await svc.setup(K, 'B', order);
  f.files.set(K, [{ id: '10', filename: 'inv.pdf', bytes: 'the invoice' }]);
  await svc.recordInvoice(K, 'B', { attachmentId: '10', amount: '200.00' });
  assert.equal((await svc.load(K)).duplicate.sameFile, 'PO-9');
  await svc.releaseClaim(K, 'ADMIN');
  assert.equal((await svc.load('PO-9')).invoice, null);
  assert.equal((await svc.load('PO-9')).supplierApproval, null);
  assert.equal((await svc.load(K)).duplicate.sameFile, null);
  await svc.approveInvoice(K, 'S');

  f.store.clear(); f.files.clear();
  await readyToPay(); // PO-1 is paid with its own invoice; a copy on PO-5 cannot release it
  await svc.requestPayment(K, 'B');
  await svc.setup('PO-5', 'B', order);
  f.files.set('PO-5', [{ id: '55', filename: 'again.pdf', bytes: 'invoice 200.00' }]);
  await svc.recordInvoice('PO-5', 'B', { attachmentId: '55', amount: '200.00' });
  await assert.rejects(svc.releaseClaim('PO-5', 'ADMIN'), /already paid/);
});
