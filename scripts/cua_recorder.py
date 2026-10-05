#!/usr/bin/env python3
"""
cua_recorder.py — global input recorder for CUA workflow capture.

Protocol (stdin / stdout, one JSON object per line):
  Commands from TS : {"cmd": "start"} | {"cmd": "stop"} | {"cmd": "ping"}
  Events to TS     : {"event": <action_object>}
  Status to TS     : {"status": "recording"} | {"status": "stopped"} | {"pong": true}
  Error to TS      : {"error": "<message>"}

Action objects mirror the CUA action schema exactly so they can be
dropped straight into a workflow nodes array.
"""
import sys
import os
import json
import time
import threading

# ── Dependency check ──────────────────────────────────────────────────────────
try:
    from pynput import mouse, keyboard
except ImportError:
    sys.stdout.write(json.dumps({"error": "pynput not installed. Run: pip3 install pynput"}) + "\n")
    sys.stdout.flush()
    sys.exit(1)

# ── State ──────────────────────────────────────────────────────────────────────

recording      = False
mouse_listener  = None
kbd_listener    = None
lock            = threading.Lock()

# Key accumulation — consecutive printable chars → single `type` node
pending_text    = ""
pending_text_ts = 0.0
TEXT_FLUSH_GAP  = 0.8   # seconds gap before flushing pending text as a node

# Modifier tracking for hotkey detection
pressed_mods: set[str] = set()
MOD_KEYS = {
    keyboard.Key.ctrl,  keyboard.Key.ctrl_r,
    keyboard.Key.alt,   keyboard.Key.alt_r,
    keyboard.Key.shift, keyboard.Key.shift_r,
    keyboard.Key.cmd,   keyboard.Key.cmd_r,
}
MOD_NAMES = {
    keyboard.Key.ctrl:    "ctrl",  keyboard.Key.ctrl_r:  "ctrl",
    keyboard.Key.alt:     "alt",   keyboard.Key.alt_r:   "alt",
    keyboard.Key.shift:   "shift", keyboard.Key.shift_r: "shift",
    keyboard.Key.cmd:     "cmd",   keyboard.Key.cmd_r:   "cmd",
}
SPECIAL_KEY_NAMES = {
    keyboard.Key.enter:      "enter",
    keyboard.Key.tab:        "tab",
    keyboard.Key.backspace:  "backspace",
    keyboard.Key.delete:     "delete",
    keyboard.Key.esc:        "escape",
    # space is handled as a printable character (accumulated into type nodes)
    keyboard.Key.up:         "up",
    keyboard.Key.down:       "down",
    keyboard.Key.left:       "left",
    keyboard.Key.right:      "right",
    keyboard.Key.home:       "home",
    keyboard.Key.end:        "end",
    keyboard.Key.page_up:    "page_up",
    keyboard.Key.page_down:  "page_down",
    keyboard.Key.f1:  "f1",  keyboard.Key.f2:  "f2",  keyboard.Key.f3:  "f3",
    keyboard.Key.f4:  "f4",  keyboard.Key.f5:  "f5",  keyboard.Key.f6:  "f6",
    keyboard.Key.f7:  "f7",  keyboard.Key.f8:  "f8",  keyboard.Key.f9:  "f9",
    keyboard.Key.f10: "f10", keyboard.Key.f11: "f11", keyboard.Key.f12: "f12",
}

# Last click tracking for double-click detection
last_click_pos  = None
last_click_time = 0.0
DOUBLE_CLICK_GAP = 0.4   # seconds

# Drag tracking
drag_start_pos  = None
drag_start_time = 0.0
DRAG_THRESHOLD  = 5      # pixels

# ── Output helper ──────────────────────────────────────────────────────────────

def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def emit_event(action: dict) -> None:
    emit({"event": action})

# ── Text flusher ───────────────────────────────────────────────────────────────

def flush_pending_text() -> None:
    global pending_text, pending_text_ts
    with lock:
        if pending_text:
            emit_event({"type": "type", "text": pending_text})
            pending_text    = ""
            pending_text_ts = 0.0

# ── Mouse handlers ─────────────────────────────────────────────────────────────

