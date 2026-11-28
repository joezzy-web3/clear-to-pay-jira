// In-memory stand-ins for Forge storage and the Jira REST API, so service.js can be tested.
// Every storage call yields to the event loop first, so tests can interleave two requests.
const tick = () => new Promise((r) => setImmediate(r));

export function makeFakes() {
  const store = new Map();
  const calls = [];
  const files = new Map(); // issueKey -> [{ id, filename, bytes }]
  const kvs = {
    async get(k) { await tick(); const v = store.get(k); return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); },
    async set(k, v, opts) {
      await tick();
      if (opts?.keyPolicy === 'FAIL_IF_EXISTS' && store.has(k)) throw new Error('KEY_ALREADY_EXISTS');
      store.set(k, JSON.parse(JSON.stringify(v)));
    },
    async delete(k) { await tick(); store.delete(k); },
  };
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => body });
  const requestJira = async (url, init = {}) => {
    await tick();
    calls.push({ url, method: init.method ?? 'GET', body: init.body });
    let m;
    if ((m = url.match(/\/rest\/api\/3\/attachment\/content\/(\w+)/))) {
      for (const list of files.values()) { const f = list.find((x) => x.id === m[1]); if (f) return ok(new TextEncoder().encode(f.bytes).buffer); }
      return { ok: false, status: 404 };
    }
    if ((m = url.match(/\/rest\/api\/3\/issue\/([A-Z0-9_]+-\d+)\?fields=attachment/))) {
      return ok({ fields: { attachment: (files.get(m[1]) ?? []).map((f) => ({ id: f.id, filename: f.filename, size: f.bytes.length, created: 'now' })) } });
    }
    if (/\/rest\/api\/3\/user\?accountId=/.test(url)) return ok({ accountId: 'x', active: true, accountType: 'atlassian' });
    if (/\/rest\/api\/3\/mypermissions/.test(url)) return ok({ permissions: { ADMINISTER: { havePermission: true } } });
    return ok({ fields: { summary: 'An issue' } });
  };
  const api = { asUser: () => ({ requestJira }), asApp: () => ({ requestJira }) };
  const route = (strings, ...vals) => strings.reduce((s, x, i) => s + x + (i < vals.length ? encodeURIComponent(vals[i]) : ''), '');
  return { store, calls, files, kvs, api, route };
}
