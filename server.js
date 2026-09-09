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
const STARTED = Date.now();

// A device is declared offline once it misses roughly three of its own polls.
// The device picks the interval (Delay= in the handshake), so measure it
// instead of assuming: a terminal on a slow link polls far less often.
const MIN_OFFLINE_MS = 75000;
const MAX_OFFLINE_MS = 10 * 60000;
const MAX_BODY = 16 * 1024 * 1024;   // a full BIODATA push can be large
const BODY_TIMEOUT_MS = 45000;
const MAX_LOGS_IN_MEMORY = 200000;

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------------------------------------------ state */

const state = {
  devices: {},   // sn -> device record
  users: {},     // pin -> user record
  logs: [],      // attendance punches
  queue: {},     // sn -> pending command objects
  events: [],    // raw protocol trace
};
const seen = new Set();          // dedupe key for punches
let cmdSeq = Date.now() % 100000;
const startupWarnings = [];

/* ------------------------------------------------------------ persistence */

// Rename is atomic on every platform we care about, so a crash or a Ctrl-C
// mid-save can never leave a half-written JSON file behind. The old code
// wrote in place: an interrupted write produced invalid JSON, loadState threw,
// and every user and device silently vanished on the next start.
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function readJsonSafe(file, label) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return {}; }                       // first run
  try { return JSON.parse(raw); }
  catch (e) {
    // Keep the damaged file instead of overwriting it, and say so loudly.
    const bak = file + '.corrupt-' + Date.now();
    try { fs.writeFileSync(bak, raw); } catch (e2) {}
    const msg = label + ' was corrupt and could not be read (' + e.message
      + '). A copy is at ' + path.basename(bak) + '; starting with an empty set.';
    startupWarnings.push(msg);
    console.error('  !! ' + msg);
    return {};
  }
}

function loadState() {
  let bad = 0;
  try {
    for (const line of fs.readFileSync(ATT_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch (e) { bad++; continue; }
      if (!r || !r.sn || !r.time) { bad++; continue; }
      r.pin = String(r.pin == null ? '' : r.pin);
      state.logs.push(r);
      seen.add(punchKey(r.sn, r.pin, r.time, r.status));
    }
  } catch (e) { /* first run */ }
  if (bad) startupWarnings.push(bad + ' unreadable line(s) in attlog.jsonl were skipped.');

  state.users = readJsonSafe(USERS_FILE, 'data/users.json');
  state.devices = readJsonSafe(DEV_FILE, 'data/devices.json');
  for (const sn of Object.keys(state.devices)) {
    state.devices[sn] = normalizeDevice(sn, state.devices[sn]);
  }
}

let saveTimer = null;
let dirty = false;

// Marks state as needing a write. The old version wrote users.json AND
// devices.json on every single device poll (~every 10s, forever) even when
// nothing had changed; now a write only happens after a real change.
function saveSoon() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(flushState, 1500);
}

function flushState() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!dirty) return;
  dirty = false;
  try {
    writeJsonAtomic(USERS_FILE, state.users);
    writeJsonAtomic(DEV_FILE, state.devices);
  } catch (e) {
    dirty = true;
    console.error('save failed', e.message);
  }
}

// lastSeen and the poll counters change on every heartbeat. Flushing those on
// each one would hammer the disk, so they ride a slow timer instead - and an
// idle server with no traffic still writes nothing at all.
let countersDirty = false;
setInterval(() => {
  if (!countersDirty) return;
  countersDirty = false;
  dirty = true;
  flushState();
}, 60000).unref();

function trace(kind, sn, msg) {
  state.events.push({ t: Date.now(), kind, sn: sn || '-', msg: String(msg).slice(0, 400) });
  if (state.events.length > 400) state.events.splice(0, state.events.length - 400);
  const tag = kind === 'err' ? '!!' : kind === 'dev' ? '<<' : kind === 'srv' ? '>>' : '..';
  console.log(new Date().toLocaleTimeString(), tag, (sn || '-'), String(msg).slice(0, 200));
}

/* ----------------------------------------------------------- device model */

function normalizeDevice(sn, d) {
  const base = {
    sn, name: '', ip: '', firstSeen: Date.now(), lastSeen: 0, lastPoll: 0,
    pushCount: 0, info: {}, stamp: '9999', opStamp: '9999', online: false,
    polls: 0, pollInterval: 0, sessions: 0, drops: 0, lastDrop: 0,
    lastCmd: 0, cmdsSent: 0, cmdsDone: 0, lastPush: 0, lastError: '',
  };
  const out = Object.assign(base, d || {}, { sn });
  out.online = false;                       // nothing is online until it polls
  out.info = out.info && typeof out.info === 'object' ? out.info : {};

  // Repair records written by the old broken options parser, which stuffed the
  // entire comma-separated option list into a single "DeviceName" value.
  for (const k of Object.keys(out.info)) {
    const v = out.info[k];
    if (typeof v === 'string' && v.length > 80 && /,[~A-Za-z_][\w~.\-]*=/.test(v)) {
      delete out.info[k];
      applyOptions(out, k + '=' + v);
    }
  }
  if (typeof out.name === 'string' && out.name.length > 80) out.name = '';
  if (!out.name) out.name = out.info.DeviceName || out.info['~DeviceName'] || '';
  return out;
}

function touchDevice(sn, req, kind) {
  if (!sn) return null;
  let d = state.devices[sn];
  if (!d) {
    d = state.devices[sn] = normalizeDevice(sn, null);
    d.lastSeen = 0;
    trace('info', sn, 'new device registered');
    saveSoon();
  }
  const now = Date.now();
  if (!d.online) {
    d.online = true;
    d.onlineSince = now;
    d.sessions = (d.sessions || 0) + 1;
    trace('info', sn, 'device is online');
    saveSoon();
  }
  d.lastSeen = now;
  countersDirty = true;

  if (kind === 'poll') {
    // Learn the device's real poll cadence so the offline check can adapt to
    // it rather than to a hardcoded 90 seconds.
    if (d.lastPoll) {
      const gap = now - d.lastPoll;
      if (gap > 500 && gap < 15 * 60000) {
        d.pollInterval = d.pollInterval ? Math.round(d.pollInterval * 0.7 + gap * 0.3) : gap;
      }
    }
    d.lastPoll = now;
    d.polls = (d.polls || 0) + 1;
  }

  if (req) {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (ip && ip !== d.ip) { d.ip = ip; saveSoon(); }
  }
  return d;
}

function offlineAfter(d) {
  const iv = d.pollInterval || 10000;
  return Math.min(MAX_OFFLINE_MS, Math.max(MIN_OFFLINE_MS, iv * 3 + 15000));
}

setInterval(() => {
  const now = Date.now();
  for (const d of Object.values(state.devices)) {
    if (d.online && now - d.lastSeen > offlineAfter(d)) {
      d.online = false;
      d.drops = (d.drops || 0) + 1;
      d.lastDrop = now;
      trace('err', d.sn, 'went offline (silent for '
        + Math.round((now - d.lastSeen) / 1000) + 's)');
      saveSoon();
    }
  }
}, 10000).unref();

/* --------------------------------------------------------------- commands */

