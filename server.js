'use strict';
/*
 * ICO Host — real hosting backend (Node.js, no npm dependencies).
 * Requires on the host: node 18+, and for bots: python3, php, javac/java, unzip.
 * Run:  ADMIN_PASSWORD='strong-pass' node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

const PORT = Number(process.env.PORT) || 3000;
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA, 'db.json');
const DAY = 864e5, MB = 1024 * 1024, GB = 1024 * MB;
const MAX_BODY = 40 * MB;
const LIM = { site: 5 * MB, bot: 20 * MB, img: 2 * MB, avatar: 200 * 1024, files: 300, servers: 20 };
const FREE = { days: 10, gb: 3, ram: 512, cpu: 50 };
const TYPES = ['website', 'bot', 'photo'];
const LANGS = {
  py:   { name: 'Python',     entry: ['main.py', 'bot.py', 'app.py'], ext: '.py' },
  js:   { name: 'JavaScript', entry: ['index.js', 'bot.js', 'main.js'], ext: '.js' },
  php:  { name: 'PHP',        entry: ['index.php'], ext: '.php' },
  java: { name: 'Java',       entry: ['Main.java'], ext: '.java' },
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.pdf': 'application/pdf',
};
const IMG_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const CLK = 100; // kernel clock ticks per second (USER_HZ on Linux)

fs.mkdirSync(path.join(DATA, 'servers'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'images'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'tmp'), { recursive: true });

/* ================= Database (JSON file, atomic writes) ================= */
let db = { users: {}, servers: {}, links: {}, sessions: {}, config: { platformName: 'ICO Host', broadcast: null, adminHash: null } };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch { /* first run */ }

function writeDB() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
let saveTimer = null;
const saveDB = () => { clearTimeout(saveTimer); saveTimer = setTimeout(writeDB, 150); };

/* ================= Helpers ================= */
const now = () => Date.now();
const rnd = n => crypto.randomBytes(n).toString('hex');
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });
const srvDir = id => path.join(DATA, 'servers', id);
const validUser = u => /^[A-Za-z0-9_.-]{3,20}$/.test(u) && u.toLowerCase() !== 'admin';
const validPass = p => p.length >= 4 && !/[\u0600-\u06FF]/.test(p);
const hashPass = (p, salt = rnd(16)) => salt + ':' + crypto.scryptSync(p, salt, 64).toString('hex');
const checkPass = (p, stored) => {
  if (!stored) return false;
  const [salt, h] = stored.split(':');
  const a = crypto.scryptSync(p, salt, 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const mimeOf = f => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

function safeRel(p) {
  if (typeof p !== 'string') return null;
  const parts = p.replace(/\\/g, '/').split('/').filter(x => x && x !== '.');
  if (!parts.length || parts.length > 6 || parts.some(x => x === '..' || x.includes('\0'))) return null;
  return parts.join('/');
}
function inDir(dir, rel) {
  const base = path.resolve(dir);
  const full = path.resolve(base, rel);
  return full.startsWith(base + path.sep) ? full : null;
}
function dirSize(dir) {
  let t = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      t += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch {}
  return t;
}
function listFiles(dir) {
  const out = [];
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (out.length >= LIM.files) return;
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else out.push({ path: rel, size: fs.statSync(path.join(d, e.name)).size });
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}
function firstEntry(dir, lang) {
  const names = listFiles(dir).map(f => f.path);
  const L = LANGS[lang];
  if (!L) return '';
  return L.entry.find(n => names.includes(n)) || names.find(n => n.endsWith(L.ext)) || '';
}
function refreshSize(s) {
  s.size = s.type === 'photo' ? (s.images || []).reduce((t, i) => t + i.size, 0) : dirSize(srvDir(s.id));
}
function logLine(s, type, msg) {
  s.logs ||= [];
  s.logs.push({ t: now(), type, msg: String(msg).slice(0, 500) });
  if (s.logs.length > 300) s.logs.splice(0, s.logs.length - 300);
  saveDB();
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function text(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return reject(httpErr(413, 'الطلب أكبر من الحد المسموح')); }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(httpErr(400, 'بيانات JSON غير صالحة')); }
    });
    req.on('error', reject);
  });
}

