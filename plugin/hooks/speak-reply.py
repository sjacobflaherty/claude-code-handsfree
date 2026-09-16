#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys

ROOT = os.environ.get("CLAUDE_VOICE_ROOT") or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ACTIVE_FLAG = os.path.join(ROOT, "state", "active.json")
SAY = os.environ.get("CLAUDE_VOICE_SAY") or "/usr/bin/say"
MAX_CHARS = 3000
RATE_WPM = "190"
CHANNEL_GRACE_MS = 15000

# `say` reads each of these as a word, and reads the dotted form letter by letter.
SPELL_OUT = {
    "api", "mcp", "cli", "sdk", "url", "uri", "http", "https", "html", "css", "sql",
    "ssh", "tls", "ssl", "vpn", "dns", "ide", "ai", "ui", "ux", "id", "pr", "ci", "cd",
    "stt", "tts", "llm", "os", "cpu", "gpu", "usb", "pdf", "csv", "md",
    "js", "ts", "mjs", "cjs", "py", "adr", "sla", "jd",
}
_ACRONYM_RE = re.compile(r"(?<![A-Za-z0-9])([A-Za-z]{2,5})(?![A-Za-z0-9])")


def spell_out_acronyms(text: str) -> str:
    def repl(m: re.Match) -> str:
        word = m.group(1)
        if word.lower() in SPELL_OUT:
            return ".".join(word.upper()) + "."
        return word
    return _ACRONYM_RE.sub(repl, text)


def read_active_flag() -> dict | None:
    try:
        with open(ACTIVE_FLAG) as f:
            raw = f.read().strip()
    except Exception:
        return None
    try:
        data = json.loads(raw)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def is_pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except Exception:
        return True
    return True


def is_own_session(flag: dict, payload: dict) -> bool:
    if not is_pid_alive(int(flag.get("pid", 0))):
        return False
    if flag.get("sessionId"):
        return flag["sessionId"] == payload.get("session_id")
    return flag.get("cwd") == payload.get("cwd")


def has_spoken_recently(flag: dict) -> bool:
    import time
    # A server started before the rename still writes ts until its session ends.
    spoke_at_ms = flag.get("spoke_at_ms")
    if spoke_at_ms is None:
        spoke_at_ms = flag.get("ts")
    return (time.time() * 1000 - int(spoke_at_ms or 0)) < CHANNEL_GRACE_MS


def strip_markdown(text: str) -> str:
    text = re.sub(r"```.*?```", " code block omitted. ", text, flags=re.S)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"^\s{0,3}#{1,6}\s*", "", text, flags=re.M)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.M)
    text = re.sub(r"^\s*\d+\.\s+", "", text, flags=re.M)
    text = re.sub(r"^\s*>\s?", "", text, flags=re.M)
    text = re.sub(r"^\s*\|.*\|\s*$", "", text, flags=re.M)
    text = re.sub(r"[*~]{1,3}", "", text)
    # An underscore at a word edge is an emphasis marker, and one inside a name is spoken as "underscore".
    text = re.sub(r"(?<!\w)_+|_+(?!\w)", "", text)
    text = re.sub(r"_+", " underscore ", text)
    text = re.sub(r"\n{2,}", ". ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def truncate_at_sentence(text: str, limit: int) -> str:
    cut = text.rfind(". ", 0, limit)
    if cut > 0:
        return text[: cut + 1]
    return text[:limit] + "."


def main() -> None:
    payload = json.load(sys.stdin)
    flag = read_active_flag()
    if flag is None or not is_own_session(flag, payload):
        return
    if has_spoken_recently(flag):
        return
    message = payload.get("last_assistant_message") or ""
    text = spell_out_acronyms(strip_markdown(message))
    if not text:
        return
    if len(text) > MAX_CHARS:
        text = truncate_at_sentence(text, MAX_CHARS) + " Reply truncated."
    subprocess.run(["pkill", "-x", "say"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run([SAY, "-r", RATE_WPM, "--", text], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
