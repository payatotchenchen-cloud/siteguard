// SQLite schema + first-run seed data (uses Node's built-in SQLite).
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const db = new DatabaseSync(process.env.DB_FILE || 'smartsite.db');
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, role TEXT DEFAULT 'supervisor');
CREATE TABLE IF NOT EXISTS workers(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT, zone TEXT, phone TEXT,
  device_id TEXT UNIQUE, helmet INTEGER DEFAULT 1, hr INTEGER DEFAULT 75,
  lat REAL, lng REAL, status TEXT DEFAULT 'safe', updated_at TEXT);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE,
  type TEXT NOT NULL, severity TEXT NOT NULL, message TEXT, ts TEXT NOT NULL, ack INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, name TEXT, zone TEXT, planned INTEGER, done INTEGER);
CREATE TABLE IF NOT EXISTS equipment_logs(id INTEGER PRIMARY KEY, equipment TEXT, active_h REAL, idle_h REAL, day TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
`);

if (!db.prepare('SELECT COUNT(*) n FROM users').get().n) {
  // Default login: admin / admin123 -- change immediately outside of local dev.
  db.prepare('INSERT INTO users(username,hash,role) VALUES(?,?,?)')
    .run('admin', bcrypt.hashSync('papasok123', 10), 'admin');

  const w = db.prepare('INSERT INTO workers(name,role,zone,phone,device_id,lat,lng,updated_at) VALUES(?,?,?,?,?,?,?,?)');
  [['Ramon Dela Cruz','Foreman','Zone A','0917-555-0101'],['Liza Santos','Crane Operator','Zone B','0917-555-0102'],
   ['Marco Reyes','Steelworker','Zone A','0917-555-0103'],['Jun Bautista','Electrician','Zone C','0917-555-0104'],
   ['Angela Cruz','Safety Officer','Zone B','0917-555-0105'],['Paolo Garcia','Mason','Zone C','0917-555-0106']]
    .forEach((r, i) => w.run(...r, 'HLM-00' + (i + 1), 14.6507, 120.9835, new Date().toISOString()));

  const t = db.prepare('INSERT INTO tasks(name,zone,planned,done) VALUES(?,?,?,?)');
  [['Rebar tying','Zone A',40,31],['Formwork','Zone A',25,22],['Crane lifts','Zone B',18,12],
   ['Conduit install','Zone C',30,19],['Masonry','Zone C',35,27],['Inspection','Zone B',10,9]].forEach(r => t.run(...r));

  const e = db.prepare('INSERT INTO equipment_logs(equipment,active_h,idle_h,day) VALUES(?,?,?,?)');
  ['Tower Crane','Excavator','Concrete Mixer','Forklift'].forEach((n, i) => {
    for (let d = 0; d < 7; d++) {
      const day = new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
      const active = +(3 + ((i * 7 + d * 3) % 5) + Math.random()).toFixed(1);
      e.run(n, active, +(10 - active).toFixed(1), day);
    }
  });
}
module.exports = db;