#!/usr/bin/env node
/**
 * AIFACE-MARS local attendance server (ESSL / ZKTeco "ADMS" push protocol)
 * Zero dependencies. Run:  node server.js      (default port 8080)
 *
 * Device setup: Menu > COMM > Cloud Server Setting (ADMS)
 *   Server Address = this PC's LAN IP     Server Port = 8080
 *   Enable Domain Name = OFF              Enable Proxy = OFF
 * Then reboot the device. It will connect and push logs in real time.
 */
'use strict';

// The terminals send naive local timestamps in Indian time, so the process is
// pinned to the same zone. Without this a UTC host (Render) groups punches
// into the wrong day between 00:00 and 05:30 IST. Override with APP_TZ.
process.env.TZ = process.env.APP_TZ || 'Asia/Kolkata';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = path.join(__dirname, 'data');
const ATT_FILE = path.join(DATA_DIR, 'attlog.jsonl');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const DEV_FILE = path.join(DATA_DIR, 'devices.json');
const SET_FILE = path.join(DATA_DIR, 'settings.json');
const snList = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
// The terminals stamp punches with their own clock, which is rarely Indian
// time: one left on UTC is 330 min behind, one set to GMT+5:00 is 30 min
// behind. Shift on ingest so everything downstream (day grouping, filters,
// exports) works in Indian time. Set DEVICE_OFFSET_MIN to pin it by hand.
const FORCED_OFFSET = process.env.DEVICE_OFFSET_MIN === undefined
  ? null : Number(process.env.DEVICE_OFFSET_MIN);
// A live punch arrives as its own tiny push; anything bigger is a backlog dump.
const LIVE_BATCH_ROWS = 3;
const MAX_OFFSET_MIN = 14 * 60;   // beyond any real timezone, so: a stale dump

// The gap between a punch's stamp and its arrival is the terminal's clock error
// at that moment - but only for a punch pushed live. Clock and timezone
// mistakes always land on a quarter hour, so round the gap to the nearest
// 15 min and take it only when what is left over is plausible upload latency;
// a backlog row is stale by an arbitrary amount and yields nothing.
function liveOffset(devTime, at) {
  const parsed = Date.parse(String(devTime).replace(' ', 'T'));
  if (!parsed) return null;
  const gap = (at - parsed) / 60000;
  const off = Math.round(gap / 15) * 15;
  if (Math.abs(gap - off) > 5 || Math.abs(off) > MAX_OFFSET_MIN) return null;
  return off;
}

// Backlog dumps arrive many rows at a time and would poison the measurement,
// so only live-sized batches are measured; a dump reuses whatever the device
// last reported.
function detectClockOffset(sn, devTime, rows) {
  if (FORCED_OFFSET !== null) return FORCED_OFFSET;
  const d = state.devices[sn];
  const known = (d && d.clockOffset) || 0;
  if (!d || rows > LIVE_BATCH_ROWS) return known;
  const off = liveOffset(devTime, Date.now());
  if (off === null) return known;
  if (off === known) return known;
  d.clockOffset = off;
  trace('info', sn, 'clock offset now ' + off + ' min (was ' + known + ')');
  restampDevice(sn);
  saveSoon();
  return off;
}

// A stored time is only the device stamp plus the clock error, so punches
// recorded under a wrong offset can be re-derived instead of staying wrong
// forever. Each one is re-derived from its own arrival gap rather than from the
// offset measured now, so that a terminal whose clock is genuinely re-set does
// not drag older, correctly stamped history along with it. Punches with no
// devTime, or that came in a backlog dump, carry no such evidence and are left
// exactly as they are.
function restampDevice(sn) {
  let changed = 0;
  for (const r of state.logs) {
    if (r.sn !== sn || !r.devTime || !r.recv) continue;
    const off = liveOffset(r.devTime, r.recv);
    if (off === null) continue;
    const t = shiftStamp(r.devTime, off);
    if (t !== r.time) { r.time = t; changed++; }
  }
  if (!changed) return;
  rewriteAttlog(sn);
  trace('info', sn, 'restamped ' + changed + ' past punch(es)');
}

// Times are the dedupe key, so the key set is rebuilt with the file.
function rewriteAttlog(sn) {
  seen.clear();
  for (const r of state.logs) seen.add(punchKey(r));
  try {
    fs.writeFileSync(ATT_FILE, state.logs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  } catch (e) { trace('err', sn || '-', 'attlog rewrite: ' + e.message); }
}

// Punches recorded before the device stamp was kept alongside the corrected one
// hold the raw terminal stamp in `time` - unshifted, so hours away from Indian
// time whenever the terminal's own clock was not set to it. When they arrived
// is still on record, so the measurement used for a live punch recovers them:
// adopt the stamp as devTime and re-derive the time from the arrival gap.
// Anything that cannot be measured keeps the stamp it was found with.
function backfillDevTime() {
  let changed = 0;
  let filled = 0;
  for (const r of state.logs) {
    if (r.devTime || !r.recv) continue;
    r.devTime = r.time;
    filled++;
    const off = liveOffset(r.devTime, r.recv);
    if (off === null) continue;
    const t = shiftStamp(r.devTime, off);
    if (t !== r.time) { r.time = t; changed++; }
  }
  if (filled) trace('info', '-', 'recovered device stamps for ' + filled + ' old punch(es), '
    + changed + ' corrected to Indian time');
  return filled;
}

// History written before PINs were normalised still carries the padded
// spelling, which reads as a second, nameless employee. Fold it onto the
// canonical PIN, and merge the two user records if both somehow exist.
function normalisePins() {
  let punches = 0;
  for (const r of state.logs) {
    const pin = normPin(r.pin);
    if (pin !== r.pin) { r.pin = pin; punches++; }
  }
  let users = 0;
  for (const key of Object.keys(state.users)) {
    const pin = normPin(key);
    if (pin === key) continue;
    const from = state.users[key];
    delete state.users[key];
    users++;
    const to = state.users[pin];
    if (!to) { from.pin = pin; state.users[pin] = from; continue; }
    // whichever record actually carries the detail wins, field by field
    to.name = to.name || from.name || '';
    to.card = to.card || from.card || '';
    to.privilege = to.privilege || from.privilege;
    to.bio = to.bio || from.bio;
  }
  if (users) saveSoon();
  if (punches || users) trace('info', '-', 'folded ' + punches + ' punch(es) and '
    + users + ' user record(s) onto their unpadded PIN');
  return punches;
}

// Both migrations rewrite the same file, so they run together and it is
// written once.
function migrate() {
  const touched = normalisePins() + backfillDevTime();
  if (touched) rewriteAttlog();
}

function punchKey(r) {
  return r.sn + '|' + r.pin + '|' + r.time + '|' + r.status;
}

// The terminals are inconsistent about leading zeros: the same enrolment
// arrives as PIN 2 in a user record and 002 in a punch. Left alone that is two
// employees - one of them nameless - splitting a person's day between them.
// Strip the padding so both spellings land on the same person. Non-numeric
// PINs are left exactly as the device sent them.
function normPin(p) {
  const v = String(p == null ? '' : p).trim();
  return /^\d+$/.test(v) ? v.replace(/^0+(?=\d)/, '') : v;
}

function shiftStamp(t, mins) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(t || '');
  if (!m || !mins) return t;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  d.setUTCMinutes(d.getUTCMinutes() + mins);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

const ROLE_IN = snList(process.env.IN_SN);
const ROLE_OUT = snList(process.env.OUT_SN);

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------------------------------------------ state */

const state = {
  devices: {},   // sn -> device record
  users: {},     // pin -> user record
  logs: [],      // attendance punches
  queue: {},     // sn -> pending command objects
  events: [],    // raw protocol trace
  // allowIps: HR API allow-list, empty = denied. faceOnly: attendance counts
  // face-verified punches only. dwellSec: gate re-tap window, see below.
  settings: { allowIps: [], faceOnly: undefined, dwellSec: undefined, doorPin: '' },
};
const seen = new Set();          // dedupe key for punches
let cmdSeq = Date.now() % 100000;

function loadState() {
  try {
    for (const line of fs.readFileSync(ATT_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      state.logs.push(r);
      seen.add(punchKey(r));
    }
  } catch (e) { /* first run */ }
  try { state.users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) {}
  try { Object.assign(state.settings, JSON.parse(fs.readFileSync(SET_FILE, 'utf8'))); } catch (e) {}
  try {
    state.devices = JSON.parse(fs.readFileSync(DEV_FILE, 'utf8'));
    for (const sn of Object.keys(state.devices)) {
      const d = state.devices[sn];
      d.online = false;
      if (ROLE_IN.includes(sn)) d.role = 'in';
      else if (ROLE_OUT.includes(sn)) d.role = 'out';
      // the old parser stuffed the whole comma-separated INFO line into one
      // key; re-split it so Firmware / Faces / Users / Logs resolve
      for (const [k, v] of Object.entries(d.info || {})) {
        if (typeof v === 'string' && v.includes('=') && v.includes(',')) {
          delete d.info[k];
          for (const part of (k + '=' + v).split(',')) {
            const i = part.indexOf('=');
            if (i > 0) d.info[part.slice(0, i).trim().replace(/^~/, '')] = part.slice(i + 1).trim();
          }
        }
      }
    }
  } catch (e) {}
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(USERS_FILE, JSON.stringify(state.users, null, 2));
      fs.writeFileSync(DEV_FILE, JSON.stringify(state.devices, null, 2));
      fs.writeFileSync(SET_FILE, JSON.stringify(state.settings, null, 2));
    } catch (e) { console.error('save failed', e.message); }
  }, 800);
}

function trace(kind, sn, msg) {
  state.events.push({ t: Date.now(), kind, sn: sn || '-', msg: String(msg).slice(0, 400) });
  if (state.events.length > 400) state.events.splice(0, state.events.length - 400);
  const tag = kind === 'err' ? '!!' : kind === 'dev' ? '<<' : kind === 'srv' ? '>>' : '..';
  const n = new Date(), p2 = (x) => String(x).padStart(2, '0');
  console.log(p2(n.getHours()) + ':' + p2(n.getMinutes()) + ':' + p2(n.getSeconds()),
    tag, (sn || '-'), String(msg).slice(0, 200));
}

/* ----------------------------------------------------------- device model */

function touchDevice(sn, req) {
  if (!sn) return null;
  let d = state.devices[sn];
  if (!d) {
    d = state.devices[sn] = {
      sn, name: '', ip: '', firstSeen: Date.now(), lastSeen: 0,
      pushCount: 0, info: {}, stamp: '9999', opStamp: '9999', online: false,
      role: ROLE_IN.includes(sn) ? 'in' : (ROLE_OUT.includes(sn) ? 'out' : ''),
    };
    trace('info', sn, 'new device registered');
  }
  d.lastSeen = Date.now();
  d.online = true;
  if (req) {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (ip) d.ip = ip;
  }
  saveSoon();
  return d;
}

setInterval(() => {
  const now = Date.now();
  for (const d of Object.values(state.devices)) {
    if (d.online && now - d.lastSeen > 90000) {
      d.online = false;
      trace('info', d.sn, 'went offline (no poll for 90s)');
    }
  }
}, 15000);

/* --------------------------------------------------------------- commands */

function enqueue(sn, cmd, meta) {
  const id = ++cmdSeq;
  const item = Object.assign(
    { id, sn, cmd, created: Date.now(), sent: 0, returned: 0, result: null }, meta || {});
  (state.queue[sn] = state.queue[sn] || []).push(item);
  // the queue is display-only state; trimming keeps a long-running server flat
  const q = state.queue[sn];
  if (q.length > 200) {
    const cut = q.length - 200;
    // keep anything still awaiting a reply, however old
    const keep = q.slice(0, cut).filter((c) => !c.returned);
    q.splice(0, cut, ...keep);
  }
  trace('info', sn, 'queued C:' + id + ':' + cmd);
  return item;
}

// Opening the door is the one command whose wording differs between firmware
// families: the access-control builds take AC_UNLOCK, the standalone terminal
// builds (ZAM platform, PushVersion 3.x) take CONTROL DEVICE. Nothing in the
// handshake tells us which we are talking to, so we try them in order and
// remember the one the terminal accepted - after the first success a device
// only ever receives its own working form.
// These are candidates, not a spec we can look up per device: the handshake
// does not say which family this firmware belongs to, so we try each in turn
// and keep the one the terminal answers Return=0 to. "Try every unlock form"
// in the dashboard fires all of them and reports each reply, which is how you
// find out whether the terminal accepts any of them at all.
const UNLOCK_SEC = Number(process.env.UNLOCK_SEC) || 5;
const UNLOCK_FORMS = [
  'AC_UNLOCK',
  'AC_UNLOCK 1',
  'CONTROL DEVICE 01 1 1 ' + UNLOCK_SEC + ' 0',
  'CONTROL DEVICE 01 000 0 0 0',
];

function unlockCommand(sn, variant) {
  const d = state.devices[sn];
  if (variant === undefined && d && d.unlockCmd) return d.unlockCmd;
  return UNLOCK_FORMS[Math.min(variant || 0, UNLOCK_FORMS.length - 1)];
}

// ZK encoded date-time integer used by SET OPTION DateTime=
function zkTime(d) {
  return ((d.getFullYear() - 2000) * 12 * 31 + d.getMonth() * 31 + (d.getDate() - 1)) * 86400
    + d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

function buildCommand(kind, p) {
  p = p || {};
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  switch (kind) {
    case 'unlock':   return unlockCommand(p.sn, p.variant);
    case 'reboot':   return 'REBOOT';
    case 'info':     return 'INFO';
    case 'check':    return 'CHECK';                       // force full re-sync from device
    case 'synctime': return 'SET OPTION DateTime=' + zkTime(new Date());
    case 'queryuser':return 'DATA QUERY USERINFO PIN=' + (p.pin || '*');
    case 'queryatt': {
      const end = new Date();
      const start = new Date(end.getTime() - (Number(p.days || 7) * 86400000));
      return 'DATA QUERY ATTLOG StartTime=' + fmt(start) + '\tEndTime=' + fmt(end);
    }
    case 'adduser':
      return 'DATA UPDATE USERINFO PIN=' + p.pin + '\tName=' + (p.name || '')
        + '\tPri=' + (p.pri || 0) + '\tPasswd=' + (p.passwd || '') + '\tCard=' + (p.card || '')
        + '\tGrp=1\tTZ=0000000000000000\tVerify=-1';
    case 'deluser':  return 'DATA DELETE USERINFO PIN=' + p.pin;
    case 'raw':      return String(p.cmd || '').trim();
    default:         return null;
  }
}

/* ---------------------------------------------------------------- parsing */

const VERIFY = {
  0: 'Password', 1: 'Fingerprint', 2: 'Card', 3: 'PW+FP', 4: 'Card+FP',
  9: 'Other', 15: 'Face', 20: 'Face', 25: 'Palm', 200: 'Manual',
};
const STATUS = {
  0: 'Check-In', 1: 'Check-Out', 2: 'Break-Out', 3: 'Break-In',
  4: 'OT-In', 5: 'OT-Out', 255: 'Punch',
};

function addPunch(sn, rawPin, devTime, status, verify, workcode, extra, offset) {
  const pin = normPin(rawPin);
  const time = shiftStamp(devTime, offset);
  const key = punchKey({ sn, pin: String(pin), time, status: Number(status) || 0 });
  if (seen.has(key)) return false;
  seen.add(key);
  const rec = {
    sn, pin: String(pin), time, devTime, status: Number(status) || 0,
    verify: Number(verify) || 0, workcode: workcode || '0',
    name: (state.users[pin] && state.users[pin].name) || '',
    recv: Date.now(), extra: extra || '',
  };
  state.logs.push(rec);
  try { fs.appendFileSync(ATT_FILE, JSON.stringify(rec) + '\n'); }
  catch (e) { trace('err', sn, 'attlog write: ' + e.message); }
  return true;
}

function parseAttlog(sn, body) {
  const rows = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split('\t');
    if (f.length < 2) continue;
    const pin = f[0].trim();
    const time = (f[1] || '').trim();
    if (!pin || !/\d{4}-\d{2}-\d{2}/.test(time)) continue;
    rows.push({ pin, time, f });
  }
  // one measurement for the batch, taken from its newest stamp - that is the
  // punch that just happened, the rest may be minutes older
  const newest = rows.reduce((a, r) => (r.time > a ? r.time : a), '');
  const off = detectClockOffset(sn, newest, rows.length);
  let n = 0;
  for (const r of rows) {
    const f = r.f;
    if (addPunch(sn, r.pin, r.time, f[2], f[3], f[4], f.slice(5).join('|'), off)) n++;
  }
  const d = state.devices[sn];
  if (d) d.pushCount = (d.pushCount || 0) + n;
  trace('dev', sn, 'ATTLOG -> ' + n + ' new punch(es)');
  return n;
}