/* ================= Accounts & sessions ================= */
const accState = u => !u ? 'deleted' : u.banned ? 'banned' : now() > u.expiresAt ? 'expired' : 'active';
const accServers = name => Object.values(db.servers).filter(s => s.owner === name).sort((a, b) => b.createdAt - a.createdAt);
const usedBytes = name => accServers(name).reduce((t, s) => t + (s.size || 0), 0);
const userView = u => ({
  username: u.username, created: u.created, expiresAt: u.expiresAt, days: u.days, spaceBytes: u.spaceBytes,
  ram: u.ram, cpu: u.cpu, banned: !!u.banned, state: accState(u), used: usedBytes(u.username), servers: accServers(u.username).length,
});
function createUser(name, pw, days, gb, ram, cpu) {
  db.users[name] = { username: name, hash: hashPass(pw), created: now(), days, expiresAt: now() + days * DAY,
    spaceBytes: Math.round(gb * GB), ram, cpu, banned: false };
  saveDB();
}
function newSession(data) {
  const t = rnd(32);
  db.sessions[t] = { ...data, at: now() };
  saveDB();
  return t;
}
function authOf(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const s = token && db.sessions[token];
  return s ? { ...s, token } : null;
}
function deleteUser(name) {
  for (const s of accServers(name)) deleteServerFully(s);
  for (const [c, l] of Object.entries(db.links)) if (l.owner === name) delete db.links[c];
  for (const [t, s] of Object.entries(db.sessions)) if (s.user === name) delete db.sessions[t];
  delete db.users[name];
  saveDB();
}
function purgeExpired() {
  for (const u of Object.values(db.users)) if (accState(u) === 'expired') deleteUser(u.username);
}

/* ================= Sites & images: public state ================= */
function siteState(s) {
  const st = accState(db.users[s.owner]);
  if (st !== 'active') return st;
  return s.status === 'running' ? 'running' : 'stopped';
}
function serverView(s, full = false) {
  const u = db.users[s.owner];
  const v = {
    id: s.id, type: s.type, lang: s.lang || null, name: s.name, siteName: s.siteName || '', entry: s.entry || '',
    owner: s.owner, status: s.status, state: siteState(s), size: s.size || 0, views: s.views || 0, hits: s.hits || 0,
    createdAt: s.createdAt, stats: s.stats || { ram: 0, cpu: 0 }, image: s.image || '',
    limits: u ? { ram: u.ram, cpu: u.cpu, spaceBytes: u.spaceBytes } : null,
    url: s.type === 'website' ? `/s/${s.id}/` : (s.type === 'bot' && s.lang === 'php') ? `/hook/${s.id}/` : null,
    images: (s.images || []).map(i => ({ alias: i.alias, name: i.name, size: i.size, views: i.views || 0, url: `/i/${i.alias}` })),
  };
  if (full) v.logs = (s.logs || []).slice(-200);
  return v;
}
function findImage(alias) {
  for (const s of Object.values(db.servers)) {
    const im = (s.images || []).find(i => i.alias === alias);
    if (im) return { s, im };
  }
  return null;
}

/* ================= Processes (real bots) ================= */
const procs = new Map(); // serverId -> { child, port, lastTicks, lastAt, paused, stopping }
let portCursor = 20000;
const nextPort = () => (portCursor = portCursor >= 29999 ? 20000 : portCursor + 1);

