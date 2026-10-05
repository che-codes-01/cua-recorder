#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// ─── cua-record ────────────────────────────────────────────────────────────────
//
// Usage:  npx cua-record [--out workflow.json] [--name "My workflow"]
//
// Brings up a terminal HUD. Press R to start recording, S to stop,
// W to save the workflow JSON, Q to quit.
//
// The recorder spawns cua_recorder.py which uses pynput to capture
// global mouse + keyboard events and streams them as JSON action objects.
//
const blessed_1 = __importDefault(require("blessed"));
const child_process_1 = require("child_process");
const readline_1 = require("readline");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const child_process_2 = require("child_process");
// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const nameArg = args.indexOf('--name');
const outFile = outArg !== -1 ? args[outArg + 1] : null;
const wfName = nameArg !== -1 ? args[nameArg + 1] : 'Recorded Workflow';
// ── Recorded actions ──────────────────────────────────────────────────────────
let actions = [];
let recording = false;
let saved = false;
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
    // Trigger node
    const triggerId = crypto_1.default.randomUUID();
    nodes.push({
        id: triggerId,
        type: 'webhook_trigger',
        name: 'Webhook Trigger',
        position: { x: 80, y: 180 },
        params: {},
    });
    // Action nodes — laid out left-to-right in a horizontal chain
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
// ── Save workflow ─────────────────────────────────────────────────────────────
function saveWorkflow() {
    const wf = buildWorkflow();
    const dest = outFile ?? `workflow-${Date.now()}.json`;
    fs_1.default.writeFileSync(dest, JSON.stringify(wf, null, 2), 'utf-8');
    saved = true;
    return path_1.default.resolve(dest);
}
// ── Blessed TUI ───────────────────────────────────────────────────────────────
const screen = blessed_1.default.screen({
    smartCSR: true,
    title: 'cua-record',
    fullUnicode: true,
});
// ── Layout ─────────────────────────────────────────────────────────────────────
const header = blessed_1.default.box({
    top: 0, left: 0, width: '100%', height: 3,
    content: ' {bold}{cyan-fg}cua-record{/cyan-fg}{/bold}  —  Record mouse + keyboard → CUA workflow JSON',
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: '#333' }, bg: '#0d0d0d', fg: '#fff' },
});
const statusBox = blessed_1.default.box({
    top: 3, left: 0, width: '100%', height: 3,
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: '#333' }, bg: '#0d0d0d' },
});
const log = blessed_1.default.log({
    top: 6, left: 0, width: '100%', height: '50%',
    label: ' Actions ',
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: '#333' }, bg: '#0d0d0d', fg: '#888' },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: '│', style: { fg: '#444' } },
});
const help = blessed_1.default.box({
    bottom: 0, left: 0, width: '100%', height: 3,
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: '#222' }, bg: '#0d0d0d', fg: '#555' },
    content: '  {bold}R{/bold} Record   {bold}S{/bold} Stop   {bold}W{/bold} Save JSON   {bold}C{/bold} Clear   {bold}Q{/bold} / {bold}Ctrl+C{/bold} Quit',
});
screen.append(header);
screen.append(statusBox);
screen.append(log);
screen.append(help);
function setStatus(state) {
    const map = {
        idle: ' {white-fg}●{/white-fg}  Idle — press {bold}R{/bold} to start recording',
        recording: ' {red-fg}{bold}⏺  RECORDING{/bold}{/red-fg}  — press {bold}S{/bold} to stop  ({bold}' + actions.length + '{/bold} actions)',
        stopped: ' {yellow-fg}■  Stopped{/yellow-fg}  — {bold}' + actions.length + '{/bold} actions captured — press {bold}W{/bold} to save or {bold}R{/bold} to re-record',
        saved: ' {green-fg}✓  Saved{/green-fg}  — {bold}' + actions.length + '{/bold} actions  — press {bold}Q{/bold} to quit or {bold}R{/bold} to record more',
    };
    statusBox.setContent(map[state]);
    screen.render();
}
function logAction(action, index) {
    const type = action.type;
    const colorMap = {
        left_click: 'blue-fg', double_click: 'cyan-fg', right_click: 'magenta-fg',
        type: 'green-fg', key: 'yellow-fg', hotkey: 'yellow-fg',
        scroll: 'white-fg',
    };
    const col = colorMap[type] ?? 'white-fg';
    const num = String(index + 1).padStart(3, ' ');
    const args = Object.entries(action)
        .filter(([k]) => k !== 'type')
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join('  ');
    log.log(` {white-fg}${num}{/white-fg}  {${col}}{bold}${humanise(type)}{/bold}{/${col}}  {#555-fg}${args}{/#555-fg}`);
}
// ── Keyboard bindings ─────────────────────────────────────────────────────────
screen.key(['r', 'R'], () => {
    actions = [];
    recording = true;
    saved = false;
    log.setContent('');
    sendCmd('start');
    setStatus('recording');
});
screen.key(['s', 'S'], () => {
    if (!recording)
        return;
    recording = false;
    sendCmd('stop');
    setStatus('stopped');
});
screen.key(['w', 'W'], () => {
    if (!actions.length)
        return;
    const dest = saveWorkflow();
    log.log(` {green-fg}✓ Saved → ${dest}{/green-fg}`);
    setStatus('saved');
});
screen.key(['c', 'C'], () => {
    actions = [];
    log.setContent('');
    setStatus(recording ? 'recording' : 'idle');
});
screen.key(['q', 'Q', 'C-c'], () => {
    sendCmd('stop');
    if (pyProc)
        pyProc.kill();
    process.exit(0);
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
            setStatus('idle');
            return;
        }
        if (msg.error) {
            log.log(` {red-fg}Error: ${msg.error}{/red-fg}`);
            screen.render();
            return;
        }
        if (msg.status === 'recording') {
            setStatus('recording');
            return;
        }
        if (msg.status === 'stopped') {
            setStatus('stopped');
            return;
        }
        // text_tick — flush handled implicitly by stop / next non-char event
        if (msg.text_tick) {
            return;
        }
        // Action event
        if (msg.event) {
            const action = msg.event;
            actions.push(action);
            logAction(action, actions.length - 1);
            // Keep status count fresh while recording
            if (recording)
                setStatus('recording');
            return;
        }
    });
    pyProc.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) {
            log.log(` {#666-fg}[py] ${text}{/#666-fg}`);
            screen.render();
        }
    });
    pyProc.on('close', (code) => {
        if (code !== 0) {
            log.log(` {red-fg}Recorder process exited (code ${code}){/red-fg}`);
            screen.render();
        }
    });
    pyProc.on('error', (err) => {
        log.log(` {red-fg}Failed to start recorder: ${err.message}{/red-fg}`);
        log.log(` {yellow-fg}Make sure python3 and pynput are installed: pip3 install pynput{/yellow-fg}`);
        screen.render();
    });
}
// ── Check pynput is installed ─────────────────────────────────────────────────
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
screen.render();
setStatus('idle');
statusBox.setContent(' {yellow-fg}Checking dependencies…{/yellow-fg}');
screen.render();
if (!checkDeps()) {
    statusBox.setContent(' {red-fg}pynput not found. Installing…{/red-fg}');
    screen.render();
    try {
        (0, child_process_2.execSync)('pip3 install pynput --break-system-packages', { stdio: 'inherit' });
    }
    catch {
        log.log('{red-fg}Failed to install pynput. Please run: pip3 install pynput{/red-fg}');
        screen.render();
    }
}
spawnRecorder();