function kv(line) {
  const out = {};
  for (const part of line.split('\t')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1);
  }
  return out;
}

function parseOperlog(sn, body) {
  let users = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^USER\s/i.test(line)) {
      const o = kv(line.replace(/^USER\s+/i, ''));
      if (!o.PIN) continue;
      const pin = normPin(o.PIN);
      const u = state.users[pin] || (state.users[pin] = { pin });
      u.name = o.Name || u.name || '';
      u.card = o.Card || u.card || '';
      u.privilege = o.Pri || u.privilege || '0';
      u.sn = sn;
      u.updated = Date.now();
      users++;
    } else if (/^(FP|FACE|BIODATA|BIOPHOTO|USERPIC)\s/i.test(line)) {
      const o = kv(line.replace(/^\S+\s+/, ''));
      const pin = normPin(o.PIN || o.Pin);
      if (pin) {
        const u = state.users[pin] || (state.users[pin] = { pin });
        const t = line.split(/\s/)[0].toUpperCase();
        u.bio = u.bio || {};
        u.bio[t] = (u.bio[t] || 0) + 1;
      }
    } else if (/^OPLOG\s/i.test(line)) {
      trace('dev', sn, 'OPLOG ' + line.slice(0, 120));
    }
  }
  if (users) { saveSoon(); trace('dev', sn, 'USERINFO -> ' + users + ' user record(s)'); }
  return users;
}

function parseOptions(sn, body) {
  const d = touchDevice(sn);
  if (!d) return;
  // firmware sends INFO as one comma-separated line: "MAC=..,UserCount=81,.."
  for (const raw of body.split(/[\r\n,]+/)) {
    const line = raw.trim().replace(/^~/, '');
    if (!line) continue;
    const i = line.indexOf('=');
    if (i > 0) d.info[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  d.name = d.info.DeviceName || d.info['~DeviceName'] || d.name;
  saveSoon();
  trace('dev', sn, 'options: ' + (d.info.FWVersion || '') + ' ' + (d.info.DeviceName || ''));
}

/* -------------------------------------------------------- http utilities */

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      if (buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b) {
        try { buf = zlib.gunzipSync(buf); } catch (e) {}
      }
      resolve(buf.toString('utf8'));
    });
    req.on('error', () => resolve(''));
  });
}

function textOut(res, body, code) {
  const b = Buffer.from(String(body), 'utf8');
  res.writeHead(code || 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': b.length,
    'Pragma': 'no-cache',
    'Connection': 'close',
  });
  res.end(b);
}

function jsonOut(res, obj, code) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': b.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(b);
}

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

/* ------------------------------------------------- device push protocol */

function handshake(sn) {
  const d = touchDevice(sn);
  const off = 5.5;
  return [
    'GET OPTION FROM: ' + sn,
    'ATTLOGStamp=' + (d ? d.stamp : '9999'),
    'OPERLOGStamp=' + (d ? d.opStamp : '9999'),
    'ATTPHOTOStamp=None',
    'BIODATAStamp=None',
    'ErrorDelay=30',
    'Delay=10',
    'TransTimes=00:00;14:00',
    'TransInterval=1',
    'TransFlag=TransData AttLog OpLog AttPhoto EnrollUser ChgUser EnrollFP ChgFP FPImag UserPic FACE BioPhoto',
    'TimeZone=' + off,
    'Realtime=1',
    'Encrypt=0',
    'ServerVer=2.4.1 ' + localDate(new Date()),
    'PushProtVer=2.4.1',
    'MultiBioDataSupport=0:1:0:0:0:0:0:0:1:0',
    'MultiBioPhotoSupport=0:0:0:0:0:0:0:0:1:0',
    '',
  ].join('\n');
}

async function handleDevice(req, res, route, q) {
  const sn = q.get('SN') || q.get('sn') || '';
  // Half of a protocol problem is what we answered, and the trace used to show
  // only the terminal's side of it. Every reply goes through here now.
  const reply = (body) => {
    trace('rep', sn, route.replace('/iclock/', '') + ' -> '
      + String(body).replace(/\r?\n/g, ' | ').trim());
    return textOut(res, body);
  };

  if (route === '/iclock/ping') { touchDevice(sn, req); return reply('OK'); }

  if (route === '/iclock/registry') {
    await readBody(req);
    trace('dev', sn, 'registry request');
    return reply('RegistryCode=' + (sn || 'AIFACE') + '\n');
  }
  if (route === '/iclock/push') {
    touchDevice(sn, req);
    return reply('RegistryCode=' + sn + '\nServerVersion=2.4.1\n');
  }

  if (route === '/iclock/cdata' && req.method === 'GET') {
    touchDevice(sn, req);
    trace('dev', sn, 'handshake: ' + req.url);
    return reply(handshake(sn));
  }

  if (route === '/iclock/cdata' && req.method === 'POST') {
    const d = touchDevice(sn, req);
    const body = await readBody(req);
    const table = (q.get('table') || q.get('Table') || '').toUpperCase();
    const stamp = q.get('Stamp') || q.get('stamp');
    if (table === 'ATTLOG') {
      if (stamp && d) d.stamp = stamp;
      const n = parseAttlog(sn, body);
      return reply('OK: ' + n);
    }
    if (table === 'OPERLOG' || table === 'USERINFO' || table === 'BIODATA') {
      if (stamp && d) d.opStamp = stamp;
      const n = parseOperlog(sn, body);
      return reply('OK: ' + n);
    }
    if (table === 'OPTIONS' || table === '') {
      parseOptions(sn, body);
      return reply('OK');
    }
    trace('dev', sn, 'table=' + table + ' (' + body.length + ' bytes, ignored)');
    return reply('OK');
  }

  if (route === '/iclock/getrequest') {
    const d = touchDevice(sn, req);
    const pending = (state.queue[sn] || []).filter((c) => !c.sent);
    if (!pending.length) return reply('OK');
    const lines = pending.map((c) => { c.sent = Date.now(); return 'C:' + c.id + ':' + c.cmd; });
    trace('srv', sn, 'sending ' + lines.length + ' command(s)');
    if (d) d.lastCmd = Date.now();
    return reply(lines.join('\n') + '\n');
  }

  if (route === '/iclock/devicecmd') {
    touchDevice(sn, req);
    const body = await readBody(req);
    for (const raw of body.split(/\r?\n|&(?=ID=)/)) {
      const line = raw.trim();
      if (!line) continue;
      const p = new URLSearchParams(line.replace(/\t/g, '&'));
      const id = Number(p.get('ID'));
      const item = (state.queue[sn] || []).find((c) => c.id === id);
      if (item) {
        item.returned = Date.now();
        item.result = p.get('Return');
        trace('dev', sn, 'cmd ' + id + ' (' + item.cmd.split(' ')[0] + ') returned ' + item.result);
        if (item.kind === 'unlock') onUnlockReply(sn, item);
        else if (item.kind === 'unlock-probe') {
          item.ok = returnedOk(item);
          // learning which wording works is the whole point of the test, so
          // keep it for the next real press
          const dev = state.devices[sn];
          if (item.ok && dev && dev.unlockCmd !== item.cmd) {
            dev.unlockCmd = item.cmd;
            trace('info', sn, 'unlock form learned from test: ' + item.cmd);
            saveSoon();
          }
        }
      } else {
        trace('dev', sn, 'devicecmd: ' + line.slice(0, 120));
      }
    }
    return reply('OK');
  }

  // fdata / querydata / edata and anything else the firmware probes
  await readBody(req);
  touchDevice(sn, req);
  trace('dev', sn, 'unhandled ' + req.method + ' ' + req.url);
  return reply('OK');
}

// Return=0 is the firmware's "done". Anything else means this build does not
// know the wording, so we move on to the next form and let the operator see
// only the final outcome.
// A reply only counts as acceptance when the terminal actually sent Return=0.
// Number(null) is 0, so a missing field must not read as success.
function returnedOk(item) {
  return item.result !== null && item.result !== undefined && String(item.result).trim() !== ''
    && Number(item.result) === 0;
}

function onUnlockReply(sn, item) {
  const d = state.devices[sn];
  if (returnedOk(item)) {
    item.ok = true;
    if (d && d.unlockCmd !== item.cmd) { d.unlockCmd = item.cmd; saveSoon(); }
    // Return=0 means the terminal accepted the command. Whether a lock
    // actually moved depends on its relay wiring and lock delay, which the
    // protocol never tells us.
    trace('info', sn, 'unlock accepted (' + item.cmd.split(' ')[0] + ')');
    return;
  }
  item.ok = false;
  const tried = item.tried || 1;
  if (tried >= UNLOCK_FORMS.length) {
    // every wording refused: forget the remembered one so the next press
    // starts the search over rather than repeating the same dead command
    if (d && d.unlockCmd) { delete d.unlockCmd; saveSoon(); }
    trace('err', sn, 'door did not open - terminal rejected every unlock form'
      + ' (last: ' + item.cmd + ' -> ' + item.result + ')');
    return;
  }
  // step to the next wording, wrapping so a remembered form that has gone
  // stale still gets the others tried
  const next = (UNLOCK_FORMS.indexOf(item.cmd) + 1) % UNLOCK_FORMS.length;
  trace('info', sn, 'unlock form "' + item.cmd.split(' ')[0] + '" rejected ('
    + item.result + '), trying the next one');
  enqueue(sn, UNLOCK_FORMS[next],
    { kind: 'unlock', tried: tried + 1, retryOf: item.retryOf || item.id });
}

/* ------------------------------------------------------------------- API */

function dirOf(rec) {
  if (rec.status === 0 || rec.status === 4 || rec.status === 3) return 'in';
  if (rec.status === 1 || rec.status === 5 || rec.status === 2) return 'out';
  const d = state.devices[rec.sn];
  return (d && d.role) || '';
}

/* ------------------------------------------------------- attendance model */

// These terminals stamp every punch with status 255 ("Punch") - the firmware
// never says whether the person was arriving or leaving. Direction therefore
// comes from, in order of trust:
//   1. an explicit status code, when a terminal is configured to send one
//   2. the gate role an admin assigned to the terminal
//   3. alternation from the first punch of the day (in, out, in, out, ...)
// The lobby here has two unassigned gates, so (3) is what actually runs.

// Firmware reports a face match as verify mode 15; some builds use 20.
const FACE_MODES = new Set([15, 20]);
const isFace = (r) => FACE_MODES.has(Number(r.verify));

// A card can be lent, a face cannot, so attendance is computed from face
// punches only unless someone deliberately turns that off.
const FACE_ONLY_DEFAULT = process.env.FACE_ONLY !== '0';

// One movement = one arrival or one departure. A punch inside this window of
// the movement before it is the same person still standing at the gate: the
// terminal double-reading in the same second, a re-tap because the door was
// slow, or the second terminal catching the face as they walk past. Counting
// those as separate movements is what produced 0h days and phantom breaks.
const DWELL_SEC_DEFAULT = Number(process.env.DWELL_SEC || 180);

const tsOf = (t) => Date.parse(t.replace(' ', 'T')) || 0;
const dayOf = (t) => t.slice(0, 10);

const faceSetting = () => (state.settings.faceOnly === undefined
  ? FACE_ONLY_DEFAULT : !!state.settings.faceOnly);

// ?face=0 shows every verification mode for one call without changing the
// saved rule; ?face=1 forces face-only. Otherwise the saved rule applies.
function faceOnly(q) {
  const v = q && q.get ? (q.get('face') || '').toLowerCase() : '';
  if (v === '0' || v === 'false' || v === 'all') return false;
  if (v === '1' || v === 'true' || v === 'face') return true;
  return faceSetting();
}

function dwellSec() {
  const n = Number(state.settings.dwellSec);
  return Number.isFinite(n) && n >= 0 && n <= 3600 ? n : DWELL_SEC_DEFAULT;
}

// First movement of the day is the arrival, the last is the departure, and the
// pairs between them are breaks. An odd number in the middle leaves one tap
// without a partner: it stays visible but is never counted, so a stray punch
// can neither invent a break nor stretch the day.
function labelMovements(evs) {
  if (!evs.length) return evs;
  evs[0].label = 'Check in';
  if (evs.length === 1) return evs;
  evs[evs.length - 1].label = 'Check out';
  const mid = evs.slice(1, -1);
  const paired = Math.floor(mid.length / 2) * 2;
  for (let i = 0; i < paired; i++) mid[i].label = i % 2 ? 'Break end' : 'Break start';
  for (let i = paired; i < mid.length; i++) mid[i].label = 'Extra punch';
  return evs;
}

// One day's punches -> the ordered movements they represent.
function dayEvents(pin, date, face) {
  const all = state.logs
    .filter((r) => r.pin === pin && dayOf(r.time) === date)
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const rows = face ? all.filter(isFace) : all;

  const win = dwellSec() * 1000;
  const evs = [];
  for (const r of rows) {
    const prev = evs[evs.length - 1];
    const dir = dirOf(r);
    // Where both gates are known, direction alone decides: you cannot arrive
    // twice without leaving in between, so a second punch at the same gate is
    // the same movement however much later it came - the door was slow, the
    // read did not take, someone tapped again on the way past. Only the
    // opposite gate starts a new movement. Without gate roles there is no
    // direction to reason from, so closeness in time is all that is left.
    const sameMove = prev && (dir && prev.dir
      ? dir === prev.dir
      : (tsOf(r.time) - tsOf(prev.time)) < win);
    // the run counts as happening at its last tap: that is the one the person
    // actually walked through on
    if (sameMove) { prev.taps++; prev.time = r.time; continue; }
    evs.push({ time: r.time, from: r.time, dir, verify: r.verify, sn: r.sn, taps: 1 });
  }
  labelMovements(evs);
  evs.taps = rows.length;
  evs.ignored = all.length - rows.length;
  return evs;
}

function daySummary(pin, date, face) {
  const evs = dayEvents(pin, date, face);
  const inEv = evs[0] || null;
  const outEv = evs.length > 1 ? evs[evs.length - 1] : null;

  const breaks = [];
  let breakMin = 0;
  for (let i = 1; i < evs.length - 1; i++) {
    if (evs[i].label !== 'Break start') continue;
    const nxt = evs[i + 1];
    if (!nxt || nxt.label !== 'Break end') continue;
    const min = Math.round((tsOf(nxt.time) - tsOf(evs[i].time)) / 60000);
    if (min <= 0) continue;
    breaks.push({ from: evs[i].time, to: nxt.time, min });
    breakMin += min;
  }

  const totalMin = inEv && outEv
    ? Math.round((tsOf(outEv.time) - tsOf(inEv.time)) / 60000) : 0;
  breakMin = Math.min(breakMin, totalMin);
  const dow = new Date(date + 'T00:00:00').getDay();
  return {
    date, dow,
    status: evs.length ? 'Present' : (dow === 0 ? 'Weekly off' : 'Absent'),
    in: inEv ? inEv.time : '',
    out: outEv ? outEv.time : '',
    // one lone movement means they were seen but never seen leaving
    incomplete: evs.length === 1,
    punches: evs.length, taps: evs.taps || 0, ignored: evs.ignored || 0,
    breakMin, totalMin, breaks,
    workMin: Math.max(0, totalMin - breakMin),
    events: evs,
  };
}