function enqueue(sn, cmd) {
  const id = ++cmdSeq;
  const item = { id, sn, cmd, created: Date.now(), sent: 0, returned: 0, result: null };
  const q = (state.queue[sn] = state.queue[sn] || []);
  q.push(item);
  if (q.length > 200) q.splice(0, q.length - 200);
  trace('info', sn, 'queued C:' + id + ':' + cmd);
  return item;
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
    case 'unlock':   return 'AC_UNLOCK';
    case 'reboot':   return 'REBOOT';
    case 'info':     return 'INFO';
    case 'check':    return 'CHECK';                       // force full re-sync from device
    case 'synctime': return 'SET OPTION DateTime=' + zkTime(new Date());
    case 'clearlog': return 'CLEAR LOG';
    case 'cleardata':return 'CLEAR DATA';
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

function punchKey(sn, pin, time, status) {
  return sn + '|' + pin + '|' + time + '|' + (Number(status) || 0);
}

function addPunch(sn, pin, time, status, verify, workcode, extra) {
  const key = punchKey(sn, pin, time, status);
  if (seen.has(key)) return false;
  seen.add(key);
  const rec = {
    sn, pin: String(pin), time, status: Number(status) || 0,
    verify: Number(verify) || 0, workcode: workcode || '0',
    name: (state.users[pin] && state.users[pin].name) || '',
    recv: Date.now(), extra: extra || '',
  };
  state.logs.push(rec);
  if (state.logs.length > MAX_LOGS_IN_MEMORY) state.logs.splice(0, 1000);
  try { fs.appendFileSync(ATT_FILE, JSON.stringify(rec) + '\n'); }
  catch (e) { trace('err', sn, 'attlog write: ' + e.message); }
  return true;
}

function parseAttlog(sn, body) {
  let n = 0, dup = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split('\t');
    if (f.length < 2) continue;
    const pin = f[0].trim();
    const time = (f[1] || '').trim();
    if (!pin || !/\d{4}-\d{2}-\d{2}/.test(time)) continue;
    if (addPunch(sn, pin, time, f[2], f[3], f[4], f.slice(5).join('|'))) n++; else dup++;
  }
  const d = state.devices[sn];
  if (d) { d.pushCount = (d.pushCount || 0) + n; d.lastPush = Date.now(); }
  trace('dev', sn, 'ATTLOG -> ' + n + ' new punch(es)' + (dup ? ', ' + dup + ' duplicate' : ''));
  if (n) saveSoon();
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
      const u = state.users[o.PIN] || (state.users[o.PIN] = { pin: o.PIN });
      u.name = o.Name || u.name || '';
      u.card = o.Card || u.card || '';
      u.privilege = o.Pri || u.privilege || '0';
      u.sn = sn;
      u.updated = Date.now();
      users++;
    } else if (/^(FP|FACE|BIODATA|BIOPHOTO|USERPIC)\s/i.test(line)) {
      const o = kv(line.replace(/^\S+\s+/, ''));
      const pin = o.PIN || o.Pin;
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

// The terminal sends its option list either one-per-line or, on most ESSL
// firmware, as a single long comma-separated line. Splitting on newlines alone
// collapsed all 50-odd options into one bogus value, which is why the device
// panel showed "?" for firmware, user count and face count.
// Only split at a comma that is followed by another "key=" token, so a value
// containing a comma survives intact.
const OPT_SPLIT = /,(?=~?[A-Za-z_][A-Za-z0-9_~.\-]*=)/g;

function optionParts(body) {
  const out = [];
  for (const line of String(body).split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let start = 0, m;
    OPT_SPLIT.lastIndex = 0;
    while ((m = OPT_SPLIT.exec(s))) {
      out.push(s.slice(start, m.index));
      start = m.index + 1;
    }
    out.push(s.slice(start));
  }
  return out;
}

function applyOptions(d, body) {
  let n = 0;
  for (const part of optionParts(body)) {
    const s = part.trim().replace(/^~/, '');
    if (!s) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    d.info[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    n++;
  }
  return n;
}

function parseOptions(sn, body) {
  const d = touchDevice(sn);
  if (!d) return;
  const n = applyOptions(d, body);
  d.name = d.info.DeviceName || d.name;
  saveSoon();
  trace('dev', sn, 'options: ' + n + ' field(s), fw ' + (d.info.FWVersion || '?')
    + ' ' + (d.info.DeviceName || ''));
}

/* -------------------------------------------------------- http utilities */

// Resolves on 'end', and also on abort, error or timeout. The old version only
// listened for 'end' and 'error', so a terminal that dropped the connection
// mid-upload left this promise pending forever: the request handler never
// returned, the socket was never closed, and the device sat waiting for a
// reply it would never get. That is the "sometimes it just does not connect".
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0, done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (why) trace('err', '', 'request body ' + why + ' after ' + size + ' bytes');
      let buf = Buffer.concat(chunks);
      if (buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b) {
        try { buf = zlib.gunzipSync(buf); } catch (e) {}
      }
      resolve(buf.toString('utf8'));
    };
    const timer = setTimeout(() => { finish('timed out'); try { req.destroy(); } catch (e) {} },
      BODY_TIMEOUT_MS);
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { finish('too large'); try { req.destroy(); } catch (e) {} return; }
      chunks.push(c);
    });
    req.on('end', () => finish(''));
    req.on('aborted', () => finish('aborted'));
    req.on('close', () => finish(''));
    req.on('error', () => finish('errored'));
  });
}

function deadRes(res) {
  return res.writableEnded || res.destroyed || (res.socket && res.socket.destroyed);
}

function textOut(res, body, code) {
  if (deadRes(res)) return;
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
  if (deadRes(res)) return;
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': b.length,
    'Cache-Control': 'no-store',
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

// Firmware differs on capitalisation, so look a parameter up case-insensitively
// rather than guessing which two spellings to try.
function param(q, name) {
  const want = name.toLowerCase();
  for (const [k, v] of q) if (k.toLowerCase() === want) return v;
  return null;
}

function handshake(sn) {
  const d = touchDevice(sn);
  const off = -new Date().getTimezoneOffset() / 60;
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
    'ServerVer=2.4.1 ' + new Date().toISOString().slice(0, 10),
    'PushProtVer=2.4.1',
    'MultiBioDataSupport=0:1:0:0:0:0:0:0:1:0',
    'MultiBioPhotoSupport=0:0:0:0:0:0:0:0:1:0',
    '',
  ].join('\n');
}

async function handleDevice(req, res, route, q) {
  const sn = param(q, 'SN') || '';

  if (!sn && route !== '/iclock/registry') {
    trace('err', '', 'device request without SN: ' + req.url.slice(0, 120));
  }

  if (route === '/iclock/ping') { touchDevice(sn, req, 'poll'); return textOut(res, 'OK'); }

  if (route === '/iclock/registry') {
    await readBody(req);
    trace('dev', sn, 'registry request');
    return textOut(res, 'RegistryCode=' + (sn || 'AIFACE') + '\n');
  }
  if (route === '/iclock/push') {
    touchDevice(sn, req);
    return textOut(res, 'RegistryCode=' + sn + '\nServerVersion=2.4.1\n');
  }

  if (route === '/iclock/cdata' && req.method === 'GET') {
    touchDevice(sn, req);
    trace('dev', sn, 'handshake: ' + req.url);
    return textOut(res, handshake(sn));
  }

  if (route === '/iclock/cdata' && req.method === 'POST') {
    const d = touchDevice(sn, req);
    const body = await readBody(req);
    const table = (param(q, 'table') || '').toUpperCase();
    const stamp = param(q, 'Stamp');
    if (table === 'ATTLOG') {
      // Acknowledging the stamp is what stops the terminal from re-sending its
      // whole buffer on the next connect. Never let it move backwards.
      if (stamp && d && stampNewer(stamp, d.stamp)) { d.stamp = stamp; saveSoon(); }
      const n = parseAttlog(sn, body);
      return textOut(res, 'OK: ' + n);
    }
    if (table === 'OPERLOG' || table === 'USERINFO' || table === 'BIODATA') {
      if (stamp && d && stampNewer(stamp, d.opStamp)) { d.opStamp = stamp; saveSoon(); }
      const n = parseOperlog(sn, body);
      return textOut(res, 'OK: ' + n);
    }
    if (table === 'OPTIONS' || table === '') {
      parseOptions(sn, body);
      return textOut(res, 'OK');
    }
    trace('dev', sn, 'table=' + table + ' (' + body.length + ' bytes, ignored)');
    return textOut(res, 'OK');
  }

  if (route === '/iclock/getrequest') {
    const d = touchDevice(sn, req, 'poll');
    const pending = (state.queue[sn] || []).filter((c) => !c.sent);
    if (!pending.length) return textOut(res, 'OK');
    const lines = pending.map((c) => { c.sent = Date.now(); return 'C:' + c.id + ':' + c.cmd; });
    trace('srv', sn, 'sending ' + lines.length + ' command(s)');
    if (d) { d.lastCmd = Date.now(); d.cmdsSent = (d.cmdsSent || 0) + lines.length; }
    return textOut(res, lines.join('\n') + '\n');
  }

  if (route === '/iclock/devicecmd') {
    const d = touchDevice(sn, req);
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
        if (d) d.cmdsDone = (d.cmdsDone || 0) + 1;
        trace('dev', sn, 'cmd ' + id + ' (' + item.cmd.split(' ')[0] + ') returned ' + item.result);
      } else {
        trace('dev', sn, 'devicecmd: ' + line.slice(0, 120));
      }
    }
    return textOut(res, 'OK');
  }

  // fdata / querydata / edata and anything else the firmware probes
  await readBody(req);
  touchDevice(sn, req);
  trace('dev', sn, 'unhandled ' + req.method + ' ' + req.url);
  return textOut(res, 'OK');
}

