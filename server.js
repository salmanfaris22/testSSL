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
// One file per person rather than a field on the record: users.json is
// rewritten whole on every save, and a base64 portrait in it would be copied
// out to disk on each one.
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const PHOTO_MAX = 1024 * 1024;   // an enrolment snapshot, not a photo library
const DEV_FILE = path.join(DATA_DIR, 'devices.json');
const SET_FILE = path.join(DATA_DIR, 'settings.json');
const MARK_FILE = path.join(DATA_DIR, 'marks.json');
// Who has been through the HR door. Employee attendance leaves this server
// through that API, so every call - admitted or refused - is written down.
const HRLOG_FILE = path.join(DATA_DIR, 'hrlog.jsonl');
const HRLOG_MAX = 2000;   // kept in memory; the file keeps the rest
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
  // punchKey -> 'in' | 'out', set by hand on the day timeline. Both terminals
  // here are readers on the same door, so no gate role can say which way a
  // person went; this is where a human says it instead. Keyed on the punch's
  // dedupe key, so a re-sync of the same punch keeps its mark and a device
  // never overwrites one.
  marks: {},
  // allowIps: HR API allow-list, empty = denied. faceOnly: attendance counts
  // face-verified punches only. dwellSec: gate re-tap window, see below.
  // hrKey: optional second lock on the HR/sync API, checked after the IP list
  settings: { allowIps: [], faceOnly: undefined, dwellSec: undefined, doorPin: '', hrKey: '' },
};
const seen = new Set();          // dedupe key for punches
const hrLog = [];                // recent HR API calls, newest last
const feeds = [];                // open live streams: {res, ip, pins, since, sent}
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
  try { state.marks = JSON.parse(fs.readFileSync(MARK_FILE, 'utf8')); } catch (e) {}
  // only the tail: this file grows with every call and none of it is needed
  // beyond what the panel shows
  try {
    const lines = fs.readFileSync(HRLOG_FILE, 'utf8').split('\n').filter(Boolean);
    for (const line of lines.slice(-HRLOG_MAX)) {
      try { hrLog.push(JSON.parse(line)); } catch (e) { /* skip a torn line */ }
    }
  } catch (e) { /* no calls yet */ }
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
      fs.writeFileSync(MARK_FILE, JSON.stringify(state.marks, null, 2));
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

// Name and card ride inside a tab-separated command line, so a tab or a
// newline in either would split the record into nonsense the terminal files
// against the wrong column. Strip them where the command is built, so every
// path that can set a name is covered rather than just the one that pastes.
function cmdField(v) {
  return String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
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
      return 'DATA UPDATE USERINFO PIN=' + p.pin + '\tName=' + cmdField(p.name)
        + '\tPri=' + (p.pri || 0) + '\tPasswd=' + (p.passwd || '') + '\tCard=' + cmdField(p.card)
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
  // This line is reached once per genuinely new punch and never for a repeat,
  // which is exactly the moment a listener wants to hear about.
  feedPush(rec);
  return true;
}

/* ------------------------------------------------------------ live feed */

// The stream. A listener opens this once and leaves it open, so nothing on
// either side needs a Fetch button. Reachable under both names because the
// two doors are the same door: allow-listed, keyed, and scoped to the people
// the listener named. The caller has already checked both locks.
function openFeed(req, res, q, route, t0) {
  const pins = new Set(pinList(q, 'connect_id').concat(pinList(q)));
  if (!pins.size) {
    return jsonOut(res, { error: 'name the people with connect_id - a feed never '
      + 'carries the whole roll' }, 400);
  }
  if (feeds.length >= FEED_MAX) {
    return jsonOut(res, { error: 'too many open feeds', open: feeds.length }, 429);
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  const f = { res, ip: clientIp(req), pins, since: Date.now(), sent: 0 };
  feeds.push(f);
  res._hr = null;                       // a stream is not a call that returns rows
  hrTrace(req, route, { pins: [...pins].join(','), rows: 0, ok: true, why: '',
    ms: Date.now() - (t0 || Date.now()) });
  trace('info', '', 'live feed opened by ' + f.ip + ' for ' + pins.size + ' person(s)');
  feedSend(f, 'hello', { ok: true, pins: [...pins], since: f.since, recv: Date.now() });
  // A reconnect names the last id it saw, and gets what it missed.
  const last = Number(req.headers['last-event-id'] || q.get('since') || 0);
  if (last) {
    for (const frame of feedReplay) {
      if (frame.recv > last && pins.has(frame.pin)) feedSend(f, 'punch', frame);
    }
  }
  // idle proxies close a silent connection, so say something harmless
  const beat = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch (e) { /* closing */ }
  }, 20000);
  const drop = () => {
    clearInterval(beat);
    const i = feeds.indexOf(f);
    if (i >= 0) feeds.splice(i, 1);
    trace('info', '', 'live feed closed for ' + f.ip + ' after ' + f.sent + ' event(s)');
  };
  req.on('close', drop);
  req.on('error', drop);
  return undefined;
}

// A listener that asked for nobody hears nobody: the PIN set is enforced here
// rather than trusted to the far end.
const FEED_MAX = 8;           // enough for every consumer, not enough to be a hole
const FEED_REPLAY = 500;      // punches kept for a reconnect to catch up on
const feedReplay = [];

function feedFrame(rec) {
  // The movement this punch belongs to cannot be known until the day is
  // re-derived, so what goes out is the tap itself plus the day it lands in -
  // the listener asks for the day when it wants the labelled version.
  return {
    pin: rec.pin, name: rec.name || '',
    time: rec.time, recv: rec.recv, gate: rec.sn,
    session_date: dayOf(rec.time), session_uid: rec.pin + '|' + dayOf(rec.time),
    device_key: punchKey(rec),
    verify: rec.verify, verified_by: VERIFY[rec.verify] || ('mode ' + rec.verify),
    dir: dirOf(rec),
  };
}

function feedPush(rec) {
  const frame = feedFrame(rec);
  feedReplay.push(frame);
  if (feedReplay.length > FEED_REPLAY) feedReplay.splice(0, feedReplay.length - FEED_REPLAY);
  for (const f of feeds) {
    if (!f.pins.has(rec.pin)) continue;
    feedSend(f, 'punch', frame);
  }
}

function feedSend(f, event, data) {
  try {
    f.res.write('id: ' + (data.recv || Date.now()) + '\n'
      + 'event: ' + event + '\n'
      + 'data: ' + JSON.stringify(data) + '\n\n');
    if (event === 'punch') f.sent++;
  } catch (e) { /* the close handler will drop it */ }
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
        // the picture rides in the same line as the count that was being kept
        if (o.Content && (t === 'USERPIC' || t === 'BIOPHOTO')) savePhoto(pin, t, o.Content);
      }
    } else if (/^OPLOG\s/i.test(line)) {
      trace('dev', sn, 'OPLOG ' + line.slice(0, 120));
    }
  }
  if (users) { saveSoon(); trace('dev', sn, 'USERINFO -> ' + users + ' user record(s)'); }
  return users;
}

// A face template is not a picture and cannot be shown, so what arrives is
// only kept when it actually decodes to an image. USERPIC is the enrolment
// portrait and wins over BIOPHOTO, which is whatever still the face engine
// happened to keep - between two of the same kind, the newer one wins.
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return 'image/png';
  return '';
}

function savePhoto(pin, kind, b64) {
  let buf;
  try { buf = Buffer.from(String(b64).replace(/\s+/g, ''), 'base64'); } catch (e) { return; }
  if (!buf.length || buf.length > PHOTO_MAX) return;
  const type = imageType(buf);
  if (!type) return;
  const u = state.users[pin];
  const had = u && u.photo;
  if (had && had.kind === 'USERPIC' && kind !== 'USERPIC') return;
  try {
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
    fs.writeFileSync(path.join(PHOTO_DIR, pin + (type === 'image/png' ? '.png' : '.jpg')), buf);
  } catch (e) { return; }
  if (u) {
    u.photo = { at: Date.now(), bytes: buf.length, kind, type };
    saveSoon();
  }
  trace('dev', '', 'photo stored for PIN ' + pin + ' (' + kind + ', ' + buf.length + ' bytes)');
}

// A record can outlive the file, and a file can outlive the record - a photo
// pulled before this server started keeping the field still has to be findable.
function photoFile(pin) {
  for (const ext of ['.jpg', '.png']) {
    const f = path.join(PHOTO_DIR, pin + ext);
    try { if (fs.statSync(f).isFile()) return { file: f, type: ext === '.png' ? 'image/png' : 'image/jpeg' }; }
    catch (e) { /* next */ }
  }
  return null;
}

function photoCount() {
  let count = 0, bytes = 0;
  try {
    for (const f of fs.readdirSync(PHOTO_DIR)) {
      try { const st = fs.statSync(path.join(PHOTO_DIR, f)); if (st.isFile()) { count++; bytes += st.size; } }
      catch (e) { /* ignore */ }
    }
  } catch (e) { /* no photos yet */ }
  return { count, bytes };
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

// How many records a reply actually carried. Each HR route names its rows
// differently, so the count is taken from whichever list is present rather
// than from a field every route would have to remember to set.
function rowCount(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  for (const k of ['users', 'punches', 'days', 'employees', 'devices', 'events', 'rows']) {
    if (Array.isArray(obj[k])) return obj[k].length;
  }
  if (obj.data && Array.isArray(obj.data.items)) return obj.data.items.length;
  return 0;
}

function jsonOut(res, obj, code) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  // an HR call logs itself as it answers, so a new route cannot forget to
  if (res._hr) {
    const h = res._hr;
    res._hr = null;
    hrTrace(h.req, h.route, {
      pins: h.pins, rows: rowCount(obj), ok: (code || 200) < 400,
      why: (code || 200) < 400 ? '' : (obj && obj.error) || String(code),
      ms: Date.now() - h.t0,
    });
  }
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

// A direction someone set by hand on the day timeline. Nothing the terminals
// send can overwrite it - the punch keeps its mark across every re-sync,
// because the mark is filed under the punch's own dedupe key.
function markOf(rec) {
  const m = state.marks[punchKey(rec)];
  return m === 'in' || m === 'out' ? m : '';
}

function dirOf(rec) {
  const m = markOf(rec);
  if (m) return m;
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

// Where every movement's direction is known - both gates carry a role, or a
// person set the punches by hand - the day reads itself in order: the first
// arrival opens it, a departure starts a break, the next arrival ends that
// break, and a departure with nothing after it closes the day.
//
// A day that ends on an arrival is simply still open. It says so, instead of
// borrowing the last punch as a check-out it never was: someone who taps in at
// 9, out at 12 and in again at 1 has checked in, taken a break, and not yet
// left, so the check-out is pending - not 1 o'clock.
function labelByDirection(evs) {
  let inside = false, arrived = false;
  for (const e of evs) {
    if (e.dir === 'in') {
      // an arrival with no departure since the last one is the same movement
      // read again at the other reader, not a second arrival
      e.label = inside ? 'Extra punch' : (arrived ? 'Break end' : 'Check in');
      inside = true;
      arrived = true;
      continue;
    }
    // a departure before anyone arrived closes nothing, so it counts for nothing
    e.label = inside ? 'Break start' : 'Extra punch';
    inside = false;
  }
  // the departure the day ends on is the check-out, not a break nobody ever
  // came back from
  const last = evs[evs.length - 1];
  if (last.label === 'Break start') last.label = 'Check out';
  return evs;
}

// No gate roles, so nothing says which way anyone went: fall back to position.
// First movement of the day is the arrival, the last is the departure, and the
// pairs between them are breaks. An odd number in the middle leaves one tap
// without a partner: it stays visible but is never counted, so a stray punch
// can neither invent a break nor stretch the day.
function labelByAlternation(evs) {
  evs[0].label = 'Check in';
  if (evs.length === 1) return evs;
  evs[evs.length - 1].label = 'Check out';
  const mid = evs.slice(1, -1);
  const paired = Math.floor(mid.length / 2) * 2;
  for (let i = 0; i < paired; i++) mid[i].label = i % 2 ? 'Break end' : 'Break start';
  for (let i = paired; i < mid.length; i++) mid[i].label = 'Extra punch';
  // Alternation is only a guess about which way someone went. Where a human
  // has said it outright, the mark decides instead: an out is the departure
  // when it ends the day and the start of a break anywhere else, an in is the
  // arrival when it opens the day and the end of a break anywhere else. That
  // is what turns a tap out and a tap straight back in from one unexplained
  // extra punch into the break it actually was.
  for (let i = 0; i < evs.length; i++) {
    if (!evs[i].mark) continue;
    evs[i].label = evs[i].mark === 'out'
      ? (i === evs.length - 1 ? 'Check out' : 'Break start')
      : (i === 0 ? 'Check in' : 'Break end');
  }
  return evs;
}

// Direction is the better reading whenever it is there for every movement;
// position is only what is left when it is not.
function labelMovements(evs) {
  if (!evs.length) return evs;
  const known = evs.every((e) => e.dir === 'in' || e.dir === 'out');
  return known ? labelByDirection(evs) : labelByAlternation(evs);
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
    const mark = markOf(r);
    const dir = dirOf(r);
    // Where both gates are known, direction alone decides: you cannot arrive
    // twice without leaving in between, so a second punch at the same gate is
    // the same movement however much later it came - the door was slow, the
    // read did not take, someone tapped again on the way past. Only the
    // opposite gate starts a new movement. Without gate roles there is no
    // direction to reason from, so closeness in time is all that is left.
    //
    // A punch someone marked by hand outranks both. It joins the movement
    // before it only when that movement carries the same mark - two taps both
    // marked out are one departure read twice - and otherwise always opens a
    // new one, however close in time. That is the only thing that can tell a
    // tap out and a tap straight back in apart from the terminal reading one
    // face twice, because here both gates are readers on the same door.
    // Unmarked taps still fold as before, so marking the two punches that
    // matter does not shatter the double-reads around them.
    const sameMove = prev && (mark
      ? mark === prev.mark
      : dir && prev.dir
        ? dir === prev.dir
        : (tsOf(r.time) - tsOf(prev.time)) < win);
    const tap = { k: punchKey(r), t: r.time, sn: r.sn, v: r.verify, m: mark };
    // the run counts as happening at its last tap: that is the one the person
    // actually walked through on
    if (sameMove) {
      prev.taps++; prev.time = r.time; prev.key = tap.k; prev.rows.push(tap);
      continue;
    }
    evs.push({ time: r.time, from: r.time, dir, mark, verify: r.verify, sn: r.sn,
               taps: 1, key: tap.k, rows: [tap] });
  }
  labelMovements(evs);
  evs.taps = rows.length;
  evs.ignored = all.length - rows.length;
  return evs;
}

function daySummary(pin, date, face) {
  const evs = dayEvents(pin, date, face);
  // The labels are the day, not the ends of the list: a day can now finish on
  // an arrival, which leaves it open with no check-out to read.
  const inEv = evs.find((e) => e.label === 'Check in') || null;
  const outEv = evs.find((e) => e.label === 'Check out') || null;

  const breaks = [];
  let breakMin = 0;
  let away = null;
  for (const e of evs) {
    if (e.label === 'Break start') { away = e; continue; }
    if (e.label !== 'Break end' || !away) continue;
    // Tapping out and straight back in lands both punches in the same minute,
    // so the rounded gap is zero and the break would vanish from the day
    // entirely. A break that really happened costs at least a minute.
    const ms = tsOf(e.time) - tsOf(away.time);
    const from = away.time;
    away = null;
    if (ms < 0) continue;
    const min = Math.max(1, Math.round(ms / 60000));
    breaks.push({ from, to: e.time, min });
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
    // seen, but never seen leaving - one lone movement, or a day that ends on
    // an arrival. Either way there is nothing to close the hours against.
    incomplete: evs.length > 0 && !(inEv && outEv),
    // still inside as far as the gates know: the check-out has not happened yet
    pending: !!inEv && !outEv,
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

/* ----------------------------------------------------------- HR event feed */

// HR connects people one at a time - a PIN typed against an employee - so a
// request names the PINs it wants instead of dragging the whole terminal
// across. No pin at all still means everyone, which is what the dashboard and
// the CSV export ask for.
// The same list under two names: this server calls them PINs, the academy
// calls them connect_ids, and they are the same numbers.
function pinList(q, field) {
  const raw = q && q.get ? String(q.get(field || 'pin') || '') : '';
  return [...new Set(raw.split(',').map((x) => normPin(x)).filter(Boolean))];
}

// A second lock behind the allow-list. The academy's client already sends
// X-API-Key on every call, so this costs it nothing; with no key set here the
// allow-list is still the only door, exactly as before.
function keyOk(req) {
  const want = String(state.settings.hrKey || '');
  if (!want) return true;
  const got = String(req.headers['x-api-key'] || req.headers['x-apikey'] || '');
  return got === want;
}

// The day model flattened to one row per movement, in the shape the academy
// stores: it keys events on {connect_id, session_uid, event_type, timestamp},
// so session_uid is the day and the timestamp is the movement's own minute.
// An Extra punch carries no event_type and is left out - it is shown on the
// timeline here, never stored as attendance there.
function syncEvents(pins, from, to, face) {
  const out = [];
  for (const pin of pins) {
    const name = (state.users[pin] && cmdField(state.users[pin].name)) || '';
    for (const date of dateRange(from, to)) {
      const day = hrDay(pin, date, face);
      if (!day) continue;
      for (const step of day.steps) {
        if (!step.event_type) continue;
        out.push({
          event_type: step.event_type,
          timestamp: isoStamp(step.time),
          connect_id: pin,
          employee_name: name || day.name || '',
          session_uid: pin + '|' + date,
          session_date: date,
          site_name: step.gate || '',
          // the punch's own dedupe key, so a re-send lands on the same row
          device_key: step.key,
          taps: step.taps,
          verified_by: step.verify_label,
        });
      }
    }
  }
  // one ordering, so paging is stable between calls
  return out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1
    : Number(a.connect_id) - Number(b.connect_id)));
}

// "2026-09-11 09:05:00" as local time, written with its offset so the far end
// cannot read it as UTC and move everyone's day by five and a half hours.
function isoStamp(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(local || ''));
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]));
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6]
    + sign + pad(off / 60 | 0) + ':' + pad(off % 60);
}

