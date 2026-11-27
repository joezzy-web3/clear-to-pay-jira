import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box, Stack, Inline, Heading, Text, Strong, Button, Lozenge, SectionMessage, Textfield, Label,
  UserPicker, Select, User, Spinner, xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const card = xcss({ padding: 'space.150', borderRadius: 'border.radius.200', backgroundColor: 'elevation.surface.sunken' });
const when = (ms) => (ms ? new Date(ms).toLocaleString() : '');

function Setup({ run }) {
  const [f, setF] = useState({ currency: 'USD', holdHours: '72' });
  const set = (k) => (v) => setF((o) => ({ ...o, [k]: v }));
  return (
    <Stack space="space.150">
      <Text>Set up this purchase order. Payment will clear only when the delivery is counted on both sides, the invoice matches what was counted, the supplier approves that exact invoice, and its payout account has waited out its hold.</Text>
      <Label labelFor="item">Item</Label>
      <Textfield id="item" placeholder="Bags of rice, 50 kg" onChange={(e) => set('item')(e.target.value)} />
      <Inline space="space.150">
        <Box><Label labelFor="qty">Quantity</Label><Textfield id="qty" placeholder="20" onChange={(e) => set('qty')(e.target.value)} /></Box>
        <Box><Label labelFor="price">Unit price</Label><Textfield id="price" placeholder="10.00" onChange={(e) => set('unitPrice')(e.target.value)} /></Box>
        <Box><Label labelFor="cur">Currency</Label><Textfield id="cur" defaultValue="USD" onChange={(e) => set('currency')(e.target.value)} /></Box>
      </Inline>
      <UserPicker label="Supplier (approves its own invoice, sets where it is paid)" name="supplier" onChange={(u) => set('supplier')(u?.id)} />
      <UserPicker label="Receiver (counts at the gate for you)" name="receiver" onChange={(u) => set('receiver')(u?.id)} />
      <UserPicker label="Supplier’s rep (counts at the gate for the supplier)" name="rep" onChange={(u) => set('rep')(u?.id)} />
      <Label labelFor="hold">Payout account hold</Label>
      <Select id="hold" defaultValue={{ label: '72 hours (recommended)', value: '72' }} onChange={(o) => set('holdHours')(o.value)}
        options={[{ label: '72 hours (recommended)', value: '72' }, { label: '24 hours', value: '24' }, { label: '2 minutes (demo only)', value: String(2 / 60) }]} />
      <Button appearance="primary" onClick={() => run('setup', f)}>Set up order</Button>
    </Stack>
  );
}

function Counts({ s, run }) {
  const [qty, setQty] = useState('');
  const me = s.roles.includes('receiver') ? 'receiver' : s.roles.includes('rep') ? 'rep' : null;
  const show = (c) => (c == null ? <Lozenge>waiting</Lozenge> : c.sealed ? <Lozenge appearance="inprogress">sealed</Lozenge> : <Lozenge appearance="success">{String(c.qty)}</Lozenge>);
  const differ = s.counts.bothIn && s.counts.receiver.qty !== s.counts.rep.qty;
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Heading as="h4">1. Blind counts at the gate</Heading>
        <Inline space="space.200"><Text>Receiver</Text>{show(s.counts.receiver)}<Text>Supplier’s rep</Text>{show(s.counts.rep)}</Inline>
        <Text>Each side counts on its own. Neither sees the other’s number until both are in.</Text>
        {me && s.counts[me] == null && !s.paid ? (
          <Inline space="space.100" alignBlock="end">
            <Box><Label labelFor="count">Your count</Label><Textfield id="count" placeholder={String(s.qty)} onChange={(e) => setQty(e.target.value)} /></Box>
            <Button appearance="primary" onClick={() => run('count', { qty })}>Seal my count</Button>
          </Inline>
        ) : null}
        {differ ? <SectionMessage appearance="warning"><Text>The counts differ: receiver {String(s.counts.receiver.qty)}, supplier’s rep {String(s.counts.rep.qty)}. Nothing can clear until a recount agrees.</Text></SectionMessage> : null}
        {differ && s.roles.includes('buyer') ? <Button onClick={() => run('resetCounts')}>Reset counts for a recount</Button> : null}
      </Stack>
    </Box>
  );
}

