const $ = (id) => document.getElementById(id);

function fmtAge(at) {
  const s = Math.floor((Date.now() - at) / 1000);
  return s < 60 ? s + 's ago' : s < 3600 ? Math.floor(s / 60) + 'm ago' : Math.floor(s / 3600) + 'h ago';
}

function defaultServers() {
  const list = [];
  if (typeof DEFAULT_BACKEND === 'string' && DEFAULT_BACKEND) {
    list.push({ url: DEFAULT_BACKEND, key: (typeof DEFAULT_KEY === 'string' ? DEFAULT_KEY : '') });
  }
  if (typeof DEFAULT_SERVERS !== 'undefined' && Array.isArray(DEFAULT_SERVERS)) {
    for (const s of DEFAULT_SERVERS) if (s && s.url) list.push({ url: s.url, key: s.key || '' });
  }
  return list.length ? list : [{ url: '', key: '' }];
}

function addRow(url, key) {
  const wrap = document.createElement('div');
  wrap.className = 'server';
  wrap.innerHTML =
    '<div class="hd"><span class="muted">Server</span>' +
    '<button class="x" type="button">Remove</button></div>' +
    '<input class="s-url" placeholder="http://host:8011">' +
    '<input class="s-key" placeholder="capture key">';
  wrap.querySelector('.s-url').value = url || '';
  wrap.querySelector('.s-key').value = key || '';
  wrap.querySelector('.x').onclick = () => wrap.remove();
  $('servers').appendChild(wrap);
}

function readRows() {
  return [...document.querySelectorAll('#servers .server')]
    .map((w) => ({
      url: w.querySelector('.s-url').value.trim().replace(/\/+$/, ''),
      key: w.querySelector('.s-key').value.trim(),
    }))
    .filter((s) => s.url);
}

async function load() {
  const cfg = await chrome.storage.local.get(['servers', 'backendUrl', 'captureKey']);
  let list = Array.isArray(cfg.servers) && cfg.servers.length ? cfg.servers : null;
  if (!list && cfg.backendUrl) list = [{ url: cfg.backendUrl, key: cfg.captureKey || '' }];
  if (!list) list = defaultServers();
  $('servers').innerHTML = '';
  list.forEach((s) => addRow(s.url, s.key));

  const { lastSent } = await chrome.storage.session.get('lastSent');
  if (!lastSent) {
    $('status').innerHTML = '<span class="muted">No token captured yet this session.</span>';
    $('tok').textContent = '';
    return;
  }
  const results = lastSent.results || [];
  const allOk = results.length && results.every((r) => r.ok);
  const head = allOk
    ? '<span class="ok">\u2713 sent to ' + results.length + ' server' + (results.length > 1 ? 's' : '') + '</span>'
    : '<span class="err">\u2717 ' + results.filter((r) => !r.ok).length + ' failed</span>';
  const detail = results.map((r) =>
    '<div>' + (r.ok ? '<span class="ok">\u2713</span> ' : '<span class="err">\u2717</span> ') +
    (r.url || '(no server)') + (r.ok ? '' : ' \u2014 ' + (r.error || r.status || 'failed')) + '</div>'
  ).join('');
  $('status').innerHTML = head + ' <span class="muted">\u00b7 ' + fmtAge(lastSent.at) + '</span>' +
    '<div class="results">' + detail + '</div>';
  $('tok').innerHTML = '<span class="muted">Token:</span> <code>' + (lastSent.preview || '') + '</code>';
}

$('add').onclick = () => addRow('', '');

$('save').onclick = async () => {
  const list = readRows();
  if (!list.length) { $('msg').textContent = 'Add at least one server.'; return; }
  const origins = [];
  for (const s of list) {
    try { origins.push(new URL(s.url).origin + '/*'); }
    catch (e) { $('msg').textContent = 'Invalid URL: ' + s.url; return; }
  }
  try {
    const granted = await chrome.permissions.request({ origins });
    if (!granted) { $('msg').textContent = 'Permission denied for one or more servers'; return; }
  } catch (e) { $('msg').textContent = String(e); return; }
  await chrome.storage.local.set({ servers: list });
  await chrome.storage.local.remove(['backendUrl', 'captureKey']);
  $('msg').textContent = 'Saved ' + list.length + ' server' + (list.length > 1 ? 's' : '') + '.';
};

$('copy').onclick = async () => {
  const { lastSent } = await chrome.storage.session.get('lastSent');
  if (lastSent && lastSent.token) { await navigator.clipboard.writeText(lastSent.token); $('msg').textContent = 'Copied.'; }
};

$('resend').onclick = () => { chrome.runtime.sendMessage({ type: 'resend' }, () => setTimeout(load, 500)); };

load();
