// The rules engine: the only thing that can say a purchase order is cleared to pay.
// Pure functions, no Jira calls, so every rule is unit-tested (test/rules.test.js).
//
// A payment request is CLEARED only when all of these hold:
//   1. both gate counts are in (receiver and supplier's rep, counted blind) and they agree,
//   2. an invoice is recorded, and its amount equals unit price x counted quantity,
//   3. the supplier approved that exact invoice (same fingerprint, same amount),
//   4. the supplier has a payout account on file, and it has waited out its hold,
//   5. the order is not already paid.
// Anything else is HELD, with every reason listed. Nobody's say-so changes this, including the AI's.

export const DEFAULT_HOLD_HOURS = 72;
export const HOUR = 3_600_000;

export const REASONS = {
  NO_ORDER: 'There is no Clear to Pay order on this issue yet.',
  ALREADY_PAID: 'This order was already cleared to pay. It cannot be paid twice.',
  COUNTS_MISSING: 'Both gate counts are needed: the receiver and the supplier’s rep each count the delivery on their own.',
  COUNTS_DIFFER: 'The two gate counts do not match. Recount, or settle it before anyone pays.',
  NO_INVOICE: 'No invoice has been recorded for this order.',
  AMOUNT_MISMATCH: 'The invoice amount does not match the price of what was counted.',
  NO_SUPPLIER_APPROVAL: 'The supplier has not approved this invoice and amount.',
  APPROVAL_FOR_OTHER_INVOICE: 'The supplier approved a different invoice or amount than the one recorded.',
  NO_PAYOUT: 'The supplier has not set a payout account.',
  PAYOUT_IN_HOLD: 'The supplier’s payout account changed recently and is still in its safety hold.',
};

/** Money is kept in minor units (cents) as integers, so there is no rounding. */
export const toMinor = (v) => {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('Use an amount like 1250 or 1250.50.');
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
};
export const fromMinor = (m) => `${Math.floor(m / 100).toLocaleString('en-US')}.${String(m % 100).padStart(2, '0')}`;

/** Price of what was actually counted: the amount a matching invoice must ask for. */
export const expectedAmount = (po) => {
  const q = countedQty(po);
  return q === null ? null : q * po.unitPriceMinor;
};

/** The agreed count, or null while counts are missing or disagree. */
export function countedQty(po) {
  const r = po.counts?.receiver, s = po.counts?.rep;
  if (r == null || s == null) return null;
  return r.qty === s.qty ? r.qty : null;
}

export const holdEndsAt = (po) => (po.payout ? po.payout.setAt + (po.holdHours ?? DEFAULT_HOLD_HOURS) * HOUR : null);

/** The decision. Returns { verdict: 'CLEARED' | 'HELD', reasons: [code], expectedMinor }. */
export function decide(po, now = Date.now()) {
  if (!po) return { verdict: 'HELD', reasons: ['NO_ORDER'] };
  if (po.paid) return { verdict: 'HELD', reasons: ['ALREADY_PAID'] };
  const reasons = [];
  const r = po.counts?.receiver, s = po.counts?.rep;
  if (r == null || s == null) reasons.push('COUNTS_MISSING');
  else if (r.qty !== s.qty) reasons.push('COUNTS_DIFFER');
  const expectedMinor = expectedAmount(po);
  if (!po.invoice) reasons.push('NO_INVOICE');
  else if (expectedMinor !== null && po.invoice.amountMinor !== expectedMinor) reasons.push('AMOUNT_MISMATCH');
  const a = po.supplierApproval;
  if (!a) reasons.push('NO_SUPPLIER_APPROVAL');
  else if (!po.invoice || a.sha256 !== po.invoice.sha256 || a.amountMinor !== po.invoice.amountMinor) reasons.push('APPROVAL_FOR_OTHER_INVOICE');
  if (!po.payout) reasons.push('NO_PAYOUT');
  else if (now < holdEndsAt(po)) reasons.push('PAYOUT_IN_HOLD');
  return { verdict: reasons.length ? 'HELD' : 'CLEARED', reasons, expectedMinor };
}

/** Who may do what. People are Atlassian account IDs. */
export function roleOf(po, accountId) {
  if (!po) return [];
  const out = [];
  if (accountId === po.buyer) out.push('buyer');
  if (accountId === po.receiver) out.push('receiver');
  if (accountId === po.rep) out.push('rep');
  if (accountId === po.supplier) out.push('supplier');
  return out;
}

/** Separation of duties, checked when the order is set up. */
export function checkSetup(p) {
  const need = ['supplier', 'receiver', 'rep', 'item', 'qty', 'unitPrice'];
  for (const k of need) if (p[k] === undefined || p[k] === null || p[k] === '') throw new Error(`Missing: ${k}.`);
  if (p.receiver === p.rep) throw new Error('The receiver and the supplier’s rep must be two different people.');
  if (p.supplier === p.receiver) throw new Error('The supplier cannot also be the receiver.');
  const qty = Number(p.qty);
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantity must be a whole number above zero.');
  const unitPriceMinor = toMinor(p.unitPrice);
  if (unitPriceMinor <= 0) throw new Error('Unit price must be above zero.');
  const holdHours = p.holdHours === undefined ? DEFAULT_HOLD_HOURS : Number(p.holdHours);
  if (!(holdHours > 0)) throw new Error('The payout hold must be above zero hours.');
  return { supplier: p.supplier, receiver: p.receiver, rep: p.rep, item: String(p.item).slice(0, 200), qty, unitPriceMinor, currency: String(p.currency || 'USD').slice(0, 3).toUpperCase(), holdHours };
}

/** The buyer sets the order up, so it may not be on the supplier's side of it. */
export function checkBuyer(clean, buyer) {
  if (buyer === clean.supplier) throw new Error('The supplier cannot set up its own purchase order. Sign in as the buyer.');
  if (buyer === clean.rep) throw new Error('The supplier’s rep cannot set up the order. Sign in as the buyer.');
}

/** What a person may see of the counts: the other side's count stays sealed until both are in. */
export function visibleCounts(po, accountId) {
  const r = po.counts?.receiver, s = po.counts?.rep;
  const both = r != null && s != null;
  const show = (c, owner) => (c == null ? null : both || accountId === owner ? { qty: c.qty, at: c.at } : { sealed: true, at: c.at });
  return { receiver: show(r, po.receiver), rep: show(s, po.rep), bothIn: both };
}

export const explain = (codes) => codes.map((c) => REASONS[c] ?? c);