const localDate = (d) => d.getFullYear() + '-'
  + String(d.getMonth() + 1).padStart(2, '0') + '-'
  + String(d.getDate()).padStart(2, '0');

function dateRange(from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  while (d <= end && out.length < 400) { out.push(localDate(d)); d.setDate(d.getDate() + 1); }
  return out;
}

function attendance(pin, from, to, face) {
  const days = dateRange(from, to).map((d) => daySummary(pin, d, face));
  const present = days.filter((d) => d.status === 'Present');
  const sum = (k) => present.reduce((a, d) => a + d[k], 0);
  return {
    pin,
    name: (state.users[pin] && state.users[pin].name) || '',
    verifiedBy: face ? 'face' : 'any',
    days: days.slice().reverse(),
    totals: {
      totalDays: days.length,
      present: present.length,
      absent: days.filter((d) => d.status === 'Absent').length,
      sundays: days.filter((d) => d.dow === 0).length,
      incomplete: days.filter((d) => d.incomplete).length,
      totalMin: sum('totalMin'),
      breakMin: sum('breakMin'),
      workMin: sum('workMin'),
      ignored: days.reduce((a, d) => a + d.ignored, 0),
    },
  };
}

// The same run of taps that the attendance model folds into one movement also
// fills the raw log with near-identical rows. Fold them here too, keeping the
// last tap of each run and remembering how many there were, so the log reads
// as movements. ?raw=1 turns it off and shows every punch as recorded - the
// stored history is never touched either way.
function collapseRepeats(rows) {
  const asc = rows.slice().sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const win = dwellSec() * 1000;
  const open = new Map();     // pin -> the run currently being extended
  const out = [];
  for (const r of asc) {
    const dir = dirOf(r) || 'none';
    const run = open.get(r.pin);
    // Same rule the attendance model uses: with a known gate, only the
    // opposite one ends the run; with no gate role there is no direction to
    // reason from, so a run is just taps close together in time - otherwise a
    // whole day at an unassigned terminal would fold into a single row. A run
    // never spans a date either way.
    const sameRun = run && run.dir === dir && dayOf(run.last) === dayOf(r.time)
      && (dir !== 'none' || (tsOf(r.time) - tsOf(run.last)) < win);
    if (sameRun) {
      run.taps++;
      run.last = r.time;
      out[run.at] = Object.assign({}, r, { taps: run.taps, from: run.from });
      continue;
    }
    open.set(r.pin, { dir, taps: 1, from: r.time, last: r.time, at: out.length });
    out.push(Object.assign({}, r, { taps: 1, from: r.time }));
  }
  return out;
}

function filterLogs(q) {
  const term = (q.get('q') || '').toLowerCase();
  const fPin = (q.get('pin') || '').trim().toLowerCase();
  const fName = (q.get('name') || '').trim().toLowerCase();
  const fDir = (q.get('dir') || '').trim();
  const fVerify = (q.get('verify') || '').trim();
  const from = q.get('from');
  const to = q.get('to');
  const limit = Math.min(Number(q.get('limit') || 500), 20000);
  let rows = state.logs;
  // resolve display names late: a punch can arrive before the user record syncs
  for (const r of rows) {
    if (!r.name && state.users[r.pin]) r.name = state.users[r.pin].name || '';
  }
  if (from) rows = rows.filter((r) => r.time >= from);
  if (to) rows = rows.filter((r) => r.time <= to + ' 23:59:59');
  if (term) {
    rows = rows.filter((r) =>
      r.pin.toLowerCase().includes(term) ||
      (r.name || '').toLowerCase().includes(term) ||
      r.sn.toLowerCase().includes(term));
  }
  if (fPin) rows = rows.filter((r) => r.pin.toLowerCase().includes(fPin));
  if (fName) rows = rows.filter((r) => (r.name || '').toLowerCase().includes(fName));
  if (fVerify === 'face') rows = rows.filter(isFace);
  else if (fVerify) rows = rows.filter((r) => String(r.verify) === fVerify);
  if (fDir) rows = rows.filter((r) => (dirOf(r) || 'none') === fDir);
  if ((q.get('raw') || '') !== '1') rows = collapseRepeats(rows);
  return rows.slice()
    .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
    .slice(0, limit)
    .map((r) => Object.assign({ dir: dirOf(r) }, r));
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

// HR integration is allow-list only, and denied while the list is empty.
function ipAllowed(req) {
  const list = state.settings.allowIps || [];
  if (!list.length) return false;
  const ip = clientIp(req);
  return list.some((a) => a === '*' || a === ip);
}

function dirSize(dir) {
  const files = [];
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.isFile()) { files.push({ name: f, bytes: st.size }); total += st.size; }
    } catch (e) { /* ignore */ }
  }
  return { total, files: files.sort((a, b) => b.bytes - a.bytes) };
}

function serverStats(days) {
  const span = Math.min(Math.max(Number(days) || 14, 1), 120);
  const store = dirSize(DATA_DIR);
  const today = localDate(new Date());
  const byDay = {};
  const byHour = new Array(24).fill(0);
  const byDevice = {};
  for (const r of state.logs) {
    const day = r.time.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
    byDevice[r.sn] = (byDevice[r.sn] || 0) + 1;
    if (day === today) byHour[Number(r.time.slice(11, 13)) || 0]++;
  }
  const series = [];
  const d = new Date();
  d.setDate(d.getDate() - (span - 1));
  for (let i = 0; i < span; i++) {
    const key = localDate(d);
    series.push({ date: key, count: byDay[key] || 0 });
    d.setDate(d.getDate() + 1);
  }
  const hours = byHour.map((count, h) => ({ date: String(h).padStart(2, '0'), count }));
  const mem = process.memoryUsage();
  return {
    store,
    counts: {
      logs: state.logs.length,
      users: Object.keys(state.users).length,
      devices: Object.keys(state.devices).length,
      online: Object.values(state.devices).filter((x) => x.online).length,
    },
    series, hours, days: span, today,
    devices: Object.values(state.devices).map((x) => ({
      sn: x.sn, online: !!x.online, role: x.role || '',
      lastSeen: x.lastSeen, clockOffset: x.clockOffset || 0,
      punches: byDevice[x.sn] || 0,
    })).sort((a, b) => b.punches - a.punches),
    proc: {
      uptime: Math.round(process.uptime()),
      rss: mem.rss, heapUsed: mem.heapUsed,
      node: process.version, pid: process.pid, port: PORT,
    },
    host: {
      load: os.loadavg().map((x) => Math.round(x * 100) / 100),
      cpus: os.cpus().length,
      totalMem: os.totalmem(), freeMem: os.freemem(),
      platform: os.platform(), hostname: os.hostname(),
    },
  };
}

async function handleApi(req, res, route, q) {
  // ---- HR read-only API, restricted to allow-listed IPs
  if (route.startsWith('/api/hr/')) {
    if (!ipAllowed(req)) {
      trace('err', '', 'HR API denied for ' + clientIp(req));
      return jsonOut(res, { error: 'forbidden', ip: clientIp(req) }, 403);
    }
    const today = localDate(new Date());
    const to = q.get('to') || today;
    const from = q.get('from') || to;
    if (route === '/api/hr/users') {
      return jsonOut(res, { users: Object.values(state.users) });
    }
    if (route === '/api/hr/punches') {
      return jsonOut(res, { from, to, punches: filterLogs(q) });
    }
    if (route === '/api/hr/attendance') {
      const face = faceOnly(q);
      const pin = q.get('pin');
      if (pin) return jsonOut(res, attendance(pin, from, to, face));
      const rows = Object.keys(state.users)
        .map((x) => attendance(x, from, to, face))
        .sort((a, b) => Number(a.pin) - Number(b.pin));
      return jsonOut(res, { from, to, verifiedBy: face ? 'face' : 'any', employees: rows });
    }
    return jsonOut(res, { error: 'unknown endpoint' }, 404);
  }
  // Backs the /opendoor kiosk page. Deliberately not behind the HR allow-list:
  // it is the door button, and the server only listens on the LAN. Set a door
  // code in settings if the page is reachable from anywhere less trusted.
  if (route === '/api/door') {
    const devs = Object.values(state.devices);
    return jsonOut(res, {
      devices: devs.length,
      online: devs.filter((d) => d.online).length,
      needsPin: !!state.settings.doorPin,
    });
  }
  // Everything known about door attempts, so "it does not work" can be read
  // as an actual answer: was a terminal online, did it ever collect the
  // command, and what did it reply.
  if (route === '/api/door/log') {
    const items = Object.values(state.queue).flat()
      .filter((c) => c.kind === 'unlock' || c.kind === 'unlock-probe')
      .sort((a, b) => b.created - a.created).slice(0, 30)
      .map((c) => ({
        id: c.id, sn: c.sn, cmd: c.cmd, probe: c.kind === 'unlock-probe',
        created: c.created, sent: c.sent, returned: c.returned,
        result: c.result, ok: c.ok === undefined ? null : c.ok,
      }));
    return jsonOut(res, {
      forms: UNLOCK_FORMS,
      devices: Object.values(state.devices).map((d) => ({
        sn: d.sn, online: d.online, lastSeen: d.lastSeen,
        // set only after a terminal answered Return=0 to one of the forms
        unlockCmd: d.unlockCmd || '',
        // a terminal that never picks commands up is the other failure mode
        lastCmd: d.lastCmd || 0,
      })),
      items,
    });
  }
  // Fires every candidate wording once at every online terminal and records
  // each reply without chaining fallbacks. This is the test that says whether
  // the terminal understands any unlock command at all.
  if (route === '/api/door/probe' && req.method === 'POST') {
    const online = Object.keys(state.devices).filter((sn) => state.devices[sn].online);
    if (!online.length) return jsonOut(res, { ok: false, error: 'no terminal is online' }, 409);
    const queued = [];
    for (const sn of online) {
      for (const form of UNLOCK_FORMS) queued.push(enqueue(sn, form, { kind: 'unlock-probe' }));
    }
    trace('info', '', 'door probe: ' + UNLOCK_FORMS.length + ' form(s) x ' + online.length + ' terminal(s)');
    return jsonOut(res, { ok: true, targets: online, queued: queued.map((c) => c.id) });
  }
  if (route === '/api/opendoor' && req.method === 'POST') {
    let p = {};
    try { p = JSON.parse((await readBody(req)) || '{}'); } catch (e) {}
    if (state.settings.doorPin && String(p.pin || '') !== String(state.settings.doorPin)) {
      trace('err', '', 'door code rejected from ' + clientIp(req));
      return jsonOut(res, { ok: false, error: 'wrong code' }, 401);
    }
    const online = Object.keys(state.devices).filter((sn) => state.devices[sn].online);
    if (!online.length) {
      return jsonOut(res, { ok: false, error: 'No terminal is online, so nothing can open the door.' }, 409);
    }
    const queued = online.map((sn) => enqueue(sn, unlockCommand(sn), { kind: 'unlock' }));
    trace('info', '', 'door requested from ' + clientIp(req) + ' -> ' + online.length + ' terminal(s)');
    return jsonOut(res, { ok: true, targets: online, queued: queued.map((c) => ({ id: c.id, sn: c.sn })) });
  }
  if (route === '/api/stats') return jsonOut(res, serverStats(q.get('days')));
  if (route === '/api/settings' && req.method === 'GET') {
    return jsonOut(res, {
      allowIps: state.settings.allowIps || [], yourIp: clientIp(req),
      faceOnly: faceSetting(), dwellSec: dwellSec(),
      doorPinSet: !!state.settings.doorPin,     // never echo the code itself
    });
  }
  if (route === '/api/settings' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (body.allowIps !== undefined) {
      state.settings.allowIps = (body.allowIps || [])
        .map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
      trace('info', '', 'HR allow-list set to ' + (state.settings.allowIps.join(' ') || '(empty)'));
    }
    if (body.faceOnly !== undefined) state.settings.faceOnly = !!body.faceOnly;
    if (body.doorPin !== undefined) {
      state.settings.doorPin = String(body.doorPin).trim().slice(0, 32);
      trace('info', '', 'door code ' + (state.settings.doorPin ? 'set' : 'cleared'));
    }
    if (body.dwellSec !== undefined) {
      const n = Number(body.dwellSec);
      if (Number.isFinite(n) && n >= 0 && n <= 3600) state.settings.dwellSec = Math.round(n);
    }
    saveSoon();
    return jsonOut(res, {
      ok: true, allowIps: state.settings.allowIps,
      faceOnly: faceSetting(), dwellSec: dwellSec(),
      doorPinSet: !!state.settings.doorPin,
    });
  }
  if (route === '/health' || route === '/api/health') {
    return jsonOut(res, { status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
  }
  if (route === '/api/attendance') {
    const today = localDate(new Date());
    const to = q.get('to') || today;
    const from = q.get('from') || to;
    const face = faceOnly(q);
    const pin = q.get('pin');
    if (pin) return jsonOut(res, attendance(pin, from, to, face));
    const rows = Object.keys(state.users)
      .map((p) => { const a = attendance(p, from, to, face); return { pin: p, name: a.name, totals: a.totals }; })
      .sort((a, b) => Number(a.pin) - Number(b.pin));
    return jsonOut(res, { from, to, verifiedBy: face ? 'face' : 'any', rows });
  }
  if (route === '/api/state') {
    const rows = filterLogs(q).slice(0, Number(q.get('limit') || 200));
    const today = localDate(new Date());
    return jsonOut(res, {
      now: Date.now(),
      port: PORT,
      tz: process.env.TZ,
      ips: lanIPs(),
      devices: Object.values(state.devices).sort((a, b) => b.lastSeen - a.lastSeen),
      users: Object.values(state.users).sort((a, b) => Number(a.pin) - Number(b.pin)),
      logs: rows,
      totals: {
        logs: state.logs.length,
        users: Object.keys(state.users).length,
        devices: Object.keys(state.devices).length,
        today: state.logs.filter((r) => r.time.startsWith(today)).length,
      },
      queue: Object.values(state.queue).flat().slice(-40).reverse(),
      events: state.events.slice(-120).reverse(),
      labels: { verify: VERIFY, status: STATUS },
    });
  }

  if (route === '/api/export.csv') {
    const rows = filterLogs(q);
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = ['Serial,PIN,Name,DateTime,Status,Verify,WorkCode']
      .concat(rows.map((r) => [r.sn, r.pin, r.name, r.time,
        STATUS[r.status] || r.status, VERIFY[r.verify] || r.verify, r.workcode].map(esc).join(',')))
      .join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="attendance.csv"',
    });
    return res.end('﻿' + csv);
  }

  if (route === '/api/cmd' && req.method === 'POST') {
    let p = {};
    try { p = JSON.parse(await readBody(req) || '{}'); } catch (e) {}
    const all = Object.keys(state.devices);
    if (!all.length) return jsonOut(res, { ok: false, error: 'no device connected yet' }, 400);
    // A command only reaches a terminal that is still polling us. Queueing for
    // an offline gate used to be indistinguishable from success, which is why
    // "Open door" looked like it did nothing.
    const online = all.filter((sn) => state.devices[sn].online);
    const targets = p.sn ? [p.sn] : online;
    if (!targets.length) {
      return jsonOut(res, { ok: false,
        error: 'no terminal is online right now - ' + all.length
          + ' known device(s), none polling this server' }, 409);
    }
    if (!buildCommand(p.kind, Object.assign({}, p, { sn: targets[0] }))) {
      return jsonOut(res, { ok: false, error: 'unknown command' }, 400);
    }
    if (p.kind === 'adduser' && p.pin) {
      const pin = normPin(p.pin);
      const u = state.users[pin] || (state.users[pin] = { pin });
      u.name = p.name || u.name || '';
      u.card = p.card || u.card || '';
      u.privilege = String(p.pri || 0);
      saveSoon();
    }
    if (p.kind === 'deluser' && p.pin) { delete state.users[normPin(p.pin)]; saveSoon(); }
    const queued = targets.map((sn) => enqueue(sn,
      buildCommand(p.kind, Object.assign({}, p, { sn })), { kind: p.kind }));
    return jsonOut(res, {
      ok: true, cmd: queued[0].cmd, targets,
      // the terminal collects this on its next poll, within Delay seconds
      queued: queued.map((c) => ({ id: c.id, sn: c.sn })),
    });
  }

  // The UI polls this after firing a command so the operator sees what the
  // terminal actually answered instead of a silent no-op.
  if (route === '/api/cmd/status') {
    const ids = (q.get('ids') || '').split(',').map(Number).filter(Boolean);
    const flat = Object.values(state.queue).flat();
    const shape = (c) => ({
      id: c.id, sn: c.sn, cmd: c.cmd, kind: c.kind || '',
      sent: c.sent, returned: c.returned, result: c.result,
      ok: c.ok === undefined ? null : c.ok, retryOf: c.retryOf || 0,
    });
    return jsonOut(res, {
      items: flat.filter((c) => ids.includes(c.id)).map(shape),
      // an unlock that fell back to another wording spawns a follow-up command
      followups: flat.filter((c) => c.retryOf && ids.includes(c.retryOf)).map(shape),
    });
  }

  if (route === '/api/role' && req.method === 'POST') {
    const p = JSON.parse((await readBody(req)) || '{}');
    const d = state.devices[p.sn];
    if (!d) return jsonOut(res, { ok: false, error: 'unknown device' }, 404);
    d.role = ['in', 'out'].includes(p.role) ? p.role : '';
    saveSoon();
    trace('info', p.sn, 'role set to ' + (d.role || 'unassigned'));
    return jsonOut(res, { ok: true, role: d.role });
  }
  if (route === '/api/purge' && req.method === 'POST') {
    state.logs.length = 0;
    seen.clear();
    try { fs.writeFileSync(ATT_FILE, ''); } catch (e) {}
    trace('info', '', 'server attendance history cleared');
    return jsonOut(res, { ok: true });
  }

  return jsonOut(res, { error: 'not found' }, 404);
}

