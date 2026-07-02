# Easy Apply — native messaging host.
# Único trabajo: cuando la extensión aprieta "Actualizar ahora", hace
# `git pull` en la carpeta del repo y responde. Después la extensión se
# recarga sola con chrome.runtime.reload(). Nada más: no toca otra cosa.

import json
import struct
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def git_pull():
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO), "pull", "--ff-only"],
            capture_output=True,
            text=True,
            timeout=120,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        output = (result.stdout + "\n" + result.stderr).strip()
        return {"ok": result.returncode == 0, "output": output[-1500:]}
    except Exception as e:  # git ausente, timeout, etc.
        return {"ok": False, "output": str(e)}


def main():
    msg = read_message()
    if not msg:
        return
    if msg.get("cmd") == "update":
        send_message(git_pull())
    elif msg.get("cmd") == "ping":
        send_message({"ok": True, "output": "pong", "repo": str(REPO)})
    else:
        send_message({"ok": False, "output": "comando desconocido"})


if __name__ == "__main__":
    main()
