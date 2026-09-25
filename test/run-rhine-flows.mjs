import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const flows = ['manual-search', 'source-selection', 'interaction-flow', 'evidence-inbox', 'investigation', 'scene-navigation', 'evidence-editor', 'investigation-editing'];
for (const flow of flows) {
  console.log(`\n[Rhine] ${flow}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`test/${flow}-browser.mjs`], { cwd: root, stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  if (code !== 0) { process.exitCode = code; break; }
}
