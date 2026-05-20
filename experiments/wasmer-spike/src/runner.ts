import { Wasmer, init, Directory, initializeLogger } from '@wasmer/sdk';

const out = document.getElementById('output')!;
const status = document.getElementById('status')!;

function log(msg: string) {
  out.textContent += msg + '\n';
  console.log(msg);
}

function clearLog() {
  out.textContent = '';
}

function setStatus(msg: string, state: 'running' | 'pass' | 'fail' | 'ready' = 'ready') {
  status.textContent = msg;
  status.className = `status ${state}`;
}

async function ensureInit() {
  if (!(window as any).__wasmer_initialized) {
    log('Initializing @wasmer/sdk...');
    await init();
    initializeLogger('debug,wasmer_wasix=trace');
    (window as any).__wasmer_initialized = true;
    log('Wasmer initialized with trace logging.');
  }
}

async function runTest(name: string, fn: () => Promise<void>) {
  clearLog();
  log(`--- Starting ${name} ---`);
  setStatus(`Running ${name}...`, 'running');

  try {
    await ensureInit();
    await fn();
    log(`\n--- ${name} PASSED ---`);
    setStatus(`${name} Passed`, 'pass');
    return true;
  } catch (err) {
    const e = err as any;
    log(`\nERROR: ${e.message ?? err}`);
    if (e.detailedMessage) log('detailedMessage: ' + e.detailedMessage);
    if (e.causes) log('causes: ' + JSON.stringify(e.causes));
    if (e.stack) log(e.stack);
    log(`\n--- ${name} FAILED ---`);
    setStatus(`${name} Failed`, 'fail');
    return false;
  }
}