/* -------------------------------------------------------------- dashboard */

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIFACE-MARS Attendance</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--line:#262d38;--fg:#e6edf3;--dim:#8b949e;
--accent:#3b82f6;--ok:#22c55e;--warn:#f59e0b;--bad:#ef4444;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;align-items:center;gap:14px;padding:14px 20px;background:var(--panel);
border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10;flex-wrap:wrap}
h1{font-size:16px;margin:0;letter-spacing:.3px}
.badge{font-size:11px;padding:3px 9px;border-radius:20px;background:#21262d;color:var(--dim);border:1px solid var(--line)}
.badge.on{background:rgba(34,197,94,.15);color:var(--ok);border-color:rgba(34,197,94,.35)}
.badge.off{background:rgba(239,68,68,.12);color:var(--bad);border-color:rgba(239,68,68,.3)}
.wrap{padding:18px 20px;max-width:1400px;margin:0 auto}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));margin-bottom:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .k{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--dim)}
.card .v{font-size:26px;font-weight:600;margin-top:4px}
.cols{display:grid;gap:14px;grid-template-columns:1fr 340px}
@media(max-width:980px){.cols{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:14px}
.panel>h2{margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.9px;color:var(--dim);
padding:11px 14px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:8px}
.body{padding:12px 14px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);
padding:9px 12px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--panel)}
td{padding:9px 12px;border-bottom:1px solid #1c222b}
tr:hover td{background:#1a2029}
.scroll{max-height:460px;overflow:auto}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.pill{font-size:11px;padding:2px 8px;border-radius:20px;background:#21262d;border:1px solid var(--line)}
.pill.in{background:rgba(34,197,94,.15);color:var(--ok)}
.pill.out{background:rgba(245,158,11,.15);color:var(--warn)}
button{background:#21262d;color:var(--fg);border:1px solid var(--line);border-radius:7px;
padding:7px 12px;font-size:12px;cursor:pointer;font-family:inherit}
button:hover{border-color:var(--accent);color:#fff}
button.p{background:var(--accent);border-color:var(--accent);color:#fff}
button.d{border-color:rgba(239,68,68,.4);color:#f87171}
input,select{background:#0d1117;color:var(--fg);border:1px solid var(--line);border-radius:7px;
padding:7px 10px;font-size:13px;font-family:inherit;width:100%}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.row>*{flex:0 0 auto}
.btns{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.log{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;max-height:260px;overflow:auto;line-height:1.7}
.log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.log .dev{color:#7ee787}.log .srv{color:#79c0ff}.log .err{color:#f87171}.log .info{color:var(--dim)}
.log .rep{color:#d2a8ff}
.hint{color:var(--dim);font-size:12px;line-height:1.7}
.scroll table{min-width:640px}
.grid{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
@media(max-width:820px){
  .cols{grid-template-columns:1fr}
  .grid{grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
  .card{padding:10px 12px}.card .v{font-size:20px}
  h2{flex-wrap:wrap;gap:6px}
  .body.row>*{flex:1 1 auto;min-width:0}
  input,select{width:100%}
  #aList{position:fixed;left:12px;right:12px;top:auto}
}
.hint b{color:var(--fg)}
code{background:#0d1117;border:1px solid var(--line);padding:1px 6px;border-radius:5px;font-size:12px}
.empty{padding:34px;text-align:center;color:var(--dim)}
.note{font-size:12px;color:var(--dim);line-height:1.6}
.tag{font-size:10.5px;padding:2px 8px;border-radius:20px;background:#21262d;
border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.tag.face{background:rgba(59,130,246,.16);color:#93c5fd;border-color:rgba(59,130,246,.4)}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;flex:0 0 auto}
.seg button{border:0;border-radius:0;background:transparent;color:var(--dim);padding:7px 13px}
.seg button:hover{color:#fff}
.seg button.on{background:var(--accent);color:#fff}
/* day timeline: one dot per movement, connected top to bottom */
.tl{position:relative;padding:4px 0 4px 28px}
.tl:before{content:'';position:absolute;left:9px;top:18px;bottom:18px;width:2px;background:var(--line)}
.tl .ev{position:relative;padding:9px 0}
.tl .ev:before{content:'';position:absolute;left:-24px;top:14px;width:11px;height:11px;
border-radius:11px;box-sizing:border-box;background:var(--panel);border:2px solid var(--dim)}
.tl .ev.a:before{background:var(--ok);border-color:var(--ok)}
.tl .ev.z:before{background:var(--warn);border-color:var(--warn)}
.tl .ev.bs:before{border-color:var(--warn)}
.tl .ev.be:before{border-color:var(--ok)}
.tl .ev.x{opacity:.5}
.tl .t{font-variant-numeric:tabular-nums}
.gap{position:relative;margin-left:-4px;font-size:11px;color:var(--dim);padding:1px 0}
.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:80;
background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:11px 16px;
box-shadow:0 14px 36px rgba(0,0,0,.55);font-size:13px;max-width:min(560px,92vw)}
.toast.ok{border-color:rgba(34,197,94,.5)}
.toast.bad{border-color:rgba(239,68,68,.5)}
td.num{font-variant-numeric:tabular-nums}
.tabs{display:flex;gap:4px;padding:0 20px;background:var(--panel);
border-bottom:1px solid var(--line);position:sticky;top:53px;z-index:9;overflow-x:auto}
.tabs::-webkit-scrollbar{display:none}
.tab{background:transparent;border:0;border-radius:0;color:var(--dim);padding:12px 15px;
font-size:13px;white-space:nowrap;border-bottom:2px solid transparent;margin-bottom:-1px}
.tab:hover{color:var(--fg)}
.tab.on{color:#fff;border-bottom-color:var(--accent)}
.tab .n{margin-left:6px;font-size:10.5px;padding:1px 6px;border-radius:20px;
background:#21262d;color:var(--dim)}
section[hidden]{display:none}
/* the big in-dashboard door button, same language as the kiosk page */
button.door{width:190px;height:190px;border-radius:50%;border:0;color:#fff;
font:600 17px/1.2 inherit;cursor:pointer;padding:0;
background:linear-gradient(160deg,#4c8dff,#2563eb 62%,#1d4ed8);
box-shadow:0 16px 40px rgba(37,99,235,.4),inset 0 1px 0 rgba(255,255,255,.28);
transition:transform .14s cubic-bezier(.2,.7,.3,1),background .3s,box-shadow .25s}
button.door:hover{border-color:transparent;transform:translateY(-2px)}
button.door:active{transform:scale(.96)}
button.door.busy{background:linear-gradient(160deg,#3f7ae0,#1e51c9)}
button.door.ok{background:linear-gradient(160deg,#34d27a,#16a34a 62%,#15803d);
box-shadow:0 16px 40px rgba(34,197,94,.4),inset 0 1px 0 rgba(255,255,255,.28)}
button.door.bad{background:linear-gradient(160deg,#f87171,#dc2626 62%,#b91c1c);
box-shadow:0 16px 40px rgba(239,68,68,.38),inset 0 1px 0 rgba(255,255,255,.28)}
h1{font-size:15px}
@media(max-width:820px){.tabs{top:auto;position:static}}
</style></head><body>
<header>
  <h1>AIFACE-MARS <span style="color:var(--dim);font-weight:400">Attendance</span></h1>
  <span class="badge" id="hdrPort"></span>
  <span class="badge" id="hdrDev">no device</span>
  <span style="flex:1"></span>
  <span class="badge" id="hdrTick">-</span>
</header>

<nav class="tabs" id="tabs">
  <button class="tab on" data-tab="att">Attendance</button>
  <button class="tab" data-tab="log">Live log</button>
  <button class="tab" data-tab="door">Door</button>
  <button class="tab" data-tab="dev">Devices</button>
  <button class="tab" data-tab="info">Server info</button>
  <button class="tab" data-tab="srv">Settings &amp; API</button>
</nav>

<div class="wrap">

<!-- ------------------------------------------------------------ attendance -->
<section data-panel="att">
  <div class="grid">
    <div class="card"><div class="k">Punches today</div><div class="v" id="cToday">0</div></div>
    <div class="card"><div class="k">Total punches</div><div class="v" id="cTotal">0</div></div>
    <div class="card"><div class="k">Enrolled users</div><div class="v" id="cUsers">0</div></div>
    <div class="card"><div class="k">Devices</div><div class="v" id="cDev">0</div></div>
  </div>

  <div class="panel">
    <h2>Employee attendance
      <span class="row">
        <span class="tag face" id="aRule">Face verified only</span>
        <button onclick="attCsv()">Download CSV</button>
      </span>
    </h2>
    <div class="body row">
      <div style="position:relative;min-width:250px;flex:1 1 250px">
        <input id="aSearch" placeholder="Search employee by name or PIN, or leave blank for everyone"
               autocomplete="off" oninput="pickFilter()" onfocus="pickOpen()">
        <div id="aList" style="display:none;position:absolute;z-index:30;left:0;right:0;top:38px;
             max-height:280px;overflow:auto;background:var(--panel);border:1px solid var(--line);
             border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.5)"></div>
      </div>
      <input type="hidden" id="aUser">
      <span class="seg" id="aRange">
        <button class="on" data-d="0" onclick="setRange('att',0)">Today</button>
        <button data-d="7" onclick="setRange('att',7)">7 days</button>
        <button data-d="30" onclick="setRange('att',30)">30 days</button>
        <button data-d="90" onclick="setRange('att',90)">90 days</button>
      </span>
      <input id="aFrom" type="date" style="width:150px" onchange="markRange('aRange','x');loadAtt()">
      <input id="aTo" type="date" style="width:150px" onchange="markRange('aRange','x');loadAtt()">
      <span class="seg">
        <button id="aFace1" class="on" onclick="setFace(1)">Face only</button>
        <button id="aFace0" onclick="setFace(0)">Every mode</button>
      </span>
    </div>
    <div id="aKpis"></div>
    <div class="scroll">
      <table id="attTable">
        <thead><tr><th>Date</th><th>Status</th><th>Check-in &ndash; Check-out</th>
        <th>Total</th><th>Break</th><th>Net hours</th><th>Movements</th></tr></thead>
        <tbody id="tbAtt"></tbody></table>
      <div class="empty" id="emptyAtt">Loading&hellip;</div>
    </div>
    <div class="body note" id="aFoot" style="border-top:1px solid var(--line)"></div>
  </div>
</section>

<!-- ------------------------------------------------------------------- log -->
<section data-panel="log" hidden>
  <div class="panel">
    <h2>Attendance log
      <span class="row">
        <button onclick="exportCsv()">Export CSV</button>
        <button class="d" onclick="purge()">Clear history</button>
      </span>
    </h2>
    <div class="body row">
      <input id="fq" placeholder="Search anything" style="flex:1;min-width:140px" oninput="debounced()">
      <input id="fpin" placeholder="PIN" style="width:90px" oninput="debounced()">
      <input id="fname" placeholder="Name" style="width:140px" oninput="debounced()">
      <select id="fdir" style="width:130px" onchange="refresh()">
        <option value="">Type: all</option>
        <option value="in">Check-in</option>
        <option value="out">Check-out</option>
        <option value="none">Unassigned</option>
      </select>
      <select id="fverify" style="width:160px" onchange="refresh()">
        <option value="face">Verified by: Face</option>
        <option value="">Verified by: all</option>
      </select>
      <span class="seg" id="fRange">
        <button class="on" data-d="0" onclick="setRange('log',0)">Today</button>
        <button data-d="7" onclick="setRange('log',7)">7 days</button>
        <button data-d="30" onclick="setRange('log',30)">30 days</button>
        <button data-d="" onclick="setRange('log','')">All</button>
      </span>
      <input id="ffrom" type="date" style="width:150px" onchange="markRange('fRange','x');refresh()">
      <input id="fto" type="date" style="width:150px" onchange="markRange('fRange','x');refresh()">
      <label class="hint" style="display:flex;align-items:center;gap:6px">
        <input id="fraw" type="checkbox" onchange="refresh()"> every tap
      </label>
      <button onclick="clearFilters()">Reset</button>
    </div>
    <div class="scroll" style="max-height:620px">
      <table><thead><tr><th>Time</th><th>PIN</th><th>Name</th><th>Type</th><th>Verified by</th><th>Device</th></tr></thead>
      <tbody id="tbLogs"></tbody></table>
      <div class="empty" id="emptyLogs">Waiting for the first punch from the device...</div>
    </div>
  </div>

  <div class="panel">
    <h2>Users on device
      <span class="row">
        <input id="uq" placeholder="Filter users" style="width:170px" oninput="renderUsers()">
        <button onclick="cmd('queryuser')">Pull from device</button>
      </span>
    </h2>
    <div class="scroll" style="max-height:300px">
      <table><thead><tr><th>PIN</th><th>Name</th><th>Card</th><th>Privilege</th><th>Biometrics</th></tr></thead>
      <tbody id="tbUsers"></tbody></table>
      <div class="empty" id="emptyUsers">No users synced yet &mdash; press <b>Pull from device</b>.</div>
    </div>
  </div>
</section>

<!-- ------------------------------------------------------------------ door -->
<section data-panel="door" hidden>
  <div class="cols">
    <div>
      <div class="panel">
        <h2>Open the door
          <span class="row"><a href="/opendoor" target="_blank"><button>Full-screen page</button></a></span>
        </h2>
        <div class="body" style="text-align:center;padding:26px 16px">
          <button class="door" id="bigDoor" onclick="openDoor()">
            <svg viewBox="0 0 32 32" width="40" height="40" style="display:block;margin:0 auto 8px">
              <path d="M20 5H9a2 2 0 0 0-2 2v18a2 2 0 0 0 2 2h11" fill="none" stroke="#fff"
                stroke-width="2" stroke-linecap="round"/>
              <path d="M20 16h6m-3-3 3 3-3 3" fill="none" stroke="#fff" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"/></svg>
            Open door
          </button>
          <div class="note" id="doorMsg" style="margin-top:16px">
            Unlocks every terminal that is online.
          </div>
        </div>
      </div>

      <div class="panel">
        <h2>Door diagnostics
          <span class="row">
            <button onclick="doorProbe()">Try every unlock form</button>
            <button onclick="loadDoor()">Refresh</button>
          </span>
        </h2>
        <div class="body note">
          The protocol only ever tells us whether the terminal <b>accepted</b> the command.
          If a form comes back <b>0</b> and the door still does not move, the command is fine
          and the lock is not: check <b>Menu &rarr; Access Control &rarr; Door Lock Delay</b>
          is above 0 on the terminal, and that the lock is wired to that terminal's relay
          rather than to a separate access panel.
        </div>
        <div id="doorDev" class="body" style="border-top:1px solid var(--line)"></div>
        <div class="scroll" style="max-height:320px">
          <table><thead><tr><th>When</th><th>Terminal</th><th>Command</th><th>Collected</th><th>Reply</th></tr></thead>
          <tbody id="tbDoor"></tbody></table>
          <div class="empty" id="emptyDoor">No door command has been sent yet.</div>
        </div>
      </div>
    </div>

    <div>
      <div class="panel">
        <h2>Door access</h2>
        <div class="body">
          <div class="note" style="margin-bottom:10px">
            <a href="/opendoor" target="_blank" style="color:var(--accent)">/opendoor</a> is a
            full-screen button meant for a tablet at reception. Anyone who can reach this server
            can press it, so set a code if that page is reachable from outside your network.
          </div>
          <div class="row">
            <input id="doorPin" placeholder="door code (blank = no code)" style="flex:1;min-width:150px">
            <button onclick="saveDoorPin()">Save code</button>
          </div>
          <div class="note" id="doorPinMsg" style="margin-top:8px"></div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- --------------------------------------------------------------- devices -->
<section data-panel="dev" hidden>
  <div class="cols">
    <div>
      <div class="panel">
        <h2>Device</h2>
        <div class="body" id="devBox"><div class="hint">No device has connected yet.</div></div>
      </div>
      <div class="panel">
        <h2>Protocol trace
          <span class="row">
            <input id="trq" placeholder="filter" style="width:130px" oninput="renderTrace()">
            <label class="hint" style="display:flex;align-items:center;gap:5px">
              <input id="trFollow" type="checkbox" checked onchange="renderTrace()"> follow
            </label>
          </span>
        </h2>
        <div class="log body" id="trace"></div>
      </div>
      <div class="panel">
        <h2>Wire the device to this server</h2>
        <div class="body hint" id="setup"></div>
      </div>
    </div>

    <div>
      <div class="panel">
        <h2>Commands</h2>
        <div class="body">
          <div class="btns">
            <button class="p" onclick="openDoor()">Open door</button>
            <button class="p" onclick="syncData()">Sync data</button>
            <button onclick="cmd('synctime')">Sync clock</button>
            <button onclick="cmd('queryuser')">Pull users</button>
            <button onclick="cmd('queryatt',{days:7})">Pull 7 days</button>
            <button onclick="cmd('queryatt',{days:30})">Pull 30 days</button>
            <button onclick="cmd('info')">Device info</button>
            <button onclick="cmd('check')">Full re-sync</button>
            <button onclick="cmd('reboot')">Reboot</button>
          </div>
          <div class="note" id="cmdMsg" style="margin-top:8px"></div>
        </div>
      </div>

      <div class="panel">
        <h2>Add / update user</h2>
        <div class="body">
          <div class="row" style="margin-bottom:8px">
            <input id="uPin" placeholder="PIN (user ID)" style="flex:1;min-width:110px">
            <input id="uName" placeholder="Name" style="flex:1;min-width:110px">
          </div>
          <div class="row" style="margin-bottom:8px">
            <input id="uCard" placeholder="HID card no. (optional)" style="flex:1;min-width:110px">
            <select id="uPri" style="width:130px">
              <option value="0">User</option><option value="2">Enroller</option>
              <option value="6">Manager</option><option value="14">Super admin</option>
            </select>
          </div>
          <div class="btns">
            <button class="p" onclick="addUser()">Push to device</button>
            <button class="d" onclick="delUser()">Delete PIN</button>
          </div>
          <p class="hint" style="margin:10px 0 0">The face template still has to be enrolled at the terminal &mdash;
          this creates the user record so the face can be registered against it.</p>
        </div>
      </div>

      <div class="panel">
        <h2>Command queue</h2>
        <div class="log body" id="queue"></div>
      </div>
    </div>
  </div>
</section>

<!-- ---------------------------------------------------------------- server -->
<section data-panel="info" hidden>
  <div class="panel">
    <h2>Server
      <span class="row">
        <span class="seg" id="sRange">
          <button data-d="7" onclick="setStatDays(7)">7 days</button>
          <button class="on" data-d="14" onclick="setStatDays(14)">14 days</button>
          <button data-d="30" onclick="setStatDays(30)">30 days</button>
          <button data-d="90" onclick="setStatDays(90)">90 days</button>
        </span>
        <button onclick="loadStats()">Refresh</button>
      </span>
    </h2>
    <div id="statBox" class="body"><div class="hint">Loading...</div></div>
  </div>
</section>

<section data-panel="srv" hidden>
  <div class="panel">
    <h2>Attendance rules</h2>
    <div class="body">
      <div class="note" style="margin-bottom:10px">These apply everywhere &mdash; the dashboard,
      the CSV exports and the HR API.</div>
      <div class="row">
        <label class="note"><input type="checkbox" id="setFace" style="width:auto;margin-right:6px"
          onchange="saveRules()">Count face-verified punches only</label>
        <label class="note">Fold repeat taps within
          <input id="setDwell" type="number" min="0" max="60" style="width:70px;margin:0 6px"
            onchange="saveRules()"> minutes into one movement</label>
      </div>
      <div class="note" id="ruleMsg" style="margin-top:8px"></div>
    </div>
  </div>

  <div class="panel">
    <h2>HR API</h2>
    <div class="body">
      <div class="note" style="margin-bottom:8px">
        Read-only API for your HR system. Only the IP addresses listed here can call it &mdash;
        an empty list blocks everyone. Your current IP is <b id="myIp">?</b>.
      </div>
      <div class="row">
        <input id="ipList" placeholder="103.119.254.234, 49.37.0.0  (comma separated, * = any)" style="flex:1;min-width:240px">
        <button class="p" onclick="saveIps()">Save allow-list</button>
        <button onclick="useMyIp()">Use my IP</button>
      </div>
      <div id="ipMsg" class="note" style="margin-top:8px"></div>
      <div class="note" style="margin-top:12px">
        <b>Endpoints</b> &mdash; share these with HR:<br>
        <span class="mono" id="hrUrls"></span>
      </div>
    </div>
  </div>
</section>

</div>

<div id="modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:50" onclick="closeModal(event)">
  <div style="max-width:560px;margin:6vh auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden" onclick="event.stopPropagation()">
    <div style="padding:16px 18px;border-bottom:1px solid var(--line)">
      <b id="mTitle"></b><div class="hint" id="mDate"></div>
    </div>
    <div style="padding:8px 18px;max-height:58vh;overflow:auto" id="mBody"></div>
    <div style="padding:12px 18px;border-top:1px solid var(--line)">
      <button style="width:100%" onclick="closeModal()">Done</button></div>
  </div>
</div>

<script>
// A thrown error used to stop the whole dashboard silently: everything still
// drew, but nothing ever loaded. Surface it where it can be seen.
window.onerror = function(msg, src, line, col){
  var el = document.getElementById('hdrTick');
  if (el){ el.textContent = 'script error: ' + msg + ' (line ' + line + ')'; el.className = 'badge off'; }
  return false;
};
var LAB = {verify:{},status:{}};
var timer = null;
var ATT_SEEDED = false;
var EVENTS = [];

function q(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function ago(ms){
  var s = Math.round((Date.now()-ms)/1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s/60) + 'm ago';
  if (s < 86400) return Math.round(s/3600) + 'h ago';
  return Math.round(s/86400) + 'd ago';
}
function params(){
  var p = new URLSearchParams();
  if (q('fq').value) p.set('q', q('fq').value);
  if (q('fpin').value) p.set('pin', q('fpin').value);
  if (q('fname').value) p.set('name', q('fname').value);
  if (q('fdir').value) p.set('dir', q('fdir').value);
  if (q('fverify').value) p.set('verify', q('fverify').value);
  if (q('ffrom').value) p.set('from', q('ffrom').value);
  if (q('fto').value) p.set('to', q('fto').value);
  if (q('fraw').checked) p.set('raw', '1');
  p.set('limit','300');
  return p;
}
function debounced(){ clearTimeout(timer); timer = setTimeout(refresh, 250); }
function clearFilters(){
  ['fq','fpin','fname','fdir'].forEach(function(id){ q(id).value = ''; });
  q('fverify').value = 'face';
  q('fraw').checked = false;
  setRange('log', 0);                // reset lands on today, like a fresh open
}

function isoDay(back){
  var d = new Date(Date.now() - (Number(back) || 0) * 86400000);
  var p = function(x){ return String(x).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// Both the log and the attendance report open on today and share one set of
// range buttons, so "what happened today" is the default question either tab
// answers. Typing in a date box directly drops the highlight - the range is
// then whatever was typed.
function markRange(id, days){
  var box = document.getElementById(id);
  if (!box) return;
  var bs = box.getElementsByTagName('button');
  for (var i = 0; i < bs.length; i++)
    bs[i].className = bs[i].getAttribute('data-d') === String(days) ? 'on' : '';
}

function setRange(scope, days){
  var att = scope === 'att';
  var all = days === '' || days === null;
  document.getElementById(att ? 'aFrom' : 'ffrom').value = all ? '' : isoDay(days);
  document.getElementById(att ? 'aTo' : 'fto').value = all ? '' : isoDay(0);
  markRange(att ? 'aRange' : 'fRange', all ? '' : days);
  if (att) loadAtt(); else refresh();
}
var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];
var DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
// Clocks read 24-hour throughout: the punches come off the terminals that way
// and a shift that runs past noon is easier to scan without AM/PM.
function pad2(n){ return String(n).padStart(2, '0'); }
function clock(t){
  var d = t instanceof Date ? t : new Date(t);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
function stampOf(t){
  var d = t instanceof Date ? t : new Date(t);
  return pad2(d.getDate()) + ' ' + MONTHS[d.getMonth()] + ' ' + clock(d);
}
// "2026-09-03 11:25:06" -> {date:"03 Sept (Thu)", time:"11:25"}
function fmtStamp(str){
  var m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[ T]([0-9]{2}):([0-9]{2}))?/.exec(str || '');
  if (!m) return { date: str || '', time: '' };
  var dt = new Date(+m[1], +m[2] - 1, +m[3]);
  var date = m[3] + ' ' + MONTHS[+m[2] - 1] + ' (' + DAYS[dt.getDay()] + ')';
  if (m[4] === undefined) return { date: date, time: '' };
  return { date: date, time: m[4] + ':' + m[5] };
}

var TAB = 'att';
function showTab(name){
  TAB = name;
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++)
    tabs[i].className = 'tab' + (tabs[i].dataset.tab === name ? ' on' : '');
  var secs = document.querySelectorAll('section[data-panel]');
  for (var j = 0; j < secs.length; j++) secs[j].hidden = secs[j].dataset.panel !== name;
  try { localStorage.setItem('tab', name); } catch (e) {}
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
  if (name === 'door') loadDoor();
  if (name === 'info') loadStats();
  if (name === 'srv') loadIps();
  refresh();
}
document.getElementById('tabs').addEventListener('click', function(e){
  var b = e.target.closest('.tab');
  if (b) showTab(b.dataset.tab);
});
window.addEventListener('hashchange', function(){
  var h = location.hash.slice(1);
  if (h && h !== TAB && document.querySelector('section[data-panel="' + h + '"]')) showTab(h);
});

function boot(){
  // the hash wins so a tab can be linked to directly, then the last tab used
  var saved = location.hash.slice(1);
  if (!saved) { try { saved = localStorage.getItem('tab') || 'att'; } catch (e) { saved = 'att'; } }
  if (!document.querySelector('section[data-panel="' + saved + '"]')) saved = 'att';
  // every panel opens on today; the range buttons widen it from there
  q('ffrom').value = isoDay(0);
  q('fto').value = isoDay(0);
  showTab(saved);
  loadIps();
  setInterval(function(){ if (TAB === 'info') loadStats(); }, 30000);
  setInterval(function(){ if (TAB === 'door') loadDoor(); }, 5000);
}

function refresh(){
  fetch('/api/state?' + params().toString())
    .then(function(r){ return r.json(); })
    .then(render)
    .catch(function(){ q('hdrTick').textContent = 'server unreachable'; });
}

// Newest first, so following means staying pinned to the top. With follow off
// the scroll position is held across refreshes, which is what makes reading
// back through a trace on a live server possible at all.
var PRIVILEGE = {'0':'User','2':'Enroller','6':'Manager','14':'Super admin'};

// Drawn from PEOPLE rather than from the response, so typing in the filter
// redraws the list without waiting for the next poll.
function renderUsers(){
  var term = (q('uq').value || '').toLowerCase();
  var list = PEOPLE || [];
  if (term) list = list.filter(function(u){
    return String(u.pin).toLowerCase().indexOf(term) >= 0
      || String(u.name || '').toLowerCase().indexOf(term) >= 0;
  });
  q('tbUsers').innerHTML = list.map(function(u){
    var bio = u.bio ? Object.keys(u.bio).join(', ') : '';
    return '<tr><td class="mono">' + esc(u.pin) + '</td><td>' + esc(u.name) + '</td>'
      + '<td class="mono">' + esc(u.card || '') + '</td>'
      + '<td>' + esc(PRIVILEGE[u.privilege] || u.privilege || 'User') + '</td>'
      + '<td style="color:#8b949e">' + esc(bio) + '</td></tr>';
  }).join('');
  var empty = q('emptyUsers');
  empty.style.display = list.length ? 'none' : 'block';
  empty.innerHTML = (PEOPLE || []).length
    ? 'No user matches that filter.'
    : 'No users synced yet &mdash; press <b>Pull from device</b>.';
}

function renderTrace(){
  var box = q('trace');
  if (!box) return;
  var term = (q('trq').value || '').toLowerCase();
  var list = EVENTS;
  if (term) list = list.filter(function(e){
    return (e.kind + ' ' + e.sn + ' ' + e.msg).toLowerCase().indexOf(term) >= 0;
  });
  var at = box.scrollTop;
  box.innerHTML = list.map(function(e){
    return '<div class="' + e.kind + '">' + clock(e.t)
      + ' [' + esc(e.sn) + '] ' + esc(e.msg) + '</div>';
  }).join('')
    || '<div class="info">' + (term ? 'nothing matches that filter' : 'no traffic yet') + '</div>';
  box.scrollTop = q('trFollow').checked ? 0 : at;
}

function render(s){
  LAB = s.labels;
  var vsel = q('fverify');
  if (vsel.options.length <= 2) {
    var seen = {};
    Object.keys(LAB.verify || {}).forEach(function(k){
      // 15 and 20 are both "Face" and are already covered by the Face option
      if (LAB.verify[k] === 'Face' || seen[LAB.verify[k]]) return;
      seen[LAB.verify[k]] = 1;
      var o = document.createElement('option'); o.value = k; o.textContent = LAB.verify[k];
      vsel.appendChild(o);
    });
  }
  q('cToday').textContent = s.totals.today;
  q('cTotal').textContent = s.totals.logs;
  q('cUsers').textContent = s.totals.users;
  q('cDev').textContent   = s.totals.devices;
  q('hdrPort').textContent = 'port ' + s.port + ' - ' + (s.tz || 'local time');
  q('hdrTick').textContent = 'updated ' + clock(new Date());

  var online = s.devices.filter(function(d){ return d.online; });
  var h = q('hdrDev');
  h.textContent = online.length ? online.length + ' device online' : (s.devices.length ? 'device offline' : 'no device');
  h.className = 'badge ' + (online.length ? 'on' : (s.devices.length ? 'off' : ''));

  // devices
  if (!s.devices.length) {
    q('devBox').innerHTML = '<div class="hint">No device has connected yet. Configure the ADMS / Cloud Server settings shown below, then reboot the terminal.</div>';
  } else {
    q('devBox').innerHTML = s.devices.map(function(d){
      var i = d.info || {};
      return '<div style="margin-bottom:12px">'
        + '<div class="row" style="justify-content:space-between"><b class="mono">' + esc(d.sn) + '</b>'
        + '<span class="row"><span class="badge ' + (d.online?'on':'off') + '">'
        + (d.online?'online':'offline') + '</span>'
        + '<button onclick="cmd(&quot;info&quot;,' + esc(JSON.stringify({sn:d.sn})) + ')">Refresh info</button>'
        + '</span></div>'
        + '<div class="hint" style="margin-top:6px">'
        + 'IP <b>' + esc(d.ip||'?') + '</b><br>'
        + 'Model <b>' + esc((i.DeviceName || i['~DeviceName'] || 'AIFACE-MARS').split(',')[0]) + '</b>'
        + ' <span class="hint">' + esc(i.Platform || '') + '</span><br>'
        + 'LAN IP <b>' + esc(i.IPAddress || '?') + '</b> &middot; MAC <b>' + esc(i.MAC || '?') + '</b><br>'
        + 'Firmware <b>' + esc(i.FWVersion || i['~ZKFPVersion'] || '?') + '</b><br>'
        + 'Faces <b>' + esc(i.FaceCount || i.face_count || '?') + '</b> &middot; '
        + 'Users <b>' + esc(i.UserCount || i.user_count || '?') + '</b> &middot; '
        + 'Logs <b>' + esc(i.TransactionCount || i.transaction_count || '?') + '</b><br>'
        + 'Last contact <b>' + (d.lastSeen ? ago(d.lastSeen) : 'never') + '</b><br>'
        + (d.clockOffset
            ? 'Terminal clock <b>' + Math.abs(d.clockOffset) + ' min '
              + (d.clockOffset > 0 ? 'behind' : 'ahead') + '</b> &middot; punches corrected to Indian time'
            : 'Terminal clock <b>in step</b> with Indian time')
        + '</div>'
        + '<div class="row" style="margin-top:6px;align-items:center">'
        + '<span class="hint">Gate role</span>'
        + '<select data-sn="' + esc(d.sn) + '" onchange="setRole(this.dataset.sn, this.value)">'
        + '<option value=""' + (d.role ? '' : ' selected') + '>Unassigned</option>'
        + '<option value="in"' + (d.role === 'in' ? ' selected' : '') + '>Check-in terminal</option>'
        + '<option value="out"' + (d.role === 'out' ? ' selected' : '') + '>Check-out terminal</option>'
        + '</select></div></div>';
    }).join('');
  }

  // logs
  var tb = '';
  for (var i = 0; i < s.logs.length; i++) {
    var r = s.logs[i];
    var st = r.dir === 'in' ? 'Check-in' : r.dir === 'out' ? 'Check-out'
           : (LAB.status[r.status] || ('Status ' + r.status));
    var cls = r.dir || '';
    var f = fmtStamp(r.time);
    tb += '<tr><td class="mono">' + esc(f.date) + ' <b>' + esc(f.time) + '</b></td>'
       + '<td class="mono">' + esc(r.pin) + '</td>'
       + '<td>' + (esc(r.name) || '<span style="color:#8b949e">&mdash;</span>') + '</td>'
       + '<td><span class="pill ' + cls + '">' + esc(st) + '</span>'
       + (r.taps > 1 ? ' <span class="tag">' + r.taps + ' taps</span>' : '') + '</td>'
       + '<td>' + esc(LAB.verify[r.verify] || ('Mode ' + r.verify)) + '</td>'
       + '<td class="mono" style="color:#8b949e">' + esc(r.sn) + '</td></tr>';
  }
  q('tbLogs').innerHTML = tb;
  q('emptyLogs').style.display = s.logs.length ? 'none' : 'block';

  PEOPLE = s.users;
  if (!q('aTo').value && !ATT_SEEDED){
    ATT_SEEDED = true;
    setRange('att', 0);               // open on everyone, today
  }

  // users
  renderUsers();

  // trace
  EVENTS = s.events;
  renderTrace();

  // queue
  q('queue').innerHTML = s.queue.map(function(c){
    var st = c.returned ? ('done (ret ' + c.result + ')') : (c.sent ? 'sent, awaiting reply' : 'pending');
    var col = c.returned ? 'srv' : (c.sent ? 'info' : 'dev');
    return '<div class="' + col + '">#' + c.id + ' ' + esc(c.cmd.split('\\t')[0]) + ' &mdash; ' + st + '</div>';
  }).join('') || '<div class="info">queue empty</div>';

  // setup help
  var ip = s.ips[0] || 'YOUR-PC-IP';
  q('setup').innerHTML =
    'On the terminal: <b>Menu &rarr; COMM &rarr; Cloud Server Setting (ADMS)</b><br><br>'
    + 'Server Address <code>' + esc(ip) + '</code><br>'
    + 'Server Port <code>' + s.port + '</code><br>'
    + 'Enable Domain Name <code>OFF</code><br>'
    + 'Enable Proxy Server <code>OFF</code><br><br>'
    + 'Save and reboot the device. Detected addresses on this machine: <code>'
    + esc(s.ips.join('  ')) + '</code>';
}

var toastTimer = null;
function toast(msg, cls){
  var el = q('toast');
  if (!el){ el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.className = 'toast ' + (cls || '');
  el.innerHTML = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.remove(); }, 6000);
}

function doorState(cls, msg){
  var b = q('bigDoor');
  if (b) b.className = 'door ' + (cls || '');
  var m = q('doorMsg');
  if (m) m.innerHTML = msg;
  if (cls === 'ok' || cls === 'bad') setTimeout(function(){
    if (q('bigDoor')) q('bigDoor').className = 'door';
  }, 5000);
}

// The terminal collects commands on its next poll and answers separately, so
// the button waits for that answer instead of claiming success immediately.
function openDoor(){
  toast('Sending to the terminal&hellip;');
  doorState('busy', 'Sending&hellip;');
  fetch('/api/cmd', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({kind:'unlock'})})
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (!j.ok){ doorState('bad', esc(j.error || 'failed')); return toast(esc(j.error || 'failed'), 'bad'); }
      var ids = j.queued.map(function(c){ return c.id; });
      var m = 'Queued for ' + j.targets.length + ' terminal(s), waiting for a reply&hellip;';
      toast(m); doorState('busy', m);
      pollDoor(ids, Date.now() + 30000);
    })
    .catch(function(){ doorState('bad', 'Server unreachable'); toast('Server unreachable', 'bad'); });
}
function pollDoor(ids, deadline){
  fetch('/api/cmd/status?ids=' + ids.join(','))
    .then(function(r){ return r.json(); })
    .then(function(j){
      var all = j.items.concat(j.followups);
      if (all.some(function(c){ return c.ok === true; })){
        // all the protocol tells us is that the command was accepted
        var m = 'Terminal accepted the unlock. If the door did not move, the lock is not '
          + 'wired to this terminal or its Door Lock Delay is 0 &mdash; see Door diagnostics.';
        doorState('ok', m);
        return toast('Unlock accepted by the terminal.', 'ok');
      }
      // a rejected wording spawns a retry; keep waiting while one is in flight
      var pending = !all.length || all.some(function(c){ return c.ok === null; });
      if (!pending){
        var last = all[all.length-1];
        var b = 'The terminal refused every unlock wording (last reply <b>'
          + esc(String(last && last.result)) + '</b>). Run <b>Try every unlock form</b> below.';
        doorState('bad', b);
        return toast(b, 'bad');
      }
      if (Date.now() > deadline){
        var t = 'No answer in 30s &mdash; the terminal is offline, or it connects but never '
          + 'collects commands. Check Door diagnostics.';
        doorState('bad', t);
        return toast(t, 'bad');
      }
      setTimeout(function(){ pollDoor(ids, deadline); }, 1000);
    })
    .catch(function(){ doorState('bad', 'Server unreachable'); toast('Server unreachable', 'bad'); });
}

function loadDoor(){
  fetch('/api/door/log').then(function(r){ return r.json(); }).then(function(j){
    var on = j.devices.filter(function(d){ return d.online; });
    q('doorDev').innerHTML = j.devices.map(function(d){
      return '<div class="row" style="justify-content:space-between;padding:5px 0">'
        + '<span class="mono">' + esc(d.sn) + '</span>'
        + '<span class="row" style="gap:6px">'
        + '<span class="tag">' + (d.lastCmd ? 'collects commands' : 'never collected a command') + '</span>'
        + (d.unlockCmd ? '<span class="tag face">accepts ' + esc(d.unlockCmd.split(' ')[0]) + '</span>' : '')
        + '<span class="badge ' + (d.online ? 'on' : 'off') + '">'
        + (d.online ? 'online' : 'offline') + '</span></span></div>';
    }).join('') || '<div class="note">No terminal has ever connected.</div>';
    if (!on.length) q('doorDev').innerHTML += '<div class="note" style="margin-top:8px;color:var(--bad)">'
      + 'Nothing is online, so no command can reach a door right now.</div>';

    q('tbDoor').innerHTML = j.items.map(function(c){
      var reply = c.returned
        ? '<b style="color:' + (c.ok ? 'var(--ok)' : 'var(--bad)') + '">' + esc(String(c.result)) + '</b>'
          + (c.ok ? ' accepted' : ' refused')
        : (c.sent ? '<span style="color:var(--warn)">no reply yet</span>'
                  : '<span style="color:var(--dim)">not collected</span>');
      return '<tr><td class="mono">' + clock(c.created) + '</td>'
        + '<td class="mono" style="color:#8b949e">' + esc(c.sn.slice(-4)) + '</td>'
        + '<td class="mono">' + esc(c.cmd) + (c.probe ? ' <span class="tag">test</span>' : '') + '</td>'
        + '<td>' + (c.sent ? clock(c.sent) : '&mdash;') + '</td>'
        + '<td>' + reply + '</td></tr>';
    }).join('');
    q('emptyDoor').style.display = j.items.length ? 'none' : 'block';
  }).catch(function(){});
}

function doorProbe(){
  if (!confirm('Send every unlock wording to each online terminal once?\\n\\n'
    + 'If one of them works the door will open during the test.')) return;
  fetch('/api/door/probe', {method:'POST'})
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (!j.ok) return toast(esc(j.error || 'failed'), 'bad');
      toast('Sent ' + j.queued.length + ' test command(s). Replies appear below within '
        + 'a few seconds of each terminal polling.');
      setTimeout(loadDoor, 1200);
    });
}

// Names go missing when someone is enrolled on the terminal but never synced
// here, and punches go missing when the terminal was offline. One press asks
// for both: who is enrolled, then the last 30 days of punches. Already-stored
// punches are ignored on arrival, so this is safe to press at any time.
function syncData(){
  var box = q('cmdMsg');
  if (box) box.textContent = 'asking the terminals for users and the last 30 days...';
  Promise.all([post('queryuser', {}), post('queryatt', {days: 30})])
    .then(function(rs){
      var bad = rs.filter(function(r){ return !r.ok; });
      if (box) box.textContent = bad.length
        ? (bad[0].error || 'the terminals did not accept the request')
        : 'requested - the terminals answer over the next minute or two.';
      refresh();
    });
}

function post(kind, extra){
  return fetch('/api/cmd', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(Object.assign({kind: kind}, extra || {}))})
    .then(function(r){ return r.json(); })
    .catch(function(){ return {ok:false, error:'server unreachable'}; });
}

function cmd(kind, extra, confirmMsg){
  if (confirmMsg && !confirm(confirmMsg)) return;
  var payload = Object.assign({kind: kind}, extra || {});
  fetch('/api/cmd', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)})
    .then(function(r){ return r.json(); })
    .then(function(j){ if (!j.ok) alert(j.error || 'failed'); refresh(); });
}
function addUser(){
  var pin = q('uPin').value.trim();
  if (!pin) return alert('PIN is required');
  cmd('adduser', {pin: pin, name: q('uName').value.trim(), card: q('uCard').value.trim(), pri: q('uPri').value});
  q('uName').value = ''; q('uCard').value = '';
}
function delUser(){
  var pin = q('uPin').value.trim();
  if (!pin) return alert('PIN is required');
  if (!confirm('Delete user ' + pin + ' from the device?')) return;
  cmd('deluser', {pin: pin});
}
function purge(){
  if (!confirm('Delete all attendance history stored on this server? The device keeps its own copy.')) return;
  fetch('/api/purge', {method:'POST'}).then(refresh);
}
function setRole(sn, role){
  fetch('/api/role', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ sn: sn, role: role }) }).then(refresh);
}
var ATT = null, PEOPLE = [], FACE = 1;
function hm(m){ return (m/60|0) + 'h ' + (m%60) + 'm'; }
function num(n){ return (Number(n) || 0).toLocaleString(); }
function setFace(on){
  FACE = on ? 1 : 0;
  q('aFace1').className = on ? 'on' : '';
  q('aFace0').className = on ? '' : 'on';
  q('aRule').textContent = on ? 'Face verified only' : 'Every verification mode';
  q('aRule').className = on ? 'tag face' : 'tag';
  loadAtt();
}
function bytes(b){
  var u = ['B','KB','MB','GB'], i = 0;
  while (b >= 1024 && i < u.length-1){ b /= 1024; i++; }
  return (i ? b.toFixed(1) : b) + ' ' + u[i];
}

function pickOpen(){ pickFilter(); q('aList').style.display = 'block'; }
function pickFilter(){
  // the box no longer matches the pinned employee, so fall back to everyone
  if (q('aUser').value && q('aSearch').value.indexOf('PIN ' + q('aUser').value) < 0){
    q('aUser').value = ''; loadAtt();
  }
  var t = q('aSearch').value.toLowerCase();
  var hits = PEOPLE.filter(function(u){
    return !t || (u.name||'').toLowerCase().indexOf(t) > -1 || String(u.pin).indexOf(t) > -1;
  }).slice(0, 60);
  var all = '<div class="opt" data-pin="" data-name=""'
    + ' style="padding:9px 12px;cursor:pointer;border-bottom:1px solid #1c222b">'
    + '<b>Everyone</b> <span class="hint">all ' + PEOPLE.length + ' employees</span></div>';
  q('aList').innerHTML = all + (hits.length ? hits.map(function(u){
    return '<div class="opt" data-pin="' + esc(u.pin) + '" data-name="' + esc(u.name||'') + '"'
      + ' style="padding:9px 12px;cursor:pointer;border-bottom:1px solid #1c222b">'
      + '<b>' + (esc(u.name) || '(no name)') + '</b>'
      + ' <span class="hint">PIN ' + esc(u.pin) + '</span></div>';
  }).join('') : '<div class="hint" style="padding:10px 12px">No match</div>');
  q('aList').style.display = 'block';
}
function pickChoose(pin, name){
  q('aUser').value = pin || '';
  q('aSearch').value = !pin ? '' : (name ? name + '  -  PIN ' + pin : 'PIN ' + pin);
  q('aList').style.display = 'none';
  loadAtt();
}
document.addEventListener('click', function(e){
  if (e.target.closest && e.target.closest('.opt')){
    var o = e.target.closest('.opt');
    return pickChoose(o.dataset.pin, o.dataset.name);
  }
  if (!e.target.closest || !e.target.closest('#aList,#aSearch')) {
    var l = q('aList'); if (l) l.style.display = 'none';
  }
});

function loadAtt(){
  var pin = q('aUser').value;
  var p = new URLSearchParams({from:q('aFrom').value, to:q('aTo').value, face:FACE});
  if (pin) p.set('pin', pin);
  fetch('/api/attendance?' + p.toString())
    .then(function(r){ return r.json(); })
    .then(pin ? renderAtt : renderEveryone)
    .catch(function(){ q('emptyAtt').textContent = 'Could not load attendance.'; });
}

// No employee picked: one row per person for the same window, same rules.
function renderEveryone(a){
  ATT = { everyone: true, from: a.from, to: a.to, rows: a.rows };
  var worked = a.rows.filter(function(r){ return r.totals.present; });
  var sum = function(k){ return a.rows.reduce(function(x,r){ return x + r.totals[k]; }, 0); };
  q('aKpis').innerHTML = '<div class="grid">'
    + kpi('Employees', a.rows.length)
    + kpi('With attendance', worked.length, worked.length ? 'var(--ok)' : '')
    + kpi('Days in range', a.rows.length ? a.rows[0].totals.totalDays : 0)
    + kpi('Present days', sum('present'), 'var(--ok)')
    + kpi('Total hours', hm(sum('totalMin')))
    + kpi('Break', hm(sum('breakMin')), 'var(--warn)')
    + '</div>';
  q('attTable').querySelector('thead').innerHTML =
    '<tr><th>PIN</th><th>Name</th><th>Present</th><th>Absent</th>'
    + '<th>Total</th><th>Break</th><th>Net hours</th></tr>';
  q('tbAtt').innerHTML = a.rows.map(function(r){
    var t = r.totals;
    return '<tr style="cursor:pointer" onclick="pickChoose(' + JSON.stringify(String(r.pin))
      + ',' + JSON.stringify(r.name || '') + ')">'
      + '<td class="mono">' + esc(r.pin) + '</td>'
      + '<td>' + (esc(r.name) || '<span style="color:#8b949e">&mdash;</span>') + '</td>'
      + '<td class="num" style="color:' + (t.present ? 'var(--ok)' : 'var(--dim)') + '">'
      + t.present + '</td>'
      + '<td class="num" style="color:' + (t.absent ? 'var(--bad)' : 'var(--dim)') + '">'
      + t.absent + '</td>'
      + '<td class="num">' + hm(t.totalMin) + '</td>'
      + '<td class="num"' + (t.breakMin ? ' style="color:var(--warn)"' : '') + '>'
      + hm(t.breakMin) + '</td>'
      + '<td class="num"><b>' + hm(t.workMin) + '</b></td></tr>';
  }).join('');
  q('emptyAtt').style.display = a.rows.length ? 'none' : 'block';
  q('emptyAtt').textContent = 'No employees synced from the terminal yet.';
  q('aFoot').innerHTML = 'Every employee, ' + esc(a.from) + ' to ' + esc(a.to) + ', counting '
    + (a.verifiedBy === 'face' ? '<b>face-verified punches only</b>' : 'every verification mode')
    + '. Click a row to open that person\u2019s daily log.';
}

function renderAtt(a){
  ATT = a;
  var t = a.totals;
  q('aKpis').innerHTML = '<div class="grid">'
    + kpi('Total days', t.totalDays) + kpi('Present', t.present, 'var(--ok)')
    + kpi('Absent', t.absent, t.absent ? 'var(--bad)' : '') + kpi('Sundays', t.sundays)
    + kpi('Total hours', hm(t.totalMin)) + kpi('Break', hm(t.breakMin), 'var(--warn)')
    + kpi('Net hours', hm(t.workMin), 'var(--accent)') + '</div>';

  q('attTable').querySelector('thead').innerHTML =
    '<tr><th>Date</th><th>Status</th><th>Check-in &ndash; Check-out</th>'
    + '<th>Total</th><th>Break</th><th>Net hours</th><th>Movements</th></tr>';

  var tb = '';
  for (var i = 0; i < a.days.length; i++){
    var d = a.days[i];
    var f = fmtStamp(d.date);
    var col = d.status === 'Present' ? 'var(--ok)' : d.status === 'Absent' ? 'var(--bad)' : 'var(--dim)';
    var span = d.in && d.out ? '<span class="t">' + fmtStamp(d.in).time + '</span> &ndash; <span class="t">'
                 + fmtStamp(d.out).time + '</span>'
             : d.in ? '<span class="t">' + fmtStamp(d.in).time
                 + '</span> &ndash; <span style="color:var(--warn)">seen once only</span>'
             : '<span style="color:#8b949e">Not marked</span>';
    tb += '<tr style="cursor:pointer" onclick="openDay(' + i + ')">'
       + '<td>' + esc(f.date) + '</td>'
       + '<td style="color:' + col + '">' + esc(d.status)
       + (d.incomplete ? ' <span class="tag">no check-out</span>' : '') + '</td>'
       + '<td>' + span + '</td>'
       + '<td class="num">' + hm(d.totalMin) + '</td>'
       + '<td class="num"' + (d.breakMin ? ' style="color:var(--warn)"' : '') + '>' + hm(d.breakMin)
       + (d.breaks && d.breaks.length > 1 ? ' <span class="hint">(' + d.breaks.length + ')</span>' : '')
       + '</td>'
       + '<td class="num"><b>' + hm(d.workMin) + '</b></td>'
       + '<td class="num" style="color:#8b949e">' + d.punches
       + (d.ignored ? ' <span class="hint">+' + d.ignored + ' other</span>' : '') + '</td></tr>';
  }
  q('tbAtt').innerHTML = tb;
  q('emptyAtt').style.display = a.days.length ? 'none' : 'block';
  q('emptyAtt').textContent = 'No days in this range.';
  q('aFoot').innerHTML = 'Counting '
    + (a.verifiedBy === 'face' ? '<b>face-verified punches only</b>' : 'every verification mode')
    + '. A day reads first movement in, last movement out, and the pairs between them as breaks; '
    + 'repeat taps at the same gate are folded into one movement.'
    + (t.ignored ? ' <b>' + t.ignored + '</b> card or fingerprint punch(es) in this range were not counted.' : '');
}
function kpi(k, v, col){
  return '<div class="card"><div class="k">' + k + '</div><div class="v"'
    + (col ? ' style="color:' + col + '"' : '') + '>' + v + '</div></div>';
}

var STEP = {'Check in':'a','Check out':'z','Break start':'bs','Break end':'be','Extra punch':'x'};
// what the gap before this movement means: at work, or away from it
var GAP = {'Break end':['Away on break','var(--warn)'],
           'Check out':['At work','var(--ok)'],
           'Break start':['At work','var(--ok)'],
           'Extra punch':['','']};

function openDay(i){
  var d = ATT.days[i];
  q('mTitle').textContent = (ATT.name || ('PIN ' + ATT.pin)) + '  -  ' + fmtStamp(d.date).date;
  q('mDate').innerHTML = d.events.length
    ? '<b style="color:var(--fg)">' + hm(d.workMin) + '</b> worked &middot; '
      + hm(d.totalMin) + ' on site &middot; ' + hm(d.breakMin) + ' break &middot; '
      + d.punches + ' movement' + (d.punches === 1 ? '' : 's')
      + (d.taps > d.punches ? ' from ' + d.taps + ' taps' : '')
      + (d.ignored ? ' &middot; ' + d.ignored + ' non-face punch(es) skipped' : '')
    : 'Nothing recorded on this day.';

  if (!d.events.length){
    q('mBody').innerHTML = '<div class="empty">No face punches on this day.</div>';
  } else {
    var html = '<div class="tl">';
    for (var k = 0; k < d.events.length; k++){
      var e = d.events[k], prev = d.events[k-1];
      if (prev){
        var mins = Math.round((new Date(e.time.replace(' ','T')) - new Date(prev.time.replace(' ','T')))/60000);
        // an unmatched tap gets the elapsed time but no claim about where
        // the person was, because that is exactly what we do not know
        var g = GAP[e.label] || ['',''];
        html += '<div class="gap">&#9474;&nbsp; ' + hm(Math.max(0,mins))
          + (g[0] ? ' <span style="color:' + g[1] + '">' + g[0] + '</span>' : '') + '</div>';
      }
      var f = fmtStamp(e.time);
      html += '<div class="ev ' + (STEP[e.label] || 'x') + '">'
        + '<div><b>' + esc(e.label) + '</b> <span class="t" style="color:var(--dim)">'
        + esc(f.time) + '</span>'
        + (e.taps > 1 ? ' <span class="tag">' + e.taps + ' taps, first ' + esc(fmtStamp(e.from).time) + '</span>' : '')
        + '</div>'
        + '<div class="hint">' + esc(LAB.verify[e.verify] || ('mode ' + e.verify))
        + ' &middot; gate ' + esc(e.sn) + '</div></div>';
    }
    html += '</div>';
    if (d.events.length === 1) html += '<div class="note" style="padding:0 0 12px">'
      + 'Only one movement, so there is nothing to close the day against &mdash; '
      + 'no hours are counted.</div>';
    q('mBody').innerHTML = html;
  }
  q('modal').style.display = 'block';
}
function closeModal(e){ if (!e || e.target === q('modal')) q('modal').style.display = 'none'; }
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeModal(); });

function attCsv(){
  if (!ATT) return;
  var rows, name;
  if (ATT.everyone){
    name = 'all-employees-' + ATT.from + '-to-' + ATT.to;
    rows = [['PIN','Name','Days','Present','Absent','Total','Break','Net hours']];
    ATT.rows.forEach(function(r){
      var t = r.totals;
      rows.push([r.pin, r.name, t.totalDays, t.present, t.absent,
                 hm(t.totalMin), hm(t.breakMin), hm(t.workMin)]);
    });
  } else {
    name = 'attendance-' + (ATT.name || ATT.pin);
    rows = [['Date','Status','Check in','Break start','Break end','Check out',
             'Total','Break','Net hours','Movements']];
    ATT.days.forEach(function(d){
      var b = (d.breaks || []).map(function(x){ return fmtStamp(x.from).time; }).join(' + ');
      var e = (d.breaks || []).map(function(x){ return fmtStamp(x.to).time; }).join(' + ');
      rows.push([d.date, d.status, fmtStamp(d.in).time, b, e, fmtStamp(d.out).time,
                 hm(d.totalMin), hm(d.breakMin), hm(d.workMin), d.punches]);
    });
  }
  var esc2 = function(v){ return '"' + String(v == null ? '' : v).replace(/"/g,'""') + '"'; };
  var csv = rows.map(function(r){ return r.map(esc2).join(','); }).join(String.fromCharCode(13,10));
  var a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = name + '.csv';
  a.click();
}

// Bars are drawn rather than pulled from a chart library: the dashboard ships
// as one file with no network access of its own, and a bar chart is a rect and
// a label. Every bar carries its own value as a tooltip.
function bars(series, label, unit){
  if (!series.length) return '<div class="hint">nothing in this range</div>';
  var max = Math.max.apply(null, series.map(function(p){ return p.count; }).concat([1]));
  var w = series.length > 40 ? 7 : 13, gap = series.length > 40 ? 2 : 4, h = 64;
  var every = Math.ceil(series.length / 16);      // keep the axis readable
  return '<svg width="' + (series.length*(w+gap)) + '" height="' + (h+18) + '" role="img">'
    + series.map(function(p, i){
        var bh = Math.max(2, Math.round(p.count / max * h));
        return '<rect x="' + (i*(w+gap)) + '" y="' + (h-bh) + '" width="' + w + '" height="' + bh
          + '" rx="2" fill="' + (p.count ? '#2f81f7' : '#30363d') + '"><title>'
          + esc(label(p)) + ': ' + p.count + ' ' + unit + '</title></rect>'
          + (i % every ? '' : '<text x="' + (i*(w+gap)+w/2) + '" y="' + (h+13)
             + '" font-size="9" fill="#8b949e" text-anchor="middle">' + esc(p.date.slice(-2)) + '</text>');
      }).join('')
    + '</svg>';
}

var STAT_DAYS = 14;
function setStatDays(n){
  STAT_DAYS = n;
  markRange('sRange', n);
  loadStats();
}

function loadStats(){
  fetch('/api/stats?days=' + STAT_DAYS).then(function(r){ return r.json(); }).then(function(t){
    var memPct = Math.round((1 - t.host.freeMem/t.host.totalMem) * 100);
    q('statBox').innerHTML = '<div class="grid">'
      + kpi('Stored data', bytes(t.store.total))
      + kpi('Punches', t.counts.logs)
      + kpi('Employees', t.counts.users)
      + kpi('Devices online', t.counts.online + ' / ' + t.counts.devices,
            t.counts.online ? 'var(--ok)' : 'var(--bad)')
      + kpi('Server uptime', hm(Math.round(t.proc.uptime/60)))
      + kpi('Process memory', bytes(t.proc.rss))
      + kpi('Host memory', memPct + '%', memPct > 85 ? 'var(--warn)' : '')
      + kpi('Load (1m)', t.host.load[0], t.host.load[0] > t.host.cpus ? 'var(--warn)' : '')
      + '</div>'
      + '<div class="hint" style="margin-bottom:6px">Punches per day &mdash; last '
      + t.days + ' days, ' + t.series.reduce(function(a,p){ return a+p.count; }, 0) + ' in total</div>'
      + '<div style="overflow-x:auto">'
      + bars(t.series, function(p){ return p.date; }, 'punches') + '</div>'
      + '<div class="hint" style="margin:14px 0 6px">Punches per hour today ('
      + esc(t.today) + ') &mdash; 24h clock</div>'
      + '<div style="overflow-x:auto">'
      + bars(t.hours, function(p){ return p.date + ':00'; }, 'punches') + '</div>'
      + '<div class="hint" style="margin:14px 0 6px">Terminals</div>'
      + '<div class="scroll"><table><thead><tr><th>Serial</th><th>State</th><th>Gate</th>'
      + '<th>Clock</th><th>Punches</th><th>Last contact</th></tr></thead><tbody>'
      + t.devices.map(function(d){
          return '<tr><td class="mono">' + esc(d.sn) + '</td>'
            + '<td><span class="badge ' + (d.online?'on':'off') + '">'
            + (d.online?'online':'offline') + '</span></td>'
            + '<td>' + (d.role === 'in' ? 'Check-in' : d.role === 'out' ? 'Check-out' : '&mdash;') + '</td>'
            + '<td>' + (d.clockOffset
                ? Math.abs(d.clockOffset) + ' min ' + (d.clockOffset > 0 ? 'behind' : 'ahead')
                : 'in step') + '</td>'
            + '<td class="mono">' + num(d.punches) + '</td>'
            + '<td>' + (d.lastSeen ? esc(stampOf(d.lastSeen)) : 'never') + '</td></tr>';
        }).join('')
      + '</tbody></table></div>'
      + '<div class="hint" style="margin-top:12px">Files in ./data &mdash; '
      + t.store.files.map(function(f){ return esc(f.name) + ' <b>' + bytes(f.bytes) + '</b>'; }).join(' &middot; ')
      + '</div>'
      + '<div class="hint" style="margin-top:6px">Node ' + esc(t.proc.node) + ' &middot; '
      + esc(t.host.platform) + ' &middot; ' + t.host.cpus + ' CPU &middot; port ' + t.proc.port + '</div>';
  });
}

function loadIps(){
  fetch('/api/settings').then(function(r){ return r.json(); }).then(function(c){
    q('ipList').value = (c.allowIps || []).join(', ');
    q('myIp').textContent = c.yourIp || '?';
    q('doorPin').placeholder = c.doorPinSet ? 'code set - type a new one to change' : 'door code (blank = no code)';
    q('doorPinMsg').innerHTML = c.doorPinSet
      ? '<span style="color:var(--ok)">/opendoor asks for a code.</span>'
      : '<span style="color:var(--warn)">/opendoor is open to anyone on this network.</span>';
    q('setFace').checked = c.faceOnly !== false;
    q('setDwell').value = Math.round((c.dwellSec || 180) / 60);
    if (FACE !== (c.faceOnly === false ? 0 : 1)) setFace(c.faceOnly === false ? 0 : 1);
    var base = location.origin;
    q('hrUrls').innerHTML = [
      base + '/api/hr/attendance?from=2026-09-01&to=2026-09-08',
      base + '/api/hr/attendance?pin=2&from=2026-09-01&to=2026-09-08',
      base + '/api/hr/punches?from=2026-09-01&to=2026-09-08',
      base + '/api/hr/users'
    ].map(esc).join('<br>');
    q('ipMsg').innerHTML = (c.allowIps || []).length
      ? '<span style="color:var(--ok)">Allow-list active for ' + c.allowIps.length + ' address(es).</span>'
      : '<span style="color:var(--bad)">Empty list &mdash; the HR API is blocked for everyone.</span>';
  });
}
function useMyIp(){
  var cur = q('ipList').value.trim();
  var mine = q('myIp').textContent;
  q('ipList').value = cur ? cur + ', ' + mine : mine;
}
function saveDoorPin(){
  fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ doorPin: q('doorPin').value.trim() }) })
    .then(function(){ q('doorPin').value = ''; loadIps(); });
}
function saveRules(){
  var mins = Number(q('setDwell').value);
  if (!(mins >= 0 && mins <= 60)) mins = 3;
  fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ faceOnly: q('setFace').checked, dwellSec: Math.round(mins * 60) }) })
    .then(function(r){ return r.json(); })
    .then(function(c){
      q('ruleMsg').innerHTML = '<span style="color:var(--ok)">Saved.</span> Attendance now counts '
        + (c.faceOnly ? '<b>face punches only</b>' : 'every verification mode')
        + ', folding taps within ' + Math.round(c.dwellSec / 60) + ' min into one movement.';
      loadAtt();
    });
}
function saveIps(){
  var list = q('ipList').value.split(',').map(function(x){ return x.trim(); }).filter(Boolean);
  fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ allowIps: list }) }).then(loadIps);
}

