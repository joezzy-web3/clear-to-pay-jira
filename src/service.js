// Everything that reads or changes a purchase order goes through here: the issue panel
// (resolver) and the Rovo agent / MCP actions share it, so they follow exactly the same rules.
// Orders live in Forge storage under the issue key; every decision is also written to the issue.
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { createHash } from 'node:crypto';
import { decide, checkSetup, checkBuyer, visibleCounts, roleOf, explain, toMinor, fromMinor, expectedAmount, holdEndsAt, countedQty, holdText } from './rules.js';

const KEY = (issueKey) => `po:${issueKey}`;
const MAX_LOG = 50;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export class UserError extends Error {}
const fail = (m) => { throw new UserError(m); };

export function checkIssueKey(k) {
  const key = String(k ?? '').trim().toUpperCase();
  if (!ISSUE_KEY.test(key)) fail('Give a Jira issue key like PO-12.');
  return key;
}

export const load = (issueKey) => kvs.get(KEY(issueKey));
const save = (issueKey, po) => kvs.set(KEY(issueKey), po);

function log(po, entry) {
  po.log = [{ at: Date.now(), ...entry }, ...(po.log ?? [])].slice(0, MAX_LOG);
}

/** The asking user must be able to see the issue (checked with their own permissions). */
export async function assertCanSee(issueKey) {
  const res = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary`);
  if (!res.ok) fail(`You cannot see ${issueKey}, or it does not exist.`);
  return (await res.json()).fields?.summary ?? '';
}

async function comment(issueKey, lines) {
  const body = { type: 'doc', version: 1, content: lines.map((t, i) => ({ type: 'paragraph', content: [{ type: 'text', text: t, ...(i === 0 ? { marks: [{ type: 'strong' }] } : {}) }] })) };
  await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
}

async function addLabel(issueKey, label) {
  await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update: { labels: [{ add: label }] } }) });
}

export async function attachments(issueKey) {
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=attachment`);
  if (!res.ok) fail(`Could not read the attachments of ${issueKey}.`);
  return ((await res.json()).fields?.attachment ?? []).map((a) => ({ id: String(a.id), filename: a.filename, size: a.size, created: a.created }));
}

async function fingerprint(attachmentId) {
  const res = await api.asApp().requestJira(route`/rest/api/3/attachment/content/${attachmentId}`);
  if (!res.ok) fail('Could not read that attachment.');
  return createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
}

// ---------- what the panel and the agent see ----------

export function view(po, accountId, now = Date.now()) {
  if (!po) return { exists: false };
  const d = decide(po, now);
  const exp = expectedAmount(po);
  return {
    exists: true,
    roles: roleOf(po, accountId),
    people: { buyer: po.buyer, supplier: po.supplier, receiver: po.receiver, rep: po.rep },
    item: po.item, qty: po.qty, unitPrice: fromMinor(po.unitPriceMinor), currency: po.currency, holdHours: po.holdHours,
    orderTotal: fromMinor(po.qty * po.unitPriceMinor),
    counts: visibleCounts(po, accountId),
    expected: exp === null ? null : fromMinor(exp),
    invoice: po.invoice ? { file: po.invoice.file, amount: fromMinor(po.invoice.amountMinor), sha256: po.invoice.sha256, by: po.invoice.by, at: po.invoice.at } : null,
    approval: po.supplierApproval ? { amount: fromMinor(po.supplierApproval.amountMinor), sha256: po.supplierApproval.sha256, at: po.supplierApproval.at } : null,
    payout: po.payout ? { account: po.payout.account, setAt: po.payout.setAt, holdEndsAt: holdEndsAt(po) } : null,
    paid: Boolean(po.paid),
    decision: { verdict: d.verdict, reasons: d.reasons, explained: explain(d.reasons) },
    log: po.log ?? [],
  };
}

