// REST API + SSE stream + static file host.
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');
const sensors = require('./sensors');

const SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const DEVICE_KEY = process.env.DEVICE_KEY || 'device-dev-key';
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- auth ----
const auth = (req, res, next) => {
  const raw = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token; // query token for EventSource
  try { req.user = jwt.verify(raw, SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
};
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !bcrypt.compareSync(password || '', u.hash)) return res.status(401).json({ error: 'Wrong username or password' });
  res.json({ token: jwt.sign({ id: u.id, username: u.username, role: u.role }, SECRET, { expiresIn: '8h' }), user: u.username, role: u.role });
});

// ---- workers CRUD ----
const WF = ['name', 'role', 'zone', 'phone', 'device_id'];
app.get('/api/workers', auth, (_q, res) => res.json(db.prepare('SELECT * FROM workers ORDER BY name').all()));
app.get('/api/workers/:id', auth, (req, res) => {
  const w = db.prepare('SELECT * FROM workers WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  w.events = db.prepare('SELECT * FROM events WHERE worker_id=? ORDER BY ts DESC LIMIT 20').all(w.id);
  res.json(w);
});
app.post('/api/workers', auth, (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Name is required' });
  try {
    const i = db.prepare('INSERT INTO workers(name,role,zone,phone,device_id,lat,lng,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(...WF.map(k => req.body[k] || null), sensors.SITE.lat, sensors.SITE.lng, new Date().toISOString());
    res.status(201).json(db.prepare('SELECT * FROM workers WHERE id=?').get(i.lastInsertRowid));
  } catch (e) { res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Device ID already assigned' : e.message }); }
});
app.put('/api/workers/:id', auth, (req, res) => {
  try {
    const r = db.prepare(`UPDATE workers SET ${WF.map(k => k + '=?').join(',')} WHERE id=?`).run(...WF.map(k => req.body[k] || null), req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'Not found' });
    res.json(db.prepare('SELECT * FROM workers WHERE id=?').get(req.params.id));
  } catch (e) { res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Device ID already assigned' : e.message }); }
});
app.delete('/api/workers/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM workers WHERE id=?').run(req.params.id); res.status(204).end();
});

// ---- events CRUD ----
const EV = `SELECT e.*, w.name worker FROM events e LEFT JOIN workers w ON w.id=e.worker_id`;
app.get('/api/events', auth, (req, res) => {
  const where = req.query.open ? 'WHERE e.ack=0' : '';
  res.json(db.prepare(`${EV} ${where} ORDER BY e.ts DESC LIMIT ?`).all(+req.query.limit || 100));
});
app.post('/api/events', auth, (req, res) => {
  const { worker_id, type, severity = 'info', message } = req.body;
  if (!type) return res.status(400).json({ error: 'type is required' });
  const i = db.prepare('INSERT INTO events(worker_id,type,severity,message,ts) VALUES(?,?,?,?,?)')
    .run(worker_id || null, type, severity, message || '', new Date().toISOString());
  res.status(201).json(db.prepare(`${EV} WHERE e.id=?`).get(i.lastInsertRowid));
});
app.put('/api/events/:id', auth, (req, res) => {
  db.prepare('UPDATE events SET ack=? WHERE id=?').run(req.body.ack ? 1 : 0, req.params.id);
  res.json(db.prepare(`${EV} WHERE e.id=?`).get(req.params.id));
});
app.delete('/api/events/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM events WHERE id=?').run(req.params.id); res.status(204).end();
});

// ---- operational metrics ----
app.get('/api/metrics', auth, (_q, res) => res.json({
  tasks: db.prepare('SELECT zone, SUM(planned) planned, SUM(done) done FROM tasks GROUP BY zone').all(),
  equipment: db.prepare('SELECT equipment, ROUND(SUM(active_h),1) active, ROUND(SUM(idle_h),1) idle FROM equipment_logs GROUP BY equipment').all(),
  site: sensors.SITE
}));

// ---- site area (geofence) ----
app.get('/api/site', auth, (_q, res) => res.json(sensors.SITE));
app.put('/api/site', auth, adminOnly, (req, res) => {
  const lat = +req.body.lat, lng = +req.body.lng, radius = +req.body.radius;
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && radius >= 20 && radius <= 5000))
    return res.status(400).json({ error: 'Invalid location or radius (20 to 5000 m)' });
  sensors.setSite({ lat, lng, radius, name: String(req.body.name || 'Site').slice(0, 60) });
  res.json(sensors.SITE);
});

// ---- device ingest (real hardware / gateway posts here) ----
app.post('/api/ingest', (req, res) => {
  if (req.headers['x-api-key'] !== DEVICE_KEY) return res.status(401).json({ error: 'Bad API key' });
  const s = sensors.ingest(req.body);
  s ? res.json({ status: s }) : res.status(404).json({ error: 'Unknown device_id' });
});

// ---- live stream (Server-Sent Events) ----
app.get('/api/stream', auth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`event: workers\ndata: ${JSON.stringify(db.prepare('SELECT * FROM workers').all())}\n\n`);
  sensors.clients.add(res);
  req.on('close', () => sensors.clients.delete(res));
});

sensors.start();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Smart Construction running on http://localhost:${PORT}`));