def on_click(x: int, y: int, button, pressed: bool) -> None:
    global last_click_pos, last_click_time
    if not recording:
        return

    if not pressed:
        # Mouse-up — check if this completed a drag
        return

    flush_pending_text()
    now = time.time()

    btn_str = {
        mouse.Button.left:   "left",
        mouse.Button.right:  "right",
        mouse.Button.middle: "middle",
    }.get(button, "left")

    coord = [x, y]

    if btn_str == "right":
        emit_event({"type": "right_click", "coordinate": coord})
        last_click_pos  = None
        last_click_time = 0.0
        return

    # Double-click detection
    if (
        last_click_pos is not None
        and abs(x - last_click_pos[0]) < 8
        and abs(y - last_click_pos[1]) < 8
        and now - last_click_time < DOUBLE_CLICK_GAP
    ):
        emit_event({"type": "double_click", "coordinate": coord})
        last_click_pos  = None
        last_click_time = 0.0
    else:
        emit_event({"type": "left_click", "coordinate": coord})
        last_click_pos  = [x, y]
        last_click_time = now


def on_scroll(x: int, y: int, dx: int, dy: int) -> None:
    if not recording:
        return
    flush_pending_text()
    direction = "up" if dy > 0 else "down"
    amount    = max(1, abs(dy))
    emit_event({"type": "scroll", "coordinate": [x, y], "scroll_direction": direction, "scroll_amount": amount})


# ── Keyboard handlers ──────────────────────────────────────────────────────────

def _mod_name(key) -> str | None:
    return MOD_NAMES.get(key)

def on_key_press(key) -> None:
    global pending_text, pending_text_ts
    if not recording:
        return

    # Track modifiers
    if key in MOD_KEYS:
        with lock:
            pressed_mods.add(_mod_name(key))
        return

    # Special key with active modifiers → hotkey
    # Exception: Shift + printable char is just the uppercase char, not a hotkey
    special = SPECIAL_KEY_NAMES.get(key)
    char    = getattr(key, "char", None)

    with lock:
        active_mods = set(pressed_mods)

    # Shift alone + a printable char → the char already carries the right case;
    # accumulate it as text rather than emitting a hotkey node.
    shift_only = active_mods == {"shift"}
    if shift_only and char and not special:
        with lock:
            pending_text    += char
            pending_text_ts  = time.time()
        emit({"text_tick": True})
        return

    if active_mods and (special or char):
        flush_pending_text()
        key_name  = special or char
        combo     = sorted(active_mods) + [key_name]
        if len(combo) == 1:
            emit_event({"type": "key", "text": combo[0]})
        else:
            emit_event({"type": "hotkey", "keys": combo})
        return

    # Space → treat as printable so it stays inside the text buffer
    if key == keyboard.Key.space:
        with lock:
            pending_text    += " "
            pending_text_ts  = time.time()
        emit({"text_tick": True})
        return

    # Other special key (no modifiers) → key node
    if special:
        flush_pending_text()
        emit_event({"type": "key", "text": special})
        return

    # Printable character → accumulate into pending text
    if char:
        with lock:
            pending_text    += char
            pending_text_ts  = time.time()
        emit({"text_tick": True})
        return


def on_key_release(key) -> None:
    if not recording:
        return
    if key in MOD_KEYS:
        with lock:
            pressed_mods.discard(_mod_name(key))


# ── Listener lifecycle ─────────────────────────────────────────────────────────

def start_recording() -> None:
    global recording, mouse_listener, kbd_listener, pressed_mods
    if recording:
        return
    with lock:
        pressed_mods = set()
    recording       = True
    mouse_listener  = mouse.Listener(on_click=on_click, on_scroll=on_scroll)
    kbd_listener    = keyboard.Listener(on_press=on_key_press, on_release=on_key_release)
    mouse_listener.start()
    kbd_listener.start()
    emit({"status": "recording"})


def stop_recording() -> None:
    global recording, mouse_listener, kbd_listener
    if not recording:
        return
    recording = False
    flush_pending_text()
    if mouse_listener:
        mouse_listener.stop()
        mouse_listener = None
    if kbd_listener:
        kbd_listener.stop()
        kbd_listener = None
    emit({"status": "stopped"})


# ── Main loop ──────────────────────────────────────────────────────────────────

def main() -> None:
    emit({"ready": True})
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
            cmd = msg.get("cmd")
            if cmd == "start":
                start_recording()
            elif cmd == "stop":
                stop_recording()
            elif cmd == "ping":
                emit({"pong": True})
        except Exception as exc:
            emit({"error": str(exc)})


if __name__ == "__main__":
    main()