/** Plain-language summary for the agent. */
export function summary(issueKey, po, now = Date.now()) {
  if (!po) return `${issueKey} has no Clear to Pay order yet. A buyer sets one up from the Clear to Pay panel on the issue.`;
  const d = decide(po, now);
  const q = countedQty(po);
  const exp = expectedAmount(po);
  const lines = [
    `${issueKey}: ${po.qty} × ${po.item} at ${fromMinor(po.unitPriceMinor)} ${po.currency} (order total ${fromMinor(po.qty * po.unitPriceMinor)} ${po.currency}).`,
    `Gate counts: ${po.counts?.receiver && po.counts?.rep ? (q === null ? 'both in, and they DIFFER' : `both in, agreed: ${q}`) : `${[po.counts?.receiver && 'receiver', po.counts?.rep && 'supplier’s rep'].filter(Boolean).join(' and ') || 'none'} in so far (each stays sealed until both are in)`}.`,
    `Invoice: ${po.invoice ? `${po.invoice.file}, ${fromMinor(po.invoice.amountMinor)} ${po.currency}, fingerprint ${po.invoice.sha256.slice(0, 12)}…` : 'none recorded'}${exp !== null ? `; the counted delivery is worth ${fromMinor(exp)} ${po.currency}` : ''}.`,
    `Supplier approval: ${po.supplierApproval ? `yes, for ${fromMinor(po.supplierApproval.amountMinor)} ${po.currency}` : 'not yet'}.`,
    `Payout account: ${po.payout ? `${po.payout.account}, ${now < holdEndsAt(po) ? `in its safety hold until ${new Date(holdEndsAt(po)).toISOString()}` : 'hold passed'}` : 'not set'}.`,
    po.paid ? 'Status: CLEARED TO PAY (already decided).' : `If payment were requested now: ${d.verdict}${d.reasons.length ? ` — ${explain(d.reasons).join(' ')}` : '.'}`,
  ];
  return lines.join('\n');
}

// ---------- changes ----------

export async function setup(issueKey, accountId, p) {
  if (await load(issueKey)) fail('This issue already has a Clear to Pay order.');
  const clean = checkSetup(p);
  checkBuyer(clean, accountId);
  const po = { ...clean, buyer: accountId, counts: {}, createdAt: Date.now() };
  log(po, { by: accountId, what: `Order set up: ${po.qty} × ${po.item} at ${fromMinor(po.unitPriceMinor)} ${po.currency}. Payout hold ${holdText(po.holdHours)}.` });
  await save(issueKey, po);
  await comment(issueKey, ['Clear to Pay: order set up', `${po.qty} × ${po.item} at ${fromMinor(po.unitPriceMinor)} ${po.currency}. Payment clears only when both gate counts agree, the invoice matches what was counted, the supplier approves that exact invoice, and its payout account has waited out its hold.`]);
  return po;
}

export async function cancelOrder(issueKey, accountId) {
  const po = await load(issueKey) ?? fail('No order on this issue.');
  if (accountId !== po.buyer) fail('Only the buyer who set up the order can cancel it.');
  if (po.counts?.receiver || po.counts?.rep || po.invoice) fail('Counting or invoicing has started, so the order can no longer be cancelled.');
  await kvs.delete(KEY(issueKey));
  await comment(issueKey, ['Clear to Pay: order cancelled', 'The buyer cancelled this order before any count or invoice. A new one can be set up.']);
}

export async function submitCount(issueKey, accountId, qty) {
  const po = await load(issueKey) ?? fail('No order on this issue.');
  if (po.paid) fail('This order is already cleared to pay.');
  const side = accountId === po.receiver ? 'receiver' : accountId === po.rep ? 'rep' : fail('Only the named receiver or the supplier’s rep can count.');
  if (po.counts?.[side]) fail('You already counted. Ask the buyer to reset the counts if a recount is needed.');
  const n = Number(qty);
  if (!Number.isInteger(n) || n < 0) fail('Count with a whole number.');
  po.counts = { ...po.counts, [side]: { qty: n, at: Date.now() } };
  log(po, { by: accountId, what: `${side === 'receiver' ? 'Receiver' : 'Supplier’s rep'} sealed a count.` });
  if (po.counts.receiver && po.counts.rep) {
    const agree = po.counts.receiver.qty === po.counts.rep.qty;
    log(po, { by: 'app', what: agree ? `Counts opened: both counted ${n === po.counts.receiver.qty ? n : po.counts.receiver.qty}.` : `Counts opened and differ: receiver ${po.counts.receiver.qty}, supplier’s rep ${po.counts.rep.qty}.` });
  }
  await save(issueKey, po);
  return po;
}

export async function resetCounts(issueKey, accountId) {
  const po = await load(issueKey) ?? fail('No order on this issue.');
  if (accountId !== po.buyer) fail('Only the buyer can reset the counts.');
  if (po.paid) fail('This order is already cleared to pay.');
  po.counts = {};
  po.supplierApproval = null;
  log(po, { by: accountId, what: 'Counts reset for a recount. Any supplier approval was withdrawn.' });
  await save(issueKey, po);
  return po;
}

