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
const snList = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
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
};
const seen = new Set();          // dedupe key for punches
let cmdSeq = Date.now() % 100000;

function loadState() {
  try {
    for (const line of fs.readFileSync(ATT_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      state.logs.push(r);
      seen.add(r.sn + '|' + r.pin + '|' + r.time + '|' + r.status);
    }
  } catch (e) { /* first run */ }
  try { state.users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) {}
  try {
    state.devices = JSON.parse(fs.readFileSync(DEV_FILE, 'utf8'));
    for (const sn of Object.keys(state.devices)) state.devices[sn].online = false;
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
    } catch (e) { console.error('save failed', e.message); }
  }, 800);
}

function trace(kind, sn, msg) {
  state.events.push({ t: Date.now(), kind, sn: sn || '-', msg: String(msg).slice(0, 400) });
  if (state.events.length > 400) state.events.splice(0, state.events.length - 400);
  const tag = kind === 'err' ? '!!' : kind === 'dev' ? '<<' : kind === 'srv' ? '>>' : '..';
  console.log(new Date().toLocaleTimeString(), tag, (sn || '-'), String(msg).slice(0, 200));
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

function enqueue(sn, cmd) {
  const id = ++cmdSeq;
  const item = { id, sn, cmd, created: Date.now(), sent: 0, returned: 0, result: null };
  (state.queue[sn] = state.queue[sn] || []).push(item);
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

function addPunch(sn, pin, time, status, verify, workcode, extra) {
  const key = sn + '|' + pin + '|' + time + '|' + status;
  if (seen.has(key)) return false;
  seen.add(key);
  const rec = {
    sn, pin: String(pin), time, status: Number(status) || 0,
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
  let n = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split('\t');
    if (f.length < 2) continue;
    const pin = f[0].trim();
    const time = (f[1] || '').trim();
    if (!pin || !/\d{4}-\d{2}-\d{2}/.test(time)) continue;
    if (addPunch(sn, pin, time, f[2], f[3], f[4], f.slice(5).join('|'))) n++;
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
    'ServerVer=2.4.1 ' + localDate(new Date()),
    'PushProtVer=2.4.1',
    'MultiBioDataSupport=0:1:0:0:0:0:0:0:1:0',
    'MultiBioPhotoSupport=0:0:0:0:0:0:0:0:1:0',
    '',
  ].join('\n');
}

async function handleDevice(req, res, route, q) {
  const sn = q.get('SN') || q.get('sn') || '';

  if (route === '/iclock/ping') { touchDevice(sn, req); return textOut(res, 'OK'); }

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
    const table = (q.get('table') || q.get('Table') || '').toUpperCase();
    const stamp = q.get('Stamp') || q.get('stamp');
    if (table === 'ATTLOG') {
      if (stamp && d) d.stamp = stamp;
      const n = parseAttlog(sn, body);
      return textOut(res, 'OK: ' + n);
    }
    if (table === 'OPERLOG' || table === 'USERINFO' || table === 'BIODATA') {
      if (stamp && d) d.opStamp = stamp;
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
    const d = touchDevice(sn, req);
    const pending = (state.queue[sn] || []).filter((c) => !c.sent);
    if (!pending.length) return textOut(res, 'OK');
    const lines = pending.map((c) => { c.sent = Date.now(); return 'C:' + c.id + ':' + c.cmd; });
    trace('srv', sn, 'sending ' + lines.length + ' command(s)');
    if (d) d.lastCmd = Date.now();
    return textOut(res, lines.join('\n') + '\n');
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

/* ------------------------------------------------------------------- API */

function dirOf(rec) {
  if (rec.status === 0 || rec.status === 4 || rec.status === 3) return 'in';
  if (rec.status === 1 || rec.status === 5 || rec.status === 2) return 'out';
  const d = state.devices[rec.sn];
  return (d && d.role) || '';
}

/* ------------------------------------------------------- attendance model */

const DEDUP_MS = 60000;   // terminal double-reads: PIN 2 punched at :09 and :10

const tsOf = (t) => Date.parse(t.replace(' ', 'T')) || 0;
const dayOf = (t) => t.slice(0, 10);

// One day's punches -> ordered, de-duplicated, labelled events.
// Direction comes from the gate role; with no roles assigned we fall back to
// alternating from the first punch (first = in, next = out, ...).
function dayEvents(pin, date) {
  const raw = state.logs
    .filter((r) => r.pin === pin && dayOf(r.time) === date)
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

  const evs = [];
  for (const r of raw) {
    const d = dirOf(r);
    const prev = evs[evs.length - 1];
    if (prev && prev.dir === d && tsOf(r.time) - tsOf(prev.time) < DEDUP_MS) continue;
    evs.push({ time: r.time, dir: d, verify: r.verify, sn: r.sn });
  }
  const anyRole = evs.some((e) => e.dir);
  evs.forEach((e, i) => { if (!anyRole) e.dir = i % 2 === 0 ? 'in' : 'out'; });

  // Staff often tap the same terminal several times. A run of same-direction
  // punches is one real movement: keep the first, mark the rest as repeats so
  // they show in the timeline but never create a phantom break.
  let held = null;
  for (const e of evs) { e.repeat = e.dir === held; if (!e.repeat) held = e.dir; }

  const core = evs.filter((e) => !e.repeat);
  const dirs = core.map((e) => e.dir);
  const firstIn = dirs.indexOf('in');
  const lastOut = dirs.lastIndexOf('out');
  core.forEach((e, i) => {
    if (i === firstIn) e.label = 'Check in';
    else if (i === lastOut && lastOut > firstIn) e.label = 'Check out';
    else if (lastOut > -1 && i > lastOut) e.label = 'Extra punch';
    else e.label = e.dir === 'out' ? 'Break start' : 'Break end';
  });
  evs.forEach((e) => { if (e.repeat) e.label = 'Repeat punch'; });
  return evs;
}

function daySummary(pin, date) {
  const evs = dayEvents(pin, date);
  const inEv = evs.find((e) => e.label === 'Check in');
  const outEv = evs.slice().reverse().find((e) => e.label === 'Check out');

  let breakMin = 0;
  for (let i = 0; i < evs.length; i++) {
    if (evs[i].label !== 'Break start') continue;
    const end = evs.slice(i + 1).find((e) => e.label === 'Break end' || e.label === 'Check out');
    if (end && end.label === 'Break end') {
      breakMin += Math.round((tsOf(end.time) - tsOf(evs[i].time)) / 60000);
    }
  }
  const totalMin = inEv && outEv ? Math.round((tsOf(outEv.time) - tsOf(inEv.time)) / 60000) : 0;
  const dow = new Date(date + 'T00:00:00').getDay();
  return {
    date, dow,
    status: evs.length ? 'Present' : (dow === 0 ? 'Weekly off' : 'Absent'),
    in: inEv ? inEv.time : '', out: outEv ? outEv.time : '',
    incomplete: !!(evs.length && (!inEv || !outEv)),
    punches: evs.length, breakMin, totalMin,
    effectiveMin: Math.max(0, totalMin - breakMin),
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

function attendance(pin, from, to) {
  const dates = dateRange(from, to);
  const days = dates.map((d) => daySummary(pin, d));
  const present = days.filter((d) => d.status === 'Present');
  const sum = (k) => present.reduce((a, d) => a + d[k], 0);
  return {
    pin,
    name: (state.users[pin] && state.users[pin].name) || '',
    days: days.slice().reverse(),
    totals: {
      totalDays: days.length,
      present: present.length,
      absent: days.filter((d) => d.status === 'Absent').length,
      sundays: days.filter((d) => d.dow === 0).length,
      totalMin: sum('totalMin'),
      breakMin: sum('breakMin'),
      effectiveMin: sum('effectiveMin'),
    },
  };
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
  if (fVerify) rows = rows.filter((r) => String(r.verify) === fVerify);
  if (fDir) rows = rows.filter((r) => (dirOf(r) || 'none') === fDir);
  return rows.slice(-limit).reverse().map((r) => Object.assign({ dir: dirOf(r) }, r));
}

async function handleApi(req, res, route, q) {
  if (route === '/health' || route === '/api/health') {
    return jsonOut(res, { status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
  }
  if (route === '/api/attendance') {
    const today = localDate(new Date());
    const to = q.get('to') || today;
    const from = q.get('from') || to;
    const pin = q.get('pin');
    if (pin) return jsonOut(res, attendance(pin, from, to));
    const rows = Object.keys(state.users)
      .map((p) => { const a = attendance(p, from, to); return { pin: p, name: a.name, totals: a.totals }; })
      .sort((a, b) => Number(a.pin) - Number(b.pin));
    return jsonOut(res, { from, to, rows });
  }
  if (route === '/api/state') {
    const rows = filterLogs(q).slice(0, Number(q.get('limit') || 200));
    const today = localDate(new Date());
    return jsonOut(res, {
      now: Date.now(),
      port: PORT,
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
    const targets = p.sn ? [p.sn] : Object.keys(state.devices);
    if (!targets.length) return jsonOut(res, { ok: false, error: 'no device connected yet' }, 400);
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
    const queued = targets.map((sn) => enqueue(sn, cmd));
    return jsonOut(res, { ok: true, cmd, queued: queued.map((c) => c.id) });
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
.hint{color:var(--dim);font-size:12px;line-height:1.7}
.hint b{color:var(--fg)}
code{background:#0d1117;border:1px solid var(--line);padding:1px 6px;border-radius:5px;font-size:12px}
.empty{padding:34px;text-align:center;color:var(--dim)}
</style></head><body>
<header>
  <h1>AIFACE-MARS &middot; Attendance Server</h1>
  <span class="badge" id="hdrPort"></span>
  <span class="badge" id="hdrDev">no device</span>
  <span style="flex:1"></span>
  <span class="badge" id="hdrTick">-</span>
</header>
<div class="wrap">
  <div class="grid">
    <div class="card"><div class="k">Punches today</div><div class="v" id="cToday">0</div></div>
    <div class="card"><div class="k">Total punches</div><div class="v" id="cTotal">0</div></div>
    <div class="card"><div class="k">Enrolled users</div><div class="v" id="cUsers">0</div></div>
    <div class="card"><div class="k">Devices</div><div class="v" id="cDev">0</div></div>
  </div>

  <div class="panel" style="margin-bottom:16px">
    <h2>Employee attendance
      <span class="row"><button onclick="attCsv()">Download CSV</button></span>
    </h2>
    <div class="body row">
      <select id="aUser" style="min-width:220px" onchange="loadAtt()"><option value="">Select an employee...</option></select>
      <input id="aFrom" type="date" style="width:150px" onchange="loadAtt()">
      <input id="aTo" type="date" style="width:150px" onchange="loadAtt()">
    </div>
    <div id="aKpis"></div>
    <div class="scroll">
      <table><thead><tr><th>Date</th><th>Status</th><th>Check-in &ndash; Check-out</th>
      <th>Total hours</th><th>Break</th><th>Effective hours</th><th>Punches</th></tr></thead>
      <tbody id="tbAtt"></tbody></table>
      <div class="empty" id="emptyAtt">Pick an employee to see their daily log.</div>
    </div>
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

  <div class="cols">
    <div>
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
          <select id="fverify" style="width:150px" onchange="refresh()">
            <option value="">Verified by: all</option>
          </select>
          <input id="ffrom" type="date" style="width:150px" onchange="refresh()">
          <input id="fto" type="date" style="width:150px" onchange="refresh()">
          <button onclick="clearFilters()">Reset</button>
        </div>
        <div class="scroll">
          <table><thead><tr><th>Time</th><th>PIN</th><th>Name</th><th>Type</th><th>Verified by</th><th>Device</th></tr></thead>
          <tbody id="tbLogs"></tbody></table>
          <div class="empty" id="emptyLogs">Waiting for the first punch from the device...</div>
        </div>
      </div>

      <div class="panel">
        <h2>Users on device</h2>
        <div class="scroll" style="max-height:260px">
          <table><thead><tr><th>PIN</th><th>Name</th><th>Card</th><th>Privilege</th><th>Biometrics</th></tr></thead>
          <tbody id="tbUsers"></tbody></table>
          <div class="empty" id="emptyUsers">No users synced yet &mdash; press <b>Pull users</b>.</div>
        </div>
      </div>

      <div class="panel">
        <h2>Protocol trace</h2>
        <div class="log body" id="trace"></div>
      </div>
    </div>

    <div>
      <div class="panel">
        <h2>Device</h2>
        <div class="body" id="devBox"><div class="hint">No device has connected yet.</div></div>
      </div>

      <div class="panel">
        <h2>Commands</h2>
        <div class="body">
          <div class="btns">
            <button class="p" onclick="cmd('unlock')">Open door</button>
            <button onclick="cmd('synctime')">Sync clock</button>
            <button onclick="cmd('queryuser')">Pull users</button>
            <button onclick="cmd('queryatt',{days:7})">Pull 7 days</button>
            <button onclick="cmd('info')">Device info</button>
            <button onclick="cmd('check')">Full re-sync</button>
            <button onclick="cmd('reboot')">Reboot</button>
            <button class="d" onclick="cmd('clearlog',null,'Erase ALL attendance logs stored on the device?')">Erase device logs</button>
          </div>
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

      <div class="panel">
        <h2>Wire the device to this server</h2>
        <div class="body hint" id="setup"></div>
      </div>
    </div>
  </div>
</div>

<script>
var LAB = {verify:{},status:{}};
var timer = null;

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
  p.set('limit','300');
  return p;
}
function debounced(){ clearTimeout(timer); timer = setTimeout(refresh, 250); }
function clearFilters(){
  ['fq','fpin','fname','fdir','fverify','ffrom','fto'].forEach(function(id){ q(id).value = ''; });
  refresh();
}
var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];
var DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
// "2026-09-03 11:25:06" -> {date:"03 Sept (Thu)", time:"11:25 AM"}
function fmtStamp(str){
  var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(str || '');
  if (!m) return { date: str || '', time: '' };
  var dt = new Date(+m[1], +m[2] - 1, +m[3]);
  var hh = +m[4], ap = hh < 12 ? 'AM' : 'PM';
  var h12 = hh % 12; if (!h12) h12 = 12;
  return {
    date: m[3] + ' ' + MONTHS[+m[2] - 1] + ' (' + DAYS[dt.getDay()] + ')',
    time: h12 + ':' + m[5] + ' ' + ap
  };
}

function refresh(){
  fetch('/api/state?' + params().toString())
    .then(function(r){ return r.json(); })
    .then(render)
    .catch(function(){ q('hdrTick').textContent = 'server unreachable'; });
}

function render(s){
  LAB = s.labels;
  var vsel = q('fverify');
  if (vsel.options.length <= 1) {
    Object.keys(LAB.verify || {}).forEach(function(k){
      var o = document.createElement('option'); o.value = k; o.textContent = LAB.verify[k];
      vsel.appendChild(o);
    });
  }
  q('cToday').textContent = s.totals.today;
  q('cTotal').textContent = s.totals.logs;
  q('cUsers').textContent = s.totals.users;
  q('cDev').textContent   = s.totals.devices;
  q('hdrPort').textContent = 'listening on port ' + s.port;
  q('hdrTick').textContent = 'updated ' + new Date().toLocaleTimeString();

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
        + '<span class="badge ' + (d.online?'on':'off') + '">' + (d.online?'online':'offline') + '</span></div>'
        + '<div class="hint" style="margin-top:6px">'
        + 'IP <b>' + esc(d.ip||'?') + '</b><br>'
        + 'Model <b>' + esc(i.DeviceName || i['~DeviceName'] || 'AIFACE-MARS') + '</b><br>'
        + 'Firmware <b>' + esc(i.FWVersion || i['~ZKFPVersion'] || '?') + '</b><br>'
        + 'Faces <b>' + esc(i.FaceCount || i.face_count || '?') + '</b> &middot; '
        + 'Users <b>' + esc(i.UserCount || i.user_count || '?') + '</b> &middot; '
        + 'Logs <b>' + esc(i.TransactionCount || i.transaction_count || '?') + '</b><br>'
        + 'Last contact <b>' + (d.lastSeen ? ago(d.lastSeen) : 'never') + '</b>'
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
       + '<td><span class="pill ' + cls + '">' + esc(st) + '</span></td>'
       + '<td>' + esc(LAB.verify[r.verify] || ('Mode ' + r.verify)) + '</td>'
       + '<td class="mono" style="color:#8b949e">' + esc(r.sn) + '</td></tr>';
  }
  q('tbLogs').innerHTML = tb;
  q('emptyLogs').style.display = s.logs.length ? 'none' : 'block';

  var sel = q('aUser');
  if (sel.options.length - 1 !== s.users.length){
    var keep = sel.value;
    sel.innerHTML = '<option value="">Select an employee...</option>';
    s.users.forEach(function(u){
      var o = document.createElement('option');
      o.value = u.pin; o.textContent = (u.name || '(no name)') + '  -  PIN ' + u.pin;
      sel.appendChild(o);
    });
    sel.value = keep;
  }
  if (!q('aTo').value){
    var now = new Date(), pad = function(x){ return String(x).padStart(2,'0'); };
    var iso = function(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); };
    q('aTo').value = iso(now);
    q('aFrom').value = iso(new Date(now.getTime() - 7*86400000));
  }

  // users
  var ub = '';
  for (var j = 0; j < s.users.length; j++) {
    var u = s.users[j];
    var bio = u.bio ? Object.keys(u.bio).join(', ') : '';
    var pri = {'0':'User','2':'Enroller','6':'Manager','14':'Super admin'}[u.privilege] || u.privilege || 'User';
    ub += '<tr><td class="mono">' + esc(u.pin) + '</td><td>' + esc(u.name) + '</td>'
       + '<td class="mono">' + esc(u.card || '') + '</td><td>' + esc(pri) + '</td>'
       + '<td style="color:#8b949e">' + esc(bio) + '</td></tr>';
  }
  q('tbUsers').innerHTML = ub;
  q('emptyUsers').style.display = s.users.length ? 'none' : 'block';

  // trace
  q('trace').innerHTML = s.events.map(function(e){
    return '<div class="' + e.kind + '">' + new Date(e.t).toLocaleTimeString()
      + ' [' + esc(e.sn) + '] ' + esc(e.msg) + '</div>';
  }).join('') || '<div class="info">no traffic yet</div>';

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
var ATT = null;
function hm(m){ return (m/60|0) + 'h ' + (m%60) + 'm'; }

function loadAtt(){
  var pin = q('aUser').value;
  q('emptyAtt').style.display = pin ? 'none' : 'block';
  if (!pin){ q('tbAtt').innerHTML=''; q('aKpis').innerHTML=''; ATT=null; return; }
  var p = new URLSearchParams({pin:pin, from:q('aFrom').value, to:q('aTo').value});
  fetch('/api/attendance?' + p.toString()).then(function(r){return r.json();}).then(renderAtt);
}

function renderAtt(a){
  ATT = a;
  var t = a.totals;
  q('aKpis').innerHTML = '<div class="grid">'
    + kpi('Total days', t.totalDays) + kpi('Present', t.present, 'var(--ok)')
    + kpi('Absent', t.absent, t.absent ? 'var(--bad)' : '') + kpi('Sundays', t.sundays)
    + kpi('Total hours', hm(t.totalMin)) + kpi('Break', hm(t.breakMin), 'var(--warn)')
    + kpi('Effective hours', hm(t.effectiveMin), 'var(--ok)') + '</div>';

  var tb = '';
  for (var i = 0; i < a.days.length; i++){
    var d = a.days[i];
    var f = fmtStamp(d.date + ' 00:00');
    var col = d.status === 'Present' ? 'var(--ok)' : d.status === 'Absent' ? 'var(--bad)' : 'var(--dim)';
    var span = d.in && d.out ? fmtStamp(d.in).time + ' - ' + fmtStamp(d.out).time
             : d.in ? fmtStamp(d.in).time + ' - <span style="color:var(--warn)">no check-out</span>'
             : '<span style="color:#8b949e">Not marked</span>';
    tb += '<tr style="cursor:pointer" onclick="openDay(' + i + ')">'
       + '<td>' + esc(f.date) + '</td>'
       + '<td style="color:' + col + '">' + esc(d.status) + '</td>'
       + '<td class="mono">' + span + '</td>'
       + '<td>' + hm(d.totalMin) + '</td><td>' + hm(d.breakMin) + '</td>'
       + '<td><b>' + hm(d.effectiveMin) + '</b></td>'
       + '<td class="mono" style="color:#8b949e">' + d.punches + '</td></tr>';
  }
  q('tbAtt').innerHTML = tb;
  q('emptyAtt').style.display = a.days.length ? 'none' : 'block';
}
function kpi(k, v, col){
  return '<div class="card"><div class="k">' + k + '</div><div class="v"'
    + (col ? ' style="color:' + col + '"' : '') + '>' + v + '</div></div>';
}

var DOT = {'Check in':'var(--ok)','Check out':'var(--warn)','Break start':'var(--warn)',
           'Break end':'var(--ok)','Repeat punch':'#8b949e','Extra punch':'#8b949e'};
function openDay(i){
  var d = ATT.days[i];
  q('mTitle').textContent = ATT.name || ('PIN ' + ATT.pin);
  q('mDate').textContent = d.date + '  -  ' + hm(d.effectiveMin) + ' effective';
  if (!d.events.length){ q('mBody').innerHTML = '<div class="empty">No punches on this day.</div>'; }
  else {
    q('mBody').innerHTML = d.events.map(function(e){
      var dim = e.label === 'Repeat punch' || e.label === 'Extra punch';
      return '<div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #1c222b'
        + (dim ? ';opacity:.5' : '') + '">'
        + '<div style="width:9px;height:9px;border-radius:9px;margin-top:5px;flex:0 0 auto;background:'
        + (DOT[e.label] || '#8b949e') + '"></div><div>'
        + '<div><b>' + esc(e.label) + '</b></div>'
        + '<div class="hint">' + esc(fmtStamp(e.time).time) + ' &middot; '
        + esc(LAB.verify[e.verify] || ('mode ' + e.verify)) + ' &middot; gate ' + esc(e.sn) + '</div>'
        + '</div></div>';
    }).join('');
  }
  q('modal').style.display = 'block';
}
function closeModal(e){ if (!e || e.target === q('modal')) q('modal').style.display = 'none'; }
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeModal(); });

function attCsv(){
  if (!ATT) return;
  var rows = [['Date','Status','Check in','Check out','Total','Break','Effective','Punches']];
  ATT.days.forEach(function(d){
    rows.push([d.date, d.status, fmtStamp(d.in).time, fmtStamp(d.out).time,
               hm(d.totalMin), hm(d.breakMin), hm(d.effectiveMin), d.punches]);
  });
  var csv = rows.map(function(r){ return r.join(','); }).join(String.fromCharCode(10));
  var a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'attendance-' + (ATT.name || ATT.pin) + '.csv';
  a.click();
}

function exportCsv(){ window.location = '/api/export.csv?' + params().toString(); }

refresh();
setInterval(refresh, 3000);
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
  console.log('');
});
