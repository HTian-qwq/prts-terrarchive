import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const rhineHost = resolve(process.env.PRTS_DSH_SOURCE_DIR || join(root, '../prts-terrarchive-portable/.build/dsh-electron'));
const candidates = [join(root, 'package.json'), join(rhineHost, 'package.json'), join(root, '../.tools/rhine-qa/package.json')];
let modulePath = process.env.PRTS_PLAYWRIGHT_MODULE && resolve(process.env.PRTS_PLAYWRIGHT_MODULE);
for (const candidate of candidates) {
  if (modulePath) break;
  try { modulePath = createRequire(candidate).resolve('playwright'); } catch {}
}
if (!modulePath) throw new Error('Install Playwright or set PRTS_PLAYWRIGHT_MODULE to its entry file.');
const playwright = await import(pathToFileURL(modulePath).href);
export const chromium = playwright.chromium || playwright.default?.chromium;
if (!chromium) throw new Error('PRTS_PLAYWRIGHT_MODULE must point to a Playwright entry exporting chromium.');
export const rhineBrowserOptions = {
  ...(process.env.PRTS_BROWSER_EXECUTABLE ? { executablePath: process.env.PRTS_BROWSER_EXECUTABLE }
    : process.env.PRTS_BROWSER_CHANNEL ? { channel: process.env.PRTS_BROWSER_CHANNEL }
    : process.platform === 'win32' ? { channel: 'msedge' } : {}),
  headless: true,
  args: ['--enable-unsafe-swiftshader'],
};