function Invoice({ s, attachments, run }) {
  const [pick, setPick] = useState(null);
  const [amount, setAmount] = useState('');
  const [replacing, setReplacing] = useState(false);
  const canEdit = !s.approval && !s.paid && (!s.invoice || replacing);
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Heading as="h4">2. Invoice and the supplier’s approval</Heading>
        {s.invoice ? (
          <Text><Strong>{s.invoice.file}</Strong> for {s.invoice.amount} {s.currency} · fingerprint {s.invoice.sha256.slice(0, 12)}…</Text>
        ) : <Text>No invoice recorded. Attach the supplier’s invoice to this issue, then record it here, or ask the Clear to Pay agent in Rovo.</Text>}
        {s.duplicate?.sameFile ? <SectionMessage appearance="error" title="Duplicate invoice"><Text>This exact file is already on {s.duplicate.sameFile}. One invoice can only be paid once. Replace it with the right invoice.</Text></SectionMessage> : null}
        {!s.duplicate?.sameFile && s.duplicate?.similar?.length ? (
          <SectionMessage appearance={s.duplicate.confirmed ? 'information' : 'warning'} title={s.duplicate.confirmed ? 'Confirmed as a separate invoice' : 'Possible duplicate'}>
            <Text>This supplier was paid the same amount on {s.duplicate.similar.join(', ')} in the last 30 days.</Text>
            {!s.duplicate.confirmed && s.roles.includes('buyer') && !s.paid ? <Button onClick={() => run('confirmSeparate')}>It is a separate invoice</Button> : null}
          </SectionMessage>
        ) : null}
        {s.expected ? <Text>The counted delivery is worth <Strong>{s.expected} {s.currency}</Strong>. The invoice must ask for exactly that.</Text> : null}
        {canEdit ? (
          <Inline space="space.100" alignBlock="end">
            <Box xcss={{ minWidth: '240px' }}><Label labelFor="att">Attachment</Label><Select id="att" placeholder={attachments.length ? 'Pick the invoice file' : 'No files yet'} options={attachments.map((a) => ({ label: a.filename, value: a.id }))} onChange={(o) => setPick(o.value)} /></Box>
            <Box><Label labelFor="amt">Invoice amount</Label><Textfield id="amt" placeholder={s.expected ?? s.orderTotal} onChange={(e) => setAmount(e.target.value)} /></Box>
            <Button appearance="primary" isDisabled={!pick || !amount} onClick={async () => { await run('recordInvoice', { attachmentId: pick, amount }); setReplacing(false); }}>Record invoice</Button>
            <Button appearance="subtle" onClick={() => run('getState')}>Refresh files</Button>
          </Inline>
        ) : null}
        {s.approval ? <Text>✅ Approved by the supplier for <Strong>{s.approval.amount} {s.currency}</Strong>.</Text>
          : s.invoice && s.roles.includes('supplier') ? <Button appearance="primary" onClick={() => run('approve')}>Approve this invoice and amount</Button>
            : s.invoice ? <Text>Waiting for the supplier to approve this invoice and amount.</Text> : null}
        {s.invoice && !s.approval && !s.paid && !replacing ? <Button appearance="subtle" onClick={() => setReplacing(true)}>Replace the invoice</Button> : null}
      </Stack>
    </Box>
  );
}

function Payout({ s, run }) {
  const [acct, setAcct] = useState('');
  const inHold = s.payout && Date.now() < s.payout.holdEndsAt;
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Heading as="h4">3. Supplier’s payout account</Heading>
        {s.payout ? <Text>Account {s.payout.account} · {inHold ? `in its safety hold until ${when(s.payout.holdEndsAt)}` : 'hold passed'}</Text> : <Text>Not set yet. Only the supplier can set it.</Text>}
        {s.roles.includes('supplier') && !s.paid ? (
          <Inline space="space.100" alignBlock="end">
            <Box><Label labelFor="acct">{s.payout ? 'Change account (restarts the hold)' : 'Account number or IBAN'}</Label><Textfield id="acct" onChange={(e) => setAcct(e.target.value)} /></Box>
            <Button appearance="primary" isDisabled={!acct} onClick={() => run('setPayout', { account: acct })}>{s.payout ? 'Change' : 'Save'}</Button>
          </Inline>
        ) : null}
      </Stack>
    </Box>
  );
}

const DONE = {
  setup: () => 'Order set up. Next: the receiver and the supplier’s rep each count the delivery at the gate.',
  count: () => 'Your count is sealed. The other count stays hidden until both are in.',
  resetCounts: () => 'Counts cleared. Both sides count again.',
  recordInvoice: (s) => `Invoice recorded and fingerprinted (${s.invoice?.sha256?.slice(0, 12)}…). Next: the supplier approves the invoice and amount.`,
  approve: (s) => (s.payout ? 'Invoice approved. Anyone can now ask for payment.' : 'Invoice approved. Next: set the payout account below.'),
  setPayout: (s) => `Payout account saved. Payment can clear after the safety hold ends (${when(s.payout?.holdEndsAt)}).`,
  cancel: () => 'Order cancelled. You can set up a new one.',
  requestPayment: (s) => (s.paid ? 'Cleared to pay. A comment and the cleared-to-pay label were added to this issue.' : 'Held. The checks still failing are listed under step 4.'),
};