// Stamps are numeric strings, but firmware occasionally sends "None" or junk.
function stampNewer(next, cur) {
  const a = Number(next), b = Number(cur);
  if (!isFinite(a)) return false;
  if (!isFinite(b)) return true;
  return a >= b || b === 9999;
}

/* ------------------------------------------------------------------- API */

function filterLogs(q) {
  const term = (param(q, 'q') || '').toLowerCase();
  const from = param(q, 'from');
  const to = param(q, 'to');
  const sn = param(q, 'sn');
  const limit = Math.min(Number(param(q, 'limit') || 500) || 500, 20000);
  let rows = state.logs;
  // resolve display names late: a punch can arrive before the user record syncs
  for (const r of rows) {
    if (!r.name && state.users[r.pin]) r.name = state.users[r.pin].name || '';
  }
  if (from) rows = rows.filter((r) => r.time >= from);
  if (to) rows = rows.filter((r) => r.time <= to + ' 23:59:59');
  if (sn) rows = rows.filter((r) => r.sn === sn);
  if (term) {
    rows = rows.filter((r) =>
      String(r.pin).toLowerCase().includes(term) ||
      (r.name || '').toLowerCase().includes(term) ||
      r.sn.toLowerCase().includes(term));
  }
  return { total: rows.length, rows: rows.slice(-limit).reverse() };
}

// Option keys arrive with or without a leading tilde depending on firmware,
// and applyOptions strips it, so accept either spelling.
function opt(info, name) {
  return info[name] || info['~' + name] || '';
}

function deviceSummary(d) {
  const i = d.info || {};
  const now = Date.now();
  return {
    sn: d.sn,
    name: d.name || i.DeviceName || '',
    ip: d.ip || '',
    online: !!d.online,
    lastSeen: d.lastSeen || 0,
    silentFor: d.lastSeen ? now - d.lastSeen : null,
    offlineAfter: offlineAfter(d),
    pollInterval: d.pollInterval || 0,
    polls: d.polls || 0,
    pushCount: d.pushCount || 0,
    lastPush: d.lastPush || 0,
    drops: d.drops || 0,
    lastDrop: d.lastDrop || 0,
    sessions: d.sessions || 0,
    firstSeen: d.firstSeen || 0,
    stamp: d.stamp,
    opStamp: d.opStamp,
    cmdsSent: d.cmdsSent || 0,
    cmdsDone: d.cmdsDone || 0,
    firmware: opt(i, 'FWVersion'),
    platform: opt(i, 'Platform'),
    push: opt(i, 'PushVersion'),
    mac: opt(i, 'MAC'),
    deviceIp: opt(i, 'IPAddress'),
    userCount: opt(i, 'UserCount'),
    maxUsers: opt(i, 'MaxUserCount'),
    faceCount: opt(i, 'FaceCount'),
    maxFaces: opt(i, 'MaxFaceCount'),
    fpCount: opt(i, 'FPCount'),
    transactions: opt(i, 'TransactionCount'),
    infoCount: Object.keys(i).length,
    info: i,
  };
}

// Turns "is it connected?" into a list of concrete pass/fail checks, so the
// answer is never just a red dot with no explanation.
function diagnose() {
  const out = [];
  const devices = Object.values(state.devices);
  const online = devices.filter((d) => d.online);
  const ips = lanIPs();
  const now = Date.now();
  const add = (level, title, detail, fix) => out.push({ level, title, detail, fix: fix || '' });

  add('ok', 'Server is listening',
    'Port ' + PORT + ' on ' + (ips.length ? ips.join(', ') : 'localhost only')
    + ' · up ' + Math.round((now - STARTED) / 1000) + 's');

  if (!ips.length) {
    add('fail', 'No LAN address found',
      'This machine has no non-loopback IPv4 address, so the terminal has nothing to connect to.',
      'Connect this computer to the same wired or Wi-Fi network as the terminal.');
  } else if (ips.length > 1) {
    add('warn', 'Several network interfaces',
      'Detected ' + ips.join(', ') + '. The terminal must point at the one on its own subnet.',
      'Compare with the device IP shown on the terminal (Menu > System Info).');
  }

  if (!devices.length) {
    add('fail', 'No terminal has ever connected',
      'The server has not received a single request from a device.',
      'On the terminal set Menu > COMM > Cloud Server (ADMS): address '
      + (ips[0] || 'this PC IP') + ', port ' + PORT
      + ', Domain Name OFF, Proxy OFF, then reboot it.');
    return out;
  }

  for (const d of devices) {
    const silent = d.lastSeen ? now - d.lastSeen : null;
    if (d.online) {
      add('ok', d.sn + ' is connected',
        'Last contact ' + Math.round(silent / 1000) + 's ago · polls every ~'
        + Math.round((d.pollInterval || 10000) / 1000) + 's · from ' + (d.ip || '?'));
    } else if (!d.lastSeen) {
      add('warn', d.sn + ' has never reported in',
        'The record exists but no request has arrived.',
        'Reboot the terminal after saving the ADMS settings.');
    } else {
      add('fail', d.sn + ' is offline',
        'Silent for ' + Math.round(silent / 1000) + 's (expected a poll every ~'
        + Math.round((d.pollInterval || 10000) / 1000) + 's). Last seen '
        + new Date(d.lastSeen).toLocaleString() + '.',
        'Check the terminal is powered on and on the network, and that this PC’s '
        + 'IP has not changed since it was configured (it is ' + (ips[0] || '?') + ' now).');
    }

    if (d.online && !Object.keys(d.info || {}).length) {
      add('warn', d.sn + ' has not sent its options',
        'Firmware, user count and capacity are unknown.',
        'Press "Device info" on the Commands tab.');
    }
    if (d.online && d.stamp === '9999' && d.pushCount > 0) {
      add('warn', d.sn + ' is not acknowledging its log pointer',
        'The device keeps re-sending records it already delivered (duplicates are '
        + 'discarded, but it wastes the link).',
        'Harmless. It resolves once the terminal sends a Stamp with its next push.');
    }
    const q = state.queue[d.sn] || [];
    const stuck = q.filter((c) => c.sent && !c.returned && now - c.sent > 120000);
    if (stuck.length) {
      add('warn', stuck.length + ' command(s) sent to ' + d.sn + ' with no reply',
        'The terminal collected them but never confirmed. Oldest '
        + Math.round((now - stuck[0].sent) / 1000) + 's ago.',
        'Usually means the firmware does not support that command.');
    }
  }

  if (!online.length && devices.length) {
    add('warn', 'Nothing is connected right now',
      devices.length + ' known device(s), none currently polling.');
  }
  for (const w of startupWarnings) add('warn', 'Startup warning', w);
  return out;
}

