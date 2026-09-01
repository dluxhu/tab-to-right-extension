// node test.mjs            # CHROME=/path/to/chrome to use another build

// Drives the real extension in Chrome for Testing over CDP.
// Oracle is the extension's own service worker: chrome.tabs.query().
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXT = process.argv[2] || process.cwd();
const CHROME = process.env.CHROME || join(process.env.HOME, '.cache/puppeteer/chrome/mac_arm-150.0.7871.24/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const PORT = 9333;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const proc = spawn(CHROME, [
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cft-'))}`,
  `--remote-debugging-port=${PORT}`,
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
  '--no-first-run', '--no-default-browser-check', '--headless=new',
  'about:blank',
], { stdio: 'ignore' });

let ws, nextId = 1;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      ws.onmessage = e => {
        const m = JSON.parse(e.data);
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      };
      return;
    } catch { await sleep(250); }
  }
  throw new Error('chrome never came up');
}

// Attach to the extension service worker and run code inside it.
let swSession;
async function attachSW() {
  for (let i = 0; i < 80; i++) {
    const { targetInfos } = await send('Target.getTargets');
    const sw = targetInfos.find(t => t.type === 'service_worker' && t.url.includes('background.js'));
    if (sw) {
      swSession = (await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
      return;
    }
    await sleep(250);
  }
  throw new Error('service worker never appeared');
}
async function inSW(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
  }, swSession);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
const strip = () => inSW(`
  const ts = await chrome.tabs.query({});
  return ts.sort((a,b)=>a.index-b.index)
    .map(t => \`\${t.index}:\${t.id}\${t.pinned?'P':''}\${t.groupId!==-1?'G'+t.groupId:''}\${t.active?'*':''}\`);
`);

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '\n      ' + detail}`);
  if (!cond) failures++;
}

await connect();
await attachSW();
console.log('waiting out the startup hush...');
await sleep(9000);

// Base layout: 5 plain tabs, activate the middle one.
const base = await inSW(`
  const ids = [];
  for (const i of [1,2,3,4]) { const t = await chrome.tabs.create({ url:'about:blank', active:false }); ids.push(t.id); await new Promise(r=>setTimeout(r,900)); }
  return ids;
`);
await sleep(1500);
await inSW(`await chrome.tabs.update(${base[0]}, { pinned: true });`);
const mid = base[1];
await inSW(`await chrome.tabs.update(${mid}, { active: true });`);
await sleep(500);
console.log('base:', (await strip()).join(' '), 'active =', mid);

// 1. A single new tab still lands right of the active tab.
await inSW(`await chrome.tabs.create({ url:'about:blank' });`);
await sleep(800);
let s = await strip();
const activeIdx = s.findIndex(x => x.includes(`:${mid}`));
check('single new tab moves next to active tab', s[activeIdx + 1].endsWith('*'), s.join(' '));

await sleep(1200);
// 2. A burst (session restore / open-all-bookmarks) is left alone.
const before = await strip();
const burst = await inSW(`
  const ids = [];
  for (const i of [1,2,3,4]) ids.push((await chrome.tabs.create({ url:'about:blank', active:false })).id);
  return ids;
`);
await sleep(1200);
s = await strip();
const tail = s.slice(-4).map(x => Number(x.split(':')[1].replace(/\D.*/, '')));
check('burst of 4 stays appended in order', JSON.stringify(tail) === JSON.stringify(burst),
      `before: ${before.join(' ')}\n      after:  ${s.join(' ')}\n      expected tail ${burst}, got ${tail}`);

await sleep(1200);
// 3. A tab Chrome groups on its own, mid-strip: one member of a saved group
//    opening. Must keep both its index and its own group.
const gBefore = await strip();
const gIdx = 2;
const g = await inSW(`
  const t = await chrome.tabs.create({ url:'about:blank', active:false, index:${gIdx} });
  const gid = await chrome.tabs.group({ tabIds: [t.id] });
  return { id: t.id, gid };
`);
await sleep(1200);
s = await strip();
check('Chrome-grouped tab keeps its slot and its group', s[gIdx] === `${gIdx}:${g.id}G${g.gid}`,
      `before: ${gBefore.join(' ')}\n      after:  ${s.join(' ')}\n      expected ${gIdx}:${g.id}G${g.gid} at ${gIdx}`);

await sleep(1200);
// 4. A pinned tab is never reshuffled.
const pBefore = await strip();
const p = await inSW(`return (await chrome.tabs.create({ url:'about:blank', active:false, pinned:true, index:0 })).id;`);
await sleep(1200);
s = await strip();
check('pinned tab stays where it was pinned', s[0] === `0:${p}P`,
      `before: ${pBefore.join(' ')}\n      after:  ${s.join(' ')}`);

proc.kill();
console.log(failures ? `\n${failures} failing` : '\nall green');
process.exit(failures ? 1 : 0);