function exportCsv(){ window.location = '/api/export.csv?' + params().toString(); }

boot();
setInterval(refresh, 3000);
</script>
</body></html>`;

/* ------------------------------------------------- door kiosk page (/opendoor) */

const DOOR_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Open door</title>
<style>
:root{--bg:#0b0f14;--fg:#e6edf3;--dim:#8b949e;--line:#222a35;
--accent:#3b82f6;--ok:#22c55e;--bad:#ef4444;}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;min-height:100vh;background:
radial-gradient(1100px 620px at 50% -12%,#16202e 0%,var(--bg) 62%);
color:var(--fg);font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;
display:flex;flex-direction:column;align-items:center;justify-content:center;
padding:26px;gap:26px;overflow:hidden}
.top{position:fixed;top:0;left:0;right:0;display:flex;align-items:center;gap:10px;
padding:14px 18px;font-size:12.5px;color:var(--dim)}
.dot{width:8px;height:8px;border-radius:8px;background:var(--dim);flex:0 0 auto}
.dot.on{background:var(--ok);box-shadow:0 0 0 4px rgba(34,197,94,.16)}
.dot.off{background:var(--bad);box-shadow:0 0 0 4px rgba(239,68,68,.14)}
h1{font-size:19px;font-weight:600;margin:0;letter-spacing:.2px;text-align:center}
.sub{color:var(--dim);font-size:13.5px;text-align:center;margin-top:6px}

.stage{position:relative;width:264px;height:264px;display:grid;place-items:center}
/* the ring breathes while idle so the button reads as live, not a screenshot */
.halo{position:absolute;inset:16px;border-radius:50%;border:1px solid rgba(59,130,246,.35);
animation:breathe 2.6s ease-out infinite}
.halo.b{animation-delay:1.3s}
@keyframes breathe{0%{transform:scale(.9);opacity:.55}100%{transform:scale(1.28);opacity:0}}

#btn{position:relative;width:210px;height:210px;border-radius:50%;border:0;cursor:pointer;
color:#fff;font:600 19px/1.2 inherit;letter-spacing:.4px;
background:linear-gradient(160deg,#4c8dff,#2563eb 62%,#1d4ed8);
box-shadow:0 20px 48px rgba(37,99,235,.42),inset 0 1px 0 rgba(255,255,255,.28);
transition:transform .14s cubic-bezier(.2,.7,.3,1),box-shadow .2s,background .3s;
display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:0}
#btn:active{transform:scale(.955)}
#btn:disabled{cursor:default}
#btn .ico{width:46px;height:46px;display:block}
#btn .ico path,#btn .ico circle,#btn .ico rect{stroke:#fff;stroke-width:2;fill:none;
stroke-linecap:round;stroke-linejoin:round}

/* one ripple per press, removed as soon as it finishes */
.ripple{position:absolute;border-radius:50%;background:rgba(255,255,255,.32);
transform:scale(0);animation:ripple .62s ease-out forwards;pointer-events:none}
@keyframes ripple{to{transform:scale(2.6);opacity:0}}

/* the spinner only exists while we are waiting on the terminal */
.spin{position:absolute;inset:-9px;border-radius:50%;border:3px solid transparent;
border-top-color:rgba(255,255,255,.92);border-right-color:rgba(255,255,255,.35);
animation:spin .85s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

body.busy #btn{background:linear-gradient(160deg,#3f7ae0,#1e51c9)}
body.ok #btn{background:linear-gradient(160deg,#34d27a,#16a34a 62%,#15803d);
box-shadow:0 20px 48px rgba(34,197,94,.42),inset 0 1px 0 rgba(255,255,255,.28)}
body.bad #btn{background:linear-gradient(160deg,#f87171,#dc2626 62%,#b91c1c);
box-shadow:0 20px 48px rgba(239,68,68,.4),inset 0 1px 0 rgba(255,255,255,.28)}
body.ok .halo,body.bad .halo,body.busy .halo{display:none}
/* the tick draws itself in on success */
.tick{stroke-dasharray:34;stroke-dashoffset:34;animation:draw .42s .06s ease-out forwards}
@keyframes draw{to{stroke-dashoffset:0}}

#msg{min-height:46px;max-width:420px;text-align:center;font-size:14px;color:var(--dim)}
#msg b{color:var(--fg)}
.pinbox{display:flex;gap:8px;justify-content:center}
.pinbox input{background:#0d131b;border:1px solid var(--line);color:var(--fg);border-radius:9px;
padding:11px 14px;font-size:17px;width:150px;text-align:center;letter-spacing:5px;font-family:inherit}
.foot{position:fixed;bottom:0;left:0;right:0;text-align:center;padding:13px;
font-size:12px;color:#5b6572}
.foot a{color:#5b6572}
@media(max-height:560px){.stage{width:200px;height:200px}#btn{width:162px;height:162px;font-size:17px}}
</style></head><body>
<div class="top"><span class="dot" id="dot"></span><span id="gates">checking terminals&hellip;</span></div>

<div><h1 id="head">Open the door</h1><div class="sub" id="sub">Press and hold nothing &mdash; one tap is enough.</div></div>

<div class="stage">
  <div class="halo"></div><div class="halo b"></div>
  <button id="btn" onclick="press(event)">
    <svg class="ico" id="ico" viewBox="0 0 32 32"><path id="icoPath"
      d="M20 5H9a2 2 0 0 0-2 2v18a2 2 0 0 0 2 2h11"/><path d="M20 16h6m-3-3 3 3-3 3"/></svg>
    <span id="label">Open</span>
  </button>
</div>

<div id="msg"></div>
<div class="pinbox" id="pinbox" style="display:none">
  <input id="pin" type="password" inputmode="numeric" placeholder="code" autocomplete="off">
</div>

<div class="foot"><a href="/">Attendance dashboard</a></div>

<script>
var q = function(id){ return document.getElementById(id); };
var esc = function(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
var busy = false, resetTimer = null;

function setState(cls, head, msg){
  document.body.className = cls || '';
  q('head').textContent = head;
  q('msg').innerHTML = msg || '';
}
function idle(){
  busy = false;
  q('btn').disabled = false;
  q('label').textContent = 'Open';
  var s = q('spin'); if (s) s.remove();
  q('ico').innerHTML = '<path d="M20 5H9a2 2 0 0 0-2 2v18a2 2 0 0 0 2 2h11"/>'
    + '<path d="M20 16h6m-3-3 3 3-3 3"/>';
  setState('', 'Open the door', '');
}
function finish(cls, head, msg){
  busy = false;
  q('btn').disabled = false;
  var s = q('spin'); if (s) s.remove();
  if (cls === 'ok'){
    q('label').textContent = 'Open';
    q('ico').innerHTML = '<path class="tick" d="M8 16.5 13.5 22 24 11"/>';
  } else {
    q('label').textContent = 'Retry';
    q('ico').innerHTML = '<path d="M16 9v9"/><circle cx="16" cy="23" r="1.2" fill="#fff"/>';
  }
  setState(cls, head, msg);
  clearTimeout(resetTimer);
  resetTimer = setTimeout(idle, cls === 'ok' ? 3500 : 7000);
}

function press(ev){
  var b = q('btn');
  var r = b.getBoundingClientRect(), d = Math.max(r.width, r.height);
  var el = document.createElement('span');
  el.className = 'ripple';
  el.style.width = el.style.height = d + 'px';
  el.style.left = ((ev.clientX || r.left + r.width/2) - r.left - d/2) + 'px';
  el.style.top = ((ev.clientY || r.top + r.height/2) - r.top - d/2) + 'px';
  b.appendChild(el);
  setTimeout(function(){ el.remove(); }, 640);
  if (busy) return;
  fire();
}

function fire(){
  busy = true;
  clearTimeout(resetTimer);
  q('btn').disabled = true;
  q('label').textContent = 'Opening';
  if (!q('spin')){
    var s = document.createElement('span'); s.className = 'spin'; s.id = 'spin';
    q('btn').appendChild(s);
  }
  setState('busy', 'Opening&hellip;', 'Waiting for the terminal to answer.');
  fetch('/api/opendoor', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ pin: q('pin').value || '' })})
    .then(function(r){ return r.json().then(function(j){ j._code = r.status; return j; }); })
    .then(function(j){
      if (j._code === 401){
        q('pinbox').style.display = 'flex';
        q('pin').focus();
        return finish('bad', 'Code needed', 'Enter the door code below, then press again.');
      }
      if (!j.ok) return finish('bad', 'Could not open', esc(j.error || 'The server refused.'));
      poll(j.queued.map(function(c){ return c.id; }), Date.now() + 30000);
    })
    .catch(function(){ finish('bad', 'No connection', 'The attendance server did not answer.'); });
}

function poll(ids, deadline){
  fetch('/api/cmd/status?ids=' + ids.join(','))
    .then(function(r){ return r.json(); })
    .then(function(j){
      var all = j.items.concat(j.followups);
      if (all.some(function(c){ return c.ok === true; }))
        return finish('ok', 'Unlocked', 'The terminal accepted it.');
      // a rejected wording queues the next one, so keep waiting while any is open
      if (all.length && !all.some(function(c){ return c.ok === null; })){
        var last = all[all.length - 1];
        return finish('bad', 'Terminal refused',
          'It answered <b>' + esc(String(last && last.result)) + '</b> to every unlock command. '
          + 'The door relay may not be wired to this terminal.');
      }
      if (Date.now() > deadline)
        return finish('bad', 'No answer', 'The terminal did not reply within 30 seconds.');
      setTimeout(function(){ poll(ids, deadline); }, 900);
    })
    .catch(function(){ finish('bad', 'No connection', 'Lost the attendance server.'); });
}

function gates(){
  fetch('/api/door').then(function(r){ return r.json(); }).then(function(j){
    q('dot').className = 'dot ' + (j.online ? 'on' : 'off');
    q('gates').textContent = j.online
      ? j.online + ' of ' + j.devices + ' terminal(s) online'
      : (j.devices ? 'no terminal is online' : 'no terminal has connected yet');
    if (j.needsPin) q('pinbox').style.display = 'flex';
    q('sub').textContent = j.online ? 'One tap unlocks every terminal that is online.'
                                    : 'The door cannot open until a terminal reconnects.';
  }).catch(function(){});
}
gates();
setInterval(gates, 10000);
document.addEventListener('keydown', function(e){
  if ((e.key === 'Enter' || e.key === ' ') && !busy && document.activeElement !== q('pin')){
    e.preventDefault(); fire();
  }
});
</script>
</body></html>`;

