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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXT = process.argv[2] || process.cwd();
const CHROME = process.env.CHROME || join(process.env.HOME, '.cache/puppeteer/chrome/mac_arm-150.0.7871.24/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Slot of a tab in a strip line-up, matched on the whole id: the entries look
// like `index:id[P][Gn][*]`, so a prefix match would confuse 12 with 120.
const slotOf = (strip, id) => strip.findIndex(x => Number(x.match(/^\d+:(\d+)/)[1]) === id);

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '\n      ' + detail}`);
  if (!cond) failures++;
}

async function withChrome(extDir, fn, { headless = true, prefs, features } = {}) {
  const port = 9000 + Math.floor(Math.random() * 1000);
  const udd = mkdtempSync(join(tmpdir(), 'cft-'));
  if (prefs) {
    mkdirSync(join(udd, 'Default'), { recursive: true });
    writeFileSync(join(udd, 'Default', 'Preferences'), JSON.stringify(prefs));
  }
  const proc = spawn(CHROME, [
    `--user-data-dir=${udd}`,
    `--remote-debugging-port=${port}`,
    `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1200,900',
    ...(features ? [`--enable-features=${features}`] : []),
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ], { stdio: 'ignore' });

  let ws, nextId = 1, swSession;
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
        // A crashed or killed browser must not leave callers awaiting forever.
        const abort = why => {
          const err = new Error(`CDP connection ${why}`);
          for (const { rej } of pending.values()) rej(err);
          pending.clear();
        };
        ws.onclose = () => abort('closed');
        ws.onerror = () => abort('errored');
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

    // Viewport width of a normal tab: a vertical tab strip eats into it, which is
    // how the vertical phase proves the strip really switched.
    const pageWidth = async () => {
      const { targetInfos } = await send('Target.getTargets');
      const pages = targetInfos.filter(t => t.type === 'page');
      // -1 fails the check that uses this; throwing here would take the summary with it.
      if (pages.length !== 1) {
        console.log(`  (cannot measure: expected exactly one page, saw ${pages.length})`);
        return -1;
      }
      const sid = (await send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true })).sessionId;
      const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true }, sid);
      return r.result?.value ?? -1;
    };

    console.log('waiting out the startup hush...');
    await sleep(9000);
    await fn({ inSW, strip, pageWidth });
  } finally {
    proc.kill();
    await Promise.race([
      new Promise(r => proc.once('exit', r)),
      sleep(5000),
    ]);
    rmSync(udd, { recursive: true, force: true });
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

async function coreChecks({ inSW, strip }, tag = '') {
  const mid = await layout({ inSW, strip });
  let s;

  // 1. A single new tab still lands right of the active tab.
  await inSW(`await chrome.tabs.create({ url:'about:blank' });`);
  await sleep(900);
  s = await strip();
  const at = slotOf(s, mid);
  check('single new tab moves next to active tab' + tag,
        at >= 0 && !!s[at + 1] && s[at + 1].endsWith('*'), s.join(' '));

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
  check('burst of 4 stays appended in order' + tag, JSON.stringify(tail) === JSON.stringify(burst),
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
  check('Chrome-grouped tab keeps its slot and its group' + tag, s[gIdx] === `${gIdx}:${g.id}G${g.gid}`,
        `after: ${s.join(' ')}\n      expected ${gIdx}:${g.id}G${g.gid} at ${gIdx}`);

  // 4. A pinned tab is never reshuffled.
  await sleep(1200);
  const pBefore = await strip();
  const p = await inSW(`return (await chrome.tabs.create({ url:'about:blank', active:false, pinned:true, index:0 })).id;`);
  await sleep(1400);
  s = await strip();
  check('pinned tab stays where it was pinned' + tag, s[0] === `0:${p}P`,
        `before: ${pBefore.join(' ')}\n      after:  ${s.join(' ')}`);

  // 5. Default placement leaves an opening two-tab group at the end, intact.
  await sleep(1200);
  await inSW(`await chrome.tabs.update(${mid}, { active: true });`);
  await sleep(500);
  const ga = await openGroup(inSW);
  await sleep(1800);
  s = await strip();
  check('two-tab group stays at the end, intact' + tag,
        s.slice(-2).join(' ') === `${s.length - 2}:${ga.ids[0]}G${ga.gid} ${s.length - 1}:${ga.ids[1]}G${ga.gid}`,
        `after: ${s.join(' ')}\n      expected tail ${ga.ids[0]}G${ga.gid} ${ga.ids[1]}G${ga.gid}`);
}

await withChrome(EXT, api => coreChecks(api));

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
  let s = await strip();
  const at = slotOf(s, mid);
  check('group moves next to the current tab as one piece',
        s[at + 1] === `${at + 1}:${gb.ids[0]}G${gb.gid}` && s[at + 2] === `${at + 2}:${gb.ids[1]}G${gb.gid}`,
        `after: ${s.join(' ')}\n      current tab ${mid} at ${at}, expected ${gb.ids[0]}G${gb.gid} then ${gb.ids[1]}G${gb.gid}`);

  // 7. Grouping tabs you already had is not a group opening, so even on 'right'
  //    the group must stay exactly where the user built it. Built at the END of
  //    the strip on purpose: that is where an opening group lands, so the
  //    end-of-strip guard can't carry this check — only the tab ages can.
  await sleep(1200);
  await inSW(`await chrome.tabs.update(${mid}, { active: true });`);
  await sleep(500);
  // A burst is left where Chrome puts it, which parks these three at the end.
  const parked = await inSW(`
    const ids = [];
    for (const i of [1,2,3]) ids.push((await chrome.tabs.create({ url:'about:blank', active:false })).id);
    return ids;
  `);
  await sleep(3000); // past NEW_TAB_MS, so these are no longer brand new
  const before = await strip();
  const [t1, t2] = parked.slice(-2);
  check('the tabs to group are at the end of the strip',
        slotOf(before, t2) === before.length - 1, before.join(' '));
  const gid = await inSW(`return await chrome.tabs.group({ tabIds: [${t1}, ${t2}] });`);
  await sleep(1800);
  s = await strip();
  check('a group built from existing tabs stays where it was',
        slotOf(s, t1) === slotOf(before, t1) && slotOf(s, t2) === slotOf(before, t2),
        `before: ${before.join(' ')}\n      after:  ${s.join(' ')}\n      group ${gid}`);

  // 8. A real group opening focuses one of its own tabs, and does so before the
  //    group event arrives, so the anchor has to be the tab the user was on
  //    *before* that. Tabs are created active:false everywhere else, which hid
  //    this entirely.
  await sleep(1200);
  await inSW(`await chrome.tabs.update(${mid}, { active: true });`);
  await sleep(600);
  const gf = await inSW(`
    const ids = [];
    for (const i of [1,2,3]) ids.push((await chrome.tabs.create({ url:'about:blank', active:false })).id);
    await chrome.tabs.update(ids[0], { active: true });
    const gid = await chrome.tabs.group({ tabIds: ids });
    return { ids, gid };
  `);
  await sleep(2200);
  s = await strip();
  const anchor = slotOf(s, mid);
  check('a group that steals focus still lands next to the tab you were on',
        anchor >= 0 && gf.ids.every((id, i) => slotOf(s, id) === anchor + 1 + i),
        `after: ${s.join(' ')}\n      tab you were on ${mid} at ${anchor}, group ${gf.ids}`);

  // 9. ...and the next new tab is still repositioned, rather than being written
  //    off as part of a group that is opening. It also must not be swallowed by
  //    the group it now lands in front of.
  await sleep(1200);
  await inSW(`await chrome.tabs.update(${mid}, { active: true });`);
  await sleep(600);
  const t3 = await inSW(`return (await chrome.tabs.create({ url:'about:blank' })).id;`);
  await sleep(1200);
  s = await strip();
  check('a new tab straight after grouping is still moved, and stays ungrouped',
        slotOf(s, t3) === slotOf(s, mid) + 1 && !s[slotOf(s, t3)].includes('G'),
        `after: ${s.join(' ')}\n      current tab ${mid} at ${slotOf(s, mid)}, new tab ${t3} at ${slotOf(s, t3)}`);

  // 10. Opening a group while sitting in the middle of another one: the new group
  //     goes after the whole of the current group, never nested inside it.
  await sleep(1200);
  const inner = await inSW(`
    const ids = [];
    for (const i of [1,2,3]) ids.push((await chrome.tabs.create({ url:'about:blank', active:false })).id);
    const gid = await chrome.tabs.group({ tabIds: ids });
    return { ids, gid };
  `);
  await sleep(2200);
  await inSW(`await chrome.tabs.update(${inner.ids[1]}, { active: true });`); // middle tab
  await sleep(600);
  const outer = await inSW(`
    const ids = [];
    for (const i of [1,2,3]) ids.push((await chrome.tabs.create({ url:'about:blank', active:false })).id);
    const gid = await chrome.tabs.group({ tabIds: ids });
    return { ids, gid };
  `);
  await sleep(2200);
  s = await strip();
  const innerEnd = Math.max(...inner.ids.map(id => slotOf(s, id)));
  const innerIntact = inner.ids.every((id, i) => slotOf(s, id) === slotOf(s, inner.ids[0]) + i
                                                && s[slotOf(s, id)].includes(`G${inner.gid}`));
  check('a group opened from inside a group lands after it, not in it',
        innerIntact && outer.ids.every((id, i) => slotOf(s, id) === innerEnd + 1 + i
                                                 && s[slotOf(s, id)].includes(`G${outer.gid}`)),
        `after: ${s.join(' ')}\n      current group ${inner.gid} ends at ${innerEnd}, new group ${outer.gid} = ${outer.ids}`);
});

