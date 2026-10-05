# cua-record

A Playwright-style recorder for CUA workflows. Run it locally, press **R** to start recording your mouse + keyboard, press **S** to stop, press **W** to save — outputs a workflow JSON you can import directly into the CUA editor.

## Install

```bash
cd packages/recorder
npm install
npm run build
```

Or install globally via npx from the repo root:

```bash
npm run build --workspace=packages/recorder
npx --prefix packages/recorder cua-record
```

Requires Python 3 + pynput (auto-installed on first run):

```bash
pip3 install pynput
```

> **macOS:** You must grant **Accessibility** and **Input Monitoring** permissions to Terminal (or your terminal app) in  
> System Preferences → Privacy & Security → Accessibility / Input Monitoring.

## Usage

```bash
# Basic — saves to workflow-<timestamp>.json
cua-record

# Custom output file
cua-record --out my-workflow.json

# Custom workflow name (shown in editor)
cua-record --name "Open Brave and search SAP"

# Both
cua-record --out sap-search.json --name "SAP Stock Search"
```

## Keyboard shortcuts (inside the recorder HUD)

| Key | Action |
|-----|--------|
| **R** | Start recording |
| **S** | Stop recording |
| **W** | Save workflow JSON |
| **C** | Clear recorded actions |
| **Q** / Ctrl+C | Quit |

## What gets recorded

| Input | CUA node type |
|-------|--------------|
| Left click | `left_click` |
| Double click | `double_click` |
| Right click | `right_click` |
| Consecutive typing | `type` (collapsed into one node) |
| Special key (Enter, Tab, Esc…) | `key` |
| Modifier combo (⌘C, ⌘V…) | `hotkey` |
| Scroll wheel | `scroll` |

## Output format

The saved JSON is a standard CUA workflow file importable via the editor's **Import** button:

```json
{
  "__cua_workflow__": true,
  "name": "My Workflow",
  "nodes": {
    "nodes": [
      { "id": "...", "type": "webhook_trigger", ... },
      { "id": "...", "type": "left_click", "params": { "coordinate": [320, 240] }, ... },
      { "id": "...", "type": "type",       "params": { "text": "hello world" }, ... }
    ],
    "edges": [
      { "id": "...", "from": "trigger-id", "to": "node-2-id" },
      ...
    ]
  }
}
```
