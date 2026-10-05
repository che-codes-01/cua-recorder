# cua-record

A **browser-based visual recorder** for CUA workflows — like Playwright's codegen, but for CUA.

Run it locally, click **Record**, interact with your screen (mouse clicks, keyboard, scroll), click **Stop**, then **Save JSON** — the workflow file is ready to import into the CUA editor.

## Quick start (from GitHub — no install needed)

```bash
npx --yes github:che-codes-01/cua-recorder
```

With options:

```bash
# Save to a specific file
npx --yes github:che-codes-01/cua-recorder --out my-workflow.json

# Custom workflow name
npx --yes github:che-codes-01/cua-recorder --name "Open SAP and search"

# Custom port (default: 7842)
npx --yes github:che-codes-01/cua-recorder --port 8080
```

The command opens a recorder window in your default browser automatically.

---

## What it looks like

A toolbar across the top with **Record ▶**, **Stop ■**, **Clear**, and **Save JSON** buttons — plus a live scrolling list of every captured action with type, colour-coding, and parameters.

---

## Requirements

- Node.js 18+
- Python 3 + `pynput` (auto-installed on first run)

> **macOS:** Grant **Accessibility** and **Input Monitoring** permissions to Terminal (or your terminal app) in  
> System Preferences → Privacy & Security → Accessibility / Input Monitoring.

---

## Local install / dev

```bash
cd packages/recorder
npm install
npm run build   # compiles TypeScript + copies ui.html → dist/
npm start
```

---

## Keyboard shortcuts (inside the recorder browser window)

| Key | Action |
|-----|--------|
| **R** | Start recording |
| **S** | Stop recording |
| **W** | Save workflow JSON |
| **C** | Clear recorded actions |
| **Esc** | Close JSON preview modal |

---

## What gets recorded

| Input | CUA node type |
|-------|--------------|
| Left click | `left_click` |
| Double click | `double_click` |
| Right click | `right_click` |
| Consecutive typing | `type` (collapsed) |
| Special key (Enter, Tab, Esc…) | `key` |
| Modifier combo (⌘C, ⌘V…) | `hotkey` |
| Scroll wheel | `scroll` |

---

## Output format

The saved JSON is a standard CUA workflow importable via the editor's **Import** button:

```json
{
  "__cua_workflow__": true,
  "name": "My Workflow",
  "nodes": {
    "nodes": [
      { "id": "...", "type": "webhook_trigger", "name": "Webhook Trigger", "params": {} },
      { "id": "...", "type": "left_click",      "name": "Left Click",      "params": { "coordinate": [320, 240] } },
      { "id": "...", "type": "type",             "name": "Type",            "params": { "text": "hello world" } }
    ],
    "edges": [
      { "id": "...", "from": "...", "to": "..." }
    ]
  }
}
```