function Progress({ s }) {
  const steps = [
    ['Counts agree', s.expected !== null && s.expected !== undefined],
    ['Invoice matches', Boolean(s.invoice && s.expected && s.invoice.amount === s.expected && !s.duplicate?.sameFile)],
    ['Supplier approved', Boolean(s.approval && s.invoice && s.approval.sha256 === s.invoice.sha256)],
    ['Payout hold passed', Boolean(s.payout && Date.now() >= s.payout.holdEndsAt)],
  ];
  const done = steps.filter(([, ok]) => ok).length;
  return (
    <Inline space="space.075" alignBlock="center" shouldWrap>
      {steps.map(([label, ok], i) => (
        <Inline key={label} space="space.075" alignBlock="center">
          <Lozenge appearance={ok || s.paid ? 'success' : 'default'}>{ok || s.paid ? '✓ ' : `${i + 1}. `}{label}</Lozenge>
          {i < steps.length - 1 ? <Text>›</Text> : null}
        </Inline>
      ))}
      <Text>{s.paid ? 'Paid' : `${done} of 4`}</Text>
    </Inline>
  );
}

function App() {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [done, setDone] = useState(null);
  const run = async (name, payload) => {
    setBusy(true); setErr(null); setDone(null);
    const r = await invoke(name, payload);
    if (r.ok) { setSt(r); setDone(DONE[name]?.(r.state) ?? null); } else setErr(r.error);
    setBusy(false);
  };
  useEffect(() => { run('getState'); }, []);
  if (!st) return err ? <SectionMessage appearance="error"><Text>{err}</Text></SectionMessage> : <Spinner />;
  const s = st.state;
  return (
    <Stack space="space.200">
      {err ? <SectionMessage appearance="error"><Text>{err}</Text></SectionMessage> : null}
      {done ? <SectionMessage appearance={done.startsWith('Held') ? 'warning' : 'success'}><Text>{done}</Text></SectionMessage> : null}
      {!s.exists ? <Setup run={run} /> : (
        <Stack space="space.150">
          <Inline space="space.100" alignBlock="center">
            <Lozenge appearance={s.paid ? 'success' : s.decision.verdict === 'CLEARED' ? 'success' : 'moved'} isBold>{s.paid ? 'Cleared to pay' : s.decision.verdict === 'CLEARED' ? 'Ready: would clear' : 'Held until the checks pass'}</Lozenge>
            <Text>{String(s.qty)} × {s.item} at {s.unitPrice} {s.currency} · total {s.orderTotal} {s.currency}</Text>
          </Inline>
          <Progress s={s} />
          <Text>You are: <Strong>{s.roles.length ? s.roles.map((r) => ({ buyer: 'the buyer', receiver: 'the receiver', rep: 'the supplier’s rep', supplier: 'the supplier' })[r]).join(' and ') : 'viewing only'}</Strong></Text>
          <Inline space="space.200"><Text>Supplier</Text><User accountId={s.people.supplier} /><Text>Receiver</Text><User accountId={s.people.receiver} /><Text>Rep</Text><User accountId={s.people.rep} /></Inline>
          {s.roles.includes('buyer') && !s.counts.receiver && !s.counts.rep && !s.invoice ? <Button appearance="subtle" onClick={() => run('cancel')}>Cancel this order</Button> : null}
          <Counts s={s} run={run} />
          <Invoice s={s} attachments={st.attachments} run={run} />
          <Payout s={s} run={run} />
          {!s.paid ? (
            <Box xcss={card}>
              <Stack space="space.100">
                <Heading as="h4">4. Ask for payment</Heading>
                {s.decision.reasons.length ? s.decision.explained.map((r) => <Text key={r}>• {r}</Text>) : <Text>Every check passes.</Text>}
                <Inline space="space.100" alignBlock="end">
                  <Box><Label labelFor="note">Note (optional)</Label><Textfield id="note" placeholder="e.g. urgent, CFO approved" onChange={(e) => setNote(e.target.value)} /></Box>
                  <Button appearance="primary" isDisabled={busy} onClick={() => run('requestPayment', { note })}>Ask for payment</Button>
                </Inline>
                <Text>Anyone can ask. Only the checks decide. A note is recorded, never counted as approval.</Text>
              </Stack>
            </Box>
          ) : null}
          <Stack space="space.050">
            <Heading as="h4">Audit trail</Heading>
            {s.log.slice(0, 8).map((l) => <Text key={`${l.at}${l.what}`}>{when(l.at)} · {l.what}</Text>)}
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}

ForgeReconciler.render(<React.StrictMode><App /></React.StrictMode>);