async function handleApi(req, res, route, q) {
  if (route === '/health' || route === '/api/health') {
    const devices = Object.values(state.devices);
    return jsonOut(res, {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: Date.now(),
      port: PORT,
      devices: devices.length,
      online: devices.filter((d) => d.online).length,
      punches: state.logs.length,
    });
  }

  if (route === '/api/state') {
    // Only the panels the open tab actually shows are serialised. The old
    // endpoint shipped every user, device and event on a 3s timer whether the
    // page needed them or not.
    const tab = (param(q, 'tab') || 'overview').toLowerCase();
    const today = new Date().toISOString().slice(0, 10);
    const devices = Object.values(state.devices).sort((a, b) => b.lastSeen - a.lastSeen);
    const out = {
      now: Date.now(),
      port: PORT,
      ips: lanIPs(),
      uptime: Math.round((Date.now() - STARTED) / 1000),
      devices: devices.map(deviceSummary),
      totals: {
        logs: state.logs.length,
        users: Object.keys(state.users).length,
        devices: devices.length,
        online: devices.filter((d) => d.online).length,
        today: state.logs.filter((r) => r.time.startsWith(today)).length,
        queued: Object.values(state.queue).flat().filter((c) => !c.returned).length,
      },
      labels: { verify: VERIFY, status: STATUS },
    };

    if (tab === 'overview' || tab === 'attendance') {
      const lim = tab === 'overview' ? 15 : Math.min(Number(param(q, 'limit') || 300) || 300, 5000);
      const f = filterLogs(q);
      out.logs = f.rows.slice(0, lim);
      out.logCount = f.total;
    }
    if (tab === 'users') {
      out.users = Object.values(state.users)
        .sort((a, b) => (Number(a.pin) || 0) - (Number(b.pin) || 0));
    }
    if (tab === 'overview' || tab === 'commands') {
      out.queue = Object.values(state.queue).flat()
        .sort((a, b) => b.created - a.created).slice(0, 40);
    }
    if (tab === 'diagnostics' || tab === 'overview') {
      out.checks = diagnose();
    }
    if (tab === 'diagnostics') {
      out.events = state.events.slice(-150).reverse();
    }
    return jsonOut(res, out);
  }

  if (route === '/api/export.csv') {
    const rows = filterLogs(q).rows;
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
    const targets = p.sn ? [p.sn] : Object.keys(state.devices);
    if (!targets.length) return jsonOut(res, { ok: false, error: 'No device has connected yet, so there is nothing to send the command to.' }, 400);
    const cmd = buildCommand(p.kind, p);
    if (!cmd) return jsonOut(res, { ok: false, error: 'unknown command' }, 400);
    if (p.kind === 'adduser' && p.pin) {
      const u = state.users[p.pin] || (state.users[p.pin] = { pin: String(p.pin) });
      u.name = p.name || u.name || '';
      u.card = p.card || u.card || '';
      u.privilege = String(p.pri || 0);
      saveSoon();
    }
    if (p.kind === 'deluser' && p.pin) { delete state.users[p.pin]; saveSoon(); }
    const offline = targets.filter((sn) => !(state.devices[sn] || {}).online);
    const queued = targets.map((sn) => enqueue(sn, cmd));
    return jsonOut(res, {
      ok: true, cmd, queued: queued.map((c) => c.id),
      warning: offline.length
        ? 'Queued, but ' + offline.join(', ') + ' is offline. It will run when the terminal reconnects.'
        : '',
    });
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
:root{
  --bg:#0b0f14;--panel:#131a23;--panel2:#0f151c;--line:#232c38;--line2:#1a222c;
  --fg:#e6edf3;--dim:#8b98a8;--faint:#5d6a7a;
  --accent:#3b82f6;--ok:#22c55e;--warn:#f59e0b;--bad:#ef4444;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}

/* ---------- header + tabs ---------- */
header{background:var(--panel);border-bottom:1px solid var(--line);
  position:sticky;top:0;z-index:20}
.hrow{display:flex;align-items:center;gap:12px;padding:12px 20px;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.2px;white-space:nowrap}
h1 span{color:var(--faint);font-weight:400}
.spacer{flex:1 1 auto}
.badge{font-size:11px;padding:3px 10px;border-radius:20px;background:#1c242e;
  color:var(--dim);border:1px solid var(--line);white-space:nowrap}
.badge.on{background:rgba(34,197,94,.14);color:var(--ok);border-color:rgba(34,197,94,.35)}
.badge.off{background:rgba(239,68,68,.12);color:var(--bad);border-color:rgba(239,68,68,.32)}
.badge.warn{background:rgba(245,158,11,.12);color:var(--warn);border-color:rgba(245,158,11,.32)}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;
  background:var(--faint);vertical-align:middle}
.dot.on{background:var(--ok);box-shadow:0 0 0 3px rgba(34,197,94,.16)}
.dot.off{background:var(--bad);box-shadow:0 0 0 3px rgba(239,68,68,.14)}
.dot.warn{background:var(--warn);box-shadow:0 0 0 3px rgba(245,158,11,.14)}

nav{display:flex;gap:2px;padding:0 12px;overflow-x:auto;scrollbar-width:none}
nav::-webkit-scrollbar{display:none}
nav button{background:none;border:0;border-bottom:2px solid transparent;color:var(--dim);
  padding:10px 14px;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;
  border-radius:0;display:flex;align-items:center;gap:7px}
nav button:hover{color:var(--fg)}
nav button.active{color:var(--fg);border-bottom-color:var(--accent)}
nav .n{font-size:10.5px;background:#1c242e;border:1px solid var(--line);
  padding:1px 6px;border-radius:10px;color:var(--dim);min-width:18px;text-align:center}
nav button.active .n{background:rgba(59,130,246,.16);border-color:rgba(59,130,246,.35);color:#9ec5ff}

/* ---------- offline banner ---------- */
#banner{display:none;padding:9px 20px;background:rgba(239,68,68,.13);
  border-bottom:1px solid rgba(239,68,68,.3);color:#ffb4b4;font-size:13px}
#banner.show{display:block}
#banner button{margin-left:10px;padding:3px 10px;font-size:12px}

/* ---------- layout ---------- */
.wrap{padding:18px 20px 40px;max-width:1500px;margin:0 auto}
.tabpane{display:none}
.tabpane.active{display:block}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  margin-bottom:16px}
.cols{display:grid;gap:14px;grid-template-columns:1fr 360px;align-items:start}
.cols2{display:grid;gap:14px;grid-template-columns:1fr 1fr;align-items:start}
@media(max-width:1050px){.cols,.cols2{grid-template-columns:1fr}}

.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:13px 15px}
.card .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.8px;color:var(--dim)}
.card .v{font-size:25px;font-weight:600;margin-top:3px;line-height:1.2}
.card .s{font-size:11.5px;color:var(--faint);margin-top:2px}

.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;
  overflow:hidden;margin-bottom:14px}
.panel>h2{margin:0;font-size:11.5px;text-transform:uppercase;letter-spacing:.9px;
  color:var(--dim);padding:11px 14px;border-bottom:1px solid var(--line);
  display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.panel .body{padding:13px 15px}
.panel .body.tight{padding:10px 14px}

/* ---------- tables ---------- */
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;
  color:var(--dim);padding:9px 13px;border-bottom:1px solid var(--line);
  position:sticky;top:0;background:var(--panel);z-index:1}
td{padding:8px 13px;border-bottom:1px solid var(--line2)}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:#19212b}
.scroll{max-height:520px;overflow:auto}
.scroll.sm{max-height:300px}

.pill{font-size:11px;padding:2px 9px;border-radius:20px;background:#1c242e;
  border:1px solid var(--line);display:inline-block}
.pill.in{background:rgba(34,197,94,.14);color:var(--ok);border-color:rgba(34,197,94,.3)}
.pill.out{background:rgba(245,158,11,.14);color:var(--warn);border-color:rgba(245,158,11,.3)}

/* ---------- controls ---------- */
button{background:#1c242e;color:var(--fg);border:1px solid var(--line);border-radius:7px;
  padding:7px 12px;font-size:12.5px;cursor:pointer;font-family:inherit;transition:.12s}