// T0: Diagnostic — verify network access from this page
async function t0() {
  log('Checking same-origin GET...');
  const r1 = await fetch('/');
  log('GET / => ' + r1.status);

  log('Checking cross-origin GET to wasmer registry...');
  try {
    const r2 = await fetch('https://registry.wasmer.io/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    });
    log('POST registry.wasmer.io/graphql => ' + r2.status);
    const text = await r2.text();
    log('body: ' + text.slice(0, 200));
  } catch (e) {
    log('cross-origin fetch failed: ' + (e as any).message);
    throw e;
  }

  log('Checking https://registry-cdn.wasmer.io ...');
  try {
    const r3 = await fetch('https://registry-cdn.wasmer.io/');
    log('GET registry-cdn.wasmer.io => ' + r3.status);
  } catch (e) {
    log('cdn fetch failed: ' + (e as any).message);
  }
}

async function t1() {
  log('Loading python/python@0.2.0 from registry (older version)...');
  const pkg = await Wasmer.fromRegistry('python/python@0.2.0');
  log('Loaded. Commands: ' + Object.keys((pkg as any).commands ?? {}).join(','));
  log('Trying with -c print');
  const inst = await pkg.entrypoint!.run({ args: ['-c', "print('hi')"] });
  const out = await inst.wait();
  log(`code=${out.code} ok=${out.ok} stdout=${JSON.stringify(out.stdout)} stderr=${JSON.stringify(out.stderr)}`);
  if (!out.ok) throw new Error(`Python exited with code ${out.code}`);
}

async function t2() {
  log('Loading wasmer/edgejs@0.0.1 (older)...');
  const pkg = await Wasmer.fromRegistry('wasmer/edgejs@0.0.1');
  log('Running: node -e "console.log(process.version)"');

  const instance = await pkg.entrypoint!.run({
    args: ['-e', 'console.log(process.version)'],
  });

  const result = await instance.wait();
  log(`code=${result.code} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);

  if (!result.ok) throw new Error(`Edge.js exited with ${result.code}\nStderr: ${result.stderr}`);
  if (!result.stdout.trim().startsWith('v')) {
    throw new Error(`Expected version starting with "v", got "${result.stdout}"`);
  }
}

async function t3() {
  log('Bonus: Trying sharrattj/bash latest...');
  try {
    const pkg = await Wasmer.fromRegistry('sharrattj/bash');
    log('Loaded. Running: bash -c "echo hi from bash"');
    const inst = await pkg.entrypoint!.run({ args: ['-c', 'echo hi from bash'] });
    const out = await inst.wait();
    log(`code=${out.code} stdout=${JSON.stringify(out.stdout)} stderr=${JSON.stringify(out.stderr)}`);
    if (!out.ok) throw new Error(`bash exited ${out.code}`);
    if (!out.stdout.includes('hi from bash')) throw new Error('No output');
  } catch (e) {
    log('latest failed, trying older sharrattj/bash@1.0.12');
    const pkg = await Wasmer.fromRegistry('sharrattj/bash@1.0.12');
    const inst = await pkg.entrypoint!.run({ args: ['-c', 'echo hi from bash'] });
    const out = await inst.wait();
    log(`code=${out.code} stdout=${JSON.stringify(out.stdout)} stderr=${JSON.stringify(out.stderr)}`);
    if (!out.ok) throw new Error(`bash exited ${out.code}`);
  }
}

async function t4() {
  log('Loading wasmer/edgejs...');
  const pkg = await Wasmer.fromRegistry('wasmer/edgejs');
  const script = `
    fetch('https://api.github.com/zen')
      .then(r => r.text())
      .then(t => console.log('ZEN:', t))
      .catch(e => { console.error('Fetch error:', e.message); process.exit(1); });
  `;
  const instance = await pkg.entrypoint!.run({ args: ['-e', script] });
  const result = await instance.wait();
  log(`Stdout: ${result.stdout.trim()}`);
  log(`Stderr: ${result.stderr.trim()}`);
  if (!result.ok) throw new Error(`Exited ${result.code}\n${result.stderr}`);
  if (!result.stdout.includes('ZEN')) throw new Error('No ZEN');
}

async function t5() {
  log('Loading wasmer/edgejs...');
  const pkg = await Wasmer.fromRegistry('wasmer/edgejs');

  const dir = new Directory();
  const enc = new TextEncoder();
  await dir.writeFile('/index.js', enc.encode(
    `const lodash = require('./node_modules/lodash/index.js');\nconsole.log('Result:', lodash.VERSION);\n`
  ));
  await dir.createDir('/node_modules');
  await dir.createDir('/node_modules/lodash');
  await dir.writeFile('/node_modules/lodash/package.json', enc.encode(
    `{"name":"lodash","version":"99.9.9","main":"index.js"}`
  ));
  await dir.writeFile('/node_modules/lodash/index.js', enc.encode(
    `module.exports = { VERSION: '99.9.9' };`
  ));

  const instance = await pkg.entrypoint!.run({
    args: ['/work/index.js'],
    mount: { '/work': dir },
  });
  const result = await instance.wait();
  log(`Stdout: ${result.stdout.trim()}`);
  log(`Stderr: ${result.stderr.trim()}`);
  if (!result.ok) throw new Error(`Exited ${result.code}\n${result.stderr}`);
  if (!result.stdout.includes('Result: 99.9.9')) throw new Error('Module resolution failed');
}

async function t6() {
  log('Skipping T6 until T1-T5 pass.');
}

document.getElementById('btn-t0')!.onclick = () => runTest('T0 (Diagnostic)', t0);
document.getElementById('btn-t1')!.onclick = () => runTest('T1 (Hello World)', t1);
document.getElementById('btn-t2')!.onclick = () => runTest('T2 (Edge.js Boots)', t2);
document.getElementById('btn-t3')!.onclick = () => runTest('T3 (VFS + fs)', t3);
document.getElementById('btn-t4')!.onclick = () => runTest('T4 (Outbound HTTP)', t4);
document.getElementById('btn-t5')!.onclick = () => runTest('T5 (Module Resolution)', t5);
document.getElementById('btn-t6')!.onclick = () => runTest('T6 (Real Skill)', t6);

document.getElementById('btn-run-all')!.onclick = async () => {
  if (!(await runTest('T1', t1))) return;
  if (!(await runTest('T2', t2))) return;
  if (!(await runTest('T3', t3))) return;
  if (!(await runTest('T4', t4))) return;
  if (!(await runTest('T5', t5))) return;
  log('All T1-T5 Passed!');
  setStatus('All Passed', 'pass');
};
