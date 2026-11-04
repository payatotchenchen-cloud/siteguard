// Sensor layer: one ingest() entry point, fed either by the mock simulator,
// by polling a real API (SENSOR_API_URL), or by devices POSTing to /api/ingest.
const db = require('./db');
const SITE = { lat: 14.6507, lng: 120.9835, radius: 220 }; // geofence centre + radius (m)
const clients = new Set();                                  // SSE subscribers
const pos = {};                                             // simulator state

const broadcast = (type, data) => {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => res.write(msg));
};

function metres(a, b, c, d) { // haversine
  const R = 6371000, r = x => x * Math.PI / 180;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function raise(w, type, severity, message) {
  const ts = new Date().toISOString();
  const info = db.prepare('INSERT INTO events(worker_id,type,severity,message,ts) VALUES(?,?,?,?,?)')
    .run(w.id, type, severity, message, ts);
  broadcast('alert', { id: info.lastInsertRowid, worker_id: w.id, worker: w.name, type, severity, message, ts, ack: 0 });
}

/** Expected reading: { device_id, lat, lng, helmet: 0|1, hr, fall: bool } */
function ingest(r) {
  const w = db.prepare('SELECT * FROM workers WHERE device_id=?').get(r.device_id);
  if (!w) return null;
  const wasOut = w.lat != null && metres(SITE.lat, SITE.lng, w.lat, w.lng) > SITE.radius;
  const out = metres(SITE.lat, SITE.lng, r.lat, r.lng) > SITE.radius;
  const hot = r.hr > 150;
  // Raise events on state transitions only, to avoid alert floods.
  if (!r.helmet && w.helmet) raise(w, 'helmet', 'warning', `${w.name} removed helmet in ${w.zone}`);
  if (out && !wasOut) raise(w, 'geofence', 'warning', `${w.name} left the site boundary`);
  if (hot && w.hr <= 150) raise(w, 'heat', 'warning', `${w.name} heart rate ${r.hr} bpm (possible heat stress)`);
  if (r.fall) raise(w, 'fall', 'critical', `Fall detected: ${w.name} (${w.zone})`);
  const status = r.fall ? 'critical' : (!r.helmet || out || hot) ? 'warning' : 'safe';
  db.prepare('UPDATE workers SET helmet=?,hr=?,lat=?,lng=?,status=?,updated_at=? WHERE id=?')
    .run(r.helmet ? 1 : 0, r.hr, r.lat, r.lng, status, new Date().toISOString(), w.id);
  return status;
}

function mockReadings() {
  return db.prepare('SELECT device_id,lat,lng FROM workers').all().map(w => {
    const s = (pos[w.device_id] ??= { lat: w.lat, lng: w.lng, helmet: 1 });
    s.lat += (Math.random() - .5) * .0003 + (SITE.lat - s.lat) * .05; // wander, drift back to centre
    s.lng += (Math.random() - .5) * .0003 + (SITE.lng - s.lng) * .05;
    if (Math.random() < .008) { s.lat += .003; }                       // occasional boundary breach
    if (s.helmet && Math.random() < .015) s.helmet = 0;
    else if (!s.helmet && Math.random() < .25) s.helmet = 1;
    return { device_id: w.device_id, lat: s.lat, lng: s.lng, helmet: s.helmet,
             hr: Math.random() < .01 ? 160 : Math.round(68 + Math.random() * 40), fall: Math.random() < .003 };
  });
}

async function readings() {
  if (!process.env.SENSOR_API_URL) return mockReadings();
  const res = await fetch(process.env.SENSOR_API_URL, { headers: { Authorization: 'Bearer ' + (process.env.SENSOR_API_KEY || '') } });
  return res.json(); // must return an array of readings in the shape above
}

function start(ms = 3000) {
  setInterval(async () => {
    try {
      (await readings()).forEach(ingest);
      broadcast('workers', db.prepare('SELECT * FROM workers').all());
    } catch (e) { console.error('sensor tick failed:', e.message); }
  }, ms);
}
module.exports = { start, ingest, clients, SITE };
