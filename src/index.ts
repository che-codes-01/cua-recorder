#!/usr/bin/env node
// ─── cua-record ─────────────────────────────────────────────────────────────
//
// Usage:  npx cua-record [--out workflow.json] [--name "My workflow"] [--port 7842]
//
// Opens a browser-based recorder UI (like Playwright's codegen).
// The Python backend streams events via Server-Sent Events.
//
import http                            from 'http';
import fs                              from 'fs';
import path                            from 'path';
import crypto                          from 'crypto';
import { spawn, ChildProcess }         from 'child_process';
import { createInterface }             from 'readline';
import { execSync }                    from 'child_process';
import open                            from 'open';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const outArg   = args.indexOf('--out');
const nameArg  = args.indexOf('--name');
const portArg  = args.indexOf('--port');
const outFile  = outArg  !== -1 ? args[outArg  + 1] : null;
const wfName   = nameArg !== -1 ? args[nameArg + 1] : 'Recorded Workflow';
const PORT     = portArg !== -1 ? parseInt(args[portArg + 1], 10) : 7842;

// ── Types ─────────────────────────────────────────────────────────────────────

type ActionNode = {
  id:       string;
  type:     string;
  name:     string;
  position: { x: number; y: number };
  params:   Record<string, unknown>;
};

type WFEdge = { id: string; from: string; to: string };

// ── State ─────────────────────────────────────────────────────────────────────

let actions:   Record<string, unknown>[] = [];
let recording  = false;

// ── SSE clients ───────────────────────────────────────────────────────────────

const sseClients = new Set<http.ServerResponse>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ── Python process ────────────────────────────────────────────────────────────

const scriptPath = path.resolve(__dirname, '..', 'scripts', 'cua_recorder.py');
let   pyProc: ChildProcess | null = null;

function sendCmd(cmd: string): void {
  if (pyProc?.stdin) {
    pyProc.stdin.write(JSON.stringify({ cmd }) + '\n');
  }
}

// ── Humanise type → default node name ────────────────────────────────────────

function humanise(type: string): string {
  return type.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// ── Build workflow JSON ───────────────────────────────────────────────────────

function buildWorkflow(): object {
  const NODE_W = 240;
  const nodes: ActionNode[] = [];
  const edges: WFEdge[]     = [];

  const triggerId = crypto.randomUUID();
  nodes.push({
    id:       triggerId,
    type:     'webhook_trigger',
    name:     'Webhook Trigger',
    position: { x: 80, y: 180 },
    params:   {},
  });

  let prevId = triggerId;
  actions.forEach((action, i) => {
    const type   = action.type as string;
    const { type: _t, ...params } = action;
    const id     = crypto.randomUUID();
    const x      = 80 + (i + 1) * (NODE_W + 50);
    nodes.push({
      id,
      type,
      name:     humanise(type),
      position: { x, y: 180 },
      params:   params as Record<string, unknown>,
    });
    edges.push({ id: crypto.randomUUID(), from: prevId, to: id });
    prevId = id;
  });

  return {
    __cua_workflow__: true,
    name:  wfName,
    nodes: { nodes, edges },
  };
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const uiPath = path.resolve(__dirname, 'ui.html');

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';

  // ── GET / → serve UI ──────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(uiPath, 'utf-8'));
    return;
  }

  // ── GET /events → SSE stream ──────────────────────────────────────────────
  if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n');
    // Send current state immediately
    res.write(`event: init\ndata: ${JSON.stringify({ actions, recording, wfName })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ── POST /control { cmd: "start"|"stop"|"clear" } ─────────────────────────
  if (req.method === 'POST' && url === '/control') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      try {
        const { cmd } = JSON.parse(body) as { cmd: string };
        if (cmd === 'start') {
          actions   = [];
          recording = true;
          sendCmd('start');
          broadcast('status', { recording: true, actions: [] });
        } else if (cmd === 'stop') {
          recording = false;
          sendCmd('stop');
          broadcast('status', { recording: false, actions });
        } else if (cmd === 'clear') {
          actions   = [];
          recording = false;
          sendCmd('stop');
          broadcast('status', { recording: false, actions: [] });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400); res.end('bad request');
      }
    });
    return;
  }

  // ── POST /save → write file, return JSON ─────────────────────────────────
  if (req.method === 'POST' && url === '/save') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      try {
        const wf   = buildWorkflow();
        const dest = outFile ?? `workflow-${Date.now()}.json`;
        fs.writeFileSync(dest, JSON.stringify(wf, null, 2), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, file: path.resolve(dest), workflow: wf }));
      } catch (e) {
        res.writeHead(500); res.end(String(e));
      }
    });
    return;
  }

  // ── GET /workflow → return current workflow JSON ──────────────────────────
  if (req.method === 'GET' && url === '/workflow') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildWorkflow(), null, 2));
    return;
  }

  res.writeHead(404); res.end('not found');
});

// ── Spawn Python recorder ─────────────────────────────────────────────────────

function spawnRecorder(): void {
  pyProc = spawn('python3', [scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env:   process.env,
  });

  const rl = createInterface({ input: pyProc.stdout! });

  rl.on('line', (raw) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw) as Record<string, unknown>; }
    catch { return; }

    if (msg.ready) {
      broadcast('ready', {});
      return;
    }
    if (msg.error) {
      broadcast('error', { message: msg.error });
      return;
    }
    if (msg.text_tick) return;
    if (msg.status) {
      broadcast('status', { recording: msg.status === 'recording', actions });
      return;
    }
    if (msg.event) {
      const action = msg.event as Record<string, unknown>;
      actions.push(action);
      broadcast('action', { action, index: actions.length - 1, total: actions.length });
      broadcast('status', { recording, actions });
    }
  });

  pyProc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) broadcast('log', { text });
  });

  pyProc.on('close', (code) => {
    if (code !== 0) broadcast('error', { message: `Recorder process exited (code ${code})` });
  });

  pyProc.on('error', (err) => {
    broadcast('error', { message: `Failed to start recorder: ${err.message}. Make sure python3 and pynput are installed.` });
  });
}

// ── Check / install pynput ────────────────────────────────────────────────────

function checkDeps(): boolean {
  try { execSync('python3 -c "import pynput"', { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

if (!checkDeps()) {
  console.log('Installing pynput…');
  try { execSync('pip3 install pynput --break-system-packages', { stdio: 'inherit' }); }
  catch { console.error('Failed to install pynput. Run: pip3 install pynput'); }
}

spawnRecorder();

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n  cua-record  →  ${url}\n`);
  open(url).catch(() => {
    console.log(`  Open your browser at ${url}`);
  });
});

process.on('SIGINT',  () => { sendCmd('stop'); if (pyProc) pyProc.kill(); process.exit(0); });
process.on('SIGTERM', () => { sendCmd('stop'); if (pyProc) pyProc.kill(); process.exit(0); });