export async function recordInvoice(issueKey, accountId, { attachmentId, filename, amount }) {
  const po = await load(issueKey) ?? fail('No order on this issue.');
  if (po.paid) fail('This order is already cleared to pay.');
  if (po.supplierApproval) fail('The supplier already approved an invoice. It cannot be swapped now.');
  const files = await attachments(issueKey);
  const a = files.find((f) => (attachmentId && f.id === String(attachmentId)) || (filename && f.filename === filename))
    ?? fail(`No attachment ${filename ?? attachmentId} on ${issueKey}. Attach the invoice to the issue first.`);
  const amountMinor = toMinor(amount);
  const sha256 = await fingerprint(a.id);
  po.invoice = { file: a.filename, attachmentId: a.id, sha256, amountMinor, by: accountId ?? 'agent', at: Date.now() };
  log(po, { by: accountId ?? 'agent', what: `Invoice recorded: ${a.filename}, ${fromMinor(amountMinor)} ${po.currency}, fingerprint ${sha256.slice(0, 12)}….` });
  await save(issueKey, po);
  return po;
}

export async function approveInvoice(issueKey, accountId) {
  const po = await load(issueKey) ?? fail('No order on this issue.');
  if (accountId !== po.supplier) fail('Only the supplier can approve its invoice.');
  if (!po.invoice) fail('There is no invoice to approve yet.');
  po.supplierApproval = { sha256: po.invoice.sha256, amountMinor: po.invoice.amountMinor, at: Date.now() };
  log(po, { by: accountId, what: `Supplier approved ${po.invoice.file} for ${fromMinor(po.invoice.amountMinor)} ${po.currency}.` });
  await save(issueKey, po);
  return po;
}

export async function setPayout(issueKey, accountId, account) {
  const po = await load(issueKey) ?? fail('No order on this issue.');
  if (accountId !== po.supplier) fail('Only the supplier can set where it is paid.');
  const raw = String(account ?? '').replace(/\s+/g, '');
  if (raw.length < 6 || raw.length > 40 || !/^[A-Za-z0-9]+$/.test(raw)) fail('Enter the account number or IBAN, letters and digits only.');
  const masked = `…${raw.slice(-4)}`;
  const changed = Boolean(po.payout);
  po.payout = { account: masked, setAt: Date.now() };
  log(po, { by: accountId, what: changed ? `Payout account CHANGED to ${masked}. Safety hold of ${holdText(po.holdHours)} restarts.` : `Payout account set to ${masked}. Safety hold of ${holdText(po.holdHours)} starts.` });
  await save(issueKey, po);
  if (changed) await comment(issueKey, ['Clear to Pay: payout account changed', `The supplier’s payout account changed to ${masked}. No payment can clear for ${holdText(po.holdHours)}. If you did not expect this, call the supplier on a number you already know.`]);
  return po;
}

/** Anyone may ask; only the rules decide. The request and its note are recorded either way. */
export async function requestPayment(issueKey, accountId, note = '') {
  const po = await load(issueKey) ?? fail('No order on this issue.');
  const d = decide(po);
  const who = accountId ?? 'agent';
  const said = String(note ?? '').trim().slice(0, 300);
  if (d.verdict === 'CLEARED') {
    po.paid = { at: Date.now(), by: who, amountMinor: po.invoice.amountMinor };
    log(po, { by: who, what: `Payment requested${said ? ` (“${said}”)` : ''}: CLEARED. ${fromMinor(po.invoice.amountMinor)} ${po.currency} to ${po.payout.account}.` });
    await save(issueKey, po);
    await addLabel(issueKey, 'cleared-to-pay');
    await comment(issueKey, ['Clear to Pay: CLEARED TO PAY', `${fromMinor(po.invoice.amountMinor)} ${po.currency} to the supplier’s payout account ${po.payout.account}. Counts agreed, the invoice matches what was counted, the supplier approved this exact invoice (fingerprint ${po.invoice.sha256.slice(0, 12)}…), and the payout account has waited out its hold.`]);
  } else {
    log(po, { by: who, what: `Payment requested${said ? ` (“${said}”)` : ''}: HELD. ${explain(d.reasons).join(' ')}` });
    await save(issueKey, po);
    await comment(issueKey, ['Clear to Pay: HELD', ...(said ? [`Request note: “${said}”. A note is not an approval.`] : []), ...explain(d.reasons)]);
  }
  return d;
}
