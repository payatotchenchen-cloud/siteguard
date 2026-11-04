// SiteGuard SPA: hash router, REST client, SSE live updates, Chart.js, Leaflet.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = t => { const s = (Date.now() - new Date(t)) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : new Date(t).toLocaleString(); };
let token = localStorage.getItem('sg_token'), role = localStorage.getItem('sg_role');
let workers = [], events = [], charts = [], map, markers = {}, es, route = 'dash';

async function api(path, opt = {}) {
  const r = await fetch('/api' + path, { method: opt.method || 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: opt.body && JSON.stringify(opt.body) });
  if (r.status === 401) { logout(); throw new Error('Session expired'); }
  if (r.status === 204) return null;
  const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Request failed'); return d;
}
const toast = (msg, sev = 'warning') => { const t = document.createElement('div'); t.className = 'toast ' + sev; t.textContent = msg; $('#toasts').append(t); setTimeout(() => t.remove(), 5000); };
const mkChart = (id, type, labels, sets, opts = {}) => {
  const colors = ['#f5a524', '#5b6b7f'];
  charts.push(new Chart($('#' + id), { type, data: { labels, datasets: sets.map((s, i) => ({ ...s, backgroundColor: colors[i], borderRadius: 2 })) },
    options: { plugins: { legend: { labels: { color: '#9aa7b7' } } }, scales: { x: { ticks: { color: '#7d8b9c' }, grid: { display: false }, ...opts.x }, y: { ticks: { color: '#7d8b9c' }, grid: { color: '#252e3a' }, ...opts.y } } } }));
};

// ---------- auth ----------
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const f = Object.fromEntries(new FormData(e.target));
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error);
    token = d.token; role = d.role; localStorage.setItem('sg_token', token); localStorage.setItem('sg_role', role); boot();
  } catch (err) { $('#loginErr').textContent = err.message; }
};
function logout() { localStorage.removeItem('sg_token'); token = null; es?.close(); $('#shell').classList.add('hidden'); $('#login').classList.remove('hidden'); }
$('#logout').onclick = logout;
$('#bell').onclick = () => $('#panel').classList.toggle('open');

// ---------- live data ----------
function connect() {
  es?.close();
  es = new EventSource('/api/stream?token=' + token);
  es.addEventListener('workers', e => { workers = JSON.parse(e.data); views[route]?.live?.(); });
  es.addEventListener('alert', e => {
    const a = JSON.parse(e.data); events.unshift(a); toast(a.message, a.severity); renderNotes(); views[route]?.alerts?.();
  });
}
function renderNotes() {
  const open = events.filter(e => !e.ack);
  $('#badge').textContent = open.length;
  $('#notes').innerHTML = open.slice(0, 40).map(e => `<li class="${e.severity}"><span>${esc(e.message)}<small>${esc(e.type)} · ${ago(e.ts)}</small></span><button class="btn ghost sm" data-ack="${e.id}">Ack</button></li>`).join('') || '<li class="muted">No open alerts</li>';
}
document.addEventListener('click', async e => {
  const id = e.target.dataset.ack; if (!id) return;
  await api('/events/' + id, { method: 'PUT', body: { ack: 1 } });
  events.find(x => x.id == id).ack = 1; renderNotes(); views[route]?.alerts?.();
});
const alertRows = list => list.map(e => `<li class="${e.severity}"><span>${esc(e.message)}<small>${esc(e.type)} · ${ago(e.ts)}</small></span><button class="btn ghost sm" data-ack="${e.id}">Acknowledge</button></li>`).join('') || '<li class="muted">All clear</li>';