button:hover:not(:disabled){border-color:var(--accent);color:#fff}
button:disabled{opacity:.45;cursor:not-allowed}
button.p{background:var(--accent);border-color:var(--accent);color:#fff}
button.p:hover:not(:disabled){background:#2f74e0}
button.d{border-color:rgba(239,68,68,.38);color:#f87171}
button.d:hover:not(:disabled){background:rgba(239,68,68,.12);border-color:var(--bad);color:#fff}
input,select{background:var(--panel2);color:var(--fg);border:1px solid var(--line);
  border-radius:7px;padding:7px 10px;font-size:13px;font-family:inherit;width:100%}
input:focus,select:focus{outline:none;border-color:var(--accent)}
label.f{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.7px;
  color:var(--dim);margin-bottom:4px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.row>*{flex:0 0 auto}
.btns{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.fld{flex:1 1 140px;min-width:120px}

/* ---------- misc ---------- */
.log{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;
  max-height:340px;overflow:auto;line-height:1.75}
.log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.log .dev{color:#7ee787}.log .srv{color:#79c0ff}.log .err{color:#f87171}
.log .info{color:var(--dim)}
.hint{color:var(--dim);font-size:12.5px;line-height:1.75}
.hint b{color:var(--fg);font-weight:600}
code{background:var(--panel2);border:1px solid var(--line);padding:1px 6px;
  border-radius:5px;font-size:12px;font-family:ui-monospace,Menlo,monospace}
.empty{padding:34px 20px;text-align:center;color:var(--faint);font-size:13px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;font-size:12.5px}
.kv dt{color:var(--dim)}
.kv dd{margin:0;color:var(--fg);word-break:break-all}

.chk{display:flex;gap:11px;padding:11px 14px;border-bottom:1px solid var(--line2);
  align-items:flex-start}
.chk:last-child{border-bottom:0}
.chk .ic{width:18px;height:18px;border-radius:50%;flex:0 0 auto;margin-top:1px;
  display:grid;place-items:center;font-size:11px;font-weight:700}
.chk.ok .ic{background:rgba(34,197,94,.16);color:var(--ok)}
.chk.warn .ic{background:rgba(245,158,11,.16);color:var(--warn)}
.chk.fail .ic{background:rgba(239,68,68,.16);color:var(--bad)}
.chk .t{font-weight:600;font-size:13px}
.chk .d{color:var(--dim);font-size:12.5px;margin-top:2px}
.chk .fx{color:#9ec5ff;font-size:12.5px;margin-top:4px}

#toast{position:fixed;right:18px;bottom:18px;z-index:60;display:flex;
  flex-direction:column;gap:8px;align-items:flex-end}
#toast div{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);
  border-radius:8px;padding:10px 14px;font-size:13px;max-width:380px;
  box-shadow:0 8px 26px rgba(0,0,0,.45);animation:sl .2s ease}
#toast div.bad{border-left-color:var(--bad)}
#toast div.good{border-left-color:var(--ok)}
@keyframes sl{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
</style></head><body>

<header>
  <div class="hrow">
    <h1>AIFACE-MARS <span>&middot; Attendance Server</span></h1>
    <span class="badge" id="hdrDev"><span class="dot"></span>no device</span>
    <span class="spacer"></span>
    <span class="badge" id="hdrPort">&mdash;</span>
    <span class="badge" id="hdrTick">connecting&hellip;</span>
  </div>
  <nav id="tabs">
    <button data-tab="overview" class="active">Overview</button>
    <button data-tab="attendance">Attendance <span class="n" id="nLogs">0</span></button>
    <button data-tab="users">Users <span class="n" id="nUsers">0</span></button>
    <button data-tab="devices">Devices <span class="n" id="nDev">0</span></button>
    <button data-tab="commands">Commands <span class="n" id="nQueue">0</span></button>
    <button data-tab="diagnostics">Diagnostics <span class="n" id="nChk">0</span></button>
  </nav>
</header>

<div id="banner">
  <b>Lost contact with the server.</b>
  <span id="bannerMsg">Retrying&hellip;</span>
  <button onclick="retryNow()">Retry now</button>
</div>

<div class="wrap">

  <!-- ============ OVERVIEW ============ -->
  <section class="tabpane active" data-pane="overview">
    <div class="grid">
      <div class="card"><div class="k">Punches today</div><div class="v" id="cToday">0</div>
        <div class="s" id="cTodayS">&nbsp;</div></div>
      <div class="card"><div class="k">Total punches</div><div class="v" id="cTotal">0</div>
        <div class="s" id="cTotalS">&nbsp;</div></div>
      <div class="card"><div class="k">Enrolled users</div><div class="v" id="cUsers">0</div>
        <div class="s">synced from the terminal</div></div>
      <div class="card"><div class="k">Devices online</div><div class="v" id="cDev">0</div>
        <div class="s" id="cDevS">&nbsp;</div></div>
    </div>
    <div class="cols">
      <div class="panel">
        <h2>Latest punches
          <button onclick="go('attendance')">View all</button></h2>
        <div class="scroll">
          <table><thead><tr><th>Time</th><th>PIN</th><th>Name</th><th>Type</th>
            <th>Verified by</th></tr></thead>
          <tbody id="tbRecent"></tbody></table>
          <div class="empty" id="emptyRecent">Waiting for the first punch&hellip;</div>
        </div>
      </div>
      <div>
        <div class="panel">
          <h2>Connection</h2>
          <div id="ovChecks"></div>
        </div>
        <div class="panel">
          <h2>Quick actions</h2>
          <div class="body">
            <div class="btns">
              <button class="p" onclick="cmd('unlock')">Open door</button>
              <button onclick="cmd('synctime')">Sync clock</button>
              <button onclick="cmd('queryuser')">Pull users</button>
              <button onclick="cmd('queryatt',{days:7})">Pull 7 days</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- ============ ATTENDANCE ============ -->
  <section class="tabpane" data-pane="attendance">
    <div class="panel">
      <h2>Filters
        <span class="row">
          <button onclick="exportCsv()">Export CSV</button>
          <button class="d" onclick="purge()">Clear history</button>
        </span>
      </h2>
      <div class="body">
        <div class="row">
          <div class="fld" style="flex:2 1 220px">
            <label class="f" for="fq">Search</label>
            <input id="fq" placeholder="PIN, name or serial" oninput="debounced()">
          </div>
          <div class="fld"><label class="f" for="ffrom">From</label>
            <input id="ffrom" type="date" onchange="refresh(true)"></div>
          <div class="fld"><label class="f" for="fto">To</label>
            <input id="fto" type="date" onchange="refresh(true)"></div>
          <div class="fld"><label class="f" for="fdev">Device</label>
            <select id="fdev" onchange="refresh(true)"><option value="">All devices</option></select></div>
          <div class="fld"><label class="f" for="flimit">Show</label>
            <select id="flimit" onchange="refresh(true)">
              <option value="100">100 rows</option>
              <option value="300" selected>300 rows</option>
              <option value="1000">1000 rows</option>
              <option value="5000">5000 rows</option>
            </select></div>
          <div class="fld" style="flex:0 0 auto;align-self:flex-end">
            <button onclick="clearFilters()">Reset</button></div>
        </div>
      </div>
    </div>
    <div class="panel">
      <h2>Attendance log <span class="badge" id="logCount">0</span></h2>
      <div class="scroll" style="max-height:none">
        <table><thead><tr><th>Time</th><th>PIN</th><th>Name</th><th>Type</th>
          <th>Verified by</th><th>Device</th></tr></thead>
        <tbody id="tbLogs"></tbody></table>
        <div class="empty" id="emptyLogs">No punches match these filters.</div>
      </div>
    </div>
  </section>

  <!-- ============ USERS ============ -->
  <section class="tabpane" data-pane="users">
    <div class="cols">
      <div class="panel">
        <h2>Users on device
          <span class="row">
            <input id="uq" placeholder="Filter users" style="width:180px" oninput="renderUsers()">
            <button onclick="cmd('queryuser')">Pull from device</button>
          </span>
        </h2>
        <div class="scroll" style="max-height:none">
          <table><thead><tr><th>PIN</th><th>Name</th><th>Card</th><th>Privilege</th>
            <th>Biometrics</th><th></th></tr></thead>
          <tbody id="tbUsers"></tbody></table>
          <div class="empty" id="emptyUsers">No users synced yet &mdash; press <b>Pull from device</b>.</div>
        </div>
      </div>
      <div class="panel">
        <h2>Add / update user</h2>
        <div class="body">
          <div class="row" style="margin-bottom:9px">
            <div class="fld"><label class="f" for="uPin">PIN (user ID)</label>
              <input id="uPin" placeholder="e.g. 51"></div>
            <div class="fld"><label class="f" for="uName">Name</label>
              <input id="uName" placeholder="Full name"></div>
          </div>
          <div class="row" style="margin-bottom:11px">
            <div class="fld"><label class="f" for="uCard">Card number</label>
              <input id="uCard" placeholder="optional"></div>
            <div class="fld"><label class="f" for="uPri">Privilege</label>
              <select id="uPri">
                <option value="0">User</option><option value="2">Enroller</option>
                <option value="6">Manager</option><option value="14">Super admin</option>
              </select></div>
          </div>
          <div class="btns">
            <button class="p" onclick="addUser()">Push to device</button>
            <button class="d" onclick="delUser()">Delete PIN</button>
          </div>
          <p class="hint" style="margin:11px 0 0">The face template still has to be enrolled at
          the terminal &mdash; this creates the user record so the face can be registered
          against it.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- ============ DEVICES ============ -->
  <section class="tabpane" data-pane="devices">
    <div id="devList"></div>
    <div class="panel" id="devEmpty" style="display:none">
      <div class="empty">No terminal has connected yet. Open the
        <b>Diagnostics</b> tab for the exact settings to enter on the device.</div>
    </div>
  </section>

  <!-- ============ COMMANDS ============ -->
  <section class="tabpane" data-pane="commands">
    <div class="cols">
      <div>
        <div class="panel">
          <h2>Send a command
            <select id="cmdTarget" style="width:auto;min-width:190px">
              <option value="">All devices</option></select></h2>
          <div class="body">
            <div class="btns" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
              <button class="p" onclick="cmd('unlock')">Open door</button>
              <button onclick="cmd('synctime')">Sync clock</button>
              <button onclick="cmd('queryuser')">Pull users</button>
              <button onclick="cmd('queryatt',{days:7})">Pull 7 days</button>
              <button onclick="cmd('queryatt',{days:30})">Pull 30 days</button>
              <button onclick="cmd('info')">Device info</button>
              <button onclick="cmd('check')">Full re-sync</button>
              <button onclick="cmd('reboot',null,'Reboot the terminal now?')">Reboot</button>
              <button class="d" onclick="cmd('clearlog',null,'Erase ALL attendance logs stored on the device? The copy on this server is kept.')">Erase device logs</button>
              <button class="d" onclick="cmd('cleardata',null,'Erase ALL users, faces and logs on the device? This cannot be undone.')">Factory clear data</button>
            </div>
          </div>
        </div>
        <div class="panel">
          <h2>Raw command</h2>
          <div class="body">
            <div class="row">
              <input id="rawCmd" class="mono" placeholder="e.g. SET OPTION DoorSensorType=0"
                style="flex:1;min-width:200px" onkeydown="if(event.key==='Enter')sendRaw()">
              <button onclick="sendRaw()">Send</button>
            </div>
            <p class="hint" style="margin:9px 0 0">Sent verbatim to the terminal as
            <code>C:id:your text</code>. Use only documented ZK push commands.</p>
          </div>
        </div>
      </div>
      <div class="panel">
        <h2>Command queue <button onclick="refresh(true)">Refresh</button></h2>
        <div class="scroll sm">
          <table><thead><tr><th>#</th><th>Command</th><th>State</th></tr></thead>
          <tbody id="tbQueue"></tbody></table>
          <div class="empty" id="emptyQueue">Queue is empty.</div>
        </div>
      </div>
    </div>
  </section>

  <!-- ============ DIAGNOSTICS ============ -->
  <section class="tabpane" data-pane="diagnostics">
    <div class="cols">
      <div>
        <div class="panel">
          <h2>Connection checks <button onclick="refresh(true)">Re-check</button></h2>
          <div id="diagChecks"></div>
        </div>
        <div class="panel">
          <h2>Protocol trace
            <span class="row">
              <input id="tq" placeholder="filter" style="width:150px" oninput="renderTrace()">
              <label class="hint" style="display:flex;gap:5px;align-items:center">
                <input type="checkbox" id="tauto" checked style="width:auto"> follow</label>
            </span>
          </h2>
          <div class="log body" id="trace"></div>
        </div>
      </div>
      <div>
        <div class="panel">
          <h2>Wire the device to this server</h2>
          <div class="body hint" id="setup"></div>
        </div>
        <div class="panel">
          <h2>Server</h2>
          <div class="body"><dl class="kv" id="srvInfo"></dl></div>
        </div>
      </div>
    </div>
  </section>

</div>
<div id="toast"></div>
<script>
var S = {};                  // last payload from the server
var TAB = 'overview';
var LAB = {verify:{}, status:{}};
var typeTimer = null, pollTimer = null;
var inFlight = null;         // guards against overlapping polls
var fails = 0, lastOk = 0;

function q(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function num(n){ return (Number(n)||0).toLocaleString(); }
function ago(ms){
  if (!ms) return 'never';
  var s = Math.round((Date.now()-ms)/1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s/60) + 'm ago';
  if (s < 86400) return Math.round(s/3600) + 'h ago';
  return Math.round(s/86400) + 'd ago';
}
function dur(s){
  s = Math.round(s||0);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
  if (s < 86400) return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
  return Math.floor(s/86400) + 'd ' + Math.floor((s%86400)/3600) + 'h';
}
function toast(msg, kind){
  var d = document.createElement('div');
  d.className = kind || '';
  d.textContent = msg;
  q('toast').appendChild(d);
  setTimeout(function(){
    d.style.opacity = '0';
    d.style.transition = 'opacity .3s';
    setTimeout(function(){ d.remove(); }, 320);
  }, kind === 'bad' ? 6000 : 3200);
}

/* ---------------- tabs ---------------- */
function go(tab){
  TAB = tab;
  var bs = document.querySelectorAll('#tabs button');
  for (var i = 0; i < bs.length; i++)
    bs[i].classList.toggle('active', bs[i].getAttribute('data-tab') === tab);
  var ps = document.querySelectorAll('.tabpane');
  for (var j = 0; j < ps.length; j++)
    ps[j].classList.toggle('active', ps[j].getAttribute('data-pane') === tab);
  try { localStorage.setItem('aiface.tab', tab); } catch (e) {}
  if (location.hash.slice(1) !== tab) history.replaceState(null, '', '#' + tab);
  refresh(true);
}
document.getElementById('tabs').addEventListener('click', function(e){
  var b = e.target.closest('button[data-tab]');
  if (b) go(b.getAttribute('data-tab'));
});
window.addEventListener('hashchange', function(){
  var t = location.hash.slice(1);
  if (t && t !== TAB) go(t);
});

/* ---------------- polling ---------------- */
function params(){
  var p = new URLSearchParams();
  p.set('tab', TAB);
  if (TAB === 'attendance' || TAB === 'overview') {
    if (q('fq').value) p.set('q', q('fq').value);
    if (q('ffrom').value) p.set('from', q('ffrom').value);
    if (q('fto').value) p.set('to', q('fto').value);
    if (q('fdev').value) p.set('sn', q('fdev').value);
    p.set('limit', q('flimit').value || '300');
  }
  return p;
}
function debounced(){ clearTimeout(typeTimer); typeTimer = setTimeout(function(){ refresh(true); }, 280); }

// One request at a time, with a hard timeout. Overlapping 3s polls used to
// stack up whenever the server was busy, which made the page feel frozen.
function refresh(force){
  if (inFlight) { if (!force) return; inFlight.abort(); inFlight = null; }
  var ac = new AbortController();
  inFlight = ac;
  var kill = setTimeout(function(){ ac.abort(); }, 12000);

  fetch('/api/state?' + params().toString(), {signal: ac.signal, cache: 'no-store'})
    .then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(s){
      clearTimeout(kill);
      if (inFlight === ac) inFlight = null;
      fails = 0; lastOk = Date.now();
      q('banner').classList.remove('show');
      render(s);
    })
    .catch(function(err){
      clearTimeout(kill);
      if (inFlight === ac) inFlight = null;
      if (err && err.name === 'AbortError' && !force) return;
      fails++;
      q('hdrTick').textContent = 'no reply';
      q('hdrTick').className = 'badge off';
      if (fails >= 2) {
        q('banner').classList.add('show');
        q('bannerMsg').textContent = 'Attempt ' + fails + ' failed'
          + (lastOk ? ' · last update ' + ago(lastOk) : '')
          + '. Is "node server.js" still running?';
      }
    });
}
function retryNow(){ fails = 0; refresh(true); }

// Back off while the server is unreachable, and stop polling entirely when the
// tab is in the background.
function schedule(){
  clearTimeout(pollTimer);
  var base = (TAB === 'overview' || TAB === 'diagnostics') ? 3000 : 5000;
  var wait = fails ? Math.min(30000, base * Math.pow(2, Math.min(fails, 4))) : base;
  pollTimer = setTimeout(function(){
    if (!document.hidden) refresh(false);
    schedule();
  }, wait);
}
document.addEventListener('visibilitychange', function(){
  if (!document.hidden) { fails = 0; refresh(true); }
});

/* ---------------- render ---------------- */
function render(s){
  S = s;
  LAB = s.labels || LAB;
  var t = s.totals;

  q('hdrPort').textContent = 'port ' + s.port + ' · up ' + dur(s.uptime);
  q('hdrTick').textContent = 'updated ' + new Date().toLocaleTimeString();
  q('hdrTick').className = 'badge';

  var cls = t.online ? 'on' : (t.devices ? 'off' : 'warn');
  var txt = t.online ? (t.online + ' device' + (t.online > 1 ? 's' : '') + ' online')
    : (t.devices ? 'device offline' : 'no device');
  q('hdrDev').className = 'badge ' + cls;
  q('hdrDev').innerHTML = '<span class="dot ' + cls + '"></span>' + txt;

  q('nLogs').textContent  = num(t.logs);
  q('nUsers').textContent = num(t.users);
  q('nDev').textContent   = num(t.devices);
  q('nQueue').textContent = num(t.queued);

  q('cToday').textContent  = num(t.today);
  q('cTotal').textContent  = num(t.logs);
  q('cUsers').textContent  = num(t.users);
  q('cDev').textContent    = t.online + ' / ' + t.devices;
  q('cTodayS').textContent = new Date().toDateString();
  q('cTotalS').textContent = 'since the server first ran';
  q('cDevS').textContent   = t.devices ? (t.online ? 'reporting normally' : 'nothing polling') : 'none configured';

  syncDevicePickers(s.devices || []);

  if (s.checks) {
    var bad = s.checks.filter(function(c){ return c.level !== 'ok'; }).length;
    q('nChk').textContent = bad ? String(bad) : 'ok';
    if (TAB === 'overview') q('ovChecks').innerHTML = checksHtml(s.checks.slice(0, 4));
    if (TAB === 'diagnostics') q('diagChecks').innerHTML = checksHtml(s.checks);
  }
  if (s.logs)   { renderRows(s.logs); }
  if (s.users)  { renderUsers(); }
  if (s.queue)  { renderQueue(s.queue); }
  if (s.events) { renderTrace(); }
  if (TAB === 'devices') renderDevices(s.devices || []);
  if (TAB === 'diagnostics') renderSetup(s);
}

function checksHtml(list){
  if (!list.length) return '<div class="empty">No checks ran.</div>';
  return list.map(function(c){
    var mark = c.level === 'ok' ? '✓' : (c.level === 'warn' ? '!' : '✕');
    return '<div class="chk ' + c.level + '"><div class="ic">' + mark + '</div><div>'
      + '<div class="t">' + esc(c.title) + '</div>'
      + '<div class="d">' + esc(c.detail) + '</div>'
      + (c.fix ? '<div class="fx">' + esc(c.fix) + '</div>' : '')
      + '</div></div>';
  }).join('');
}

function rowHtml(r, withDev){
  var st = LAB.status[r.status] || ('Status ' + r.status);
  var c = (r.status === 1 || r.status === 5) ? 'out'
        : ((r.status === 0 || r.status === 4) ? 'in' : '');
  return '<tr><td class="mono">' + esc(r.time) + '</td>'
    + '<td class="mono">' + esc(r.pin) + '</td>'
    + '<td>' + (r.name ? esc(r.name) : '<span style="color:#5d6a7a">&mdash;</span>') + '</td>'
    + '<td><span class="pill ' + c + '">' + esc(st) + '</span></td>'
    + '<td>' + esc(LAB.verify[r.verify] || ('Mode ' + r.verify)) + '</td>'
    + (withDev ? '<td class="mono" style="color:#5d6a7a">' + esc(r.sn) + '</td>' : '') + '</tr>';
}

function renderRows(logs){
  if (TAB === 'overview') {
    q('tbRecent').innerHTML = logs.map(function(r){ return rowHtml(r, false); }).join('');
    q('emptyRecent').style.display = logs.length ? 'none' : 'block';
  } else if (TAB === 'attendance') {
    q('tbLogs').innerHTML = logs.map(function(r){ return rowHtml(r, true); }).join('');
    q('emptyLogs').style.display = logs.length ? 'none' : 'block';
    q('logCount').textContent = logs.length < S.logCount
      ? ('showing ' + num(logs.length) + ' of ' + num(S.logCount))
      : (num(logs.length) + ' rows');
  }
}

function renderUsers(){
  var list = S.users || [];
  var term = (q('uq').value || '').toLowerCase();
  if (term) list = list.filter(function(u){
    return String(u.pin).toLowerCase().indexOf(term) >= 0
      || String(u.name || '').toLowerCase().indexOf(term) >= 0;
  });
  var PRI = {'0':'User','2':'Enroller','6':'Manager','14':'Super admin'};
  q('tbUsers').innerHTML = list.map(function(u){
    var bio = u.bio ? Object.keys(u.bio).join(', ') : '';
    return '<tr><td class="mono">' + esc(u.pin) + '</td>'
      + '<td>' + esc(u.name || '') + '</td>'
      + '<td class="mono">' + esc(u.card || '') + '</td>'
      + '<td>' + esc(PRI[u.privilege] || u.privilege || 'User') + '</td>'
      + '<td style="color:#5d6a7a">' + esc(bio) + '</td>'
      + '<td style="text-align:right"><button onclick="editUser('
      + esc(JSON.stringify(String(u.pin))) + ')">Edit</button></td></tr>';
  }).join('');
  q('emptyUsers').style.display = list.length ? 'none' : 'block';
  if (term && !list.length) q('emptyUsers').textContent = 'No user matches "' + term + '".';
}

function editUser(pin){
  var u = (S.users || []).filter(function(x){ return String(x.pin) === String(pin); })[0];
  if (!u) return;
  q('uPin').value = u.pin;
  q('uName').value = u.name || '';
  q('uCard').value = u.card || '';
  q('uPri').value = u.privilege || '0';
  q('uPin').focus();
}

function renderDevices(devs){
  if (!devs.length) { q('devList').innerHTML = ''; q('devEmpty').style.display = 'block'; return; }
  q('devEmpty').style.display = 'none';
  q('devList').innerHTML = devs.map(function(d){
    var st = d.online ? 'on' : 'off';
    var health = d.online
      ? 'Polling every ~' + Math.round((d.pollInterval || 10000) / 1000) + 's'
      : 'Silent for ' + (d.silentFor ? dur(d.silentFor / 1000) : 'ever');
    var pairs = [
      ['Serial', d.sn], ['Model', d.name || 'AIFACE-MARS'], ['Firmware', d.firmware || '?'],
      ['Platform', d.platform || '?'], ['Push protocol', d.push || '?'],
      ['Address seen by server', d.ip || '?'], ['Address on device', d.deviceIp || '?'],
      ['MAC', d.mac || '?'],
      ['Users on device', (d.userCount || '?') + (d.maxUsers ? ' / ' + d.maxUsers : '')],
      ['Faces enrolled', (d.faceCount || '?') + (d.maxFaces ? ' / ' + d.maxFaces : '')],
      ['Fingerprints', d.fpCount || '?'],
      ['Transactions on device', d.transactions || '?'],
      ['Punches received here', num(d.pushCount)],
      ['Last punch received', d.lastPush ? ago(d.lastPush) : 'none'],
      ['Last contact', ago(d.lastSeen)],
      ['First seen', d.firstSeen ? new Date(d.firstSeen).toLocaleString() : '?'],
      ['Polls received', num(d.polls)],
      ['Connections', num(d.sessions) + (d.drops ? ' (' + d.drops + ' drop' + (d.drops > 1 ? 's' : '') + ')' : '')],
      ['Last drop', d.lastDrop ? ago(d.lastDrop) : 'none'],
      ['Commands sent / confirmed', num(d.cmdsSent) + ' / ' + num(d.cmdsDone)],
      ['Log pointer', d.stamp + ' / ' + d.opStamp]
    ];
    return '<div class="panel"><h2>'
      + '<span><span class="dot ' + st + '"></span>' + esc(d.sn)
      + (d.name ? ' · ' + esc(d.name) : '') + '</span>'
      + '<span class="row"><span class="badge ' + st + '">' + (d.online ? 'online' : 'offline')
      + '</span><span class="badge">' + esc(health) + '</span>'
      + '<button onclick="cmd(&quot;info&quot;,{sn:' + esc(JSON.stringify(d.sn)) + '})">Refresh info</button>'
      + '</span></h2><div class="body"><dl class="kv">'
      + pairs.map(function(p){
          return '<dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd>'; }).join('')
      + '</dl>'
      + (d.infoCount ? '' : '<p class="hint" style="margin:11px 0 0">This terminal has not '
        + 'sent its option list yet, so the hardware details above are unknown. Press '
        + '<b>Refresh info</b>.</p>')
      + '</div></div>';
  }).join('');
}

function renderQueue(list){
  q('tbQueue').innerHTML = list.map(function(c){
    var st = c.returned ? 'done (ret ' + c.result + ')'
           : (c.sent ? 'sent, awaiting reply' : 'pending');
    var cl = c.returned ? (String(c.result) === '0' ? 'in' : '') : (c.sent ? '' : 'out');
    return '<tr><td class="mono">' + c.id + '</td>'
      + '<td class="mono">' + esc(c.cmd.split('\\t')[0]) + '</td>'
      + '<td><span class="pill ' + cl + '">' + esc(st) + '</span></td></tr>';
  }).join('');
  q('emptyQueue').style.display = list.length ? 'none' : 'block';
}

function renderTrace(){
  var ev = S.events || [];
  var term = (q('tq').value || '').toLowerCase();
  if (term) ev = ev.filter(function(e){
    return (e.msg + ' ' + e.sn + ' ' + e.kind).toLowerCase().indexOf(term) >= 0; });
  q('trace').innerHTML = ev.map(function(e){
    return '<div class="' + e.kind + '">' + new Date(e.t).toLocaleTimeString()
      + ' [' + esc(e.sn) + '] ' + esc(e.msg) + '</div>';
  }).join('') || '<div class="info">no traffic yet</div>';
}

function renderSetup(s){
  var ip = s.ips[0] || 'YOUR-PC-IP';
  q('setup').innerHTML =
    'On the terminal: <b>Menu &rarr; COMM &rarr; Cloud Server Setting (ADMS)</b><br><br>'
    + 'Server Address <code>' + esc(ip) + '</code><br>'
    + 'Server Port <code>' + s.port + '</code><br>'
    + 'Enable Domain Name <code>OFF</code><br>'
    + 'Enable Proxy Server <code>OFF</code><br><br>'
    + 'Save, then reboot the terminal. It should appear here within about a minute.'
    + (s.ips.length > 1 ? '<br><br>This machine has several addresses &mdash; use the one on '
      + 'the same subnet as the terminal: <code>' + esc(s.ips.join('  ')) + '</code>' : '');
  q('srvInfo').innerHTML = [
    ['Listening on', 'port ' + s.port],
    ['Addresses', s.ips.join(', ') || 'localhost only'],
    ['Uptime', dur(s.uptime)],
    ['Punches stored', num(s.totals.logs)],
    ['Users stored', num(s.totals.users)],
    ['Health endpoint', location.origin + '/health']
  ].map(function(p){ return '<dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd>'; }).join('');
}

function syncDevicePickers(devs){
  var opts = '<option value="">All devices</option>' + devs.map(function(d){
    return '<option value="' + esc(d.sn) + '">' + esc(d.sn)
      + (d.online ? '' : ' (offline)') + '</option>'; }).join('');
  ['fdev', 'cmdTarget'].forEach(function(id){
    var el = q(id);
    if (el.getAttribute('data-sig') === opts) return;
    var keep = el.value;
    el.innerHTML = opts;
    el.value = keep;
    el.setAttribute('data-sig', opts);
  });
}

/* ---------------- actions ---------------- */
function cmd(kind, extra, confirmMsg){
  if (confirmMsg && !confirm(confirmMsg)) return;
  var payload = Object.assign({kind: kind}, extra || {});
  if (!payload.sn) {
    var t = q('cmdTarget');
    if (t && t.value) payload.sn = t.value;
  }
  fetch('/api/cmd', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)})
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (!j.ok) return toast(j.error || 'Command failed', 'bad');
      toast(j.warning || ('Queued: ' + j.cmd.split('\\t')[0]), j.warning ? '' : 'good');
      refresh(true);
    })
    .catch(function(){ toast('Could not reach the server', 'bad'); });
}
function sendRaw(){
  var v = q('rawCmd').value.trim();
  if (!v) return;
  cmd('raw', {cmd: v});
  q('rawCmd').value = '';
}
function addUser(){
  var pin = q('uPin').value.trim();
  if (!pin) return toast('PIN is required', 'bad');
  cmd('adduser', {pin: pin, name: q('uName').value.trim(),
    card: q('uCard').value.trim(), pri: q('uPri').value});
  q('uName').value = ''; q('uCard').value = '';
}
function delUser(){
  var pin = q('uPin').value.trim();
  if (!pin) return toast('PIN is required', 'bad');
  if (!confirm('Delete user ' + pin + ' from the device?')) return;
  cmd('deluser', {pin: pin});
}
function purge(){
  if (!confirm('Delete all attendance history stored on this server? The device keeps its own copy.')) return;
  fetch('/api/purge', {method: 'POST'})
    .then(function(){ toast('Server history cleared', 'good'); refresh(true); })
    .catch(function(){ toast('Could not reach the server', 'bad'); });
}
function clearFilters(){
  q('fq').value = ''; q('ffrom').value = ''; q('fto').value = '';
  q('fdev').value = ''; q('flimit').value = '300';
  refresh(true);
}
function exportCsv(){
  var p = params();
  p.delete('tab');
  p.set('limit', '20000');
  window.location = '/api/export.csv?' + p.toString();
}

/* ---------------- boot ---------------- */
(function(){
  var t = location.hash.slice(1);
  if (!t) { try { t = localStorage.getItem('aiface.tab') || ''; } catch (e) {} }
  var valid = ['overview','attendance','users','devices','commands','diagnostics'];
  go(valid.indexOf(t) >= 0 ? t : 'overview');
  schedule();
})();
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
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }
    if (route.startsWith('/iclock')) return await handleDevice(req, res, route, query);
    // /health sits outside /api/, so it needs naming here or it 404s.
    if (route.startsWith('/api/') || route === '/health') {
      return await handleApi(req, res, route, query);
    }
    if (route === '/' || route === '/index.html') {
      const b = Buffer.from(HTML, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': b.length,
        'Cache-Control': 'no-cache',
      });
      return res.end(b);
    }
    if (route === '/favicon.ico') { res.writeHead(204); return res.end(); }
    return textOut(res, 'Not found', 404);
  } catch (e) {
    trace('err', '', route + ' -> ' + e.message);
    return textOut(res, 'Server error', 500);
  }
});

