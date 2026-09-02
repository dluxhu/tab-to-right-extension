// node test.mjs            # CHROME=/path/to/chrome to use another build
//
// Drives the real extension in Chrome for Testing over CDP. The oracle is the
// extension's own service worker: chrome.tabs.query().
//
// Two launches. CDP evaluates against a service worker in an isolated world:
// chrome.tabs and chrome.tabGroups are there, but chrome.storage is not, the
// worker's own globals are not reachable, and a chrome-extension:// page can't
// be opened from it. So the group-placement setting is seeded by launching a
// second copy of the extension with its DEFAULTS patched.
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXT = process.argv[2] || process.cwd();
const CHROME = process.env.CHROME || join(process.env.HOME, '.cache/puppeteer/chrome/mac_arm-150.0.7871.24/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '\n      ' + detail}`);
  if (!cond) failures++;
}

async function withChrome(extDir, fn) {
  const port = 9000 + Math.floor(Math.random() * 1000);
  const proc = spawn(CHROME, [
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cft-'))}`,
    `--remote-debugging-port=${port}`,
    `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws, nextId = 1;
  const pending = new Map();
  const send = (method, params = {}, sessionId) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };

  try {
    for (let i = 0; ; i++) {
      try {
        const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = e => {
          const m = JSON.parse(e.data);
          const p = pending.get(m.id);
          if (!p) return;
          pending.delete(m.id);
          m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        };
        break;
      } catch (e) {
        if (i === 60) throw new Error('chrome never came up');
        await sleep(250);
      }
    }

    let swSession;
    for (let i = 0; ; i++) {
      const { targetInfos } = await send('Target.getTargets');
      const sw = targetInfos.find(t => t.type === 'service_worker' && t.url.includes('background.js'));
      if (sw) {
        swSession = (await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
        break;
      }
      if (i === 80) throw new Error('service worker never appeared');
      await sleep(250);
    }

    const inSW = async expr => {
      const r = await send('Runtime.evaluate', {
        expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
      }, swSession);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const strip = () => inSW(`
      const ts = await chrome.tabs.query({});
      return ts.sort((a,b)=>a.index-b.index)
        .map(t => \`\${t.index}:\${t.id}\${t.pinned?'P':''}\${t.groupId!==-1?'G'+t.groupId:''}\${t.active?'*':''}\`);
    `);

    console.log('waiting out the startup hush...');
    await sleep(9000);
    await fn({ inSW, strip });
  } finally {
    proc.kill();
  }
}

// Four plain tabs one at a time, one of them pinned, with a known active tab.
async function layout({ inSW, strip }) {
  const ids = await inSW(`
    const ids = [];
    for (const i of [1,2,3,4]) {
      ids.push((await chrome.tabs.create({ url:'about:blank', active:false })).id);
      await new Promise(r=>setTimeout(r,900));
    }
    return ids;
  `);
  await sleep(1500);
  await inSW(`await chrome.tabs.update(${ids[0]}, { pinned: true });`);
  const mid = ids[1];
  await inSW(`await chrome.tabs.update(${mid}, { active: true });`);
  await sleep(600);
  console.log('base:', (await strip()).join(' '), 'active =', mid);
  return mid;
}

// Two tabs appearing and then being grouped: what opening a saved tab group
// looks like from the outside, and small enough to slip under the burst guard.
const openGroup = inSW => inSW(`
  const a = await chrome.tabs.create({ url:'about:blank', active:false });
  const b = await chrome.tabs.create({ url:'about:blank', active:false });
  const gid = await chrome.tabs.group({ tabIds: [a.id, b.id] });
  return { ids: [a.id, b.id], gid };
`);

await withChrome(EXT, async ({ inSW, strip }) => {
  const mid = await layout({ inSW, strip });
  let s;

  // 1. A single new tab still lands right of the active tab.
  await inSW(`await chrome.tabs.create({ url:'about:blank' });`);
  await sleep(900);
  s = await strip();
  const at = s.findIndex(x => x.split(':')[1].startsWith(String(mid)));
  check('single new tab moves next to active tab', s[at + 1].endsWith('*'), s.join(' '));

  // 2. A burst (session restore, open-all-bookmarks) is left alone.
  await sleep(1200);
  const before = await strip();
  const burst = await inSW(`
    const ids = [];
    for (const i of [1,2,3,4]) ids.push((await chrome.tabs.create({ url:'about:blank', active:false })).id);
    return ids;
  `);
  await sleep(1400);
  s = await strip();
  const tail = s.slice(-4).map(x => Number(x.split(':')[1].replace(/\D.*/, '')));
  check('burst of 4 stays appended in order', JSON.stringify(tail) === JSON.stringify(burst),
        `before: ${before.join(' ')}\n      after:  ${s.join(' ')}\n      expected tail ${burst}, got ${tail}`);

  // 3. A tab Chrome groups on its own, mid-strip: one member of a group opening.
  await sleep(1200);
  const gIdx = 2;
  const g = await inSW(`
    const t = await chrome.tabs.create({ url:'about:blank', active:false, index:${gIdx} });
    const gid = await chrome.tabs.group({ tabIds: [t.id] });
    return { id: t.id, gid };
  `);
  await sleep(1400);
  s = await strip();
  check('Chrome-grouped tab keeps its slot and its group', s[gIdx] === `${gIdx}:${g.id}G${g.gid}`,
        `after: ${s.join(' ')}\n      expected ${gIdx}:${g.id}G${g.gid} at ${gIdx}`);

  // 4. A pinned tab is never reshuffled.
  await sleep(1200);
  const pBefore = await strip();
  const p = await inSW(`return (await chrome.tabs.create({ url:'about:blank', active:false, pinned:true, index:0 })).id;`);
  await sleep(1400);
  s = await strip();
  check('pinned tab stays where it was pinned', s[0] === `0:${p}P`,
        `before: ${pBefore.join(' ')}\n      after:  ${s.join(' ')}`);

  // 5. Default placement leaves an opening two-tab group at the end, intact.
  await sleep(1200);
  await inSW(`await chrome.tabs.update(${mid}, { active: true });`);
  await sleep(500);
  const ga = await openGroup(inSW);
  await sleep(1800);
  s = await strip();
  check('two-tab group stays at the end, intact',
        s.slice(-2).join(' ') === `${s.length - 2}:${ga.ids[0]}G${ga.gid} ${s.length - 1}:${ga.ids[1]}G${ga.gid}`,
        `after: ${s.join(' ')}\n      expected tail ${ga.ids[0]}G${ga.gid} ${ga.ids[1]}G${ga.gid}`);
});

// 6. With groupPlacement 'right', the whole group moves and stays a group.
const alt = mkdtempSync(join(tmpdir(), 'ext-right-'));
cpSync(EXT, alt, { recursive: true, filter: src => !/\/(\.git|dist|node_modules)$/.test(src) });
const bg = join(alt, 'background.js');
// Anchored on DEFAULTS: the phrase also appears in the comment above it.
const patched = readFileSync(bg, 'utf8')
  .replace(/(const DEFAULTS = \{[^}]*groupPlacement: ')end(')/, '$1right$2');
if (!/const DEFAULTS = \{[^}]*groupPlacement: 'right'/.test(patched)) {
  throw new Error('could not patch the default placement');
}
writeFileSync(bg, patched);

await withChrome(alt, async ({ inSW, strip }) => {
  const mid = await layout({ inSW, strip });
  await sleep(1000);
  const gb = await openGroup(inSW);
  await sleep(2000);
  const s = await strip();
  const at = s.findIndex(x => x.split(':')[1].startsWith(String(mid)));
  check('group moves next to the current tab as one piece',
        s[at + 1] === `${at + 1}:${gb.ids[0]}G${gb.gid}` && s[at + 2] === `${at + 2}:${gb.ids[1]}G${gb.gid}`,
        `after: ${s.join(' ')}\n      current tab ${mid} at ${at}, expected ${gb.ids[0]}G${gb.gid} then ${gb.ids[1]}G${gb.gid}`);
});

console.log(failures ? `\n${failures} failing` : '\nall green');
process.exit(failures ? 1 : 0);