/* ---------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  let route, query;
  try {
    const u = new URL(req.url, 'http://x');
    route = u.pathname.replace(/\.aspx$/i, '').replace(/\/+$/, '') || '/';
    route = route.toLowerCase();
    query = u.searchParams;
  } catch (e) { return textOut(res, 'Bad Request', 400); }

  try {
    if (route.startsWith('/iclock')) return await handleDevice(req, res, route, query);
    if (route === '/health' || route.startsWith('/api/')) return await handleApi(req, res, route, query);
    if (route === '/' || route === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }
    if (route === '/opendoor' || route === '/opendoor.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(DOOR_HTML);
    }
    if (route === '/favicon.ico') { res.writeHead(204); return res.end(); }
    return textOut(res, 'Not found', 404);
  } catch (e) {
    trace('err', '', route + ' -> ' + e.message);
    return textOut(res, 'Server error', 500);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error('  Port ' + PORT + ' is already in use.');
    console.error('  Another copy of this server is probably still running.');
    console.error('');
    console.error('  See what is holding it:   lsof -nP -iTCP:' + PORT + ' -sTCP:LISTEN');
    console.error('  Stop it:                  pkill -f "node server.js"');
    console.error('  Or use another port:      PORT=8081 npm start');
    console.error('     (then set the same port in the device ADMS settings)');
    console.error('');
  } else if (err.code === 'EACCES') {
    console.error('');
    console.error('  Not allowed to bind port ' + PORT + '. Ports below 1024 need sudo.');
    console.error('  Use a high port instead:  PORT=8080 npm start');
    console.error('');
  } else {
    console.error('  Server error: ' + err.message);
  }
  process.exit(1);
});

loadState();
migrate();
server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPs();
  console.log('');
  console.log('  AIFACE-MARS attendance server');
  console.log('  ------------------------------------------------------------');
  console.log('  Dashboard    http://localhost:' + PORT);
  ips.forEach((ip) => console.log('               http://' + ip + ':' + PORT));
  console.log('  Door button  http://' + (ips[0] || 'localhost') + ':' + PORT + '/opendoor');
  console.log('');
  console.log('  On the device: Menu > COMM > Cloud Server Setting (ADMS)');
  console.log('     Server Address : ' + (ips[0] || '<this PC IP>'));
  console.log('     Server Port    : ' + PORT);
  console.log('     Domain / Proxy : OFF, then reboot the terminal');
  console.log('');
  console.log('  Loaded ' + state.logs.length + ' punches, '
    + Object.keys(state.users).length + ' users, '
    + Object.keys(state.devices).length + ' device(s) from ./data');
  console.log('');
});