// ---------- views ----------
const views = {
  dash: {
    title: 'Site overview',
    async render(el) {
      const m = await api('/metrics');
      el.innerHTML = `<div class="kpis" id="kpis"></div><div class="grid">
        <section><h3>Task completion by zone</h3><canvas id="c1"></canvas></section>
        <section><h3>Equipment hours, last 7 days</h3><canvas id="c2"></canvas></section>
        <section class="wide"><h3>Open alerts</h3><ul class="list" id="al"></ul></section></div>`;
      mkChart('c1', 'bar', m.tasks.map(t => t.zone), [{ label: 'Planned', data: m.tasks.map(t => t.planned) }, { label: 'Done', data: m.tasks.map(t => t.done) }]);
      mkChart('c2', 'bar', m.equipment.map(t => t.equipment), [{ label: 'Active h', data: m.equipment.map(t => t.active) }, { label: 'Idle h', data: m.equipment.map(t => t.idle) }], { x: { stacked: true, grid: { display: false } }, y: { stacked: true } });
      this.m = m; this.live(); this.alerts();
    },
    live() {
      if (!$('#kpis')) return;
      const n = workers.length || 1, helmets = workers.filter(w => w.helmet).length;
      const done = this.m.tasks.reduce((a, t) => a + t.done, 0), plan = this.m.tasks.reduce((a, t) => a + t.planned, 0);
      const act = this.m.equipment.reduce((a, t) => a + t.active, 0), idle = this.m.equipment.reduce((a, t) => a + t.idle, 0);
      const risk = workers.filter(w => w.status !== 'safe').length, pct = Math.round(helmets / n * 100);
      $('#kpis').innerHTML = [['Workers on site', workers.length, ''], ['Helmet compliance', pct + '%', pct < 90 ? 'warn' : ''], ['Workers at risk', risk, risk ? 'bad' : ''],
        ['Task completion', Math.round(done / plan * 100) + '%', ''], ['Equipment utilisation', Math.round(act / (act + idle) * 100) + '%', '']]
        .map(k => `<div class="kpi ${k[2]}"><small>${k[0]}</small><div>${k[1]}</div></div>`).join('');
    },
    alerts() { const el = $('#al'); if (el) el.innerHTML = alertRows(events.filter(e => !e.ack).slice(0, 12)); }
  },
  workers: {
    title: 'Worker profiles',
    async render(el) { el.innerHTML = `<section><div class="row" style="margin-bottom:12px"><button class="btn" id="add">Add worker</button></div><div class="tbl"><table><thead><tr><th>Worker</th><th>Role / zone</th><th>Device</th><th>Helmet</th><th>HR</th><th>Position</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody id="rows"></tbody></table></div></section>`;
      $('#add').onclick = () => this.edit(); this.live(); },
    live() {
      const b = $('#rows'); if (!b) return;
      b.innerHTML = workers.map(w => `<tr><td>${esc(w.name)}<br><span class="muted">${esc(w.phone)}</span></td><td>${esc(w.role)}<br><span class="muted">${esc(w.zone)}</span></td><td class="m">${esc(w.device_id)}</td>
        <td class="${w.helmet ? 'safe' : 'warning'}">${w.helmet ? 'ON' : 'OFF'}</td><td class="m">${w.hr} bpm</td><td class="m">${w.lat?.toFixed(5)}, ${w.lng?.toFixed(5)}</td>
        <td><span class="pill ${w.status}">${w.status}</span></td><td class="m">${ago(w.updated_at)}</td>
        <td><button class="btn ghost sm" data-edit="${w.id}">Edit</button> ${role === 'admin' ? `<button class="btn ghost sm" data-del="${w.id}">Delete</button>` : ''}</td></tr>`).join('');
      b.querySelectorAll('[data-edit]').forEach(x => x.onclick = () => this.edit(workers.find(w => w.id == x.dataset.edit)));
      b.querySelectorAll('[data-del]').forEach(x => x.onclick = async () => { if (confirm('Delete this worker and their events?')) { await api('/workers/' + x.dataset.del, { method: 'DELETE' }); workers = workers.filter(w => w.id != x.dataset.del); this.live(); } });
    },
    edit(w = {}) {
      const f = $('#dlgForm');
      f.innerHTML = `<h3>${w.id ? 'Edit' : 'New'} worker</h3>` + [['name', 'Full name'], ['role', 'Role'], ['zone', 'Zone'], ['phone', 'Phone'], ['device_id', 'Helmet device ID']].map(([k, l]) => `<label>${l}<input name="${k}" value="${esc(w[k])}" ${k === 'name' ? 'required' : ''}></label>`).join('') + `<p class="err" id="fe"></p><div class="row"><button type="button" class="btn ghost" id="cx">Cancel</button><button class="btn">Save</button></div>`;
      $('#cx').onclick = () => $('#dlg').close();
      f.onsubmit = async e => { e.preventDefault();
        try { const body = Object.fromEntries(new FormData(f)); const r = await api(w.id ? '/workers/' + w.id : '/workers', { method: w.id ? 'PUT' : 'POST', body });
          const i = workers.findIndex(x => x.id === r.id); i < 0 ? workers.push(r) : workers[i] = { ...workers[i], ...r }; $('#dlg').close(); this.live(); }
        catch (err) { $('#fe').textContent = err.message; } };
      $('#dlg').showModal();
    }
  },
  map: {
    title: 'Live tracking',
    async render(el) {
      const { site } = await api('/metrics');
      el.innerHTML = '<div id="map"></div>'; markers = {};
      map = L.map('map').setView([site.lat, site.lng], 17);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      L.circle([site.lat, site.lng], { radius: site.radius, color: '#f5a524', weight: 2, dashArray: '6 6', fillOpacity: .05 }).addTo(map);
      this.live();
    },
    live() {
      if (!map || !$('#map')) return;
      const col = { safe: '#3fb67a', warning: '#f5a524', critical: '#ef4b4b' };
      workers.forEach(w => {
        if (w.lat == null) return;
        const m = markers[w.id] ??= L.circleMarker([w.lat, w.lng], { radius: 9, weight: 2, fillOpacity: .85 }).addTo(map);
        m.setLatLng([w.lat, w.lng]).setStyle({ color: col[w.status], fillColor: col[w.status] }).bindTooltip(`${esc(w.name)} · ${esc(w.zone)}<br>HR ${w.hr} · helmet ${w.helmet ? 'on' : 'off'}`);
      });
    }
  },
  events: {
    title: 'Event log',
    async render(el) {
      events = await api('/events?limit=200'); renderNotes();
      el.innerHTML = `<section><div class="tbl"><table><thead><tr><th>Time</th><th>Worker</th><th>Type</th><th>Severity</th><th>Message</th><th></th></tr></thead><tbody id="ev"></tbody></table></div></section>`; this.alerts();
    },
    alerts() {
      const b = $('#ev'); if (!b) return;
      b.innerHTML = events.map(e => `<tr><td class="m">${ago(e.ts)}</td><td>${esc(e.worker)}</td><td class="m">${esc(e.type)}</td><td class="${e.severity}">${esc(e.severity)}</td><td>${esc(e.message)}</td>
        <td>${e.ack ? '<span class="muted">acked</span>' : `<button class="btn ghost sm" data-ack="${e.id}">Ack</button>`} ${role === 'admin' ? `<button class="btn ghost sm" data-rm="${e.id}">Delete</button>` : ''}</td></tr>`).join('');
      b.querySelectorAll('[data-rm]').forEach(x => x.onclick = async () => { await api('/events/' + x.dataset.rm, { method: 'DELETE' }); events = events.filter(v => v.id != x.dataset.rm); renderNotes(); this.alerts(); });
    }
  }
};

async function navigate() {
  route = views[location.hash.slice(1)] ? location.hash.slice(1) : 'dash';
  charts.forEach(c => c.destroy()); charts = []; map?.remove(); map = null;
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.hash === '#' + route));
  $('#title').textContent = views[route].title;
  const el = $('#view'); el.innerHTML = '';
  try { await views[route].render(el); } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
async function boot() {
  if (!token) { $('#login').classList.remove('hidden'); return; }
  $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden');
  try { events = await api('/events?limit=200'); } catch { return; }
  renderNotes(); connect(); navigate();
}
addEventListener('hashchange', navigate);
boot();