// Terminals keep sockets open and sometimes vanish mid-request. Without these
// the default 5s keep-alive raced the device's own reuse of the connection,
// which shows up as an occasional failed poll.
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.requestTimeout = 120000;
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  trace('err', '', 'bad client request: ' + err.message);
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

// One malformed push should never take the whole server down and leave the
// terminal with nothing to talk to.
process.on('uncaughtException', (e) => {
  trace('err', '', 'uncaught: ' + (e && e.stack ? e.stack.split('\n')[0] : e));
  console.error(e);
});
process.on('unhandledRejection', (e) => {
  trace('err', '', 'unhandled rejection: ' + (e && e.message ? e.message : e));
});

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) process.exit(0);
    closing = true;
    console.log('\n  saving state and shutting down...');
    dirty = true;
    flushState();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

loadState();
server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPs();
  console.log('');
  console.log('  AIFACE-MARS attendance server');
  console.log('  ------------------------------------------------------------');
  console.log('  Dashboard    http://localhost:' + PORT);
  ips.forEach((ip) => console.log('               http://' + ip + ':' + PORT));
  console.log('');
  console.log('  On the device: Menu > COMM > Cloud Server Setting (ADMS)');
  console.log('     Server Address : ' + (ips[0] || '<this PC IP>'));
  console.log('     Server Port    : ' + PORT);
  console.log('     Domain / Proxy : OFF, then reboot the terminal');
  console.log('');
  console.log('  Loaded ' + state.logs.length + ' punches, '
    + Object.keys(state.users).length + ' users, '
    + Object.keys(state.devices).length + ' device(s) from ./data');
  if (startupWarnings.length) {
    console.log('');
    startupWarnings.forEach((w) => console.log('  !! ' + w));
  }
  console.log('');
});
