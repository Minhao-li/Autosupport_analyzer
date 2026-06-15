importScripts('config.js');
const BEARER_RE = /Bearer\s+(eyJ[A-Za-z0-9._-]+)/i;
const DEDUPE_MS = 60000;

function defaultServers() {
  const list = [];
  if (typeof DEFAULT_BACKEND === 'string' && DEFAULT_BACKEND) {
    list.push({ url: DEFAULT_BACKEND, key: (typeof DEFAULT_KEY === 'string' ? DEFAULT_KEY : '') });
  }
  if (typeof DEFAULT_SERVERS !== 'undefined' && Array.isArray(DEFAULT_SERVERS)) {
    for (const s of DEFAULT_SERVERS) if (s && s.url) list.push({ url: s.url, key: s.key || '' });
  }
  return list;
}

function normalize(list) {
  const seen = new Set();
  const out = [];
  for (const s of (list || [])) {
    if (!s || !s.url) continue;
    const url = String(s.url).trim().replace(/\/+$/, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, key: (s.key || '').trim() });
  }
  return out;
}

// Resolve the configured servers, migrating the legacy single-server keys.
async function servers() {
  const s = await chrome.storage.local.get(['servers', 'backendUrl', 'captureKey']);
  let list = Array.isArray(s.servers) && s.servers.length ? s.servers : null;
  if (!list && s.backendUrl) list = [{ url: s.backendUrl, key: s.captureKey || '' }];
  if (!list) list = defaultServers();
  return normalize(list);
}

function badge(ok) {
  try {
    chrome.action.setBadgeText({ text: ok ? '\u2713' : '!' });
    chrome.action.setBadgeBackgroundColor({ color: ok ? '#16a34a' : '#b91c1c' });
  } catch (e) {}
}

async function postTo(srv, token) {
  const res = { url: srv.url };
  try {
    const r = await fetch(srv.url + '/api/asup/token/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, key: srv.key, submitter: 'extension' }),
    });
    res.ok = r.ok; res.status = r.status;
    if (!r.ok) res.error = 'HTTP ' + r.status;
  } catch (e) {
    res.ok = false; res.error = String(e);
  }
  return res;
}

async function send(token, url, force) {
  if (!token) return;
  const { lastSent } = await chrome.storage.session.get('lastSent');
  if (!force && lastSent && lastSent.token === token && (Date.now() - lastSent.at) < DEDUPE_MS) return;
  const list = await servers();
  const rec = { token, preview: token.slice(0, 10) + '\u2026' + token.slice(-6), at: Date.now(), url: url || '', results: [] };
  if (!list.length) {
    rec.results.push({ url: '', ok: false, error: 'No server configured (open the popup)' });
    await chrome.storage.session.set({ lastSent: rec });
    badge(false);
    return;
  }
  rec.results = await Promise.all(list.map((srv) => postTo(srv, token)));
  await chrome.storage.session.set({ lastSent: rec });
  badge(rec.results.every((r) => r.ok));
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const h = (details.requestHeaders || []).find((x) => x.name.toLowerCase() === 'authorization');
    if (!h || !h.value) return;
    const m = String(h.value).match(BEARER_RE);
    if (m) send(m[1], details.url, false);
  },
  { urls: AIQ_URLS },
  ['requestHeaders', 'extraHeaders']
);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'resend') {
    chrome.storage.session.get('lastSent').then(({ lastSent }) => {
      if (lastSent && lastSent.token) send(lastSent.token, lastSent.url, true).then(() => reply({ ok: true }));
      else reply({ ok: false });
    });
    return true;
  }
});
