#!/usr/bin/env python3
import json
import os
import subprocess
import sys

ROOT = os.environ.get("CLAUDE_VOICE_ROOT") or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHANNEL_FLAG = os.path.join(ROOT, "state", "active.json")


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except Exception:
        return True
    return True


def main() -> None:
    payload = json.load(sys.stdin)
    # A spoken message also arrives as a prompt, and the only `say` playing right after a send is the receipt cue.
    if str(payload.get("prompt") or "").lstrip().startswith("<channel"):
        return
    with open(CHANNEL_FLAG) as f:
        flag = json.load(f)
    if not isinstance(flag, dict) or not pid_alive(int(flag.get("pid", 0))):
        return
    if flag.get("sessionId"):
        owns = flag["sessionId"] == payload.get("session_id")
    else:
        owns = flag.get("cwd") == payload.get("cwd")
    if not owns:
        return
    subprocess.run(["pkill", "-x", "say"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
