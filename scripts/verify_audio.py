"""Verify generated pronunciation clips against cards.json. Local only; no AWS calls.

Checks, for every card: both clips exist, look like MP3s, were generated for the card's
ASSIGNED voice and CURRENT text (via the manifest hash), and term + example share a voice.
It also flags unexpected files. Limit: the manifest records the voice REQUESTED from
Polly; this proves the request matched the assignment, not what the audio sounds like.

Usage: python3 scripts/verify_audio.py
"""
from __future__ import annotations

import json
import os
import sys

import generate_audio as g

MIN_BYTES = g.MIN_VALID_BYTES


def looks_like_mp3(path: str) -> bool:
    with open(path, "rb") as f:
        head = f.read(3)
    # ID3 tag, or an MPEG audio frame sync (0xFFEx / 0xFFFx)
    return head == b"ID3" or (len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0)


def verify(cards: list[dict], out_dir: str) -> list[str]:
    problems: list[str] = []
    manifest = g.read_manifest(out_dir)
    expected_names = set()
    for c in cards:
        for suffix, text in (("t", c["term"]), ("e", c["example"])):
            name = f"{c['id']}-{suffix}.mp3"
            expected_names.add(name)
            path = os.path.join(out_dir, name)
            if not os.path.exists(path):
                problems.append(f"{name}: missing")
                continue
            if os.path.getsize(path) < MIN_BYTES or not looks_like_mp3(path):
                problems.append(f"{name}: not an MP3 (or too small)")
                continue
            recorded = manifest.get(name)
            if recorded is None:
                problems.append(f"{name}: no manifest entry")
            elif recorded != g.clip_key(c["voice"], text):
                other = ({"Joanna", "Joey"} - {c["voice"]}).pop()
                which = f"generated with {other}" if recorded == g.clip_key(other, text) else "text or voice changed since generation"
                problems.append(f"{name}: voice/text mismatch ({which}); expected {c['voice']}")
    for extra in sorted(os.listdir(out_dir)):
        if extra not in expected_names and extra != g.MANIFEST:
            problems.append(f"{extra}: unexpected file")
    return problems


def main() -> None:
    cards = g.load_cards()
    problems = verify(cards, g.OUT_DIR)
    clips = len(cards) * 2
    if problems:
        print(f"FAIL: {len(problems)} problem(s) across {clips} expected clips")
        for p in problems:
            print("  -", p)
        sys.exit(1)
    by_voice = {v: sum(1 for c in cards if c["voice"] == v) for v in sorted(g.VOICES)}
    print(f"OK: {clips} clips present, valid MP3 headers, voice+text match for all; cards per voice {by_voice}")


if __name__ == "__main__":
    main()
