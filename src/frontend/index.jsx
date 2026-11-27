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
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Heading as="h4">2. Invoice and the supplier’s approval</Heading>
        {s.invoice ? (
          <Text><Strong>{s.invoice.file}</Strong> for {s.invoice.amount} {s.currency} · fingerprint {s.invoice.sha256.slice(0, 12)}…</Text>
        ) : <Text>No invoice recorded. Attach the supplier’s invoice to this issue, then record it here, or ask the Clear to Pay agent in Rovo.</Text>}
        {s.expected ? <Text>The counted delivery is worth <Strong>{s.expected} {s.currency}</Strong>. The invoice must ask for exactly that.</Text> : null}
        {!s.approval && !s.paid ? (
          <Inline space="space.100" alignBlock="end">
            <Box xcss={{ minWidth: '240px' }}><Label labelFor="att">Attachment</Label><Select id="att" placeholder={attachments.length ? 'Pick the invoice file' : 'No files yet'} options={attachments.map((a) => ({ label: a.filename, value: a.id }))} onChange={(o) => setPick(o.value)} /></Box>
            <Box><Label labelFor="amt">Invoice amount</Label><Textfield id="amt" placeholder={s.expected ?? s.orderTotal} onChange={(e) => setAmount(e.target.value)} /></Box>
            <Button onClick={() => run('recordInvoice', { attachmentId: pick, amount })}>Record invoice</Button>
            <Button appearance="subtle" onClick={() => run('getState')}>Refresh files</Button>
          </Inline>
        ) : null}
        {s.approval ? <Lozenge appearance="success">Approved by the supplier for {s.approval.amount} {s.currency}</Lozenge>
          : s.invoice && s.roles.includes('supplier') ? <Button appearance="primary" onClick={() => run('approve')}>Approve this invoice and amount</Button>
            : s.invoice ? <Lozenge appearance="moved">Waiting for the supplier’s approval</Lozenge> : null}
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
            <Button onClick={() => run('setPayout', { account: acct })}>{s.payout ? 'Change' : 'Save'}</Button>
          </Inline>
        ) : null}
      </Stack>
    </Box>
  );
}

function App() {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const run = async (name, payload) => {
    setBusy(true); setErr(null);
    const r = await invoke(name, payload);
    if (r.ok) setSt(r); else setErr(r.error);
    setBusy(false);
  };
  useEffect(() => { run('getState'); }, []);
  if (!st) return err ? <SectionMessage appearance="error"><Text>{err}</Text></SectionMessage> : <Spinner />;
  const s = st.state;
  return (
    <Stack space="space.200">
      {err ? <SectionMessage appearance="error"><Text>{err}</Text></SectionMessage> : null}
      {!s.exists ? <Setup run={run} /> : (
        <Stack space="space.150">
          <Inline space="space.100" alignBlock="center">
            <Lozenge appearance={s.paid ? 'success' : s.decision.verdict === 'CLEARED' ? 'success' : 'moved'} isBold>{s.paid ? 'Cleared to pay' : s.decision.verdict === 'CLEARED' ? 'Ready: would clear' : 'Held until the checks pass'}</Lozenge>
            <Text>{String(s.qty)} × {s.item} at {s.unitPrice} {s.currency} · total {s.orderTotal} {s.currency}</Text>
          </Inline>
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
