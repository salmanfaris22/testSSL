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

const PORT = 8000 + (process.pid % 900);
const child = spawn(process.execPath, [require.resolve('./server.js')], {
  env: Object.assign({}, process.env, { PORT: String(PORT) }),
  stdio: 'ignore',
});

const get = (path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve(body));
  }).on('error', reject);
});

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
  } catch (e) {
    console.error('  ' + e.message);
    failed++;
  }
  child.kill();
  process.exit(failed ? 1 : 0);
})();
