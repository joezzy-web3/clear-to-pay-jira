// Everything that reads or changes a purchase order goes through here: the issue panel
// (resolver) and the Rovo agent / MCP actions share it, so they follow exactly the same rules.
// Orders live in Forge storage under the issue key; every decision is also written to the issue.
import * as forgeApi from '@forge/api';
const { route } = forgeApi;
const api = forgeApi.default?.asUser ? forgeApi.default : forgeApi.default?.default ?? forgeApi;
import { kvs } from '@forge/kvs';
import { createHash, randomUUID } from 'node:crypto';
import { decide, checkSetup, checkBuyer, visibleCounts, roleOf, explain, toMinor, fromMinor, expectedAmount, holdEndsAt, countedQty, holdText, overDelivered, quoteData, MIN_HOLD_HOURS } from './rules.js';

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

// ---------- one change at a time per order ----------
// Forge storage has no compare-and-set on plain keys, but it can refuse to create a key that
// exists. A short-lived lock key per order makes every change load -> check -> save in turn,
// so two counts at once both land, and two payment requests at once cannot both clear.
const LOCK = (issueKey) => `lock:${issueKey}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The lock records who holds it and until when. Forge may keep an expired key for up to 48 h,
// and that key still blocks FAIL_IF_EXISTS, so the expiry is read from the value, not left to storage.
const LOCK_MS = 30_000;
const lockUntil = (v) => (v && typeof v === 'object' ? v.until : typeof v === 'number' ? v + LOCK_MS : 0);
export async function withLock(name, fn, { tries = 40, waitMs = 100 } = {}) {
  const key = LOCK(name);
  const mine = { owner: randomUUID(), until: 0 };
  for (let i = 0; i < tries; i++) {
    mine.until = Date.now() + LOCK_MS;
    try {
      await kvs.set(key, mine, { keyPolicy: 'FAIL_IF_EXISTS', ttl: { value: 60, unit: 'SECONDS' } });
    } catch {
      // Taken, or a storage hiccup. A lock past its time is left by a call that died: take it over.
      const held = await kvs.get(key).catch(() => undefined);
      if (held !== undefined && lockUntil(held) < Date.now()) await kvs.delete(key).catch(() => {});
      await sleep(waitMs + Math.floor(Math.random() * waitMs));
      continue;
    }
    try { return await fn(); } finally {
      // Remove the lock only if it is still ours; a slow change must not free someone else's lock.
      // A failed release never turns a finished change into an error; the lock expires by its time.
      try { if ((await kvs.get(key))?.owner === mine.owner) await kvs.delete(key); } catch { /* expires */ }
    }
  }
  fail('Someone else is changing this order right now. Try again in a moment.');
}

// ---------- site settings ----------
const SETTINGS = 'settings';
export const getSettings = async () => ({ demoMode: false, ...((await kvs.get(SETTINGS)) ?? {}) });
export async function isJiraAdmin() {
  const res = await api.asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
  return res.ok && Boolean((await res.json()).permissions?.ADMINISTER?.havePermission);
}
/** Demo mode allows payout holds under a day, for testing only. Jira admins only. */
export async function setDemoMode(accountId, on) {
  if (!(await isJiraAdmin())) fail('Only a Jira admin can change demo mode.');
  const next = { ...(await getSettings()), demoMode: Boolean(on), demoModeBy: accountId, demoModeAt: Date.now() };
  await kvs.set(SETTINGS, next);
  return next;
}

// ---------- duplicate-invoice index (across all orders) ----------
// inv:<sha256>               -> the issue that holds that exact invoice file
// paid:<supplier>:<amount>   -> recent payments to that supplier for that amount
const INV = (sha) => `inv:${sha}`;
const PAID = (supplier, amountMinor) => `paid:${supplier}:${amountMinor}`;
const SIMILAR_DAYS = 30;

async function findDuplicates(issueKey, po, now = Date.now()) {
  if (!po.invoice) return null;
  const owner = await kvs.get(INV(po.invoice.sha256));
  const sameFile = owner && owner !== issueKey ? owner : null;
  const recent = (await kvs.get(PAID(po.supplier, po.invoice.amountMinor))) ?? [];
  const similar = recent.filter((p) => p.key !== issueKey && now - p.at < SIMILAR_DAYS * 24 * 3_600_000);
  return { sameFile, similar, confirmed: po.duplicate?.confirmed ?? null };
}

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

/** Named people must be active human accounts on this site (not deactivated, not app or bot accounts). */
async function userExists(accountId) {
  const res = await api.asApp().requestJira(route`/rest/api/3/user?accountId=${accountId}`);
  if (!res.ok) return false;
  const u = await res.json();
  return u.active === true && u.accountType === 'atlassian';
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

export function view(rawPo, accountId, now = Date.now(), settings = null) {
  const po = settings ? effective(rawPo, settings) : rawPo;
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
    overDelivered: overDelivered(po),
    invoice: po.invoice ? { file: po.invoice.file, amount: fromMinor(po.invoice.amountMinor), sha256: po.invoice.sha256, by: po.invoice.by, at: po.invoice.at } : null,
    approval: po.supplierApproval ? { amount: fromMinor(po.supplierApproval.amountMinor), sha256: po.supplierApproval.sha256, at: po.supplierApproval.at } : null,
    payout: po.payout ? { account: po.payout.account, setAt: po.payout.setAt, holdEndsAt: holdEndsAt(po) } : null,
    duplicate: po.duplicate ? { sameFile: po.duplicate.sameFile, similar: po.duplicate.similar.map((p) => p.key), confirmed: Boolean(po.invoice && po.duplicate.confirmed?.sha256 === po.invoice.sha256) } : null,
    paid: Boolean(po.paid),
    decision: { verdict: d.verdict, reasons: d.reasons, explained: explain(d.reasons) },
    log: po.log ?? [],
  };
}

/** Plain-language summary for the agent. */
export function summary(issueKey, rawPo, now = Date.now(), settings = null) {
  const po = settings ? effective(rawPo, settings) : rawPo;
  if (!po) return `${issueKey} has no Clear to Pay order yet. A buyer sets one up from the Clear to Pay panel on the issue.`;
  const d = decide(po, now);
  const q = countedQty(po);
  const exp = expectedAmount(po);
  const lines = [
    `VERDICT: ${po.paid ? 'CLEARED (already paid)' : d.verdict}`,
    `${issueKey}: ${po.qty} × ${quoteData(po.item)} at ${fromMinor(po.unitPriceMinor)} ${po.currency} (order total ${fromMinor(po.qty * po.unitPriceMinor)} ${po.currency}).`,
    `Gate counts: ${po.counts?.receiver && po.counts?.rep ? (q === null ? 'both in, and they DIFFER' : `both in, agreed: ${q}`) : `${[po.counts?.receiver && 'receiver', po.counts?.rep && 'supplier’s rep'].filter(Boolean).join(' and ') || 'none'} in so far (each stays sealed until both are in)`}.`,
    ...(overDelivered(po) ? [`More was counted than ordered (${overDelivered(po)} extra). Only what was ordered is payable; the buyer raises a change order for the rest.`] : []),
    `Invoice: ${po.invoice ? `${quoteData(po.invoice.file)}, ${fromMinor(po.invoice.amountMinor)} ${po.currency}, fingerprint ${po.invoice.sha256.slice(0, 12)}…` : 'none recorded'}${exp !== null ? `; the counted delivery is worth ${fromMinor(exp)} ${po.currency}` : ''}.`,
    ...(po.duplicate?.sameFile ? [`DUPLICATE: this exact invoice file is already on ${po.duplicate.sameFile}.`] : po.duplicate?.similar?.length ? [`Possible duplicate: this supplier was paid the same amount on ${po.duplicate.similar.map((p) => p.key).join(', ')} in the last 30 days${po.duplicate.confirmed ? '; the buyer confirmed this is a separate invoice' : '; the buyer has not confirmed it is separate'}.`] : []),
    `Supplier approval: ${po.supplierApproval ? `yes, for ${fromMinor(po.supplierApproval.amountMinor)} ${po.currency}` : 'not yet'}.`,
    `Payout account: ${po.payout ? `${po.payout.account}, ${now < holdEndsAt(po) ? `in its safety hold until ${new Date(holdEndsAt(po)).toISOString()}` : 'hold passed'}` : 'not set'}.`,
    po.paid ? 'Status: CLEARED TO PAY (already decided).' : `If payment were requested now: ${d.verdict}${d.reasons.length ? ` — ${explain(d.reasons).join(' ')}` : '.'}`,
  ];
  return lines.join('\n');
}

// ---------- changes ----------

async function setupNow(issueKey, accountId, p) {
  if (await load(issueKey)) fail('This issue already has a Clear to Pay order.');
  const clean = checkSetup(p, await getSettings());
  checkBuyer(clean, accountId);
  for (const [who, id] of [['supplier', clean.supplier], ['receiver', clean.receiver], ['supplier’s rep', clean.rep]]) {
    if (!(await userExists(id))) fail(`The ${who} must be an active person on this site (not a deactivated or app account).`);
  }
  const po = { ...clean, buyer: accountId, counts: {}, createdAt: Date.now() };
  log(po, { by: accountId, what: `Order set up: ${po.qty} × ${po.item} at ${fromMinor(po.unitPriceMinor)} ${po.currency}. Payout hold ${holdText(po.holdHours)}.` });
  await save(issueKey, po);
  await comment(issueKey, ['Clear to Pay: order set up', `${po.qty} × ${po.item} at ${fromMinor(po.unitPriceMinor)} ${po.currency}. Payment clears only when both gate counts agree, the invoice matches what was counted, the supplier approves that exact invoice, and its payout account has waited out its hold.`]);
  return po;
}

async function cancelOrderNow(issueKey, accountId) {
  const po = await load(issueKey) ?? fail('No order on this issue.');
  if (accountId !== po.buyer) fail('Only the buyer who set up the order can cancel it.');
  if (po.counts?.receiver || po.counts?.rep || po.invoice) fail('Counting or invoicing has started, so the order can no longer be cancelled.');
  await kvs.delete(KEY(issueKey));
  await comment(issueKey, ['Clear to Pay: order cancelled', 'The buyer cancelled this order before any count or invoice. A new one can be set up.']);
}

async function submitCountNow(issueKey, accountId, qty) {
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

async function resetCountsNow(issueKey, accountId) {
  const po = await load(issueKey) ?? fail('No order on this issue.');
  if (accountId !== po.buyer) fail('Only the buyer can reset the counts.');
  if (po.paid) fail('This order is already cleared to pay.');
  po.counts = {};
  po.supplierApproval = null;
  log(po, { by: accountId, what: 'Counts reset for a recount. Any supplier approval was withdrawn.' });
  await save(issueKey, po);
  return po;
}

async function recordInvoiceNow(issueKey, accountId, { attachmentId, filename, amount }) {
  const po = await load(issueKey) ?? fail('No order on this issue.');
  if (po.paid) fail('This order is already cleared to pay.');
  if (po.supplierApproval) fail('The supplier already approved an invoice. It cannot be swapped now.');
  const files = await attachments(issueKey);
  const a = files.find((f) => (attachmentId && f.id === String(attachmentId)) || (filename && f.filename === filename))
    ?? fail(`No attachment ${quoteData(filename ?? attachmentId)} on ${issueKey}. Attach the invoice to the issue first.`);
  const amountMinor = toMinor(amount);
  if (amountMinor <= 0) fail('The invoice amount must be above zero.');
  const sha256 = await fingerprint(a.id);
  if (po.invoice && po.invoice.sha256 !== sha256 && (await kvs.get(INV(po.invoice.sha256))) === issueKey) await kvs.delete(INV(po.invoice.sha256));
  // Claim the file in one step: of two orders recording it at once, only one can create the claim.
  try { await kvs.set(INV(sha256), issueKey, { keyPolicy: 'FAIL_IF_EXISTS' }); } catch { /* already claimed; findDuplicates reads the owner */ }
  po.invoice = { file: a.filename, attachmentId: a.id, sha256, amountMinor, by: accountId ?? 'agent', at: Date.now() };
  log(po, { by: accountId ?? 'agent', what: `Invoice recorded: ${a.filename}, ${fromMinor(amountMinor)} ${po.currency}, fingerprint ${sha256.slice(0, 12)}….` });
  po.duplicate = await findDuplicates(issueKey, po);
  if (po.duplicate.sameFile) log(po, { by: 'clear-to-pay', what: `DUPLICATE: this exact invoice file is already on ${po.duplicate.sameFile}. Payment is held.` });
  else if (po.duplicate.similar.length) log(po, { by: 'clear-to-pay', what: `Possible duplicate: this supplier was paid ${fromMinor(amountMinor)} ${po.currency} on ${po.duplicate.similar.map((p) => p.key).join(', ')} in the last 30 days.` });
  await save(issueKey, po);
  if (po.duplicate.sameFile) await comment(issueKey, ['Clear to Pay: duplicate invoice', `This exact invoice file is already recorded on ${po.duplicate.sameFile}. One invoice can only be paid once, so this order is held.`]);
  return po;
}

async function approveInvoiceNow(issueKey, accountId) {
  const po = await load(issueKey) ?? fail('No order on this issue.');
  if (accountId !== po.supplier) fail('Only the supplier can approve its invoice.');
  if (!po.invoice) fail('There is no invoice to approve yet.');
  po.supplierApproval = { sha256: po.invoice.sha256, amountMinor: po.invoice.amountMinor, at: Date.now() };
  log(po, { by: accountId, what: `Supplier approved ${po.invoice.file} for ${fromMinor(po.invoice.amountMinor)} ${po.currency}.` });
  await save(issueKey, po);
  return po;
}

async function setPayoutNow(issueKey, accountId, account) {
  const po = await load(issueKey) ?? fail('No order on this issue.');
  if (accountId !== po.supplier) fail('Only the supplier can set where it is paid.');
  const raw = String(account ?? '').replace(/\s+/g, '');
  if (raw.length < 6 || raw.length > 40 || !/^[A-Za-z0-9]+$/.test(raw)) fail('Enter the account number or IBAN, letters and digits only.');
  const masked = `…${raw.slice(-4)}`;
  const digest = createHash('sha256').update(`${issueKey}:${raw.toUpperCase()}`).digest('hex');
  if (po.payout?.digest === digest) fail('That is already the payout account. Nothing changed, and the hold was not restarted.');
  const changed = Boolean(po.payout);
  po.payout = { account: masked, digest, setAt: Date.now() };
  log(po, { by: accountId, what: changed ? `Payout account CHANGED to ${masked}. Safety hold of ${holdText(po.holdHours)} restarts.` : `Payout account set to ${masked}. Safety hold of ${holdText(po.holdHours)} starts.` });
  await save(issueKey, po);
  if (changed) await comment(issueKey, ['Clear to Pay: payout account changed', `The supplier’s payout account changed to ${masked}. No payment can clear for ${holdText(po.holdHours)}. If you did not expect this, call the supplier on a number you already know.`]);
  return po;
}

/** The buyer confirms a same-supplier, same-amount payment elsewhere is a different invoice. Never clears an exact duplicate. */
async function confirmSeparateNow(issueKey, accountId) {
  const po = await load(issueKey) ?? fail('No order on this issue.');
  if (accountId !== po.buyer) fail('Only the buyer can confirm this is a separate invoice.');
  if (!po.invoice) fail('There is no invoice yet.');
  po.duplicate = await findDuplicates(issueKey, po);
  if (po.duplicate.sameFile) fail(`This exact invoice file is on ${po.duplicate.sameFile}. That cannot be confirmed away.`);
  if (!po.duplicate.similar.length) fail('There is no similar payment to confirm against.');
  po.duplicate.confirmed = { by: accountId, at: Date.now(), sha256: po.invoice.sha256 };
  log(po, { by: accountId, what: `Buyer confirmed ${po.invoice.file} is a separate invoice from ${po.duplicate.similar.map((p) => p.key).join(', ')}.` });
  await save(issueKey, po);
  return po;
}

/** Anyone may ask; only the rules decide. The request and its note are recorded either way. */
/** A short demo hold only counts while demo mode is on. Once an admin turns it off, the order waits the full minimum. */
export const effective = (po, settings) => (po && po.holdHours < MIN_HOLD_HOURS && !settings?.demoMode ? { ...po, holdHours: MIN_HOLD_HOURS } : po);

async function requestPaymentNow(issueKey, accountId, note = '') {
  const po = await load(issueKey) ?? fail('No order on this issue.');
  if (po.invoice && !po.paid) po.duplicate = await findDuplicates(issueKey, po);
  const d = decide(effective(po, await getSettings()));
  if (po.paid) d.paidAt = po.paid.at;
  const who = accountId ?? 'agent';
  const said = note ? quoteData(note, 300) : '';
  if (d.verdict === 'CLEARED') {
    po.paid = { at: Date.now(), by: who, amountMinor: po.invoice.amountMinor };
    log(po, { by: who, what: `Payment requested${said ? ` (${said})` : ''}: CLEARED. ${fromMinor(po.invoice.amountMinor)} ${po.currency} to ${po.payout.account}.` });
    await save(issueKey, po);
    // Saved as paid. Nothing below may turn that into an error for the caller.
    const pk = PAID(po.supplier, po.invoice.amountMinor);
    try { await kvs.set(pk, [{ key: issueKey, at: Date.now() }, ...((await kvs.get(pk)) ?? [])].slice(0, 50)); } catch { d.note = 'The duplicate-check record could not be written.'; }
    // The decision is saved. If Jira refuses the label or comment, the payment is still cleared.
    try { await addLabel(issueKey, 'cleared-to-pay'); } catch { d.note = 'The cleared-to-pay label could not be added.'; }
    try { await comment(issueKey, ['Clear to Pay: CLEARED TO PAY', `${fromMinor(po.invoice.amountMinor)} ${po.currency} to the supplier’s payout account ${po.payout.account}. Counts agreed, the invoice matches what was counted, the supplier approved this exact invoice (fingerprint ${po.invoice.sha256.slice(0, 12)}…), and the payout account has waited out its hold.`]); } catch { d.note = 'The Jira comment could not be added.'; }
  } else {
    log(po, { by: who, what: `Payment requested${said ? ` (${said})` : ''}: HELD. ${explain(d.reasons).join(' ')}` });
    await save(issueKey, po);
    try { await comment(issueKey, ['Clear to Pay: HELD', ...(said ? [`Request note: ${said}. A note is not an approval.`] : []), ...explain(d.reasons)]); } catch { /* the decision is saved */ }
  }
  return d;
}

// Every change runs under the order's lock.
export const setup = (issueKey, ...rest) => withLock(issueKey, () => setupNow(issueKey, ...rest));
export const cancelOrder = (issueKey, ...rest) => withLock(issueKey, () => cancelOrderNow(issueKey, ...rest));
export const submitCount = (issueKey, ...rest) => withLock(issueKey, () => submitCountNow(issueKey, ...rest));
export const resetCounts = (issueKey, ...rest) => withLock(issueKey, () => resetCountsNow(issueKey, ...rest));
export const recordInvoice = (issueKey, ...rest) => withLock(issueKey, () => recordInvoiceNow(issueKey, ...rest));
export const approveInvoice = (issueKey, ...rest) => withLock(issueKey, () => approveInvoiceNow(issueKey, ...rest));
export const setPayout = (issueKey, ...rest) => withLock(issueKey, () => setPayoutNow(issueKey, ...rest));
export const confirmSeparate = (issueKey, ...rest) => withLock(issueKey, () => confirmSeparateNow(issueKey, ...rest));
// Payment takes the order's lock, then the supplier's (always in that order), so two orders for the
// same supplier and amount cannot both pass the "paid recently" check at the same moment.
export const requestPayment = async (issueKey, ...rest) => {
  const supplier = (await load(issueKey))?.supplier;
  return withLock(issueKey, () => (supplier ? withLock(`sup:${supplier}`, () => requestPaymentNow(issueKey, ...rest)) : requestPaymentNow(issueKey, ...rest)));
};
