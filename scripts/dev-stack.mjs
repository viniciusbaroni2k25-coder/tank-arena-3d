import { spawn } from 'node:child_process';

const children = [];
let stopping = false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function start(label, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, ...extraEnv },
    detached: process.platform !== 'win32', shell: false
  });
  child.label = label;
  children.push(child);
  child.on('error', error => { console.error(`[${label}] ${error.message}`); stop(1); });
  child.on('exit', code => {
    if (!stopping) {
      console.error(`[${label}] encerrou com código ${code ?? 'desconhecido'}.`);
      stop(code || 1);
    }
  });
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch { /* process already exited */ }
  }
  if (code !== 0) process.exitCode = code;
}

async function waitForService(child, url) {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (stopping || child.exitCode !== null) throw new Error(`${child.label} não iniciou.`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* still booting */ }
    await wait(1000);
  }
  throw new Error(`${child.label} excedeu o tempo para iniciar em ${url}.`);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

try {
  const build = spawn('npm', ['run', 'build'], { cwd: process.cwd(), stdio: 'inherit', shell: false });
  const buildExit = await new Promise(resolve => build.on('exit', resolve));
  if (buildExit !== 0) throw new Error('O build falhou; os servidores locais não foram iniciados.');

  const node22 = script => ['--yes', '--package=node@22', '-c', `node ./node_modules/wrangler/bin/wrangler.js ${script}`];
  const worker = start('Worker local', 'npx', node22('dev --config cloudflare/wrangler.jsonc --local --port 8787'));
  await waitForService(worker, 'http://127.0.0.1:8787/');
  const pages = start('Pages e Durable Object', 'npx', node22('pages dev dist --do LOBBY=GameLobby@tank-arena-lobby --port 8788'));
  await waitForService(pages, 'http://127.0.0.1:8788/');
  const vite = start('Interface', process.execPath, ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0'], { TANK_ARENA_WRANGLER_DEV: '1' });
  await waitForService(vite, 'http://127.0.0.1:5173/');
  console.log('\nTank Arena pronto em http://localhost:5173');
  console.log('Conta, lobby e Durable Object locais estão conectados. Ctrl+C encerra tudo.\n');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  stop(1);
}