// 7. The vertical tab strip. Headful only — headless draws no browser UI at all,
//    so the strip can't switch there. VERTICAL=1 node test.mjs to include it.
if (process.env.VERTICAL) {
  const VERT = { headless: false, features: 'VerticalTabs,VerticalTabsLaunch' };
  // Baseline: plain headful Chrome with the feature off entirely, so the strip is
  // certainly horizontal. Measured at the same point in startup as the run below.
  let flat = 0;
  await withChrome(EXT, async ({ pageWidth }) => { flat = await pageWidth(); }, { headless: false });

  await withChrome(EXT, async (api) => {
    const wide = await api.pageWidth();
    console.log(`viewport width: ${flat}px with the normal strip, ${wide}px with the vertical one`);
    const on = wide > 0 && flat - wide >= 30;
    check('vertical tab strip is actually on', on,
          `viewport is ${wide}px with the pref on vs ${flat}px without it; a side strip takes a bite out of the width, a collapsed one a small bite, none at all means the pref did not apply`);
    // Never report vertical passes that were measured against a horizontal strip.
    if (!on) return;
    await coreChecks(api, ' (vertical tab strip)');
  }, { ...VERT, prefs: { vertical_tabs: { enabled: true } } });
}

rmSync(alt, { recursive: true, force: true });

console.log(failures ? `\n${failures} failing` : '\nall green');
process.exit(failures ? 1 : 0);
