import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Stack, Heading, Text, Strong, Toggle, Label, SectionMessage, Spinner, Inline } from '@forge/react';
import { invoke } from '@forge/bridge';

function Admin() {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState(null);
  const load = async (name, payload) => {
    setErr(null);
    let r; try { r = await invoke(name, payload); } catch (e) { r = { ok: false, error: `The app could not be reached: ${e?.message ?? e}` }; }
    if (r.ok) setSt(r); else setErr(r.error);
  };
  useEffect(() => { load('getSettings'); }, []);
  if (!st) return err ? <SectionMessage appearance="error"><Text>{err}</Text></SectionMessage> : <Spinner />;
  const on = st.settings.demoMode;
  return (
    <Stack space="space.200">
      <Heading as="h2">Clear to Pay settings</Heading>
      {err ? <SectionMessage appearance="error"><Text>{err}</Text></SectionMessage> : null}
      <Heading as="h4">Demo mode</Heading>
      <Text>A changed payout account must normally wait at least 24 hours before anyone can be paid. Demo mode allows a 2-minute hold so you can try the whole flow in one sitting.</Text>
      <Inline space="space.100" alignBlock="center">
        <Toggle id="demo" isChecked={on} isDisabled={!st.isAdmin} onChange={() => load('setDemoMode', { on: !on })} />
        <Label labelFor="demo">{on ? 'Demo mode is on' : 'Demo mode is off'}</Label>
      </Inline>
      {on ? <SectionMessage appearance="warning"><Text>Turn this off before real use. Orders set up while it is on keep their short hold, and their panel says <Strong>Demo mode</Strong>.</Text></SectionMessage> : null}
    </Stack>
  );
}

ForgeReconciler.render(<React.StrictMode><Admin /></React.StrictMode>);
