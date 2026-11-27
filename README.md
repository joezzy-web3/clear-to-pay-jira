# Clear to Pay for Jira

### The AI asks. The rules decide.

A three-way match for Jira that Rovo can use but can't talk its way around.

AI agents are moving into accounts payable, and the oldest procurement fraud still works: "our bank details have changed", a rushed "the CFO already approved this", an invoice for more than was delivered. Clear to Pay puts the check a good warehouse does at the gate into Jira, as rules an agent can ask but never override.

Every purchase order is a Jira issue with a **Clear to Pay** panel. Payment clears only when:

1. **Both gate counts agree.** The receiver and the supplier's rep each count on their own; neither sees the other's number until both are in.
2. **The invoice matches what was counted.** The invoice must ask for exactly unit price × counted quantity (a three-way match: order, delivery, invoice).
3. **The supplier approved that exact invoice.** The app fingerprints the attached file (SHA-256); approval is for that file and amount only.
4. **The payout account has waited out its hold.** Any change of bank details restarts a safety hold (72 hours by default).

Anything else is **Held**, with every reason, written to the issue. Nobody's say-so changes that, including the AI's.

## What's in the app

| Part | Forge module | What it does |
|---|---|---|
| Issue panel | `jira:issuePanel` (UI Kit) | Set up the order, seal counts, record and approve the invoice, set the payout account, ask for payment, audit trail |
| Rovo agent | `rovo:agent` | "Clear to Pay agent": reads orders, checks invoices, records them, asks for payment. Cannot approve |
| Actions | `action` | `get-order`, `check-invoice`, `record-invoice`, `request-payment` |
| MCP server | `rovo:mcp` | The same four actions as MCP tools, for any MCP client |
| Rules engine | `src/rules.js` | Pure functions, unit-tested; the only code that decides |

## Run it

Requirements: Node 22, the Forge CLI (`npm install -g @forge/cli`), `forge login`, and an Atlassian Cloud developer site.

```
npm install
forge register        # first time only: gives this copy its own app ID
forge deploy
forge install --site <your-site>.atlassian.net --product jira
npm test              # the rules engine tests
```

Built for Codegeist 2026, started 27 Nov 2026. The idea comes from [Clear to Pay on Concordium](https://github.com/joezzy-web3/ctp-concordium) (blockchain escrow); this Forge app is new code.
