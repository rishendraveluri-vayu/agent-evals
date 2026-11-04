// Measures each page for scripts/screenshots.sh: its full height (so the screenshot is the whole
// page), its scroll width (any sideways overflow shows up as more than the window width) and the
// header's height. Starts one headless Chrome with a debugging port, talks to it over the DevTools
// protocol, and stops exactly that process when done.
//
// Usage: node scripts/measure-pages.mjs <chrome> <profile-dir> <jobs.tsv> <out.tsv>
// jobs.tsv lines: name <TAB> width <TAB> url. out.tsv lines: name, width, height, scrollWidth, header.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [chrome, profile, jobsFile, outFile] = process.argv.slice(2);
if (!chrome || !profile || !jobsFile || !outFile) {
  console.error('usage: measure-pages.mjs <chrome> <profile-dir> <jobs.tsv> <out.tsv>');
  process.exit(2);
}
const jobs = readFileSync(jobsFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [name, width, url] = line.split('\t');
    return { name, width: Number(width), url };
  });

const browser = spawn(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], {
  stdio: ['ignore', 'ignore', 'pipe'],
});

const wsUrl = await new Promise((resolve, reject) => {
  let buffer = '';
  const timer = setTimeout(() => reject(new Error('Chrome did not start its debugging port')), 20000);
  browser.stderr.on('data', (chunk) => {
    buffer += String(chunk);
    const m = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
  browser.on('exit', () => reject(new Error('Chrome exited before it was ready')));
});

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const waiters = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  for (const w of [...waiters]) {
    if (w.method === msg.method && w.sessionId === msg.sessionId) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg.params);
    }
  }
});

function send(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function once(method, sessionId, ms = 15000) {
  return new Promise((resolve) => {
    const w = { method, sessionId, resolve };
    waiters.push(w);
    setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      resolve(null);
    }, ms);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rows = [];
try {
  for (const job of jobs) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: job.width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Emulation.setScrollbarsHidden', { hidden: true }, sessionId);
    const loaded = once('Page.loadEventFired', sessionId);
    await send('Page.navigate', { url: job.url }, sessionId);
    await loaded;
    // The fixtures (or the API's answers) load and the fonts swap in: give the page a moment to settle.
    await sleep(Number(process.env.SETTLE_MS) || 1500);
    const { result } = await send(
      'Runtime.evaluate',
      {
        expression:
          'JSON.stringify({ h: Math.ceil(document.documentElement.scrollHeight), w: document.documentElement.scrollWidth, header: Math.round(document.querySelector("header")?.getBoundingClientRect().height ?? 0) })',
        returnByValue: true,
      },
      sessionId,
    );
    const m = JSON.parse(result.value);
    rows.push([job.name, job.width, m.h, m.w, m.header].join('\t'));
    await send('Target.closeTarget', { targetId });
  }
} finally {
  ws.close();
  browser.kill('SIGTERM');
}
writeFileSync(outFile, `${rows.join('\n')}\n`);
