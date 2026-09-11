#!/usr/bin/env node
/**
 * Boots the server on a scratch port and syntax-checks the HTML pages it
 * actually serves.
 *
 * The pages live in template literals, so an escape that is correct in the
 * source can still be wrong once rendered: a "\n" inside the template becomes
 * a real newline in the served page and breaks the inline script. That kills
 * the whole dashboard silently - every panel still draws, nothing ever loads -
 * and `node --check server.js` cannot see it. This can.
 */
'use strict';
const http = require('http');
const vm = require('vm');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8000 + (process.pid % 900);
const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aiface-mars-check-'));
fs.cpSync(path.join(__dirname, 'data'), TEST_DATA, { recursive: true });
const child = spawn(process.execPath, [require.resolve('./server.js')], {
  env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: TEST_DATA }),
  stdio: 'ignore',
});

const get = (path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve(body));
  }).on('error', reject);
});

const api = (method, route, body) => new Promise((resolve, reject) => {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: PORT, path: route, method,
    headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
  (res) => {
    let text = '';
    res.on('data', (c) => { text += c; });
    res.on('end', () => {
      try { resolve({ code: res.statusCode, body: JSON.parse(text) }); }
      catch (e) { reject(new Error(route + ' returned invalid JSON: ' + text.slice(0, 160))); }
    });
  });
  req.on('error', reject);
  req.end(payload);
});

function webhookReceiver() {
  let resolveDelivery;
  const delivered = new Promise((resolve) => { resolveDelivery = resolve; });
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      try { resolveDelivery(JSON.parse(text)); } catch (e) { resolveDelivery({ parseError: e.message }); }
      res.writeHead(204); res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, delivered, url: 'http://127.0.0.1:' + server.address().port + '/attendance-webhook/receive',
  })));
}

async function waitForServer(deadline) {
  for (;;) {
    try { await get('/health'); return; } catch (e) {
      if (Date.now() > deadline) throw new Error('server did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

(async () => {
  let failed = 0;
  let receivers = [];
  try {
    await waitForServer(Date.now() + 10000);
    for (const path of ['/', '/opendoor']) {
      const html = await get(path);
      const scripts = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
      if (!scripts.length) { console.error('  ' + path + ': no inline script found'); failed++; continue; }
      let bad = false;
      scripts.forEach((block, i) => {
        const src = block.replace(/^<script>/, '').replace(/<\/script>$/, '');
        try {
          new vm.Script(src, { filename: path + ' script#' + i });
        } catch (e) {
          bad = true;
          console.error('  ' + path + ' script#' + i + ': ' + e.message);
        }
      });
      if (bad) failed++; else console.log('  ' + path + ': served script parses (' + html.length + ' bytes)');
    }
    receivers = await Promise.all([webhookReceiver(), webhookReceiver()]);
    const made = await Promise.all(receivers.map((receiver, i) => api('POST', '/api/hooks', {
      name: i ? 'Academy contract check' : 'HR contract check', url: receiver.url,
      from: i ? '2' : '1', to: i ? '2' : '1',
    })));
    if (made.some((row) => !row.body.ok)) throw new Error('could not create test webhooks');
    await Promise.all(made.map((row) => api('POST', '/api/hooks/test', { id: row.body.hook.id })));
    const deliveries = await Promise.all(receivers.map((receiver) => Promise.race([
      receiver.delivered, new Promise((_, reject) => setTimeout(() => reject(new Error('webhook was not delivered')), 5000)),
    ])));
    for (const delivery of deliveries) {
      const steps = delivery && delivery.data && delivery.data.attendance && delivery.data.attendance.steps;
      const labels = (steps || []).map((s) => s.step).join('|');
      if (delivery.event !== 'attendance.test' || delivery.data.contract !== 'attendance-day/v1'
        || labels !== 'Check in|Break start|Break end|Check out'
        || steps[1].taps_label !== '2 taps, first 11:31 AM') {
        throw new Error('webhook attendance contract is incomplete');
      }
    }
    console.log('  webhooks: HR and Academy both received the labelled attendance timeline');
  } catch (e) {
    console.error('  ' + e.message);
    failed++;
  }
  receivers.forEach((receiver) => receiver.server.close());
  child.kill();
  fs.rmSync(TEST_DATA, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
