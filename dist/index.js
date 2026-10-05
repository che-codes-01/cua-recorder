#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// ─── cua-record ─────────────────────────────────────────────────────────────
//
// Usage:  npx cua-record [--out workflow.json] [--name "My workflow"] [--port 7842]
//
// Opens a browser-based recorder UI (like Playwright's codegen).
// The Python backend streams events via Server-Sent Events.
//
const http_1 = __importDefault(require("http"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const child_process_1 = require("child_process");
const readline_1 = require("readline");
const child_process_2 = require("child_process");
const open_1 = __importDefault(require("open"));
// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const nameArg = args.indexOf('--name');
const portArg = args.indexOf('--port');
const outFile = outArg !== -1 ? args[outArg + 1] : null;
const wfName = nameArg !== -1 ? args[nameArg + 1] : 'Recorded Workflow';
const PORT = portArg !== -1 ? parseInt(args[portArg + 1], 10) : 7842;
// ── State ─────────────────────────────────────────────────────────────────────
let actions = [];
let recording = false;
// ── SSE clients ───────────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
        try {
            res.write(payload);
        }
        catch {
            sseClients.delete(res);
        }
    }
}
// ── Python process ────────────────────────────────────────────────────────────
const scriptPath = path_1.default.resolve(__dirname, '..', 'scripts', 'cua_recorder.py');
let pyProc = null;
function sendCmd(cmd) {
    if (pyProc?.stdin) {
        pyProc.stdin.write(JSON.stringify({ cmd }) + '\n');
    }
}
// ── Humanise type → default node name ────────────────────────────────────────
function humanise(type) {
    return type.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}
// ── Build workflow JSON ───────────────────────────────────────────────────────
function buildWorkflow() {
    const NODE_W = 240;
    const nodes = [];
    const edges = [];
    const triggerId = crypto_1.default.randomUUID();
    nodes.push({
        id: triggerId,
        type: 'webhook_trigger',
        name: 'Webhook Trigger',
        position: { x: 80, y: 180 },
        params: {},
    });
    let prevId = triggerId;
    actions.forEach((action, i) => {
        const type = action.type;
        const { type: _t, ...params } = action;
        const id = crypto_1.default.randomUUID();
        const x = 80 + (i + 1) * (NODE_W + 50);
        nodes.push({
            id,
            type,
            name: humanise(type),
            position: { x, y: 180 },
            params: params,
        });
        edges.push({ id: crypto_1.default.randomUUID(), from: prevId, to: id });
        prevId = id;
    });
    return {
        __cua_workflow__: true,
        name: wfName,
        nodes: { nodes, edges },
    };
}
// ── HTTP server ───────────────────────────────────────────────────────────────
const uiPath = path_1.default.resolve(__dirname, 'ui.html');
const server = http_1.default.createServer((req, res) => {
    const url = req.url ?? '/';
    // ── GET / → serve UI ──────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs_1.default.readFileSync(uiPath, 'utf-8'));
        return;
    }
    // ── GET /events → SSE stream ──────────────────────────────────────────────
    if (req.method === 'GET' && url === '/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
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
                const { cmd } = JSON.parse(body);
                if (cmd === 'start') {
                    actions = [];
                    recording = true;
                    sendCmd('start');
                    broadcast('status', { recording: true, actions: [] });
                }
                else if (cmd === 'stop') {
                    recording = false;
                    sendCmd('stop');
                    broadcast('status', { recording: false, actions });
                }
                else if (cmd === 'clear') {
                    actions = [];
                    recording = false;
                    sendCmd('stop');
                    broadcast('status', { recording: false, actions: [] });
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            }
            catch {
                res.writeHead(400);
                res.end('bad request');
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
                const wf = buildWorkflow();
                const dest = outFile ?? `workflow-${Date.now()}.json`;
                fs_1.default.writeFileSync(dest, JSON.stringify(wf, null, 2), 'utf-8');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, file: path_1.default.resolve(dest), workflow: wf }));
            }
            catch (e) {
                res.writeHead(500);
                res.end(String(e));
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
    res.writeHead(404);
    res.end('not found');
});
// ── Spawn Python recorder ─────────────────────────────────────────────────────
function spawnRecorder() {
    pyProc = (0, child_process_1.spawn)('python3', [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
    });
    const rl = (0, readline_1.createInterface)({ input: pyProc.stdout });
    rl.on('line', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (msg.ready) {
            broadcast('ready', {});
            return;
        }
        if (msg.error) {
            broadcast('error', { message: msg.error });
            return;
        }
        if (msg.text_tick)
            return;
        if (msg.status) {
            broadcast('status', { recording: msg.status === 'recording', actions });
            return;
        }
        if (msg.event) {
            const action = msg.event;
            actions.push(action);
            broadcast('action', { action, index: actions.length - 1, total: actions.length });
            broadcast('status', { recording, actions });
        }
    });
    pyProc.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text)
            broadcast('log', { text });
    });
    pyProc.on('close', (code) => {
        if (code !== 0)
            broadcast('error', { message: `Recorder process exited (code ${code})` });
    });
    pyProc.on('error', (err) => {
        broadcast('error', { message: `Failed to start recorder: ${err.message}. Make sure python3 and pynput are installed.` });
    });
}
// ── Check / install pynput ────────────────────────────────────────────────────
function checkDeps() {
    try {
        (0, child_process_2.execSync)('python3 -c "import pynput"', { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
// ── Boot ──────────────────────────────────────────────────────────────────────
if (!checkDeps()) {
    console.log('Installing pynput…');
    try {
        (0, child_process_2.execSync)('pip3 install pynput --break-system-packages', { stdio: 'inherit' });
    }
    catch {
        console.error('Failed to install pynput. Run: pip3 install pynput');
    }
}
spawnRecorder();
server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}`;
    console.log(`\n  cua-record  →  ${url}\n`);
    (0, open_1.default)(url).catch(() => {
        console.log(`  Open your browser at ${url}`);
    });
});
process.on('SIGINT', () => { sendCmd('stop'); if (pyProc)
    pyProc.kill(); process.exit(0); });
process.on('SIGTERM', () => { sendCmd('stop'); if (pyProc)
    pyProc.kill(); process.exit(0); });
