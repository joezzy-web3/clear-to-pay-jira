// Entry points. `handler` serves the issue panel; the other exports are Rovo actions,
// also exposed as MCP tools. They all go through service.js and the rules in rules.js.
import Resolver from '@forge/resolver';
import * as svc from './service.js';
import { decide, explain, fromMinor, expectedAmount } from './rules.js';

const resolver = new Resolver();
const issueOf = (req) => { const k = req.context.extension?.issue?.key; if (!k) throw new svc.UserError('Open this from a Jira issue.'); return k; };
const wrap = (fn) => async (req) => {
  try { return { ok: true, ...(await fn(req)) }; } catch (e) { return { ok: false, error: e instanceof svc.UserError ? e.message : 'Something went wrong. Try again.' }; }
};
const state = async (key, accountId) => ({ state: svc.view(await svc.load(key), accountId), attachments: await svc.attachments(key) });

resolver.define('getState', wrap(async (req) => state(issueOf(req), req.context.accountId)));
resolver.define('setup', wrap(async (req) => { await svc.setup(issueOf(req), req.context.accountId, req.payload); return state(issueOf(req), req.context.accountId); }));
resolver.define('cancel', wrap(async (req) => { await svc.cancelOrder(issueOf(req), req.context.accountId); return state(issueOf(req), req.context.accountId); }));
resolver.define('count', wrap(async (req) => { await svc.submitCount(issueOf(req), req.context.accountId, req.payload.qty); return state(issueOf(req), req.context.accountId); }));
resolver.define('resetCounts', wrap(async (req) => { await svc.resetCounts(issueOf(req), req.context.accountId); return state(issueOf(req), req.context.accountId); }));
resolver.define('recordInvoice', wrap(async (req) => { await svc.recordInvoice(issueOf(req), req.context.accountId, req.payload); return state(issueOf(req), req.context.accountId); }));
resolver.define('approve', wrap(async (req) => { await svc.approveInvoice(issueOf(req), req.context.accountId); return state(issueOf(req), req.context.accountId); }));
resolver.define('setPayout', wrap(async (req) => { await svc.setPayout(issueOf(req), req.context.accountId, req.payload.account); return state(issueOf(req), req.context.accountId); }));
resolver.define('requestPayment', wrap(async (req) => { const d = await svc.requestPayment(issueOf(req), req.context.accountId, req.payload?.note); return { decision: d, ...(await state(issueOf(req), req.context.accountId)) }; }));

export const handler = resolver.getDefinitions();

// ---------- Rovo actions / MCP tools ----------
// Each answers in plain text. They run with the asking user's view of Jira.
const accountOf = (payload) => payload?.context?.accountId;
const text = (fn) => async (payload) => {
  try { return await fn(payload); } catch (e) { return e instanceof svc.UserError ? `Could not do that: ${e.message}` : 'Something went wrong. Try again.'; }
};

export const getOrder = text(async (payload) => {
  const key = svc.checkIssueKey(payload.issueKey);
  await svc.assertCanSee(key);
  return svc.summary(key, await svc.load(key));
});

export const checkInvoice = text(async (payload) => {
  const key = svc.checkIssueKey(payload.issueKey);
  await svc.assertCanSee(key);
  const po = await svc.load(key);
  if (!po) return `${key} has no Clear to Pay order yet.`;
  const exp = expectedAmount(po);
  const d = decide(po);
  const match = !po.invoice ? 'No invoice is recorded yet.'
    : exp === null ? `Invoice asks for ${fromMinor(po.invoice.amountMinor)} ${po.currency}; the counted value is not known until both gate counts are in and agree.`
      : po.invoice.amountMinor === exp ? `Three-way match: order, counted delivery and invoice agree at ${fromMinor(exp)} ${po.currency}.`
        : `Three-way match FAILS: the invoice asks for ${fromMinor(po.invoice.amountMinor)} ${po.currency}, but what was counted is worth ${fromMinor(exp)} ${po.currency}.`;
  return `${match}\nIf payment were requested now: ${d.verdict}${d.reasons.length ? ` — ${explain(d.reasons).join(' ')}` : '.'}\nI can record and check invoices, but I cannot approve or release a payment: only the rules can.`;
});

export const recordInvoice = text(async (payload) => {
  const key = svc.checkIssueKey(payload.issueKey);
  await svc.assertCanSee(key);
  const po = await svc.recordInvoice(key, accountOf(payload), { filename: payload.filename, amount: payload.amount });
  return `Recorded ${po.invoice.file} for ${fromMinor(po.invoice.amountMinor)} ${po.currency} on ${key} (fingerprint ${po.invoice.sha256.slice(0, 12)}…). Next, the supplier approves this exact invoice from the Clear to Pay panel.`;
});

export const requestPayment = text(async (payload) => {
  const key = svc.checkIssueKey(payload.issueKey);
  await svc.assertCanSee(key);
  const d = await svc.requestPayment(key, accountOf(payload), payload.note);
  return d.verdict === 'CLEARED'
    ? `CLEARED: ${key} is cleared to pay. The decision is recorded on the issue.`
    : `HELD: ${key} cannot be paid yet. ${explain(d.reasons).join(' ')} The decision and your note are recorded on the issue. A note or someone’s say-so is not an approval: only the checks above can clear it.`;
});