const STEP_TYPE = {
  'Check in': 'CHECK_IN', 'Break start': 'BREAK_START',
  'Break end': 'BREAK_END', 'Check out': 'CHECK_OUT',
};
// What the gap before a movement says about where the person was - the same
// reading the day timeline prints between two dots. An unmatched tap gets the
// elapsed time but no claim, because that is exactly what is not known.
const GAP_STATE = {
  'Break end': 'Away on break', 'Break start': 'At work', 'Check out': 'At work',
};
const PENDING_NOTE = 'The day ends on an arrival, so nobody has left yet.';

// The dashboard prints these; HR should not have to rebuild them from parts.
function ampmOf(t) {
  const m = /[ T](\d{2}):(\d{2})/.exec(t || '');
  if (!m) return '';
  const h = Number(m[1]);
  return (h % 12 || 12) + ':' + m[2] + ' ' + (h >= 12 ? 'PM' : 'AM');
}
const hmOf = (m) => (m / 60 | 0) + 'h ' + (m % 60) + 'm';

// One movement, flattened: what it was, the time it counts at, the gate that
// saw it, and every tap behind it - a folded run keeps its taps because only a
// person can say that two of them were different movements.
function stepRow(e, prev) {
  const gapMin = prev
    ? Math.max(0, Math.round((tsOf(e.time) - tsOf(prev.time)) / 60000)) : null;
  const where = prev ? (GAP_STATE[e.label] || '') : '';
  return {
    step: e.label,
    // an Extra punch counts for nothing, so it carries no event type: it is
    // shown, never stored as attendance
    event_type: STEP_TYPE[e.label] || '',
    time: e.time,
    time_label: ampmOf(e.time),
    gate: e.sn,
    dir: e.dir || '',
    taps: e.taps,
    first_time: e.from,
    taps_label: e.taps > 1 ? e.taps + ' taps, first ' + ampmOf(e.from) : '1 tap',
    verify: e.verify,
    verify_label: VERIFY[e.verify] || ('mode ' + e.verify),
    marked: !!e.mark,
    key: e.key,
    gap_before_minutes: gapMin,
    gap_before_state: where,
    gap_before_label: gapMin === null ? '' : (hmOf(gapMin) + (where ? ' ' + where : '')),
    rows: (e.rows || []).map((t) => ({
      time: t.t, time_label: ampmOf(t.t), gate: t.sn, key: t.k, mark: t.m || '',
    })),
  };
}

// One day as HR should store it: the steps in the order they happened, and the
// taps behind each one.
function hrDay(pin, date, face) {
  const d = daySummary(pin, date, face);
  if (!d.punches) return null;
  return {
    pin,
    name: (state.users[pin] && state.users[pin].name) || '',
    date: d.date,
    status: d.status,
    check_in: d.in || null,
    check_out: d.out || null,
    check_in_label: ampmOf(d.in),
    check_out_label: d.pending ? 'Pending' : ampmOf(d.out),
    pending: !!d.pending,
    pending_note: d.pending ? PENDING_NOTE : '',
    incomplete: !!d.incomplete,
    total_minutes: d.totalMin,
    break_minutes: d.breakMin,
    work_minutes: d.workMin,
    movements: d.punches,
    taps: d.taps,
    ignored: d.ignored,
    breaks: d.breaks,
    steps: d.events.map((e, i) => stepRow(e, d.events[i - 1])),
  };
}

// A day changes when a punch lands in it, and a punch can land days after it
// happened - a terminal that was offline dumps its whole backlog at once. So
// "what is new" is asked of arrival time (`recv`), never of the punch's own
// clock: a date-range question would never see that backlog at all.
function changedSince(since) {
  const touched = new Set();
  let latest = 0;
  for (const r of state.logs) {
    const recv = Number(r.recv) || 0;
    if (recv > latest) latest = recv;
    if (recv > since) touched.add(normPin(r.pin) + '|' + dayOf(r.time));
  }
  return { touched, latest };
}

function hrEvents(pins, from, to, face, since) {
  const { touched, latest } = changedSince(since);
  const days = [];
  for (const pin of pins) {
    for (const date of dateRange(from, to)) {
      if (since && !touched.has(pin + '|' + date)) continue;
      const day = hrDay(pin, date, face);
      if (day) days.push(day);
    }
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
    : Number(a.pin) - Number(b.pin)));
  return { days, next: latest };
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

// `opts.pins` is the HR reading of a pin: the exact people it has connected.
// The dashboard's own filter stays a search box, where typing 10 should still
// turn up 10, 100 and 1023.
// `opts.since` is the arrival cursor - see changedSince() for why arrival and
// not the punch's own clock.
function filterLogs(q, opts) {
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
  const since = Number(opts && opts.since) || 0;
  if (since) rows = rows.filter((r) => (Number(r.recv) || 0) > since);
  if (from) rows = rows.filter((r) => r.time >= from);
  if (to) rows = rows.filter((r) => r.time <= to + ' 23:59:59');
  if (term) {
    rows = rows.filter((r) =>
      r.pin.toLowerCase().includes(term) ||
      (r.name || '').toLowerCase().includes(term) ||
      r.sn.toLowerCase().includes(term));
  }
  const wantPins = opts && opts.pins && opts.pins.length ? new Set(opts.pins) : null;
  if (wantPins) rows = rows.filter((r) => wantPins.has(normPin(r.pin)));
  else if (fPin) rows = rows.filter((r) => r.pin.toLowerCase().includes(fPin));
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

// The socket peer is a fact; X-Forwarded-For is a claim anybody who can reach
// the port is free to make. Honouring it unconditionally meant the allow-list
// could be walked straight past by sending one header, so the claim is only
// believed when it arrives from a proxy we were told to expect.
const TRUST_PROXY = String(process.env.TRUST_PROXY || '')
  .split(',').map((x) => x.trim()).filter(Boolean);

function peerIp(req) {
  return String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}

function clientIp(req) {
  const peer = peerIp(req);
  if (!TRUST_PROXY.length) return peer;
  if (!TRUST_PROXY.some((rule) => ipMatches(rule, peer))) return peer;
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || peer).replace(/^::ffff:/, '');
}

// The door's own history, grouped by who knocked. An address that was turned
// away is the useful row here: it carries the exact string to allow-list, so
// the fix is a copy rather than a guess.
function hrLogView(q) {
  const limit = Math.min(Math.max(Number(q && q.get && q.get('limit')) || 120, 1), 500);
  const by = new Map();
  for (const r of hrLog) {
    const seenIp = by.get(r.ip) || {
      ip: r.ip, calls: 0, denied: 0, rows: 0, first: r.t, last: 0,
      lastRoute: '', lastWhy: '', allowed: false, pins: '',
    };
    seenIp.calls++;
    if (!r.ok) { seenIp.denied++; seenIp.lastWhy = r.why; }
    seenIp.rows += Number(r.rows) || 0;
    if (r.t >= seenIp.last) { seenIp.last = r.t; seenIp.lastRoute = r.route; seenIp.pins = r.pins; }
    by.set(r.ip, seenIp);
  }
  const callers = [...by.values()].sort((a, b) => b.last - a.last);
  // said plainly, rather than left for the operator to work out from the rules
  for (const c of callers) {
    c.rule = ruleFor(c.ip);
    c.allowed = !!c.rule;
  }
  return {
    total: hrLog.length,
    allowIps: state.settings.allowIps || [],
    trustProxy: TRUST_PROXY,
    keySet: !!state.settings.hrKey,
    callers,
    feeds: feedList(),
    calls: hrLog.slice(-limit).reverse(),
  };
}

// Who is holding a live stream open right now. Empty until a feed connects.
function feedList() {
  return feeds.map((f) => ({
    ip: f.ip, pins: [...f.pins].join(','), since: f.since, sent: f.sent,
  }));
}

// which rule admits this address, '' when none does
function ruleFor(ip) {
  for (const rule of state.settings.allowIps || []) {
    if (ipMatches(rule, ip)) return rule;
  }
  return '';
}

// One row per call at the HR door. `why` is empty when the call was admitted.
function hrTrace(req, route, info) {
  const row = Object.assign({
    t: Date.now(), ip: clientIp(req), peer: peerIp(req), route,
    pins: '', rows: 0, ok: true, why: '', ms: 0,
  }, info || {});
  hrLog.push(row);
  if (hrLog.length > HRLOG_MAX) hrLog.splice(0, hrLog.length - HRLOG_MAX);
  try { fs.appendFileSync(HRLOG_FILE, JSON.stringify(row) + '\n'); } catch (e) { /* best effort */ }
  return row;
}

// An HR server rarely calls from one fixed address - a NAT gateway, a pool of
// workers, a provider that reassigns on restart - so the allow-list takes four
// forms rather than one. Exact-match-only was a trap: "49.37.0.0" looks like a
// range and matches nothing, so the API stayed shut with a rule sitting in it.
//   *              every caller
//   103.119.254.234   one address
//   49.37.*        every address under that prefix
//   49.37.0.0/16   the same thing in CIDR
const ipToLong = (ip) => {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n >>> 0;
};

function cidrMatch(rule, ip) {
  const at = rule.indexOf('/');
  const base = ipToLong(rule.slice(0, at));
  const addr = ipToLong(ip);
  const bits = Number(rule.slice(at + 1));
  if (base === null || addr === null) return false;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (bits === 32 ? -1 : ~((1 << (32 - bits)) - 1)) >>> 0;
  return (base & mask) >>> 0 === (addr & mask) >>> 0;
}

function ipMatches(rule, ip) {
  if (rule === '*') return true;
  if (rule === ip) return true;
  if (!ip) return false;
  if (rule.includes('/')) return cidrMatch(rule, ip);
  if (!rule.includes('*')) return false;
  const r = rule.split('.'), a = ip.split('.');
  // "49.37.*" stands for every octet left, so it may be shorter than the address
  if (r[r.length - 1] === '*' ? r.length > a.length : r.length !== a.length) return false;
  for (let i = 0; i < r.length; i++) {
    if (r[i] === '*') return true;
    if (r[i] !== a[i]) return false;
  }
  return true;
}

// A rule that can never match is worse than no rule: it looks like the door is
// open when it is shut. The settings endpoint rejects these outright rather
// than storing them.
function badIpRule(rule) {
  if (rule === '*') return '';
  if (rule.includes('/')) {
    const at = rule.indexOf('/');
    const bits = Number(rule.slice(at + 1));
    if (ipToLong(rule.slice(0, at)) === null) return 'not an address';
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return 'prefix must be /0 to /32';
    return '';
  }
  if (rule.includes('*')) {
    const r = rule.split('.');
    if (r.indexOf('*') !== r.length - 1) return 'the * must come last';
    if (r.length < 2 || r.length > 4) return 'not an address pattern';
    return r.slice(0, -1).every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
      ? '' : 'not an address pattern';
  }
  // a bare IPv6 address is kept as-is and matched exactly
  if (rule.includes(':')) return '';
  return ipToLong(rule) === null ? 'not an address' : '';
}