function buildCommand(s) {
  const u = db.users[s.owner];
  const q = x => "'" + String(x).replace(/'/g, "'\\''") + "'";
  const guard = `ulimit -v ${u.ram * 1024} 2>/dev/null; exec nice -n 10 `;
  if (s.lang === 'py') return { cmd: guard + `python3 -u ${q(s.entry)}` };
  if (s.lang === 'js') return { cmd: `exec nice -n 10 node ${q(s.entry)}` }; // node reserves big virtual memory, RAM is enforced by the monitor
  if (s.lang === 'php') { const port = nextPort(); return { port, cmd: guard + `php -S 127.0.0.1:${port} -t .` }; }
  const main = path.basename(s.entry, '.java');
  return { cmd: `rm -rf out && mkdir -p out && javac -d out *.java && exec nice -n 10 java -Xmx${Math.floor(u.ram * 0.7)}m -cp out ${q(main)}` };
}

function startServer(s) {
  if (s.type !== 'bot') { s.status = 'running'; saveDB(); return null; }
  if (procs.has(s.id)) return null;
  if (!s.entry || !fs.existsSync(inDir(srvDir(s.id), s.entry) || '')) return 'لا يوجد ملف رئيسي. ارفع الملفات أولاً';
  const spec = buildCommand(s);
  const dir = srvDir(s.id);
  const child = spawn('/bin/sh', ['-c', spec.cmd], {
    cwd: dir, env: { PATH: process.env.PATH, HOME: dir, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const p = { child, port: spec.port || null, lastTicks: 0, lastAt: 0, paused: false, stopping: false };
  procs.set(s.id, p);
  s.status = 'running';
  s.pid = child.pid;
  logLine(s, 'ok', `تشغيل ${LANGS[s.lang].name} — ${s.entry}`);
  const pipe = (stream, type) => {
    const dec = new StringDecoder('utf8');
    let buf = '';
    stream.on('data', d => {
      buf += dec.write(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { logLine(s, type, buf.slice(0, i)); buf = buf.slice(i + 1); }
      if (buf.length > 4000) { logLine(s, type, buf); buf = ''; }
    });
  };
  pipe(child.stdout, 'info');
  pipe(child.stderr, 'err');
  child.on('exit', (code, signal) => {
    if (procs.get(s.id) === p) procs.delete(s.id);
    s.pid = null;
    if (!p.stopping) s.status = 'stopped';
    logLine(s, 'warn', `توقف البوت (code ${code ?? signal})`);
  });
  child.on('error', e => logLine(s, 'err', e.message));
  saveDB();
  return null;
}

function stopServer(s, silent = false) {
  const p = procs.get(s.id);
  if (p) {
    p.stopping = true;
    procs.delete(s.id);
    try { p.child.kill('SIGCONT'); p.child.kill('SIGTERM'); } catch {}
  }
  s.status = 'stopped';
  s.pid = null;
  if (!silent) logLine(s, 'warn', 'تم الإيقاف');
  saveDB();
}

/* Monitor: real RSS from /proc enforces RAM; CPU above quota is throttled with SIGSTOP/SIGCONT */
function sampleProcs() {
  for (const [sid, p] of procs) {
    const s = db.servers[sid];
    const u = s && db.users[s.owner];
    if (!s || !u) continue;
    let rss = 0, ticks = 0;
    try {
      const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${p.child.pid}/status`, 'utf8'));
      rss = m ? Number(m[1]) / 1024 : 0;
      const f = fs.readFileSync(`/proc/${p.child.pid}/stat`, 'utf8').split(') ')[1].split(' ');
      ticks = Number(f[11]) + Number(f[12]);
    } catch { continue; }
    const t = now();
    const pct = p.lastAt ? ((ticks - p.lastTicks) / CLK) / ((t - p.lastAt) / 1000) * 100 : 0;
    p.lastTicks = ticks;
    p.lastAt = t;
    s.stats = { ram: Math.round(rss), cpu: Math.round(pct) };
    if (rss > u.ram) {
      logLine(s, 'err', `تجاوز حد الرام (${Math.round(rss)} / ${u.ram} MB) فتم إيقاف البوت`);
      stopServer(s, true);
      continue;
    }
    if (pct > u.cpu && !p.paused) {
      p.paused = true;
      try { p.child.kill('SIGSTOP'); } catch {}
      setTimeout(() => { p.paused = false; try { p.child.kill('SIGCONT'); } catch {} }, 1000);
    }
  }
}

function deleteServerFully(s) {
  stopServer(s, true);
  for (const im of s.images || []) fs.rmSync(path.join(DATA, 'images', im.file), { force: true });
  fs.rmSync(srvDir(s.id), { recursive: true, force: true });
  delete db.servers[s.id];
}

/* ================= Zip (uses the system unzip) ================= */
const runCmd = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 60000 }, (e, so, se) => e
    ? reject(httpErr(400, cmd === 'unzip' ? 'unzip غير مثبت على الخادم أو الملف تالف' : (se || e.message)))
    : resolve(so));
});

/* Extracts a zip into a temp folder first, checks the size, then copies over the server folder */
async function extractZip(s, base64) {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length > LIM.bot) throw httpErr(400, 'ملف zip أكبر من 20 ميجابايت');
  const tmpZip = path.join(DATA, 'tmp', rnd(8) + '.zip');
  const tmpOut = path.join(DATA, 'tmp', rnd(8));
  fs.writeFileSync(tmpZip, buf);
  fs.mkdirSync(tmpOut, { recursive: true });
  try {
    await runCmd('unzip', ['-o', '-q', tmpZip, '-d', tmpOut]);
    const size = dirSize(tmpOut);
    const cap = s.type === 'website' ? LIM.site : LIM.bot;
    if (size > cap) throw httpErr(400, 'محتوى zip أكبر من الحد المسموح');
    const used = usedBytes(s.owner) - (s.size || 0) + size;
    if (used > db.users[s.owner].spaceBytes) throw httpErr(400, 'المساحة لا تكفي لهذا الملف');
    fs.cpSync(tmpOut, srvDir(s.id), { recursive: true });
  } finally {
    fs.rmSync(tmpZip, { force: true });
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }
}

/* Checks quota before writing a text file */
function checkWrite(s, u, rel, newSize) {
  const full = inDir(srvDir(s.id), rel);
  const old = full && fs.existsSync(full) ? fs.statSync(full).size : 0;
  const total = dirSize(srvDir(s.id)) - old + newSize;
  const cap = s.type === 'website' ? LIM.site : LIM.bot;
  if (total > cap) throw httpErr(400, 'حجم السيرفر أكبر من الحد المسموح');
  if (usedBytes(u.username) - (s.size || 0) + total > u.spaceBytes) throw httpErr(400, 'المساحة لا تكفي');
  if (!full) throw httpErr(400, 'مسار غير صالح');
  if (!fs.existsSync(full) && listFiles(srvDir(s.id)).length >= LIM.files) throw httpErr(400, 'عدد الملفات تجاوز الحد');
  return full;
}

/* ================= Public routes: sites, images, webhooks, short links ================= */
function serveSite(req, res, url) {
  const x = url.pathname.match(/^\/s\/(\w+)(\/.*)?$/);
  const s = x && db.servers[x[1]];
  if (!s || s.type !== 'website' || siteState(s) !== 'running') return text(res, 404, 'الموقع غير متاح');
  const raw = x[2] || '/';
  const rel = raw === '/' ? '' : safeRel(decodeURIComponent(raw));
  if (rel === null) return text(res, 400, 'مسار غير صالح');
  const dir = srvDir(s.id);
  let full = rel ? inDir(dir, rel) : path.join(dir, 'index.html');
  if (full && fs.existsSync(full) && fs.statSync(full).isDirectory()) full = path.join(full, 'index.html');
  if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return text(res, 404, 'الملف غير موجود');
  if (!rel) { s.views = (s.views || 0) + 1; saveDB(); }
  res.writeHead(200, {
    'Content-Type': mimeOf(full),
    // Sandboxed origin: the hosted page cannot read the platform's localStorage or API token
    'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(full).pipe(res);
}

function serveImage(req, res, url) {
  const alias = url.pathname.slice(3);
  const f = findImage(alias);
  if (!f || accState(db.users[f.s.owner]) !== 'active') return text(res, 404, 'الصورة غير موجودة');
  const full = path.join(DATA, 'images', f.im.file);
  if (!fs.existsSync(full)) return text(res, 404, 'الصورة غير موجودة');
  f.im.views = (f.im.views || 0) + 1;
  saveDB();
  res.writeHead(200, { 'Content-Type': mimeOf(full), 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(full).pipe(res);
}

/* PHP webhook: forwards the request to the PHP built-in server running this bot */
function proxyHook(req, res, url) {
  const x = url.pathname.match(/^\/hook\/(\w+)(\/.*)?$/);
  const s = x && db.servers[x[1]];
  if (!s || s.type !== 'bot' || s.lang !== 'php') return text(res, 404, 'غير موجود');
  const p = procs.get(s.id);
  if (!p || !p.port || siteState(s) !== 'running') return text(res, 503, 'البوت متوقف');
  s.hits = (s.hits || 0) + 1;
  logLine(s, 'info', `${req.method} ${url.pathname}`);
  const up = require('http').request({
    host: '127.0.0.1', port: p.port, path: (x[2] || '/') + url.search, method: req.method,
    headers: { ...req.headers, host: '127.0.0.1:' + p.port },
  }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { if (!res.headersSent) text(res, 502, 'البوت لا يستجيب'); });
  req.pipe(up);
}

function redirectShort(res, url) {
  const code = url.pathname.slice(3);
  const l = db.links[code];
  if (!l) return text(res, 404, 'الرابط غير موجود');
  l.clicks = (l.clicks || 0) + 1;
  saveDB();
  res.writeHead(302, { Location: l.url });
  res.end();
}

function serveStatic(res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return text(res, 400, 'bad request'); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(PUBLIC, path.normalize(rel));
  if (!full.startsWith(PUBLIC)) return text(res, 403, 'forbidden');
  fs.readFile(full, (err, data) => {
    if (err) return text(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': mimeOf(full), 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}

/* ================= API ================= */
async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname.slice(4).replace(/\/+$/, '') || '/';
  const b = await readBody(req);

  if (m === 'GET' && p === '/public') return send(res, 200, { platformName: db.config.platformName, broadcast: db.config.broadcast });

  if (m === 'POST' && p === '/register') {
    const u = String(b.username || '').trim(), pw = String(b.password || '');
    if (!validUser(u)) return send(res, 400, { error: 'اليوزر: من 3 إلى 20 حرفاً إنجليزياً أو أرقام أو _ . -' });
    if (!validPass(pw)) return send(res, 400, { error: 'كلمة المرور 4 أحرف على الأقل وبدون عربي' });
    if (db.users[u]) return send(res, 409, { error: 'اليوزر موجود بالفعل' });
    createUser(u, pw, FREE.days, FREE.gb, FREE.ram, FREE.cpu);
    return send(res, 200, { token: newSession({ user: u }), admin: false });
  }
  if (m === 'POST' && p === '/login') {
    const u = db.users[String(b.username || '').trim()];
    if (!u || !checkPass(String(b.password || ''), u.hash)) return send(res, 401, { error: 'بيانات الدخول غير صحيحة' });
    if (accState(u) !== 'active') return send(res, 403, { error: accState(u) === 'banned' ? 'هذا الحساب محظور' : 'انتهت مدة الحساب' });
    return send(res, 200, { token: newSession({ user: u.username }), admin: false });
  }
  if (m === 'POST' && p === '/admin/login') {
    if (!checkPass(String(b.password || ''), db.config.adminHash)) return send(res, 401, { error: 'كلمة مرور الأدمن غير صحيحة' });
    return send(res, 200, { token: newSession({ admin: true }), admin: true });
  }

  const sess = authOf(req);
  if (!sess) return send(res, 401, { error: 'سجل الدخول أولاً' });
  if (p.startsWith('/admin')) {
    if (!sess.admin) return send(res, 403, { error: 'هذه الصفحة للأدمن فقط' });
    return adminApi(res, m, p.slice(6) || '/', b);
  }

  const u = db.users[sess.user];
  if (!u || accState(u) !== 'active') {
    delete db.sessions[sess.token]; saveDB();
    return send(res, 403, { error: !u ? 'الحساب غير موجود' : accState(u) === 'banned' ? 'تم حظر حسابك' : 'انتهت مدة حسابك' });
  }
  return userApi(req, res, m, p, b, u, url);
}

async function userApi(req, res, m, p, b, u, url) {
  if (m === 'GET' && p === '/me') return send(res, 200, userView(u));
  if (m === 'POST' && p === '/logout') { delete db.sessions[authOf(req).token]; saveDB(); return send(res, 200, { ok: true }); }
  if (m === 'GET' && p === '/servers') return send(res, 200, accServers(u.username).map(s => serverView(s)));
  if (m === 'POST' && p === '/servers') return createServer(res, u, b);

  if (m === 'GET' && p === '/links') {
    return send(res, 200, Object.entries(db.links).filter(([, l]) => l.owner === u.username)
      .map(([c, l]) => ({ code: c, short: `/r/${c}`, target: l.url, clicks: l.clicks || 0, at: l.at })));
  }
  if (m === 'POST' && p === '/links') {
    let href;
    try { const x = new URL(String(b.url || '')); if (!['http:', 'https:'].includes(x.protocol)) throw 0; href = x.href; }
    catch { return send(res, 400, { error: 'اكتب رابطاً صحيحاً يبدأ بـ http أو https' }); }
    let code = String(b.alias || '').trim();
    if (code) {
      if (!/^[A-Za-z0-9_-]{3,30}$/.test(code) || db.links[code]) return send(res, 400, { error: 'الاسم المخصص غير صالح أو مستخدم' });
    } else { do code = rnd(3); while (db.links[code]); }
    db.links[code] = { url: href, owner: u.username, clicks: 0, at: now() };
    saveDB();
    return send(res, 200, { code, short: `/r/${code}` });
  }
  let x = p.match(/^\/links\/(\w[\w-]*)$/);
  if (x && m === 'DELETE') {
    const l = db.links[x[1]];
    if (!l || l.owner !== u.username) return send(res, 404, { error: 'الرابط غير موجود' });
    delete db.links[x[1]]; saveDB();
    return send(res, 200, { ok: true });
  }

  x = p.match(/^\/servers\/(\w+)(\/.*)?$/);
  if (x) {
    const s = db.servers[x[1]];
    if (!s || s.owner !== u.username) return send(res, 404, { error: 'السيرفر غير موجود' });
    return serverApi(res, m, x[2] || '', b, s, u, url);
  }
  send(res, 404, { error: 'غير موجود' });
}

function createServer(res, u, b) {
  const type = b.type;
  const name = String(b.name || '').trim().slice(0, 40);
  if (!TYPES.includes(type)) return send(res, 400, { error: 'نوع السيرفر غير صالح' });
  if (!name) return send(res, 400, { error: 'اكتب اسم السيرفر' });
  const lang = type === 'bot' ? String(b.lang || '') : null;
  if (type === 'bot' && !LANGS[lang]) return send(res, 400, { error: 'اختر لغة صالحة للبوت' });
  if (accServers(u.username).length >= LIM.servers) return send(res, 400, { error: `الحد الأقصى ${LIM.servers} سيرفر` });
  const sid = 's' + rnd(8);
  const s = {
    id: sid, type, lang, name, siteName: type === 'website' ? (String(b.siteName || '').trim().slice(0, 60) || name) : '',
    owner: u.username, status: type === 'bot' ? 'stopped' : 'running', size: 0, views: 0, hits: 0, daily: {},
    logs: [], images: [], entry: type === 'website' ? 'index.html' : '', createdAt: now(), image: '',
  };
  fs.mkdirSync(srvDir(sid), { recursive: true });
  if (type === 'website') fs.writeFileSync(path.join(srvDir(sid), 'index.html'), '<!doctype html><meta charset="utf-8"><title>موقعي</title><h1>ارفع ملفات موقعك من لوحة السيرفر</h1>');
  db.servers[sid] = s;
  logLine(s, 'ok', 'تم إنشاء السيرفر');
  refreshSize(s);
  saveDB();
  send(res, 200, serverView(s, true));
}

async function serverApi(res, m, sub, b, s, u, url) {
  const dir = srvDir(s.id);

  if (m === 'GET' && sub === '') return send(res, 200, serverView(s, true));
  if (m === 'DELETE' && sub === '') { deleteServerFully(s); saveDB(); return send(res, 200, { ok: true }); }

  if (m === 'PATCH' && sub === '') {
    if (b.name !== undefined) {
      const n = String(b.name).trim().slice(0, 40);
      if (!n) return send(res, 400, { error: 'اسم السيرفر مطلوب' });
      s.name = n;
    }
    if (b.siteName !== undefined && s.type === 'website') s.siteName = String(b.siteName).trim().slice(0, 60) || s.name;
    if (b.entry !== undefined && s.type === 'bot') {
      const rel = safeRel(b.entry);
      const full = rel && inDir(dir, rel);
      if (!full || !fs.existsSync(full)) return send(res, 400, { error: 'الملف غير موجود' });
      s.entry = rel;
    }
    if (b.image !== undefined) {
      const img = String(b.image || '');
      if (img && (!/^data:image\/(png|jpeg|gif|webp);base64,/.test(img) || img.length > LIM.avatar * 1.4)) return send(res, 400, { error: 'الصورة غير صالحة أو أكبر من 200KB' });
      s.image = img;
    }
    logLine(s, 'info', 'تم تحديث الإعدادات');
    return send(res, 200, serverView(s, true));
  }

  if (m === 'POST' && sub === '/power') {
    if (s.type !== 'bot') return send(res, 400, { error: 'هذا النوع يعمل تلقائياً' });
    if (b.on) {
      const err = startServer(s);
      if (err) return send(res, 400, { error: err });
    } else stopServer(s);
    return send(res, 200, serverView(s, true));
  }

  if (s.type === 'photo') {
    if (m === 'POST' && sub === '/images') {
      const mt = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(b.data || ''));
      if (!mt) return send(res, 400, { error: 'صيغة الصورة غير صالحة' });
      const buf = Buffer.from(mt[2], 'base64');
      if (buf.length > LIM.img) return send(res, 400, { error: 'الصورة أكبر من 2 ميجابايت' });
      if (usedBytes(u.username) - (s.size || 0) + buf.length > u.spaceBytes) return send(res, 400, { error: 'المساحة لا تكفي' });
      let alias = String(b.alias || '').trim();
      if (alias && (!/^[A-Za-z0-9_-]{3,30}$/.test(alias) || findImage(alias))) return send(res, 400, { error: 'الرابط المخصص غير صالح أو مستخدم' });
      if (!alias) do alias = rnd(4); while (findImage(alias));
      const file = alias + IMG_EXT[mt[1]];
      fs.writeFileSync(path.join(DATA, 'images', file), buf);
      s.images.push({ alias, file, name: String(b.name || 'image').slice(0, 80), size: buf.length, at: now(), views: 0 });
      refreshSize(s);
      logLine(s, 'ok', `تم رفع صورة: ${alias}`);
      return send(res, 200, serverView(s, true));
    }
    const x = sub.match(/^\/images\/(\w[\w-]*)$/);
    if (m === 'DELETE' && x) {
      const i = s.images.findIndex(im => im.alias === x[1]);
      if (i < 0) return send(res, 404, { error: 'الصورة غير موجودة' });
      fs.rmSync(path.join(DATA, 'images', s.images[i].file), { force: true });
      s.images.splice(i, 1);
      refreshSize(s);
      logLine(s, 'warn', `تم حذف صورة: ${x[1]}`);
      return send(res, 200, serverView(s, true));
    }
    return send(res, 404, { error: 'غير موجود' });
  }

  /* website & bot: file management */
  if (m === 'GET' && sub === '/files') return send(res, 200, { files: listFiles(dir) });

  if (m === 'GET' && sub === '/file') {
    const rel = safeRel(url.searchParams.get('path'));
    const full = rel && inDir(dir, rel);
    if (!full || !fs.existsSync(full)) return send(res, 404, { error: 'الملف غير موجود' });
    if (fs.statSync(full).size > MB) return send(res, 400, { error: 'الملف أكبر من 1 ميجابايت للتعديل' });
    return send(res, 200, { path: rel, text: fs.readFileSync(full, 'utf8') });
  }

  if (m === 'POST' && sub === '/file') {
    const rel = safeRel(b.path);
    if (!rel) return send(res, 400, { error: 'اسم الملف غير صالح' });
    const content = String(b.text ?? '');
    const full = checkWrite(s, u, rel, Buffer.byteLength(content));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    refreshSize(s);
    if (s.type === 'bot' && !s.entry) s.entry = firstEntry(dir, s.lang);
    logLine(s, 'ok', `تم حفظ ${rel}`);
    return send(res, 200, serverView(s, true));
  }

  if (m === 'DELETE' && sub === '/file') {
    const rel = safeRel(url.searchParams.get('path'));
    const full = rel && inDir(dir, rel);
    if (!full || !fs.existsSync(full)) return send(res, 404, { error: 'الملف غير موجود' });
    fs.rmSync(full, { force: true });
    refreshSize(s);
    if (s.type === 'bot' && s.entry === rel) s.entry = firstEntry(dir, s.lang);
    logLine(s, 'warn', `تم حذف ${rel}`);
    return send(res, 200, serverView(s, true));
  }

  if (m === 'POST' && sub === '/zip') {
    await extractZip(s, String(b.data || ''));
    refreshSize(s);
    if (s.type === 'bot' && (!s.entry || !fs.existsSync(path.join(dir, s.entry)))) s.entry = firstEntry(dir, s.lang);
    if (s.type === 'website' && !fs.existsSync(path.join(dir, 'index.html'))) logLine(s, 'warn', 'لم يتم العثور على index.html في الأرشيف');
    logLine(s, 'ok', 'تم فك ضغط الأرشيف');
    return send(res, 200, serverView(s, true));
  }

  send(res, 404, { error: 'غير موجود' });
}

function adminApi(res, m, p, b) {
  if (m === 'GET' && p === '/stats') {
    const users = Object.values(db.users), srvs = Object.values(db.servers);
    const today = new Date().toISOString().slice(0, 10);
    return send(res, 200, {
      users: users.length,
      activeUsers: users.filter(u => accState(u) === 'active').length,
      bannedUsers: users.filter(u => u.banned).length,
      newToday: users.filter(u => new Date(u.created).toISOString().slice(0, 10) === today).length,
      servers: srvs.length,
      running: srvs.filter(s => s.status === 'running').length,
      byType: { website: srvs.filter(s => s.type === 'website').length, bot: srvs.filter(s => s.type === 'bot').length, photo: srvs.filter(s => s.type === 'photo').length },
      storage: srvs.reduce((t, s) => t + (s.size || 0), 0),
      views: srvs.reduce((t, s) => t + (s.views || 0), 0),
      allocRam: users.reduce((t, u) => t + u.ram, 0),
      allocCpu: users.reduce((t, u) => t + u.cpu, 0),
      processes: procs.size,
    });
  }

  if (m === 'GET' && p === '/users') return send(res, 200, Object.values(db.users).map(userView));

  if (m === 'POST' && p === '/users') {
    const name = String(b.username || '').trim(), pw = String(b.password || '');
    const days = Math.floor(Number(b.days)), gb = Number(b.gb), ram = Math.floor(Number(b.ram)), cpu = Math.floor(Number(b.cpu));
    if (!validUser(name)) return send(res, 400, { error: 'اليوزر: 3 إلى 20 حرفاً إنجليزياً أو أرقام أو _ . -' });
    if (!validPass(pw)) return send(res, 400, { error: 'كلمة المرور 4 أحرف على الأقل وبدون عربي' });
    if (!(days >= 1 && days <= 3650)) return send(res, 400, { error: 'الأيام بين 1 و 3650' });
    if (!(gb >= 0.1 && gb <= 1000)) return send(res, 400, { error: 'المساحة بين 0.1 و 1000 جيجا' });
    if (!(ram >= 64 && ram <= 16384)) return send(res, 400, { error: 'الرام بين 64 و 16384 MB' });
    if (!(cpu >= 5 && cpu <= 100)) return send(res, 400, { error: 'المعالج بين 5% و 100%' });
    if (db.users[name]) return send(res, 409, { error: 'اليوزر موجود بالفعل' });
    createUser(name, pw, days, gb, ram, cpu);
    return send(res, 200, userView(db.users[name]));
  }

  let x = p.match(/^\/users\/([\w.-]+)$/);
  if (x) {
    const u = db.users[x[1]];
    if (!u) return send(res, 404, { error: 'الحساب غير موجود' });
    if (m === 'DELETE') { deleteUser(u.username); return send(res, 200, { ok: true }); }
    if (m === 'PATCH') {
      if (b.ram !== undefined) { const v = Math.floor(Number(b.ram)); if (!(v >= 64 && v <= 16384)) return send(res, 400, { error: 'الرام بين 64 و 16384' }); u.ram = v; }
      if (b.cpu !== undefined) { const v = Math.floor(Number(b.cpu)); if (!(v >= 5 && v <= 100)) return send(res, 400, { error: 'المعالج بين 5 و 100' }); u.cpu = v; }
      if (b.days !== undefined) {
        const d = Math.floor(Number(b.days));
        if (!(d >= 1 && d <= 3650)) return send(res, 400, { error: 'الأيام بين 1 و 3650' });
        u.expiresAt = Math.max(now(), u.expiresAt) + d * DAY;
      }
      if (b.banned !== undefined) u.banned = !!b.banned;
      if (b.password) { if (!validPass(String(b.password))) return send(res, 400, { error: 'كلمة المرور غير صالحة' }); u.hash = hashPass(String(b.password)); }
      saveDB();
      return send(res, 200, userView(u));
    }
  }

  if (m === 'GET' && p === '/servers') return send(res, 200, Object.values(db.servers).sort((a, b) => b.createdAt - a.createdAt).map(s => serverView(s)));

  x = p.match(/^\/servers\/(\w+)(\/power)?$/);
  if (x) {
    const s = db.servers[x[1]];
    if (!s) return send(res, 404, { error: 'السيرفر غير موجود' });
    if (m === 'DELETE' && !x[2]) { deleteServerFully(s); saveDB(); return send(res, 200, { ok: true }); }
    if (m === 'POST' && x[2]) {
      if (s.type === 'bot') { if (b.on) { const e = startServer(s); if (e) return send(res, 400, { error: e }); } else stopServer(s); }
      return send(res, 200, serverView(s));
    }
  }

  if (m === 'PATCH' && p === '/config') {
    if (b.platformName !== undefined) {
      const n = String(b.platformName).trim().slice(0, 30);
      if (!n) return send(res, 400, { error: 'اسم المنصة مطلوب' });
      db.config.platformName = n;
    }
    if (b.adminPassword) {
      if (String(b.adminPassword).length < 6) return send(res, 400, { error: 'كلمة مرور الأدمن 6 أحرف على الأقل' });
      db.config.adminHash = hashPass(String(b.adminPassword));
    }
    if (b.broadcast !== undefined) {
      const t = String(b.broadcast || '').trim();
      db.config.broadcast = t ? { id: now(), text: t.slice(0, 300) } : null;
    }
    saveDB();
    return send(res, 200, { platformName: db.config.platformName, broadcast: db.config.broadcast });
  }

  send(res, 404, { error: 'غير موجود' });
}

/* ================= Router ================= */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    const pn = url.pathname;
    if (pn.startsWith('/api/')) return await api(req, res, url);
    if (pn.startsWith('/s/')) return serveSite(req, res, url);
    if (pn.startsWith('/i/')) return serveImage(req, res, url);
    if (pn.startsWith('/hook/')) return proxyHook(req, res, url);
    if (pn.startsWith('/r/')) return redirectShort(res, url);
    return serveStatic(res, pn);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : 'خطأ داخلي في الخادم' });
  }
});

/* ================= Boot ================= */
function checkTools() {
  for (const t of ['python3', 'node', 'php', 'javac', 'java', 'unzip']) {
    try { execFileSync('/bin/sh', ['-c', `command -v ${t}`], { stdio: 'ignore' }); }
    catch { console.warn(`[تحذير] الأداة غير مثبتة: ${t} (البوتات المرتبطة بها لن تعمل)`); }
  }
}

// Admin password hash (scrypt, salted). The plaintext password is NOT stored anywhere in this code.
const DEFAULT_ADMIN_HASH = 'a3f1c9e2d7b04866f5e1a92c3d8b7074:7988ef2717176c6f4a533961b15941ad47575eb1bf520488d0646b3f26018bb687b1f2e09a11f5855ef73e45757d25f2c779ba935446bdd0e147269625300391';
if (process.env.ADMIN_PASSWORD) {
  // Optional override: if set, it replaces the stored admin password on every start
  if (!checkPass(process.env.ADMIN_PASSWORD, db.config.adminHash)) {
    db.config.adminHash = hashPass(process.env.ADMIN_PASSWORD);
    saveDB();
    console.log('[admin] تم تطبيق كلمة مرور الأدمن من ADMIN_PASSWORD');
  }
} else if (!db.config.adminHash) {
  db.config.adminHash = DEFAULT_ADMIN_HASH;
  saveDB();
}
for (const s of Object.values(db.servers)) if (s.type === 'bot' && s.status === 'running') s.status = 'stopped';
checkTools();
setInterval(sampleProcs, 1000);
setInterval(purgeExpired, 60000);

process.on('SIGINT', () => { for (const p of procs.values()) { try { p.child.kill('SIGTERM'); } catch {} } writeDB(); process.exit(0); });
process.on('SIGTERM', () => { for (const p of procs.values()) { try { p.child.kill('SIGTERM'); } catch {} } writeDB(); process.exit(0); });

server.listen(PORT, () => console.log(`ICO Host running on http://localhost:${PORT}`));
