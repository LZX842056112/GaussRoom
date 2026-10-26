// Read-only browser regression: a component check ending at gate refreshes evidence.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {createWorkbenchServer} from './server.mjs';
const server=createWorkbenchServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const require = createRequire(import.meta.url);
const cache = resolve(process.env.LOCALAPPDATA, 'npm-cache/_npx');
const moduleDir = readdirSync(cache).map(name => resolve(cache, name, 'node_modules/playwright')).find(existsSync);
const { chromium } = require(moduleDir);
const browsers = resolve(process.env.LOCALAPPDATA, 'ms-playwright');
const version = readdirSync(browsers).filter(name => /^chromium-\d+$/.test(name)).sort((a,b) => Number(b.split('-')[1])-Number(a.split('-')[1]))[0];
const browser = await chromium.launch({ headless: true, executablePath: resolve(browsers, version, 'chrome-win64/chrome.exe') });
try {
  const page = await browser.newPage();
  const project = { id: 'quality-ui', name: '独立区域', state: 'partial', progress: 0.5,
    sourceDir: 'fixture', cameraModel: 'SIMPLE_RADIAL', useGpu: true, mapper: 'global', trainingPreset: 'full', scene: null,
    steps: ['prepare','features','match','sparse','gate','undistort','train'].map((id,index) => ({ id, name: id, progress: index<5?1:0, status: index<5?'success':'pending' })) };
  let summaries = 0;
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() { this.listeners = {}; window.__qualityES = this; }
      addEventListener(name, callback) { this.listeners[name] = callback; }
      close() {}
    };
  });
  await page.route('**/api/projects', route => route.fulfill({ json: [project] }));
  await page.route('**/api/projects/quality-ui', route => route.fulfill({ json: project }));
  await page.route('**/api/projects/quality-ui/summary', route => {
    summaries += 1;
    return route.fulfill({ json: { gate: summaries === 1 ? null : { verdict: 'pass', message: '检查通过',
      geometryValidationVersion: 1, models: [{ name: '0', registered: 3, registration_ratio: 1, points: 6000,
        geometryComponents: [{ index: 0, registered: 3, images: ['a.jpg','b.jpg','c.jpg'] }] }] } } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.__qualityES?.listeners?.state);
  while (!summaries) await new Promise(resolve => setTimeout(resolve, 20));
  await page.evaluate(project => window.__qualityES.listeners.state({ data: JSON.stringify(project) }), project);
  await page.waitForFunction(() => document.querySelector('#evidence')?.textContent.includes('最终几何分量'), null, { timeout: 3000 });
  assert.ok(summaries >= 2);
  console.log('PASS: partial state after component gate refreshes evidence');
} finally { await browser.close();await new Promise(r=>server.close(r)); }