// HR integration is allow-list only, and denied while the list is empty.
function ipAllowed(req) {
  const list = state.settings.allowIps || [];
  if (!list.length) return false;
  const ip = clientIp(req);
  return list.some((rule) => ipMatches(rule, ip));
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
  store.photos = photoCount();
  store.total += store.photos.bytes;
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
    devices: Object.values(state.devices).map((x) => {
      const i = x.info || {};
      return {
        sn: x.sn, online: !!x.online, role: x.role || '',
        lastSeen: x.lastSeen, clockOffset: x.clockOffset || 0,
        punches: byDevice[x.sn] || 0,
        // what the terminal itself holds, so the server view can show the
        // same face coverage the device card does
        faces: Number(i.FaceCount || i.face_count || 0),
        users: Number(i.UserCount || i.user_count || 0),
        maxFaces: Number(i.MaxFaceCount || 0),
      };
    }).sort((a, b) => b.punches - a.punches),
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

/* ---------------------------------------------------- bulk user import */

// A class roll never arrives as a tidy CSV. It is pasted out of a spreadsheet,
// a PDF table or a message, so whatever survived the copy is the separator: a
// tab, a comma, or a run of spaces. Rather than make the office reformat the
// list, take the first field as the PIN and the rest as the name, and let a
// preview show what was understood before anything reaches a terminal.
const NAME_MAX = 24;      // what the firmware stores; longer names get cut there
const IMPORT_MAX = 500;   // one paste, so a mis-paste cannot flood the queue
let importSeq = 0;        // one paste = one batch, so progress can be asked for

// A heading line ("No.  Student Name") is dropped rather than reported as a
// broken row, because it is in every paste and it is not an operator mistake.
const HEADER_RE = /^(no|s\.?\s*no|sl|sr|pin|id|emp(loyee)?|user|roll|serial|student|name)\b/i;

function splitRow(line) {
  if (line.indexOf('\t') >= 0) return line.split('\t');
  if (line.indexOf(',') >= 0) return line.split(',');
  if (line.indexOf(';') >= 0) return line.split(';');
  if (/\s{2,}/.test(line)) return line.split(/\s{2,}/);
  // "5001 HASHIM SHAHAL K" - one space between the columns and more inside the
  // name, so only the first gap is a column break
  const i = line.search(/\s/);
  return i < 0 ? [line] : [line.slice(0, i), line.slice(i + 1)];
}

// Two records for one human. A name is what a person is recognised by, and
// case, punctuation and spacing all vary between one roll and the next - the
// initials especially, which arrive as "T.S.", "T S" and "TS" for the same
// person - so none of them are allowed to hide a match. Dropping the gaps
// entirely can in principle read "RAJ U" as "RAJU", which is why a record
// with a face enrolled on it is never removed without a deliberate tick.
function nameKey(n) {
  return cmdField(n).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// A duplicate is a flag, not a status: the line is still perfectly usable on
// its own, so it keeps whatever new/changed/unchanged it earned and carries
// the other PIN alongside for the operator to judge.
function markDup(row, pin) {
  row.dup = true;
  row.dupOf = row.dupOf || [];
  if (pin && row.dupOf.indexOf(pin) < 0) row.dupOf.push(pin);
}

// One person, two records. Which of the two is the real one is not a guess:
// a record with a face enrolled is the one that opens the door, a record with
// punches behind it is the one the reports are built from, and between two
// that are equal the lower number is the one that was there first. A record
// created by a mis-paste has none of those, which is why it sorts last and
// gets removed rather than the original it shadows.
function dupeGroups() {
  const punches = new Map();
  for (const r of state.logs) punches.set(r.pin, (punches.get(r.pin) || 0) + 1);
  const hits = (u) => punches.get(String(u.pin)) || 0;
  const faces = (u) => (u.bio && Object.keys(u.bio).length ? 1 : 0);
  const rank = (u) => [faces(u), hits(u) ? 1 : 0, Number(u.privilege || 0), -Number(u.pin)];
  const by = new Map();
  for (const u of Object.values(state.users)) {
    const k = nameKey(u.name);
    if (!k) continue;                       // a nameless record has no twin to find
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(u);
  }
  const groups = [];
  for (const list of by.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => {
      const x = rank(a), y = rank(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
      return 0;
    });
    const shape = (u) => ({
      pin: String(u.pin), name: cmdField(u.name), punches: hits(u),
      privilege: String(u.privilege || '0'), faces: !!faces(u),
    });
    const keep = shape(list[0]);
    keep.why = [
      faces(list[0]) ? 'face enrolled' : '',
      hits(list[0]) ? hits(list[0]) + ' punch(es) on file' : '',
      Number(list[0].privilege || 0) ? PRI_LABEL[String(list[0].privilege)] || 'privileged' : '',
    ].filter(Boolean).join(', ') || 'the lower number, so the original';
    groups.push({
      name: keep.name,
      keep,
      // held back rather than hidden: removing either of these loses something
      // the operator may not want to lose, so it takes a deliberate tick
      drop: list.slice(1).map((u) => {
        const d = shape(u);
        d.holds = [];
        if (d.faces) d.holds.push('face');
        if (d.punches) d.holds.push('history');
        if (d.privilege !== '0') d.holds.push('admin');
        d.why = [
          d.faces ? 'a face is enrolled on it' : '',
          d.punches ? d.punches + ' punch(es) would stop being reported' : '',
          d.privilege !== '0' ? (PRI_LABEL[d.privilege] || 'an admin') + ' record' : '',
        ].filter(Boolean).join(', ');
        return d;
      }),
    });
  }
  return groups.sort((a, b) => Number(a.keep.pin) - Number(b.keep.pin));
}

function hasLower(name) {
  const n = cmdField(name);
  return !!n && n !== n.toUpperCase();
}

// A roll often arrives as bare names with no numbers at all. The office
// numbers people in order, so a new name takes the highest number in use plus
// one - not the lowest gap, which would drop a new student into a number that
// was retired years ago. A name already on file keeps the number it already
// has, because giving it a fresh one is precisely how a person ends up on the
// terminal twice.
function autoNumber(lines) {
  const taken = new Set(Object.keys(state.users));
  // a number written out in the paste is spoken for too, even on a later line
  for (const raw of lines) {
    const t = String(raw).trim();
    if (!t) continue;
    const pin = normPin(splitRow(t)[0] || '');
    if (/^\d{1,9}$/.test(pin)) taken.add(pin);
  }
  let next = 0;
  for (const p of taken) {
    const n = Number(p);
    if (Number.isFinite(n) && n > next) next = n;
  }
  next++;
  const held = new Map();             // name key -> the PIN that name already has
  for (const u of Object.values(state.users)) {
    const k = nameKey(u.name);
    if (!k) continue;
    const pin = String(u.pin);
    // someone already on file twice keeps the lower of the two numbers
    if (!held.has(k) || Number(pin) < Number(held.get(k))) held.set(k, pin);
  }
  return {
    held,
    take() {
      while (taken.has(String(next))) next++;
      const pin = String(next);
      taken.add(pin);
      return pin;
    },
  };
}

function parseUserList(text, upper, auto) {
  const rows = [];
  const at = new Map();               // pin -> row index, so a repeat can void the first
  const byName = new Map();           // name key -> row indexes, so one person twice shows
  const lines = String(text || '').split(/\r?\n/);
  const numbers = auto ? autoNumber(lines) : null;
  const given = new Map();            // name key -> PIN handed out earlier in this paste
  let over = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (rows.length >= IMPORT_MAX) { over++; continue; }
    // an empty middle field ("5001,,NAME") is a spreadsheet artefact, not a column
    const f = splitRow(line).map((x) => x.trim()).filter((x, j) => j === 0 || x !== '');
    const row = { line: i + 1, pin: '', name: '', card: '', status: '', note: '' };
    const heading = !/^\d/.test(f[0] || '') && HEADER_RE.test(f[0] || '');
    // A line that does not open with a number has no number column to split
    // off: the whole of it is the name. Without auto-numbering that is still
    // a broken row, which is what it was before.
    const bare = !heading && !/^\d/.test(f[0] || '') && !!numbers;
    const cols = bare ? f : f.slice(1);
    let name = cols.join(' ');
    let card = '';
    // a trailing all-digit field is a card number - but only when there is a
    // name in front of it, so "5001  12345678" stays a (badly named) person
    if (cols.length > 1 && /^\d{4,20}$/.test(cols[cols.length - 1])) {
      card = cols[cols.length - 1];
      name = cols.slice(0, -1).join(' ');
    }
    row.name = cmdField(name);
    // every name is stored in capitals, so a roll typed in mixed case reads
    // the same on the terminal as one typed in shouting
    if (upper) row.name = row.name.toUpperCase();
    row.card = card;
    if (heading) {
      row.pin = f[0];
      row.status = 'header';
      row.note = 'column heading, skipped';
      rows.push(row);
      continue;
    }
    if (bare) {
      const key = nameKey(row.name);
      // the same name twice in one paste is one person, and a name already on
      // file keeps its number - both are how a second record is avoided, and
      // they are told apart because only one of them is a record that exists
      const earlier = key && given.get(key);
      const onFile = key && numbers.held.get(key);
      if (!row.name) { row.status = 'error'; row.note = 'nothing on this line'; }
      else if (earlier) { row.pin = earlier.pin; row.auto = 'again'; row.autoLine = earlier.line; }
      else if (onFile) { row.pin = onFile; row.auto = 'held'; }
      else { row.pin = numbers.take(); row.auto = 'fresh'; }
      if (key && row.pin && !earlier) given.set(key, { pin: row.pin, line: row.line });
    } else {
      row.pin = normPin(f[0] || '');
    }
    if (row.status === 'error') { /* already judged */ }
    else if (!row.pin) { row.status = 'error'; row.note = 'no PIN on this line'; }
    else if (!/^\d{1,9}$/.test(row.pin)) { row.status = 'error'; row.note = 'PIN must be a number'; }
    else if (!row.name) { row.status = 'error'; row.note = 'no name on this line'; }
    else if (row.name.length > NAME_MAX) {
      row.note = row.name.length + ' characters - the terminal stores about ' + NAME_MAX;
    }
    if (row.status !== 'error') {
      const prev = at.get(row.pin);
      if (prev !== undefined) {
        rows[prev].status = 'dupe';
        rows[prev].note = 'PIN repeats on line ' + (i + 1) + ', which wins';
      }
      at.set(row.pin, rows.length);
      const key = nameKey(row.name);
      if (key) {
        const twins = byName.get(key) || [];
        for (const t of twins) {
          if (rows[t].pin === row.pin) continue;   // same PIN twice is a repeat, not a twin
          markDup(rows[t], row.pin);
          markDup(row, rows[t].pin);
        }
        twins.push(rows.length);
        byName.set(key, twins);
      }
    }
    rows.push(row);
  }
  return { rows, over };
}

// Which rows a push actually sends. Re-sending a record the terminal already
// has is harmless - DATA UPDATE USERINFO is an upsert - so "unchanged" is a
// real choice, not a mistake: it is how a terminal that was wiped gets its
// names back from records this server still holds.
const PICK = {
  all: ['new', 'update', 'same'],
  new: ['new'],
  update: ['update'],
  same: ['same'],
  dup: ['new', 'update', 'same'],
};

// "dup" is not a status of its own - it is every usable row that names a
// person already on file under another number, which is the slice an operator
// wants to look at before anything goes out.
const inPick = (r, pick) => (pick === 'dup'
  ? !!r.dup && PICK.all.includes(r.status)
  : PICK[pick].includes(r.status));

const PICK_WORD = {
  all: 'usable', new: 'new', update: 'changed', same: 'unchanged', dup: 'a duplicate name',
};

const PRI_LABEL = { 0: 'User', 2: 'Enroller', 6: 'Manager', 14: 'Super admin' };

// What the paste would do to the records we already hold. Runs on the same
// rows the push uses, so the preview cannot disagree with the result - and it
// says which field moves, because a class roll pasted at the User role would
// otherwise demote a super admin whose PIN happens to collide, silently.
function gradeImport(rows, pri) {
  // The paste only ever shows one half of a duplicate: the person already on
  // file under a second number is in the records, not in the text, so the
  // records are what the names are matched against.
  const held = new Map();
  for (const u of Object.values(state.users)) {
    const k = nameKey(u.name);
    if (!k) continue;
    if (!held.has(k)) held.set(k, []);
    held.get(k).push(String(u.pin));
  }
  for (const r of rows) {
    if (r.status === 'error' || r.status === 'header') continue;
    for (const pin of held.get(nameKey(r.name)) || []) {
      if (pin !== r.pin) markDup(r, pin);
    }
    if (r.status === 'dupe') continue;
    const u = state.users[r.pin];
    if (!u) { r.status = 'new'; continue; }
    const was = [];
    if (cmdField(u.name) !== r.name) was.push('name was "' + (cmdField(u.name) || 'blank') + '"');
    if (r.card && String(u.card || '') !== r.card) was.push('card was ' + (u.card || 'blank'));
    if (String(u.privilege || '0') !== pri) {
      const old = String(u.privilege || '0');
      was.push('role was ' + (PRI_LABEL[old] || old));
    }
    r.status = was.length ? 'update' : 'same';
    r.note = [r.note, was.join(', ')].filter(Boolean).join(' - ');
  }
  for (const r of rows) {
    if (r.auto === 'fresh') {
      r.note = ['number ' + r.pin + ' assigned', r.note].filter(Boolean).join(' - ');
    } else if (r.auto === 'held') {
      r.note = ['matched to PIN ' + r.pin + ' already on file', r.note].filter(Boolean).join(' - ');
    } else if (r.auto === 'again') {
      r.note = ['same name as line ' + r.autoLine + ', so the same number ' + r.pin, r.note]
        .filter(Boolean).join(' - ');
    }
    if (!r.dup) continue;
    r.note = [r.note, 'same name already on PIN ' + r.dupOf.join(', ')]
      .filter(Boolean).join(' - ');
  }
  const count = (k) => rows.filter((r) => r.status === k).length;
  return {
    lines: rows.length, new: count('new'), update: count('update'), same: count('same'),
    dupe: count('dupe'), header: count('header'), error: count('error'),
    // how many numbers this paste had to hand out, so the operator sees it
    assigned: rows.filter((r) => r.auto === 'fresh').length,
    matched: rows.filter((r) => r.auto === 'held').length,
    // what the duplicate view would send, so the button and the chip agree
    dup: rows.filter((r) => inPick(r, 'dup')).length,
    // every twin found, including the ones no pick can send
    dupAll: rows.filter((r) => r.dup).length,
  };
}

async function handleApi(req, res, route, q) {
  // ---- The dialect the academy admin already speaks.
  // Its sync engine was written against another HR server: it calls
  // /api/v1/sync/health and /api/v1/sync/events with connect_id / start_date /
  // end_date / page / limit and an X-API-Key header. Answering in that shape
  // means the academy needs no new client - only its base URL repointed here.
  if (route.startsWith('/api/v1/sync/')) {
    const t0 = Date.now();
    const asked = String(q.get('connect_id') || '');
    if (!ipAllowed(req)) {
      const why = (state.settings.allowIps || []).length
        ? 'address not on the allow-list' : 'allow-list is empty, so nobody is admitted';
      hrTrace(req, route, { pins: asked, ok: false, why, ms: Date.now() - t0 });
      trace('err', '', 'sync API denied for ' + clientIp(req) + ' - ' + why);
      return jsonOut(res, { error: 'forbidden', ip: clientIp(req) }, 403);
    }
    if (!keyOk(req)) {
      hrTrace(req, route, { pins: asked, ok: false, why: 'wrong or missing API key',
        ms: Date.now() - t0 });
      return jsonOut(res, { error: 'unauthorized' }, 401);
    }
    res._hr = { req, route, pins: asked, t0 };

    if (route === '/api/v1/sync/health') {
      return jsonOut(res, { data: {
        ok: true, service: 'aiface-mars', transport: 'rest+sse',
        devices: Object.keys(state.devices).length,
        online: Object.values(state.devices).filter((d) => d.online).length,
      } });
    }

    if (route === '/api/v1/sync/stream') return openFeed(req, res, q, route, t0);

    if (route === '/api/v1/sync/events') {
      // Empty means nobody here, not everybody. This feed exists to carry the
      // people the academy has connected, and a caller that names none of them
      // is asking for nothing - never for the whole roll.
      const pins = pinList(q, 'connect_id');
      if (!pins.length) {
        return jsonOut(res, { data: { items: [], total: 0, page: 1, limit: 0,
          note: 'name the people with connect_id - this feed never returns the whole roll' } });
      }
      const today = localDate(new Date());
      const end = q.get('end_date') || today;
      const start = q.get('start_date') || end;
      const page = Math.max(1, Number(q.get('page')) || 1);
      const limit = Math.min(Math.max(Number(q.get('limit')) || 200, 1), 1000);
      const items = syncEvents(pins, start, end, faceOnly(q));
      const from = (page - 1) * limit;
      return jsonOut(res, { data: {
        items: items.slice(from, from + limit),
        total: items.length, page, limit,
      } });
    }
    return jsonOut(res, { error: 'unknown endpoint' }, 404);
  }

  // ---- HR read-only API, restricted to allow-listed IPs
  if (route.startsWith('/api/hr/')) {
    // the dashboard's own view of the door - local UI data about who knocked,
    // so it is not behind the door it describes
    if (route === '/api/hr/log') return jsonOut(res, hrLogView(q));
    const t0 = Date.now();
    if (!ipAllowed(req)) {
      const why = (state.settings.allowIps || []).length
        ? 'address not on the allow-list' : 'allow-list is empty, so nobody is admitted';
      hrTrace(req, route, { pins: q.get('pin') || '', ok: false, why, ms: Date.now() - t0 });
      trace('err', '', 'HR API denied for ' + clientIp(req) + ' - ' + why);
      return jsonOut(res, { error: 'forbidden', ip: clientIp(req) }, 403);
    }
    if (!keyOk(req)) {
      hrTrace(req, route, { pins: q.get('pin') || '', ok: false,
        why: 'wrong or missing API key', ms: Date.now() - t0 });
      return jsonOut(res, { error: 'unauthorized' }, 401);
    }
    if (route === '/api/hr/stream') return openFeed(req, res, q, route, t0);
    res._hr = { req, route, pins: q.get('pin') || '', t0 };
    const today = localDate(new Date());
    const to = q.get('to') || today;
    const from = q.get('from') || to;
    // Which people HR asked for. Empty means everyone, so a first sync can
    // still see the roll and connect it up.
    const want = pinList(q);
    const scope = want.length ? want : Object.keys(state.users);
    const since = Number(q.get('since')) || 0;
    if (route === '/api/hr/users') {
      const users = Object.values(state.users)
        .filter((u) => !want.length || want.includes(normPin(u.pin)));
      return jsonOut(res, { users, pins: want, total: users.length });
    }
    if (route === '/api/hr/punches') {
      const punches = filterLogs(q, { pins: want, since });
      const next = state.logs.reduce((m, r) => Math.max(m, Number(r.recv) || 0), 0);
      return jsonOut(res, { from, to, pins: want, since, next, punches });
    }
    if (route === '/api/hr/events') {
      const face = faceOnly(q);
      const { days, next } = hrEvents(scope, from, to, face, since);
      return jsonOut(res, {
        from, to, verifiedBy: face ? 'face' : 'any',
        pins: want, since, next, days,
      });
    }
    // What HR shows when a sync comes back short: a terminal that has stopped
    // polling is holding punches nobody can see yet.
    if (route === '/api/hr/devices') {
      const rows = Object.values(state.devices).map((d) => ({
        sn: d.sn, name: (d.info && d.info.DeviceName) || d.name || '',
        online: !!d.online, role: d.role || '',
        last_seen: d.lastSeen || 0, punches: d.pushCount || 0,
      }));
      return jsonOut(res, { devices: rows, online: rows.filter((d) => d.online).length });
    }
    // A terminal that was offline still holds its own log. This asks for it -
    // the command is collected on the gate's next poll, so the punches land a
    // moment later and the next events call with the same cursor picks them up.
    if (route === '/api/hr/fetch') {
      const all = Object.keys(state.devices);
      const online = all.filter((sn) => state.devices[sn].online);
      const days = Math.min(Math.max(Number(q.get('days')) || 7, 1), 90);
      if (!online.length) {
        return jsonOut(res, { ok: false, queued: [], devices: all.length, online: 0, days,
          error: all.length
            ? 'no terminal is polling this server right now - nothing can be asked of them'
            : 'no terminal has ever connected to this server' }, 409);
      }
      const queued = online.map((sn) => enqueue(sn, buildCommand('queryatt', { days }),
        { kind: 'queryatt' }));
      trace('info', '', 'HR asked the gates for the last ' + days + ' day(s) of log');
      return jsonOut(res, {
        ok: true, days, devices: all.length, online: online.length,
        queued: queued.map((c) => ({ id: c.id, sn: c.sn })),
        note: 'Each gate uploads on its next poll. Call /api/hr/events again with your '
          + 'last cursor in a few seconds to collect what arrives.',
      });
    }
    if (route === '/api/hr/attendance') {
      const face = faceOnly(q);
      // one connected person is the common call, and it keeps the shape it has
      // always had; a list of them answers with the roll
      if (want.length === 1) return jsonOut(res, attendance(want[0], from, to, face));
      const rows = scope
        .map((x) => attendance(x, from, to, face))
        .sort((a, b) => Number(a.pin) - Number(b.pin));
      return jsonOut(res, {
        from, to, verifiedBy: face ? 'face' : 'any', pins: want, employees: rows,
      });
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
      hrKeySet: !!state.settings.hrKey,         // nor the API key
    });
  }
  if (route === '/api/settings' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    let ipRejected = [];
    if (body.allowIps !== undefined) {
      const wanted = (body.allowIps || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
      ipRejected = wanted
        .map((rule) => ({ rule, why: badIpRule(rule) }))
        .filter((x) => x.why);
      const bad = new Set(ipRejected.map((x) => x.rule));
      state.settings.allowIps = wanted.filter((rule) => !bad.has(rule));
      trace('info', '', 'HR allow-list set to ' + (state.settings.allowIps.join(' ') || '(empty)')
        + (ipRejected.length ? ' (rejected: ' + ipRejected.map((x) => x.rule).join(' ') + ')' : ''));
    }
    if (body.faceOnly !== undefined) state.settings.faceOnly = !!body.faceOnly;
    if (body.hrKey !== undefined) {
      state.settings.hrKey = String(body.hrKey).trim().slice(0, 128);
      trace('info', '', 'HR API key ' + (state.settings.hrKey ? 'set' : 'cleared'));
    }
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
      ok: true, allowIps: state.settings.allowIps, ipRejected,
      faceOnly: faceSetting(), dwellSec: dwellSec(),
      doorPinSet: !!state.settings.doorPin, hrKeySet: !!state.settings.hrKey,
    });
  }
  // The picture itself. Served from disk rather than through the state payload
  // so a list of 300 people does not carry 300 portraits with it.
  if (route === '/api/userpic') {
    const pin = normPin(q.get('pin') || '');
    const found = pin && photoFile(pin);
    if (!found) return jsonOut(res, { ok: false, error: 'no photo on file for that PIN' }, 404);
    try {
      const buf = fs.readFileSync(found.file);
      res.writeHead(200, { 'Content-Type': found.type, 'Content-Length': buf.length,
        'Cache-Control': 'no-cache' });
      return res.end(buf);
    } catch (e) {
      return jsonOut(res, { ok: false, error: 'photo could not be read' }, 500);
    }
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

  // The roll as a spreadsheet, cut to a run of numbers. An office asks for
  // "5001 to 5200", not for the whole file, so the range is the only filter -
  // an open end simply means everything above or below it.
  if (route === '/api/users.csv') {
    const asNum = (v) => (v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    const from = asNum(q.get('from'));
    const to = asNum(q.get('to'));
    const lo = from === null ? -Infinity : Math.min(from, to === null ? from : to);
    const hi = to === null ? Infinity : Math.max(to, from === null ? to : from);
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const rows = Object.values(state.users)
      .filter((u) => {
        const n = Number(u.pin);
        return Number.isFinite(n) && n >= lo && n <= hi;
      })
      .sort((a, b) => Number(a.pin) - Number(b.pin));
    const csv = ['PIN,Name,Card,Privilege,Face enrolled,Biometrics,Photo,Last updated']
      .concat(rows.map((u) => {
        const bio = Object.keys(u.bio || {});
        return [
          u.pin, cmdField(u.name), u.card || '',
          PRI_LABEL[String(u.privilege || '0')] || u.privilege || 'User',
          bio.some((k) => k === 'BIODATA' || k === 'FACE') ? 'yes' : 'no',
          bio.join(' '), u.photo ? 'yes' : 'no',
          u.updated ? new Date(u.updated).toISOString() : '',
        ].map(esc).join(',');
      }))
      .join('\r\n');
    const tag = (from === null && to === null) ? 'all'
      : (from === null ? 'up-to-' + hi : to === null ? 'from-' + lo : lo + '-' + hi);
    trace('info', '', 'users exported: ' + rows.length + ' record(s), range ' + tag);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="users-' + tag + '.csv"',
    });
    return res.end('\ufeff' + csv);
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

  // Bulk import. One paste of "PIN<sep>Name" lines becomes one user record per
  // line and one DATA UPDATE USERINFO per record, which the terminal collects
  // on its next poll. dryRun grades the paste and changes nothing - that is
  // what Preview calls, and it runs the same rows the push would send.
  if (route === '/api/users/import' && req.method === 'POST') {
    let p = {};
    try { p = JSON.parse((await readBody(req)) || '{}'); } catch (e) {}
    const pri = String(Number(p.pri) || 0);
    const upper = p.upper !== false;
    const auto = p.auto !== false;
    const parsed = parseUserList(p.text, upper, auto);
    const counts = gradeImport(parsed.rows, pri);
    const pick = PICK[p.pick] ? p.pick : 'all';
    const wanted = parsed.rows.filter((r) => inPick(r, pick));
    counts.push = wanted.length;
    counts.pick = pick;
    const preview = {
      ok: true, dryRun: true, upper, auto, counts, rows: parsed.rows, over: parsed.over,
    };
    if (p.dryRun) return jsonOut(res, preview);

    if (!wanted.length) {
      return jsonOut(res, Object.assign({}, preview, { ok: false, dryRun: false,
        error: counts.lines === 0 || (counts.error && !counts.new && !counts.update && !counts.same)
          ? 'nothing to push - no usable line in the paste'
          : 'nothing to push - no line in this paste is ' + PICK_WORD[pick] }), 400);
    }
    const all = Object.keys(state.devices);
    const online = all.filter((sn) => state.devices[sn].online);
    const targets = p.sn ? [p.sn] : online;
    if (!targets.length) {
      return jsonOut(res, Object.assign({}, preview, { ok: false, dryRun: false,
        error: 'no terminal is online right now - ' + all.length
          + ' known device(s), none polling this server' }), 409);
    }
    const batch = ++importSeq;
    const queued = [];
    for (const r of wanted) {
      const u = state.users[r.pin] || (state.users[r.pin] = { pin: r.pin });
      // no card column in the paste means "leave the card alone", so the stored
      // one is what gets sent rather than a blank that would clear it
      const card = r.card || u.card || '';
      u.name = r.name;
      u.card = card;
      u.privilege = pri;
      u.updated = Date.now();
      for (const sn of targets) {
        queued.push(enqueue(sn, buildCommand('adduser', { pin: r.pin, name: r.name, card, pri }),
          { kind: 'adduser', batch, pin: r.pin }));
      }
    }
    saveSoon();
    trace('info', '', 'bulk import: ' + wanted.length + ' user record(s) -> '
      + targets.length + ' terminal(s), batch ' + batch);
    return jsonOut(res, Object.assign({}, preview, {
      dryRun: false, batch, targets,
      queued: queued.map((c) => ({ id: c.id, sn: c.sn, pin: c.pin })),
    }));
  }

  // How far a paste actually got. Asking by batch keeps the browser from
  // listing several hundred command ids back at us on every poll, and a
  // terminal that rejects a record names the PIN it rejected.
  if (route === '/api/users/import/status') {
    const batch = Number(q.get('batch') || 0);
    const items = Object.values(state.queue).flat().filter((c) => c.batch === batch);
    const done = items.filter((c) => c.returned);
    const bad = done.filter((c) => !returnedOk(c));
    return jsonOut(res, {
      batch, total: items.length,
      sent: items.filter((c) => c.sent).length,
      returned: done.length, failed: bad.length,
      failures: bad.slice(0, 20).map((c) => ({ sn: c.sn, pin: c.pin || '', result: c.result })),
    });
  }

  // Two records for one person, and one of them has to go. dryRun lists every
  // pair with the survivor already chosen and changes nothing. The apply never
  // takes the browser's word for which PIN is disposable: the groups are built
  // again here, and a PIN that is not a dropped twin in that fresh reading is
  // refused however it was asked for.
  if (route === '/api/users/dupes' && req.method === 'POST') {
    let p = {};
    try { p = JSON.parse((await readBody(req)) || '{}'); } catch (e) {}
    const groups = dupeGroups();
    const held = groups.reduce((n, g) => n + g.drop.filter((d) => d.holds.length).length, 0);
    const free = groups.reduce((n, g) => n + g.drop.filter((d) => !d.holds.length).length, 0);
    const preview = {
      ok: true, dryRun: true, groups,
      pairs: groups.length, removable: free, held,
    };
    if (p.dryRun) return jsonOut(res, preview);

    const allowed = new Map();
    for (const g of groups) {
      for (const d of g.drop) {
        if (d.holds.length && !p.includeHeld) continue;
        allowed.set(d.pin, { keep: g.keep.pin, name: d.name });
      }
    }
    const asked = Array.isArray(p.pins) && p.pins.length
      ? p.pins.map((x) => normPin(x)) : [...allowed.keys()];
    const wanted = [...new Set(asked)].filter((pin) => allowed.has(pin));
    if (!wanted.length) {
      return jsonOut(res, Object.assign({}, preview, { ok: false, dryRun: false,
        error: held && !free
          ? 'every duplicate here is held back - tick the box to include them'
          : 'no duplicate record to remove' }), 400);
    }
    const all = Object.keys(state.devices);
    const online = all.filter((sn) => state.devices[sn].online);
    const targets = p.sn ? [p.sn] : online;
    if (!targets.length) {
      return jsonOut(res, Object.assign({}, preview, { ok: false, dryRun: false,
        error: 'no terminal is online right now - ' + all.length
          + ' known device(s), none polling this server' }), 409);
    }
    const batch = ++importSeq;
    const queued = [];
    for (const pin of wanted) {
      const gone = allowed.get(pin);
      delete state.users[pin];
      for (const sn of targets) {
        queued.push(enqueue(sn, buildCommand('deluser', { pin }),
          { kind: 'deluser', batch, pin }));
      }
      trace('info', '', 'duplicate removed: PIN ' + pin + ' "' + gone.name
        + '" - kept PIN ' + gone.keep);
    }
    saveSoon();
    return jsonOut(res, Object.assign({}, preview, {
      dryRun: false, batch, targets, removed: wanted,
      queued: queued.map((c) => ({ id: c.id, sn: c.sn, pin: c.pin })),
    }));
  }

  // Names stored in mixed case. They came in that way from an older paste or
  // from the terminal's own keypad, and they are the ones that read wrong next
  // to a roll typed in capitals. dryRun lists them and changes nothing; the
  // apply rewrites the name only - privilege and card are carried through
  // untouched, so raising a name's case can never quietly demote anyone.
  if (route === '/api/users/case' && req.method === 'POST') {
    let p = {};
    try { p = JSON.parse((await readBody(req)) || '{}'); } catch (e) {}
    const only = Array.isArray(p.pins) && p.pins.length
      ? new Set(p.pins.map((x) => normPin(x))) : null;
    const found = Object.values(state.users)
      .filter((u) => hasLower(u.name))
      .filter((u) => !only || only.has(String(u.pin)))
      .sort((a, b) => Number(a.pin) - Number(b.pin))
      .map((u) => ({ pin: String(u.pin), name: cmdField(u.name),
        upper: cmdField(u.name).toUpperCase() }));
    const preview = { ok: true, dryRun: true, total: found.length, rows: found };
    if (p.dryRun) return jsonOut(res, preview);
    if (!found.length) {
      return jsonOut(res, Object.assign({}, preview, { ok: false, dryRun: false,
        error: 'every stored name is already in capitals' }), 400);
    }
    const all = Object.keys(state.devices);
    const online = all.filter((sn) => state.devices[sn].online);
    const targets = p.sn ? [p.sn] : online;
    if (!targets.length) {
      return jsonOut(res, Object.assign({}, preview, { ok: false, dryRun: false,
        error: 'no terminal is online right now - ' + all.length
          + ' known device(s), none polling this server' }), 409);
    }
    const batch = ++importSeq;
    const queued = [];
    for (const r of found) {
      const u = state.users[r.pin];
      if (!u) continue;
      u.name = r.upper;
      u.updated = Date.now();
      const pri = String(u.privilege || '0');
      for (const sn of targets) {
        queued.push(enqueue(sn, buildCommand('adduser',
          { pin: r.pin, name: r.upper, card: u.card || '', pri }),
        { kind: 'adduser', batch, pin: r.pin }));
      }
    }
    saveSoon();
    trace('info', '', 'case fix: ' + found.length + ' name(s) raised to capitals -> '
      + targets.length + ' terminal(s), batch ' + batch);
    return jsonOut(res, Object.assign({}, preview, {
      dryRun: false, batch, targets,
      queued: queued.map((c) => ({ id: c.id, sn: c.sn, pin: c.pin })),
    }));
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
  // Both terminals here are readers on the same door, so nothing in the
  // protocol says which way a person went. This is where a human says it.
  // The mark is filed under the punch's dedupe key, which is what a re-sync
  // matches on, so pulling the same punch again never disturbs it.
  if (route === '/api/punch/dir' && req.method === 'POST') {
    const p = JSON.parse((await readBody(req)) || '{}');
    // one punch, or a whole run at once - splitting a folded run sets both
    // ends together, so it lands as one save and one redraw
    const wanted = Array.isArray(p.marks) ? p.marks : [{ key: p.key, dir: p.dir }];
    const done = [];
    for (const w of wanted.slice(0, 50)) {
      const key = String((w && w.key) || '');
      if (!seen.has(key)) return jsonOut(res, { ok: false, error: 'unknown punch' }, 404);
      const dir = ['in', 'out'].includes(w.dir) ? w.dir : '';
      if (dir) state.marks[key] = dir; else delete state.marks[key];
      done.push({ key, dir });
      trace('info', key.split('|')[0], 'punch ' + key.split('|').slice(1, 3).join(' ')
        + ' marked ' + (dir || 'automatic'));
    }
    saveSoon();
    return jsonOut(res, { ok: true, marks: done });
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
.card.sm{padding:11px 13px}
.card.sm .k{text-transform:none;letter-spacing:0;font-size:11.5px;
font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis}
.card.sm .v{font-size:16px;margin-top:3px}
.card.sm .sub{font-size:11px;color:var(--dim);margin-top:2px}
.grid.tight{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
/* how much of the roll the terminal can actually recognise */
.meter{height:8px;border-radius:6px;background:#0d1117;border:1px solid var(--line);overflow:hidden}
.meter i{display:block;height:100%;background:var(--accent);border-radius:6px}
.meter i.warn{background:var(--warn)}
.meter i.bad{background:#f87171}
.devcard{border:1px solid var(--line);border-radius:10px;padding:12px 13px;margin-bottom:12px;
background:#0d1117}
.cols{display:grid;gap:14px;grid-template-columns:1fr 340px}
/* a grid track is as wide as its widest child unless told otherwise, and the
   protocol trace is one long unwrapped line - without this the main column
   stretches past the window and takes the side column off-screen with it */
.cols>*{min-width:0}
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
/* a standalone button that is holding a filter open, outside a .seg group */
button.on{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled,button.p:disabled{background:#21262d;border-color:var(--line);color:var(--dim);
cursor:default;opacity:.65}
input,select,textarea{background:#0d1117;color:var(--fg);border:1px solid var(--line);border-radius:7px;
padding:7px 10px;font-size:13px;font-family:inherit;width:100%}
textarea{resize:vertical;min-height:118px;line-height:1.65;white-space:pre;
font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
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
  input,select,textarea{width:100%}
  #aList{position:fixed;left:12px;right:12px;top:auto}
}
.hint b{color:var(--fg)}
code{background:#0d1117;border:1px solid var(--line);padding:1px 6px;border-radius:5px;font-size:12px}
.empty{padding:34px;text-align:center;color:var(--dim)}
.note{font-size:12px;color:var(--dim);line-height:1.6}
.tag{font-size:10.5px;padding:2px 8px;border-radius:20px;background:#21262d;
border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.tag.face{background:rgba(59,130,246,.16);color:#93c5fd;border-color:rgba(59,130,246,.4)}
.st{font-size:10.5px;padding:2px 8px;border-radius:20px;background:#21262d;border:1px solid var(--line);
color:var(--dim);white-space:nowrap}
.st.new{background:rgba(34,197,94,.15);color:var(--ok);border-color:rgba(34,197,94,.35)}
.st.update{background:rgba(59,130,246,.16);color:#93c5fd;border-color:rgba(59,130,246,.4)}
.st.dupe,.st.header{background:rgba(245,158,11,.13);color:var(--warn);border-color:rgba(245,158,11,.32)}
.st.error{background:rgba(239,68,68,.12);color:#f87171;border-color:rgba(239,68,68,.3)}
.st.dup{background:rgba(168,85,247,.16);color:#d8b4fe;border-color:rgba(168,85,247,.42)}
.st.low{background:rgba(245,158,11,.13);color:var(--warn);border-color:rgba(245,158,11,.32)}
.st.keep{background:rgba(34,197,94,.15);color:var(--ok);border-color:rgba(34,197,94,.35)}
.st.drop{background:rgba(239,68,68,.12);color:#f87171;border-color:rgba(239,68,68,.3)}
.st.hold{background:rgba(245,158,11,.13);color:var(--warn);border-color:rgba(245,158,11,.32)}
button.rm{padding:3px 9px;font-size:11px;border-color:rgba(239,68,68,.35);color:#f87171}
button.rm:hover{border-color:#f87171;background:rgba(239,68,68,.12);color:#fca5a5}
button.vw{padding:3px 9px;font-size:11px}
.rule{display:inline-flex;align-items:center;gap:8px;background:#0d1117;border:1px solid var(--line);
border-radius:7px;padding:5px 6px 5px 11px;font-size:12px;font-family:ui-monospace,Menlo,monospace}
.rule button{padding:1px 7px;font-size:13px;line-height:1.2;border-color:transparent;
background:transparent;color:var(--dim)}
.rule button:hover{color:#f87171;border-color:rgba(239,68,68,.35)}
#mBody img.face{display:block;margin:0 auto;max-width:100%;border-radius:10px;
border:1px solid var(--line);background:#0d1117}
/* a row the current pick would not send - still listed, visibly not going */
#bRows tr.skip{opacity:.38}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;flex:0 0 auto}
.seg button{border:0;border-radius:0;background:transparent;color:var(--dim);padding:7px 13px}
.seg button:hover{color:#fff}
.seg button.on{background:var(--accent);color:#fff}
/* the day as a table: one row per movement, in the order it happened */
.steps{margin:2px 0 14px}
.steps td{padding:7px 10px}
.steps tr:hover td{background:transparent}
.steps .sdot{display:inline-block;width:9px;height:9px;border-radius:9px;margin-right:8px;
box-sizing:border-box;background:var(--panel);border:2px solid var(--dim);vertical-align:middle}
.steps .sdot.a{background:var(--ok);border-color:var(--ok)}
.steps .sdot.z{background:var(--warn);border-color:var(--warn)}
.steps .sdot.bs{border-color:var(--warn)}
.steps .sdot.be{border-color:var(--ok)}
.steps tr.x{opacity:.5}
.steps tr.pend td{color:var(--warn)}
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
/* hand-set direction: with two readers on one door, nothing in the protocol
   says which way someone went, so this is where a person says it */
.tapline{display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding:4px 0 0}
.dir{display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden}
.dir button{border:0;border-radius:0;background:transparent;color:var(--dim);
padding:2px 9px;font-size:10.5px}
.dir button:hover{color:#fff}
.dir button.on.in{background:var(--ok);color:#06210f}
.dir button.on.out{background:var(--warn);color:#241a00}
.dir button.on.auto{background:#30363d;color:#fff}
.tl .split{padding:2px 9px;font-size:10.5px;background:transparent;color:var(--dim)}
.tl .split:hover{color:#fff}
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
        <button class="p" onclick="syncData()">Sync data</button>
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
    <div class="body note syncMsg" style="padding-top:0"></div>
    <div class="scroll" style="max-height:620px">
      <table><thead><tr><th>Time</th><th>PIN</th><th>Name</th><th>Type</th><th>Verified by</th><th>Device</th>
      <th></th></tr></thead>
      <tbody id="tbLogs"></tbody></table>
      <div class="empty" id="emptyLogs">Waiting for the first punch from the device...</div>
    </div>
  </div>

  <div class="panel">
    <h2>Users on device
      <span class="row">
        <input id="uq" placeholder="Filter users" style="width:170px" oninput="renderUsers()">
        <button id="uLow" onclick="toggleLower()">small letters</button>
        <button class="p" id="uFix" onclick="fixCase()">UPPERCASE</button>
        <button id="uDup" onclick="toggleDupes()">duplicates</button>
        <button class="d" id="uDrop" onclick="dropDupes()">Remove duplicates</button>
        <button onclick="exportUsers()">Export</button>
        <button onclick="cmd('queryuser')">Pull from device</button>
      </span>
    </h2>
    <div class="note" id="uMsg" style="padding:0 14px 8px"></div>
    <div class="note" id="uHeld" style="padding:0 14px 8px;display:none">
      <label style="display:flex;align-items:center;gap:6px">
        <input id="uHeldOn" type="checkbox" style="width:auto" onchange="renderUsers()">
        <span id="uHeldTxt"></span>
      </label>
    </div>
    <div class="scroll" style="max-height:300px">
      <table><thead><tr><th>PIN</th><th>Name</th><th>Card</th><th>Privilege</th><th>Biometrics</th>
      <th></th></tr></thead>
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
        <h2>Bulk import users
          <span class="row">
            <select id="bPri" style="width:120px">
              <option value="0">User</option><option value="2">Enroller</option>
              <option value="6">Manager</option><option value="14">Super admin</option>
            </select>
            <label class="hint" style="display:flex;align-items:center;gap:5px"
              title="Store every name in capital letters">
              <input id="bUpper" type="checkbox" checked style="width:auto" onchange="bulkRegrade()">CAPS
            </label>
            <label class="hint" style="display:flex;align-items:center;gap:5px"
              title="A line with no number gets the next one after the highest in use">
              <input id="bAuto" type="checkbox" checked style="width:auto" onchange="bulkRegrade()">Auto #
            </label>
            <span class="seg" id="bPick">
              <button class="on" onclick="setPick('all')" id="pkall">All</button>
              <button onclick="setPick('new')" id="pknew">New</button>
              <button onclick="setPick('update')" id="pkupdate">Changed</button>
              <button onclick="setPick('same')" id="pksame">Unchanged</button>
              <button onclick="setPick('dup')" id="pkdup">Dupes</button>
            </span>
          </span>
        </h2>
        <div class="body">
          <textarea id="bText" rows="7" spellcheck="false"
            placeholder="No.&#9;Student Name&#10;5001&#9;HASHIM SHAHAL K&#10;5002&#9;MUHAMMED JASIM&#10;5003&#9;MUHAMMED HIZAM"></textarea>
          <div class="row" style="margin-top:9px">
            <button onclick="bulkPreview()">Preview</button>
            <button class="p" id="bPush" onclick="bulkPush()" disabled>Push to device</button>
            <button id="bDropDup" onclick="dropDupeLines()" style="display:none"></button>
            <button id="bSeeDup" onclick="reviewDupes()" style="display:none"></button>
            <button onclick="bulkClear()">Clear</button>
            <span class="note" id="bMsg" style="flex:1 1 160px"></span>
          </div>
          <div class="row" id="bCounts" style="margin-top:9px"></div>
          <div class="scroll" id="bWrap" style="max-height:330px;margin-top:9px;display:none;border:1px solid var(--line);border-radius:8px">
            <table><thead><tr><th>Line</th><th>PIN</th><th>Name</th><th>Card</th><th>Status</th></tr></thead>
            <tbody id="bRows"></tbody></table>
          </div>
        </div>
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
            <button onclick="cmd('queryatt',{days:1})">Pull today</button>
            <button onclick="cmd('queryatt',{days:7})">Pull 7 days</button>
            <button onclick="cmd('queryatt',{days:30})">Pull 30 days</button>
            <button onclick="cmd('info')">Device info</button>
            <button onclick="cmd('check')">Full re-sync</button>
            <button onclick="cmd('reboot')">Reboot</button>
          </div>
          <div class="note syncMsg" style="margin-top:8px"></div>
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
          this creates the user record so the face can be registered against it.
          A whole class at once goes through <b>Bulk import users</b>.</p>
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
        Read-only API for your HR system. Only the addresses listed here can call it &mdash;
        an empty list blocks everyone. Your current IP is <b id="myIp">?</b>.<br>
        An HR server rarely calls from one fixed address, so a rule can be any of four forms:
        <code>*</code> every caller &middot;
        <code>103.119.254.234</code> one address &middot;
        <code>49.37.*</code> everything under that prefix &middot;
        <code>49.37.0.0/16</code> the same in CIDR.
        A rule that could never match is refused rather than saved.
      </div>
      <div class="row">
        <input id="ipNew" placeholder="103.119.254.234  or  49.37.*  or  10.0.0.0/8"
          style="flex:1;min-width:240px" onkeydown="if(event.key==='Enter')addIp()">
        <button class="p" onclick="addIp()">Add</button>
        <button onclick="useMyIp()">Add my IP</button>
      </div>
      <div id="ipRules" class="row" style="margin-top:10px"></div>
      <div id="ipMsg" class="note" style="margin-top:8px"></div>
      <div class="row" style="margin-top:12px">
        <input id="hrKey" placeholder="API key (optional second lock)" style="flex:1;min-width:220px">
        <button class="p" onclick="saveHrKey()">Save key</button>
        <button onclick="clearHrKey()">Clear</button>
      </div>
      <div id="hrKeyMsg" class="note" style="margin-top:8px"></div>
      <div class="note" style="margin-top:12px">
        <b>Endpoints</b> &mdash; share these with HR:<br>
        <span class="mono" id="hrUrls"></span><br>
        <span style="display:inline-block;margin-top:8px">Add <code>pin=2,5,9</code> to any of them
        to fetch <b>only the people HR has connected</b>, and
        <code>since=&lt;ms&gt;</code> to ask for just what has arrived since the last sync &mdash;
        each answer carries the <code>next</code> cursor to send back. Punches reach this server
        long after they happen when a terminal has been offline, so the cursor is arrival time,
        not the punch's own clock. When a gate has been away, <code>/api/hr/fetch</code> asks it
        for its own log &mdash; it uploads on its next poll, so HR calls
        <code>/api/hr/events</code> again a moment later with the same cursor.</span>
      </div>
    </div>
  </div>

  <div class="panel">
    <h2>Who is calling the HR API
      <span class="row">
        <span class="note" id="hrLogSum"></span>
        <button onclick="loadHrLog()">Refresh</button>
      </span>
    </h2>
    <div class="body">
      <div class="note" style="margin-bottom:10px">Every call at the HR door, admitted or refused,
      with the address it came from. An address that was turned away carries the exact string to
      paste into the allow-list above &mdash; so the fix is a copy, not a guess.</div>
      <div id="hrFeeds"></div>
      <div class="scroll" style="max-height:240px">
        <table><thead><tr><th>Address</th><th>State</th><th>Calls</th><th>Refused</th>
        <th>Records sent</th><th>Last call</th></tr></thead>
        <tbody id="hrCallers"></tbody></table>
        <div class="empty" id="hrNone">Nobody has called the HR API yet.</div>
      </div>
      <div class="hint" style="margin:14px 0 6px">Recent calls</div>
      <div class="scroll" style="max-height:280px">
        <table><thead><tr><th>Time</th><th>Address</th><th>Endpoint</th><th>People asked for</th>
        <th>Records</th><th>Took</th></tr></thead>
        <tbody id="hrCalls"></tbody></table>
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
// Clocks read 12-hour with AM/PM throughout - the way the wall clock and the
// people reading this page say the time. The stored punch keeps its 24-hour
// stamp; only the display changes.
function pad2(n){ return String(n).padStart(2, '0'); }
function ampm(h, m, s){
  return (h % 12 || 12) + ':' + pad2(m) + (s === undefined ? '' : ':' + pad2(s))
    + ' ' + (h < 12 ? 'AM' : 'PM');
}
function clock(t){
  var d = t instanceof Date ? t : new Date(t);
  return ampm(d.getHours(), d.getMinutes(), d.getSeconds());
}
function stampOf(t){
  var d = t instanceof Date ? t : new Date(t);
  return pad2(d.getDate()) + ' ' + MONTHS[d.getMonth()] + ' ' + clock(d);
}
// "2026-09-03 11:25:06" -> {date:"03 Sept (Thu)", time:"11:25 AM"}
function fmtStamp(str){
  var m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[ T]([0-9]{2}):([0-9]{2}))?/.exec(str || '');
  if (!m) return { date: str || '', time: '' };
  var dt = new Date(+m[1], +m[2] - 1, +m[3]);
  var date = m[3] + ' ' + MONTHS[+m[2] - 1] + ' (' + DAYS[dt.getDay()] + ')';
  if (m[4] === undefined) return { date: date, time: '' };
  return { date: date, time: ampm(+m[4], +m[5]) };
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
  if (name === 'srv') { loadIps(); loadHrLog(); }
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
  setInterval(function(){ if (TAB === 'srv') loadHrLog(); }, 10000);
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
// A name is "small letters" when raising it would change it - that catches
// "Joel Mathews" and "MOHAMMED mufeed" alike, and leaves a name that is
// already shouting, or has no letters at all, alone.
function isLower(name){
  var n = String(name || '').trim();
  return !!n && n !== n.toUpperCase();
}

var LOWONLY = false, CASE_TIMER = null;
// what the server decided about each twin, pin -> {role, twin, why, holds}
var DUPES = null, DUPONLY = false, DUP_ASKED = false;

// The survivor is the server's call, not the browser's - asking for it keeps
// one ranking in one place, and the list here only draws what came back.
function loadDupes(then){
  fetch('/api/users/dupes', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({dryRun:true})})
    .then(function(r){ return r.json(); })
    .catch(function(){ return null; })
    .then(function(j){
      if (!j || !j.ok) { userNote('could not read the duplicates'); return; }
      DUPES = {};
      // a reply that is ok but shaped wrong would throw here, and one thrown
      // error in this file stops the whole dashboard drawing
      (j.groups || []).forEach(function(g){
        DUPES[g.keep.pin] = {role:'keep', why:g.keep.why, holds:[], group:g.keep.pin,
          twin:g.drop.map(function(d){ return d.pin; }).join(', ')};
        g.drop.forEach(function(d){
          DUPES[d.pin] = {role: d.holds.length ? 'hold' : 'drop', why:d.why,
            holds:d.holds, twin:g.keep.pin, group:g.keep.pin};
        });
      });
      DUPES.summary = {pairs:j.pairs, removable:j.removable, held:j.held};
      renderUsers();
      if (then) then(j);
    });
}

function toggleDupes(){
  DUPONLY = !DUPONLY;
  if (DUPONLY && !DUPES) return loadDupes();
  renderUsers();
}

// every PIN the Remove button would send, which is what the confirm lists
function dropList(){
  if (!DUPES) return [];
  var held = q('uHeldOn').checked;
  return visibleUsers().filter(function(u){
    var d = DUPES[String(u.pin)];
    return d && (d.role === 'drop' || (held && d.role === 'hold'));
  });
}

function dropDupes(){
  if (!DUPES) return loadDupes(function(){ userNote('duplicates read - press Remove again'); });
  var rows = dropList();
  if (!rows.length) return userNote(DUPES.summary && DUPES.summary.held
    ? 'nothing to remove - ' + DUPES.summary.held + ' duplicate(s) are held back, tick the box to include them'
    : 'no duplicate record to remove');
  var lines = rows.slice(0, 6).map(function(u){
    var d = DUPES[String(u.pin)];
    return 'remove ' + u.pin + ' ' + u.name + '  (keeping ' + d.twin + ')'
      + (d.holds.length ? '  - ' + d.why : '');
  }).join('\\n');
  if (!confirm('Remove ' + rows.length + ' duplicate record(s) from this server and from the '
    + 'terminal?\\n\\n' + lines + (rows.length > 6 ? '\\n...and ' + (rows.length - 6) + ' more' : '')
    + '\\n\\nThe face enrolled on a removed record goes with it.')) return;
  q('uDrop').disabled = true;
  userNote('removing ' + rows.length + ' record(s)...');
  fetch('/api/users/dupes', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({pins: rows.map(function(u){ return String(u.pin); }),
      includeHeld: q('uHeldOn').checked})})
    .then(function(r){ return r.json(); })
    .catch(function(){ return {ok:false, error:'server unreachable'}; })
    .then(function(j){
      if (!j.ok) { q('uDrop').disabled = false; return userNote(j.error || 'nothing was removed'); }
      DUPES = null;
      userNote('queued ' + j.queued.length + ' delete(s) for ' + j.targets.length
        + ' terminal(s) - collected on the next poll.');
      CASE_TIMER = setTimeout(function(){
        bulkWatch(j.batch, Date.now() + 180000, userNote);
      }, 1600);
      refresh();
      loadDupes();
    });
}

function toggleLower(){
  LOWONLY = !LOWONLY;
  q('uLow').className = LOWONLY ? 'on' : '';
  renderUsers();
}

function userNote(msg){ q('uMsg').textContent = msg; }

// The office asks for a run of numbers - "5001 to 5200" - so the range is
// what the popup asks for, prefilled with the span actually on file. An end
// left blank means no bound on that side rather than zero.
function exportUsers(){
  var pins = (PEOPLE || []).map(function(u){ return Number(u.pin); })
    .filter(function(n){ return isFinite(n); }).sort(function(a, b){ return a - b; });
  var lo = pins.length ? pins[0] : '', hi = pins.length ? pins[pins.length - 1] : '';
  q('mTitle').textContent = 'Export users';
  q('mDate').textContent = pins.length
    ? pins.length + ' on file, numbered ' + lo + ' to ' + hi : 'no users on file yet';
  q('mBody').innerHTML = '<div style="padding:12px 0">'
    + '<div class="row" style="align-items:flex-end">'
    + '<label class="hint" style="flex:1;min-width:110px">From PIN<br>'
    + '<input id="exFrom" type="number" value="' + lo + '" style="margin-top:4px"></label>'
    + '<label class="hint" style="flex:1;min-width:110px">To PIN<br>'
    + '<input id="exTo" type="number" value="' + hi + '" style="margin-top:4px"></label>'
    + '<button class="p" onclick="exportGo()" style="flex:0 0 auto">Download CSV</button>'
    + '</div>'
    + '<div class="note" id="exMsg" style="margin-top:10px"></div>'
    + '<div class="note" style="margin-top:10px">Leave an end blank for no limit on that '
    + 'side. The file carries PIN, name, card, role, whether a face is enrolled, and '
    + 'whether a photo has been synced.</div>'
    + '</div>';
  exportCount();
  q('exFrom').oninput = exportCount;
  q('exTo').oninput = exportCount;
  q('modal').style.display = 'block';
}

// say how many the range covers before anything is downloaded
function exportCount(){
  var from = q('exFrom').value, to = q('exTo').value;
  var lo = from === '' ? -Infinity : Number(from);
  var hi = to === '' ? Infinity : Number(to);
  if (lo > hi){ var t = lo; lo = hi; hi = t; }
  var n = (PEOPLE || []).filter(function(u){
    var v = Number(u.pin);
    return isFinite(v) && v >= lo && v <= hi;
  }).length;
  q('exMsg').innerHTML = n
    ? '<b>' + n + '</b> user(s) in this range'
    : '<span style="color:var(--warn)">No user has a number in this range</span>';
}

function exportGo(){
  var p = [];
  if (q('exFrom').value !== '') p.push('from=' + encodeURIComponent(q('exFrom').value));
  if (q('exTo').value !== '') p.push('to=' + encodeURIComponent(q('exTo').value));
  window.location = '/api/users.csv' + (p.length ? '?' + p.join('&') : '');
}

// Removing one record by hand. Which of a pair to keep is sometimes a call
// only the office can make - this is where they make it - so the confirm
// says what is attached to this number rather than just asking twice.
function removeUser(pin){
  var u = (PEOPLE || []).filter(function(x){ return String(x.pin) === String(pin); })[0];
  if (!u) return;
  var d = DUPES && DUPES[String(pin)];
  var face = u.bio && Object.keys(u.bio).length;
  if (!confirm('Remove PIN ' + pin + ' ' + (u.name || '') + ' from this server and the terminal?'
    + (d ? '\\n\\nThe other record for this name is PIN ' + d.twin + '.' : '')
    + (face ? '\\n\\nA face is enrolled on this record and goes with it.' : '')
    + '\\n\\nPunches already recorded under this number stay on the server, but stop being '
    + 'reported once the record is gone.')) return;
  userNote('removing PIN ' + pin + ' ' + (u.name || '') + '...');
  cmd('deluser', {pin: String(pin)});
  DUPES = null;                       // the pairs have changed, so read them again
  setTimeout(loadDupes, 600);
}

// What the UPPERCASE button would act on: whatever is listed right now, so
// both the text filter and the small-letters toggle narrow it.
function lowerShown(){
  return visibleUsers().filter(function(u){ return isLower(u.name); });
}

function visibleUsers(){
  var term = (q('uq').value || '').toLowerCase();
  var list = PEOPLE || [];
  if (term) list = list.filter(function(u){
    return String(u.pin).toLowerCase().indexOf(term) >= 0
      || String(u.name || '').toLowerCase().indexOf(term) >= 0;
  });
  if (LOWONLY) list = list.filter(function(u){ return isLower(u.name); });
  if (DUPONLY && DUPES){
    var want = {};
    list.forEach(function(u){
      var d = DUPES[String(u.pin)];
      if (d) want[d.group] = 1;
    });
    list = (PEOPLE || []).filter(function(u){
      var d = DUPES[String(u.pin)];
      return d && want[d.group];
    });
  } else if (DUPONLY) list = [];
  return list;
}

// twins sit next to each other, survivor first, so a pair reads as a pair
function byGroup(list){
  if (!DUPONLY || !DUPES) return list;
  return list.slice().sort(function(a, b){
    var x = DUPES[String(a.pin)] || {}, y = DUPES[String(b.pin)] || {};
    if (Number(x.group) !== Number(y.group)) return Number(x.group) - Number(y.group);
    return (x.role === 'keep' ? 0 : 1) - (y.role === 'keep' ? 0 : 1);
  });
}

var DUP_PILL = {keep:'keep', drop:'remove', hold:'held back'};

function renderUsers(){
  var list = byGroup(visibleUsers());
  q('tbUsers').innerHTML = list.map(function(u){
    var bio = u.bio ? Object.keys(u.bio).join(', ') : '';
    var d = DUPES && DUPES[String(u.pin)];
    var dup = d ? ' <span class="st ' + d.role + '">' + DUP_PILL[d.role] + '</span>'
      + ' <span class="hint">' + (d.role === 'keep' ? 'over PIN ' : 'twin of PIN ') + esc(d.twin)
      + (d.why ? ' - ' + esc(d.why) : '') + '</span>' : '';
    return '<tr><td class="mono">' + esc(u.pin) + '</td><td>' + esc(u.name)
      + (isLower(u.name) ? ' <span class="st low">small letters</span>' : '') + dup + '</td>'
      + '<td class="mono">' + esc(u.card || '') + '</td>'
      + '<td>' + esc(PRIVILEGE[u.privilege] || u.privilege || 'User') + '</td>'
      + '<td style="color:#8b949e">' + esc(bio) + '</td>'
      + '<td style="text-align:right;white-space:nowrap">'
      + (u.photo ? '<button class="vw" onclick="viewPhoto(\\'' + esc(u.pin) + '\\')">View</button> ' : '')
      + '<button class="rm" onclick="removeUser(\\''
      + esc(u.pin) + '\\')">Remove</button></td></tr>';
  }).join('');
  var low = (PEOPLE || []).filter(function(u){ return isLower(u.name); }).length;
  q('uLow').textContent = 'small letters' + (low ? ' ' + low : '');
  q('uLow').className = LOWONLY ? 'on' : '';
  var n = lowerShown().length;
  q('uFix').disabled = !n;
  q('uFix').textContent = n ? 'UPPERCASE ' + n : 'UPPERCASE';
  var sum = DUPES && DUPES.summary;
  q('uDup').textContent = 'duplicates' + (sum ? ' ' + sum.pairs : '');
  q('uDup').className = DUPONLY ? 'on' : '';
  var gone = dropList().length;
  q('uDrop').disabled = !!DUPES && !gone;
  q('uDrop').className = 'd';
  q('uDrop').textContent = gone ? 'Remove ' + gone : 'Remove duplicates';
  // the held-back tick only appears when there is something behind it
  q('uHeld').style.display = sum && sum.held ? 'block' : 'none';
  if (sum && sum.held){
    q('uHeldTxt').textContent = 'also remove ' + sum.held + ' duplicate(s) held back for '
      + 'carrying a face, attendance history or an admin role';
  }
  var empty = q('emptyUsers');
  empty.style.display = list.length ? 'none' : 'block';
  empty.innerHTML = (PEOPLE || []).length
    ? (LOWONLY ? 'Every listed name is already in capitals.'
      : DUPONLY ? 'Nobody is on file twice.' : 'No user matches that filter.')
    : 'No users synced yet &mdash; press <b>Pull from device</b>.';
}

// Raise the listed small-letter names to capitals here and on the terminal.
// Only the name moves - the PIN keeps its card, its role and its face.
function fixCase(){
  var rows = lowerShown();
  if (!rows.length) return userNote('every listed name is already in capitals');
  var sample = rows.slice(0, 4).map(function(u){
    return u.pin + ' ' + u.name + ' \\u2192 ' + String(u.name).toUpperCase();
  }).join('\\n');
  if (!confirm('Raise ' + rows.length + ' name(s) to capitals and push them to the terminal?\\n\\n'
    + sample + (rows.length > 4 ? '\\n...and ' + (rows.length - 4) + ' more' : ''))) return;
  q('uFix').disabled = true;
  userNote('queueing ' + rows.length + ' record(s)...');
  fetch('/api/users/case', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({pins: rows.map(function(u){ return String(u.pin); })})})
    .then(function(r){ return r.json(); })
    .catch(function(){ return {ok:false, error:'server unreachable'}; })
    .then(function(j){
      if (!j.ok) return userNote(j.error || 'could not raise these names');
      userNote('queued ' + j.queued.length + ' command(s) for ' + j.targets.length
        + ' terminal(s) - collected on the next poll.');
      CASE_TIMER = setTimeout(function(){
        bulkWatch(j.batch, Date.now() + 180000, userNote);
      }, 1600);
      refresh();
      loadDupes();
    });
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
      var faces = Number(i.FaceCount || i.face_count || 0);
      var users = Number(i.UserCount || i.user_count || 0);
      var logs = Number(i.TransactionCount || i.transaction_count || 0);
      // a terminal only recognises the people whose faces it holds, so the
      // gap between the two counts is the part of the roll that cannot get in
      var pct = users ? Math.round(faces / users * 100) : 0;
      var tone = pct >= 90 ? '' : pct >= 60 ? 'warn' : 'bad';
      var maxFace = cap(faces, i.MaxFaceCount);
      // the multi-bio table keeps its own face figure and the two disagree on
      // this firmware; one number goes on screen, the other stays reachable
      var bioFace = Number((String(i.MaxMultiBioDataCount || '').split(':'))[8] || 0);
      var faceTip = maxFace && bioFace && bioFace !== maxFace
        ? 'MaxFaceCount ' + num(maxFace) + ', multi-bio face slot ' + num(bioFace) : '';
      return '<div class="devcard">'
        + '<div class="row" style="justify-content:space-between"><b class="mono">' + esc(d.sn) + '</b>'
        + '<span class="row"><span class="badge ' + (d.online?'on':'off') + '">'
        + (d.online?'online':'offline') + '</span>'
        + '<button onclick="cmd(&quot;info&quot;,' + esc(JSON.stringify({sn:d.sn})) + ')">Refresh info</button>'
        + '</span></div>'
        + '<div class="grid tight" style="margin:10px 0">'
        + card('sm', 'Faces', num(faces), maxFace ? 'of ' + num(maxFace) : '', faceTip)
        + card('sm', 'Users', num(users), cap(users, i.MaxUserCount) ? 'of ' + num(cap(users, i.MaxUserCount)) : '')
        + card('sm', 'Logs', num(logs), cap(logs, i.MaxAttLogCount) ? 'of ' + num(cap(logs, i.MaxAttLogCount)) : '')
        + '</div>'
        + (users
            ? '<div class="hint" style="margin-bottom:5px"><b>'
              + (faces >= users ? 'Everyone has a face'
                  : users - faces === 1 ? '1 person still needs a face'
                    : num(users - faces) + ' people still need a face')
              + '</b></div><div class="meter"><i class="' + tone + '" style="width:'
              + Math.min(pct, 100) + '%"></i></div>'
              + '<div class="hint" style="margin-top:5px">' + num(faces) + ' of ' + num(users)
              + ' people done'
              + (maxFace ? ' &middot; this terminal holds ' + num(maxFace) + ' faces' : '')
              + '</div>'
            : '')
        + '<div class="hint" style="margin-top:10px">'
        + 'IP <b>' + esc(d.ip||'?') + '</b><br>'
        + 'Model <b>' + esc((i.DeviceName || i['~DeviceName'] || 'AIFACE-MARS').split(',')[0]) + '</b>'
        + ' <span class="hint">' + esc(i.Platform || '') + '</span><br>'
        + 'LAN IP <b>' + esc(i.IPAddress || '?') + '</b> &middot; MAC <b>' + esc(i.MAC || '?') + '</b><br>'
        + 'Firmware <b>' + esc(i.FWVersion || i['~ZKFPVersion'] || '?') + '</b><br>'
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
  // who has a portrait on file, read from this frame's users rather than from
  // PEOPLE, which is only assigned further down
  var hasPic = {};
  for (var pi = 0; pi < s.users.length; pi++) {
    if (s.users[pi].photo) hasPic[String(s.users[pi].pin)] = 1;
  }
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
       + '<td class="mono" style="color:#8b949e">' + esc(r.sn) + '</td>'
       + '<td style="text-align:right">'
       + (hasPic[String(r.pin)]
           ? '<button class="vw" onclick="viewPhoto(\\'' + esc(r.pin) + '\\')">View</button>' : '')
       + '</td></tr>';
  }
  q('tbLogs').innerHTML = tb;
  q('emptyLogs').style.display = s.logs.length ? 'none' : 'block';

  PEOPLE = s.users;
  // the survivor ranking walks the whole punch log, so it is read once here
  // and again only after something has changed the records
  if (!DUPES && !DUP_ASKED && PEOPLE.length){ DUP_ASKED = true; loadDupes(); }
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
  say('asking the terminals for users and the last 30 days...');
  Promise.all([post('queryuser', {}), post('queryatt', {days: 30})])
    .then(function(rs){
      var bad = rs.filter(function(r){ return !r.ok; });
      say(bad.length
        ? (bad[0].error || 'the terminals did not accept the request')
        : 'requested - the terminals answer over the next minute or two.');
      refresh();
    });
}

// The sync can be started from Commands or from the log, so the reply goes to
// every message holder rather than to whichever tab happens to be showing.
function say(msg){
  var els = document.getElementsByClassName('syncMsg');
  for (var i = 0; i < els.length; i++) els[i].textContent = msg;
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
/* ------ bulk import: paste a roll, see what it means, push it in one go */
var BULK = null, BULK_TIMER = null, PICK = 'all';
var BULK_LABEL = {new:'new', update:'update', same:'unchanged', dupe:'repeat',
                  header:'heading', error:'problem'};
// mirrors the server's sets, so the button can be re-counted without asking
var SENDABLE = ['new','update','same'];
var PICK_SET = {all:SENDABLE, new:['new'], update:['update'], same:['same'], dup:SENDABLE};
var PICK_WORD = {all:'', new:'new ', update:'changed ', same:'unchanged ', dup:'duplicated '};

function bulkNote(msg){ q('bMsg').textContent = msg; }

function pickCount(c){
  if (!c) return 0;
  if (PICK === 'dup') return c.dup || 0;
  return PICK_SET[PICK].reduce(function(n, k){ return n + (c[k] || 0); }, 0);
}

// a row is in the duplicate view by its flag, not by its status - it keeps
// whatever new/changed/unchanged it earned
function rowInPick(tr){
  var st = tr.getAttribute('data-st');
  if (PICK === 'dup') return tr.getAttribute('data-dup') === '1' && SENDABLE.indexOf(st) >= 0;
  return PICK_SET[PICK].indexOf(st) >= 0;
}

// The paste is graded once; which slice of it goes out is a local decision, so
// changing the pick re-counts the button and re-shades the table on the spot.
function setPick(p){
  PICK = PICK_SET[p] ? p : 'all';
  ['all','new','update','same','dup'].forEach(function(k){
    q('pk' + k).className = k === PICK ? 'on' : '';
  });
  paintRows();
  bulkLabel();
  if (BULK && BULK.dryRun) bulkNote(bulkReady(BULK.counts));
}

function paintRows(){
  var trs = q('bRows').children;
  for (var i = 0; i < trs.length; i++) trs[i].className = rowInPick(trs[i]) ? '' : 'skip';
}

function bulkLabel(){
  var n = pickCount(BULK && BULK.counts);
  q('bPush').disabled = !n;
  q('bPush').textContent = n ? 'Push ' + n + ' to device' : 'Push to device';
  var dl = dupeLines().length;
  q('bDropDup').style.display = dl ? '' : 'none';
  q('bDropDup').textContent = 'Drop ' + dl + ' duplicate line' + (dl === 1 ? '' : 's');
  var onFile = (BULK && BULK.counts && BULK.counts.dupAll) || 0;
  q('bSeeDup').style.display = onFile ? '' : 'none';
  q('bSeeDup').textContent = 'Review ' + onFile + ' on file \\u2192';
}

function bulkReady(c){
  return pickCount(c) ? 'ready - nothing has been sent yet'
    : 'no line in this paste is ' + (PICK_WORD[PICK].trim() || 'usable');
}

function labelSegs(c){
  var n = function(k){ return c ? ' ' + (c[k] || 0) : ''; };
  q('pkall').textContent = 'All' + (c ? ' ' + ((c.new||0) + (c.update||0) + (c.same||0)) : '');
  q('pknew').textContent = 'New' + n('new');
  q('pkupdate').textContent = 'Changed' + n('update');
  q('pksame').textContent = 'Unchanged' + n('same');
  q('pkdup').textContent = 'Dupes' + n('dup');
}

// the grade depends on the toggles, so flipping one re-reads the same paste
function bulkRegrade(){
  if (BULK && q('bText').value.trim()) bulkPreview();
}

// Which lines name someone already on file under another number. They are the
// lines that would make a second record if they were pushed.
function dupeLines(){
  var out = [];
  ((BULK && BULK.rows) || []).forEach(function(r){
    if (r.dup && SENDABLE.indexOf(r.status) >= 0) out.push(r);
  });
  return out;
}

// Take them out of the paste rather than off the terminal: nothing is deleted
// anywhere, the text box just stops asking for a record that already exists.
function dropDupeLines(){
  var rows = dupeLines();
  if (!rows.length) return bulkNote('no duplicate line in this paste');
  var sample = rows.slice(0, 6).map(function(r){
    return 'line ' + r.line + '  ' + r.pin + ' ' + r.name
      + '  (already on PIN ' + (r.dupOf || []).join(', ') + ')';
  }).join('\\n');
  if (!confirm('Take ' + rows.length + ' duplicate line(s) out of the paste?\\n\\n' + sample
    + (rows.length > 6 ? '\\n...and ' + (rows.length - 6) + ' more' : '')
    + '\\n\\nNothing on the terminal is touched - only the text above changes.')) return;
  var kill = {};
  rows.forEach(function(r){ kill[r.line] = 1; });
  q('bText').value = q('bText').value.split(/\\r?\\n/)
    .filter(function(l, i){ return !kill[i + 1]; }).join('\\n');
  bulkNote(rows.length + ' duplicate line(s) removed from the paste');
  bulkPreview();
}

// The other half of the same problem: the records already on file. That is a
// deletion, so it happens where deletions happen, with the pairs side by side.
function reviewDupes(){
  showTab('log');
  if (!DUPONLY) toggleDupes();
  else if (!DUPES) loadDupes();
  var box = q('tbUsers');
  if (box && box.scrollIntoView) box.scrollIntoView({block: 'center'});
}

function bulkCall(dry){
  return fetch('/api/users/import', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({text: q('bText').value, pri: q('bPri').value,
      pick: PICK, upper: q('bUpper').checked, auto: q('bAuto').checked, dryRun: dry})})
    .then(function(r){ return r.json(); })
    .catch(function(){ return {ok:false, error:'server unreachable'}; });
}

function bulkClear(){
  clearTimeout(BULK_TIMER);
  BULK = null;
  q('bText').value = ''; q('bRows').innerHTML = ''; q('bCounts').innerHTML = '';
  q('bWrap').style.display = 'none';
  q('bPush').disabled = true; q('bPush').textContent = 'Push to device';
  q('bDropDup').style.display = 'none'; q('bSeeDup').style.display = 'none';
  labelSegs(null);
  bulkNote('');
}

function bulkPreview(){
  if (!q('bText').value.trim()) return bulkNote('paste the list first');
  bulkNote('reading the paste...');
  bulkCall(true).then(bulkShow);
}

function bulkShow(j){
  BULK = j;
  var rows = j.rows || [], c = j.counts || {};
  q('bWrap').style.display = rows.length ? 'block' : 'none';
  q('bRows').innerHTML = rows.map(function(r){
    return '<tr data-st="' + r.status + '" data-dup="' + (r.dup ? 1 : 0) + '">'
      + '<td class="mono">' + r.line + '</td><td class="mono">'
      + esc(r.pin) + '</td><td>' + esc(r.name) + '</td><td class="mono">' + esc(r.card || '-')
      + '</td><td><span class="st ' + r.status + '">' + (BULK_LABEL[r.status] || r.status) + '</span>'
      + (r.dup ? ' <span class="st dup">duplicate</span>' : '')
      + (r.note ? ' <span class="hint">' + esc(r.note) + '</span>' : '') + '</td></tr>';
  }).join('');
  labelSegs(c);
  paintRows();
  // the picker above already counts what will go, so this line is only for the
  // lines that cannot go at all - otherwise the same numbers appear twice
  var chips = [];
  ['header','dupe','error'].forEach(function(k){
    if (c[k]) chips.push('<span class="st ' + k + '">' + c[k] + ' ' + BULK_LABEL[k] + '</span>');
  });
  if (j.over) chips.push('<span class="st error">' + j.over + ' line(s) over the limit, dropped</span>');
  var head = chips.length ? '<span class="hint">never sent:</span> ' + chips.join(' ') : '';
  if (c.assigned || c.matched){
    var made = [];
    if (c.assigned) made.push('<span class="st new">' + c.assigned + ' number(s) assigned</span>');
    if (c.matched) made.push('<span class="st update">' + c.matched
      + ' matched to a number on file</span>');
    head += (head ? '<span class="hint" style="margin:0 8px">&middot;</span>' : '') + made.join(' ');
  }
  if (c.dupAll){
    head += (head ? '<span class="hint" style="margin:0 8px">&middot;</span>' : '')
      + '<span class="hint">already on file twice:</span> <span class="st dup">'
      + c.dupAll + ' duplicate name(s)</span>';
  }
  q('bCounts').innerHTML = head;
  bulkLabel();
  if (j.error) return bulkNote(j.error);
  if (j.dryRun) bulkNote(bulkReady(c));
}

function bulkPush(){
  var n = pickCount(BULK && BULK.counts);
  if (!n) return;
  if (!confirm('Push ' + n + ' ' + PICK_WORD[PICK] + 'user record(s) to the terminal?')) return;
  q('bPush').disabled = true;
  bulkNote('queueing ' + n + ' record(s)...');
  bulkCall(false).then(function(j){
    bulkShow(j);
    if (!j.ok) return;
    q('bPush').disabled = true;
    bulkNote('queued ' + j.queued.length + ' command(s) for ' + j.targets.length
      + ' terminal(s) - collected on the next poll.');
    BULK_TIMER = setTimeout(function(){ bulkWatch(j.batch, Date.now() + 180000); }, 1600);
    refresh();
    loadDupes();
  });
}

// Queued is only half the answer: what matters is what the terminal said back,
// so keep asking until every record has a reply or the wait runs out.
function bulkWatch(batch, deadline, note){
  // a paste and a case fix are the same queue seen from two panels, so the
  // watcher writes wherever it was told to rather than always into the paste
  note = note || bulkNote;
  clearTimeout(BULK_TIMER);
  clearTimeout(CASE_TIMER);
  fetch('/api/users/import/status?batch=' + batch)
    .then(function(r){ return r.json(); })
    .then(function(s){
      var left = s.total - s.returned;
      if (!left){
        note(s.failed
          ? (s.total - s.failed) + ' of ' + s.total + ' accepted, ' + s.failed + ' refused: '
            + s.failures.map(function(f){ return 'PIN ' + f.pin + ' (' + f.result + ')'; }).join(', ')
          : 'all ' + s.total + ' record(s) accepted by the terminal.');
        return refresh();
      }
      if (Date.now() > deadline){
        return note(s.returned + ' of ' + s.total + ' confirmed, ' + left
          + ' unanswered - check the terminal is online and still polling.');
      }
      note(s.returned + ' of ' + s.total + ' confirmed'
        + (s.failed ? ', ' + s.failed + ' refused' : '') + ' - waiting for the rest...');
      var again = setTimeout(function(){ bulkWatch(batch, deadline, note); }, 3000);
      if (note === bulkNote) BULK_TIMER = again; else CASE_TIMER = again;
    })
    .catch(function(){ note('lost contact with the server while waiting.'); });
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
                 + '</span> &ndash; <span style="color:var(--warn)">check-out pending</span>'
             : d.punches ? '<span style="color:var(--warn)">no check-in</span>'
             : '<span style="color:#8b949e">Not marked</span>';
    tb += '<tr style="cursor:pointer" onclick="openDay(' + i + ')">'
       + '<td>' + esc(f.date) + '</td>'
       + '<td style="color:' + col + '">' + esc(d.status)
       + (d.incomplete
            ? ' <span class="tag">' + (d.pending ? 'check-out pending' : 'no check-in') + '</span>'
            : '') + '</td>'
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
    + '. Where both terminals carry a gate role, the day reads in order: first arrival is the '
    + 'check-in, a departure starts a break, the next arrival ends it, and a departure with '
    + 'nothing after it is the check-out &mdash; a day that ends on an arrival stays open, with '
    + 'the check-out pending. Repeat taps at the same gate are one movement, timed at the last '
    + 'tap. Open a day to set a punch to In or Out by hand &mdash; a marked punch is never folded '
    + 'into its neighbour, so tapping out and straight back in reads as a break of at least a minute.'
    + (t.ignored ? ' <b>' + t.ignored + '</b> card or fingerprint punch(es) in this range were not counted.' : '');
}
// the same card at a smaller size, for a fact that reads as a word
function card(cls, k, v, sub, title){
  return '<div class="card ' + cls + '"' + (title ? ' title="' + esc(String(title)) + '"' : '')
    + '><div class="k" title="' + esc(String(k)) + '">'
    + esc(String(k)) + '</div><div class="v">' + v + '</div>'
    + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
}

// A maximum below the count it is supposed to cap is not a maximum. This
// firmware reports MaxAttLogCount=20 against thousands of stored punches and
// MaxUserCount=100 against nearly three hundred users, so a ceiling is shown
// only where it could actually be true - everywhere else, nothing is shown
// rather than a number that would have to be explained away.
function cap(current, max){
  var m = Number(max) || 0;
  return m > 0 && m >= (Number(current) || 0) ? m : 0;
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

// One row per tap inside the movement, each with the direction someone can
// set by hand. A folded run gets a row per tap because the whole point is to
// pull a tap out of it: an out and an in a second apart look identical to the
// terminal, and only a person can say they were two different movements.
function dirRows(e, day){
  var taps = e.rows || [];
  var out = '';
  for (var j = 0; j < taps.length; j++){
    var tp = taps[j];
    out += '<div class="tapline"><span class="hint t">' + esc(fmtStamp(tp.t).time) + '</span>'
      + dirSeg(tp.k, tp.m, day) + '</div>';
  }
  return out;
}
function dirSeg(key, mark, day){
  var b = function(v, txt, cls){
    return '<button data-k="' + esc(key) + '" data-d="' + v + '" data-day="' + day + '"'
      + ' class="' + (mark === v ? 'on ' + cls : '') + '">' + txt + '</button>';
  };
  return '<span class="dir">' + b('in', 'In', 'in') + b('out', 'Out', 'out')
    + b('', 'Auto', 'auto') + '</span>';
}
// A run of taps that the model folded into one movement is, when it sits in
// the middle of a day, usually a departure and a return read as one: that is
// the "Extra punch" that counts for nothing. Marking its first tap out and its
// last tap in splits it back into the break it was, in one press. The taps
// between stay unmarked and keep folding into the departure, so a four-tap run
// becomes a break start and a break end, not four movements.
function splitBreak(day, idx){
  var e = ATT.days[day].events[idx], r = e.rows || [];
  if (r.length < 2) return toast('Only one tap here, so there is nothing to split.', 'bad');
  setDir([{key: r[0].k, dir: 'out'}, {key: r[r.length-1].k, dir: 'in'}], null, day);
}
// Marking a punch re-splits the day, so pull the range again rather than
// guessing at the new shape, then redraw the timeline that is still open.
function setDir(key, dir, day){
  var marks = Array.isArray(key) ? key : [{key: key, dir: dir}];
  fetch('/api/punch/dir', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({marks: marks})})
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (!j.ok) throw new Error(j.error || 'failed');
      var pin = q('aUser').value;
      if (!pin) throw new Error('no employee selected');
      var p = new URLSearchParams({from:q('aFrom').value, to:q('aTo').value,
                                   face:FACE, pin:pin});
      return fetch('/api/attendance?' + p.toString()).then(function(r){ return r.json(); });
    })
    .then(function(a){ renderAtt(a); openDay(day); })
    .catch(function(err){ toast('Could not set the direction: ' + err.message, 'bad'); });
}
document.addEventListener('click', function(e){
  if (!e.target.closest) return;
  var b = e.target.closest('.dir button');
  if (b) return setDir(b.dataset.k, b.dataset.d, Number(b.dataset.day));
  var sp = e.target.closest('.tl .split');
  if (sp) return splitBreak(Number(sp.dataset.day), Number(sp.dataset.ev));
});

// The day as a table, in the order it happened: what each movement was, the
// time it counts at, which gate saw it, and how many taps it was folded from.
// A day whose check-in or check-out never arrived says so in its own row
// rather than leaving the reader to notice the gap.
function dayStepsTable(d){
  var rows = '';
  if (d.punches && !d.in) rows += '<tr class="pend"><td><span class="sdot a"></span>Check in</td>'
    + '<td colspan="3">Missing &mdash; the day opens on a departure, so nothing counts against it.</td></tr>';
  for (var k = 0; k < d.events.length; k++){
    var e = d.events[k], cls = STEP[e.label] || 'x';
    rows += '<tr' + (cls === 'x' ? ' class="x"' : '') + '>'
      + '<td><span class="sdot ' + cls + '"></span>' + esc(e.label) + '</td>'
      + '<td class="t">' + esc(fmtStamp(e.time).time) + '</td>'
      + '<td>' + (e.dir ? '<span class="pill ' + e.dir + '">' + (e.dir === 'in' ? 'In' : 'Out')
                          + '</span> ' : '')
      + '<span class="hint">' + esc(e.sn) + '</span></td>'
      + '<td class="hint">'
      + (e.taps > 1 ? e.taps + ' taps, first ' + esc(fmtStamp(e.from).time) : '1 tap')
      + (e.mark ? ' &middot; set by hand' : '') + '</td></tr>';
  }
  if (d.pending) rows += '<tr class="pend"><td><span class="sdot z"></span>Check out</td>'
    + '<td colspan="3">Pending &mdash; the day ends on an arrival, so nobody has left yet.</td></tr>';
  return '<table class="steps"><thead><tr><th>Step</th><th>Time</th><th>Gate</th><th>Taps</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function openDay(i){
  var d = ATT.days[i];
  var bsum = (d.breaks || []).reduce(function(n, b){ return n + b.min; }, 0);
  q('mTitle').textContent = (ATT.name || ('PIN ' + ATT.pin)) + '  -  ' + fmtStamp(d.date).date;
  q('mDate').innerHTML = !d.events.length ? 'Nothing recorded on this day.'
    // an open day has no span to report, so it reports what it does know
    : (d.pending
        ? '<b style="color:var(--warn)">Check-out pending</b> &middot; in at '
          + esc(fmtStamp(d.in).time) + ' &middot; ' + hm(bsum) + ' break so far'
        : '<b style="color:var(--fg)">' + hm(d.workMin) + '</b> worked &middot; '
          + hm(d.totalMin) + ' on site &middot; ' + hm(d.breakMin) + ' break')
      + ' &middot; ' + d.punches + ' movement' + (d.punches === 1 ? '' : 's')
      + (d.taps > d.punches ? ' from ' + d.taps + ' taps' : '')
      + (d.ignored ? ' &middot; ' + d.ignored + ' non-face punch(es) skipped' : '');

  if (!d.events.length){
    q('mBody').innerHTML = '<div class="empty">No face punches on this day.</div>';
  } else {
    var html = dayStepsTable(d)
      + '<div class="hint" style="margin:0 0 2px">Every tap behind those movements &mdash; '
      + 'set one to In or Out to change how the day reads.</div>'
      + '<div class="tl">';
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
        + (e.taps > 1 ? ' <span class="tag">' + e.taps + ' taps, first ' + esc(fmtStamp(e.from).time) + '</span>'
             + ' <button class="split" data-day="' + i + '" data-ev="' + k + '">Split into break</button>' : '')
        + (e.mark ? ' <span class="tag">set by hand</span>' : '')
        + '</div>'
        + '<div class="hint">' + esc(LAB.verify[e.verify] || ('mode ' + e.verify))
        + ' &middot; gate ' + esc(e.sn) + '</div>'
        + dirRows(e, i) + '</div>';
    }
    html += '</div>';
    if (d.pending) html += '<div class="note" style="padding:0 0 12px">'
      + (d.events.length === 1
          ? 'Only one movement, so there is nothing to close the day against'
          : 'The day ends on an arrival, so the check-out has not happened yet')
      + ' &mdash; no hours are counted. If that last punch was the person leaving, set it to '
      + '<b>Out</b> and the day closes on it.</div>';
    else if (!d.in) html += '<div class="note" style="padding:0 0 12px">'
      + 'No arrival on this day, so there is nothing for these punches to belong to '
      + '&mdash; no hours are counted.</div>';
    q('mBody').innerHTML = html;
  }
  q('modal').style.display = 'block';
}
// The portrait the terminal enrolled the face against. It arrives with the
// user sync rather than on request, so a face that has never been synced has
// no picture here and the button is simply not drawn.
function viewPhoto(pin){
  var u = (PEOPLE || []).filter(function(x){ return String(x.pin) === String(pin); })[0] || {};
  var p = u.photo || {};
  q('mTitle').textContent = (u.name || ('PIN ' + pin)) + '  -  PIN ' + pin;
  q('mDate').textContent = p.at
    ? (p.kind === 'USERPIC' ? 'enrolment photo' : 'face photo') + ', '
      + Math.round((p.bytes || 0) / 1024) + ' KB, synced ' + stampOf(p.at)
    : 'from the terminal';
  q('mBody').innerHTML = '<div style="padding:10px 0">'
    + '<img class="face" src="/api/userpic?pin=' + encodeURIComponent(pin) + '&t=' + Date.now()
    + '" alt="" onerror="this.parentNode.innerHTML='
    + '&quot;<div class=\\&quot;empty\\&quot;>The picture could not be read.</div>&quot;">'
    + '</div>';
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
      // an empty check-out column could be read as a missing punch, so the
      // export says outright that the day never closed
      rows.push([d.date, d.status, fmtStamp(d.in).time, b, e,
                 d.pending ? 'pending' : fmtStamp(d.out).time,
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
      + '<th>Faces</th><th>Users</th>'
      + '<th>Clock</th><th>Punches</th><th>Last contact</th></tr></thead><tbody>'
      + t.devices.map(function(d){
          return '<tr><td class="mono">' + esc(d.sn) + '</td>'
            + '<td><span class="badge ' + (d.online?'on':'off') + '">'
            + (d.online?'online':'offline') + '</span></td>'
            + '<td>' + (d.role === 'in' ? 'Check-in' : d.role === 'out' ? 'Check-out' : '&mdash;') + '</td>'
            + '<td class="mono">' + num(d.faces)
            + (cap(d.faces, d.maxFaces)
                ? ' <span class="hint">/ ' + num(cap(d.faces, d.maxFaces)) + '</span>' : '')
            + '</td>'
            + '<td class="mono">' + num(d.users) + '</td>'
            + '<td>' + (d.clockOffset
                ? Math.abs(d.clockOffset) + ' min ' + (d.clockOffset > 0 ? 'behind' : 'ahead')
                : 'in step') + '</td>'
            + '<td class="mono">' + num(d.punches) + '</td>'
            + '<td>' + (d.lastSeen ? esc(stampOf(d.lastSeen)) : 'never') + '</td></tr>';
        }).join('')
      + '</tbody></table></div>'
      + '<div class="hint" style="margin:16px 0 6px">Files in ./data</div>'
      + '<div class="grid tight">'
      + t.store.files.map(function(f){ return card('sm', f.name, bytes(f.bytes)); }).join('')
      + (t.store.photos && t.store.photos.count
          ? card('sm', 'photos/', num(t.store.photos.count) + ' &middot; ' + bytes(t.store.photos.bytes))
          : '')
      + '</div>'
      + '<div class="hint" style="margin:16px 0 6px">Runtime</div>'
      + '<div class="grid tight">'
      + card('sm', 'Node', esc(t.proc.node))
      + card('sm', 'Platform', esc(t.host.platform))
      + card('sm', 'CPUs', t.host.cpus)
      + card('sm', 'Port', t.proc.port)
      + card('sm', 'Host', esc(t.host.hostname || '?'))
      + card('sm', 'PID', t.proc.pid)
      + '</div>';
  });
}

// The door's log. Local UI data about who knocked, so it is not itself behind
// the door it describes.
function saveHrKey(){
  var v = q('hrKey').value.trim();
  if (!v) return q('hrKeyMsg').textContent = 'type a key first, or press Clear to remove it';
  fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ hrKey: v }) })
    .then(function(){ q('hrKey').value = ''; loadIps(); });
}

function clearHrKey(){
  if (!confirm('Remove the API key? The allow-list becomes the only lock on this API.')) return;
  fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ hrKey: '' }) })
    .then(function(){ q('hrKey').value = ''; loadIps(); });
}

function loadHrLog(){
  fetch('/api/hr/log').then(function(r){ return r.json(); }).then(function(j){
    var callers = j.callers || [], calls = j.calls || [];
    q('hrNone').style.display = callers.length ? 'none' : 'block';
    q('hrLogSum').textContent = j.total
      ? j.total + ' call(s) from ' + callers.length + ' address(es)'
      : 'no calls yet';
    q('hrCallers').innerHTML = callers.map(function(c){
      return '<tr><td class="mono">' + esc(c.ip) + '</td>'
        + '<td>' + (c.allowed
            ? '<span class="st new">admitted</span> <span class="hint">by ' + esc(c.rule) + '</span>'
            : '<span class="st error">refused</span>'
              + (c.lastWhy ? ' <span class="hint">' + esc(c.lastWhy) + '</span>' : '')
              + ' <button class="vw" onclick="addIp(\\'' + esc(c.ip) + '\\')">Allow</button>')
        + '</td>'
        + '<td class="mono">' + num(c.calls) + '</td>'
        + '<td class="mono">' + (c.denied
            ? '<span style="color:#f87171">' + num(c.denied) + '</span>' : '0') + '</td>'
        + '<td class="mono">' + num(c.rows) + '</td>'
        + '<td>' + esc(stampOf(c.last)) + ' <span class="hint">' + ago(c.last) + '</span></td></tr>';
    }).join('');
    q('hrCalls').innerHTML = calls.map(function(r){
      return '<tr' + (r.ok ? '' : ' style="opacity:.75"') + '>'
        + '<td class="mono">' + esc(stampOf(r.t)) + '</td>'
        + '<td class="mono">' + esc(r.ip)
        + (r.peer && r.peer !== r.ip ? ' <span class="hint">via ' + esc(r.peer) + '</span>' : '')
        + '</td>'
        + '<td class="mono">' + esc(r.route)
        + (r.ok ? '' : ' <span class="st error">refused</span>'
            + (r.why ? ' <span class="hint">' + esc(r.why) + '</span>' : '')) + '</td>'
        + '<td class="mono">' + (r.pins ? esc(r.pins) : '<span class="hint">everyone</span>') + '</td>'
        + '<td class="mono">' + (r.ok ? num(r.rows) : '&mdash;') + '</td>'
        + '<td class="mono hint">' + (r.ms || 0) + ' ms</td></tr>';
    }).join('');
    var feeds = j.feeds || [];
    q('hrFeeds').innerHTML = feeds.length
      ? '<div class="note" style="margin-bottom:10px"><b>Live feeds open:</b> '
        + feeds.map(function(f){
            return '<span class="st new">' + esc(f.ip) + '</span> <span class="hint">'
              + (f.pins ? f.pins.split(',').length + ' people' : 'nobody')
              + ' &middot; ' + num(f.sent) + ' sent &middot; since ' + esc(stampOf(f.since))
              + '</span>';
          }).join(' &middot; ') + '</div>'
      : '';
  });
}

function loadIps(){
  fetch('/api/settings').then(function(r){ return r.json(); }).then(function(c){
    IPS = (c.allowIps || []).slice();
    drawIps();
    q('myIp').textContent = c.yourIp || '?';
    q('doorPin').placeholder = c.doorPinSet ? 'code set - type a new one to change' : 'door code (blank = no code)';
    q('hrKey').placeholder = c.hrKeySet
      ? 'key set - type a new one to change' : 'API key (optional second lock)';
    q('hrKeyMsg').innerHTML = c.hrKeySet
      ? '<span style="color:var(--ok)">A key is required as well as an allowed address.</span>'
      : '<span class="hint">No key set &mdash; the allow-list is the only lock.</span>';
    q('doorPinMsg').innerHTML = c.doorPinSet
      ? '<span style="color:var(--ok)">/opendoor asks for a code.</span>'
      : '<span style="color:var(--warn)">/opendoor is open to anyone on this network.</span>';
    q('setFace').checked = c.faceOnly !== false;
    q('setDwell').value = Math.round((c.dwellSec || 180) / 60);
    if (FACE !== (c.faceOnly === false ? 0 : 1)) setFace(c.faceOnly === false ? 0 : 1);
    var base = location.origin, day = q('aFrom').value || '2026-09-01',
        end = q('aTo').value || '2026-09-08';
    q('hrUrls').innerHTML = [
      base + '/api/hr/events?pin=2,5,9&from=' + day + '&to=' + end,
      base + '/api/hr/events?pin=2,5,9&since=0',
      base + '/api/hr/attendance?pin=2&from=' + day + '&to=' + end,
      base + '/api/hr/punches?pin=2,5,9&from=' + day + '&to=' + end,
      base + '/api/hr/users',
      base + '/api/hr/devices',
      'POST ' + base + '/api/hr/fetch?days=7',
      '',
      'For the academy admin (set this as its base URL):',
      base + '/api/v1/sync/health',
      base + '/api/v1/sync/events?connect_id=1,2,3&start_date=' + day + '&end_date=' + end
    ].map(esc).join('<br>');
    q('ipMsg').innerHTML = (c.allowIps || []).length
      ? '<span style="color:var(--ok)">Allow-list active for ' + c.allowIps.length + ' rule(s).</span>'
      : '<span style="color:var(--bad)">Empty list &mdash; the HR API is blocked for everyone.</span>';
  });
}
// The list on screen is the list in force: adding and removing write straight
// through, so there is never a saved state and a shown state to tell apart.
var IPS = [];

function drawIps(){
  q('ipRules').innerHTML = IPS.length
    ? IPS.map(function(r, i){
        return '<span class="rule">' + esc(r) + '<button title="Remove this rule" '
          + 'onclick="dropIp(' + i + ')">&times;</button></span>';
      }).join('')
    : '<span class="hint">No rule yet &mdash; the HR API is blocked for everyone.</span>';
}

function addIp(rule){
  var v = String(rule || q('ipNew').value || '').trim();
  if (!v) return;
  if (IPS.indexOf(v) >= 0){ q('ipNew').value = ''; return toast(v + ' is already on the list'); }
  IPS.push(v);
  q('ipNew').value = '';
  saveIps();
}

function dropIp(i){
  var gone = IPS[i];
  if (!confirm('Remove ' + gone + ' from the allow-list?')) return;
  IPS.splice(i, 1);
  saveIps();
}

function useMyIp(){ addIp(q('myIp').textContent); }
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
  drawIps();
  fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ allowIps: IPS }) })
    .then(function(r){ return r.json(); })
    .then(function(j){
      loadIps();
      // a refused rule has to say so out loud: silently dropping it leaves the
      // list looking open while the door is still shut
      var bad = j.ipRejected || [];
      if (bad.length) toast('Not saved: ' + bad.map(function(x){
        return x.rule + ' (' + x.why + ')'; }).join(', '), 'bad');
    });
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
