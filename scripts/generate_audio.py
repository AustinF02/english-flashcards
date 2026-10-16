"""One-time Polly Standard audio generation for english-flashcards (Stage 2).

SAFETY
  * Default is a DRY RUN: verifies the voices and prints the plan. No synthesis.
  * Synthesis requires --confirm AND the planned cost must be <= the approved cap.
  * Clips that already exist, are non-empty, and match the current voice+text are
    REUSED; nothing is regenerated unnecessarily.
  * Credentials come from the caller's environment only. They are never read,
    printed, or logged here. The account/identity is printed so you can see it.

Usage
  EXPECTED_ACCOUNT=<your-aws-account-id> python3 scripts/generate_audio.py             # dry run
  EXPECTED_ACCOUNT=<your-aws-account-id> python3 scripts/generate_audio.py --confirm   # PAID (<= $1)

  EXPECTED_ACCOUNT is REQUIRED and has no default. It pins the AWS account the script
  is allowed to bill. If it is unset/empty, the script fails closed before any AWS call.
  Optional: REGION (default ap-northeast-1).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

REGION = os.environ.get("REGION", "ap-northeast-1")
ENGINE = "standard"
VOICES = {"Joanna", "Joey"}
PRICE_PER_MILLION_USD = 4.00      # Polly Standard (verified against aws.amazon.com/polly/pricing)
COST_CAP_USD = 1.00               # owner-approved maximum synthesis charge
# No default: the operator MUST pin the account via the EXPECTED_ACCOUNT env var.
EXPECTED_ACCOUNT = os.environ.get("EXPECTED_ACCOUNT", "").strip()
MIN_VALID_BYTES = 1000            # smaller than this is not a usable MP3

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT_DIR = os.path.join(ROOT, "public", "audio")
MANIFEST = "manifest.json"


def load_cards() -> list[dict]:
    path = os.path.join(ROOT, "cards.json")
    if not os.path.exists(path):
        sys.exit(f"cards.json missing at {path}. Run: npx vite-node scripts/export_cards.ts")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def assert_voice_split(cards: list[dict]) -> None:
    """20 Joanna / 20 Joey overall and 10/10 inside every deck; only approved voices."""
    bad = {c["voice"] for c in cards} - VOICES
    if bad:
        sys.exit(f"ABORT: unapproved voice(s) {sorted(bad)}")
    total = {v: sum(1 for c in cards if c["voice"] == v) for v in VOICES}
    if total["Joanna"] != total["Joey"]:
        sys.exit(f"ABORT: voice split is not even: {total}")
    for deck in {c["deck"] for c in cards}:
        inside = [c for c in cards if c["deck"] == deck]
        j = sum(1 for c in inside if c["voice"] == "Joanna")
        if j * 2 != len(inside):
            sys.exit(f"ABORT: deck {deck!r} is not balanced ({j} Joanna of {len(inside)})")


def plan(cards: list[dict]) -> list[tuple[str, str, str]]:
    """(voiceId, text, filename) for each card's term and example; same voice for both."""
    items: list[tuple[str, str, str]] = []
    for c in cards:
        items.append((c["voice"], c["term"], f"{c['id']}-t.mp3"))
        items.append((c["voice"], c["example"], f"{c['id']}-e.mp3"))
    return items


def clip_key(voice: str, text: str) -> str:
    return hashlib.sha256(f"{ENGINE}|{voice}|{text}".encode("utf-8")).hexdigest()


def read_manifest(out_dir: str) -> dict[str, str]:
    p = os.path.join(out_dir, MANIFEST)
    if not os.path.exists(p):
        return {}
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def write_manifest(out_dir: str, manifest: dict[str, str]) -> None:
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, MANIFEST), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)


def clips_to_synthesize(items: list[tuple[str, str, str]], out_dir: str) -> list[tuple[str, str, str]]:
    """Reuse a clip only if the file is valid AND (when the manifest knows it) the
    voice+text hash still matches. Missing, empty, or changed clips are redone."""
    manifest = read_manifest(out_dir)
    todo = []
    for voice, text, name in items:
        path = os.path.join(out_dir, name)
        valid = os.path.exists(path) and os.path.getsize(path) >= MIN_VALID_BYTES
        if valid and name in manifest and manifest[name] != clip_key(voice, text):
            valid = False
        if not valid:
            todo.append((voice, text, name))
    return todo


def cost_usd(characters: int) -> float:
    return characters * PRICE_PER_MILLION_USD / 1_000_000


def assert_under_cap(cost: float) -> None:
    if cost > COST_CAP_USD:
        sys.exit(f"ABORT: planned cost ${cost:.4f} exceeds the approved ${COST_CAP_USD:.2f} cap")


def assert_expected_account(account: str, expected: str = EXPECTED_ACCOUNT) -> None:
    # Fail closed: an unset/empty expectation is a configuration error, not a match.
    if not expected:
        sys.exit("ABORT: EXPECTED_ACCOUNT is not set. Export EXPECTED_ACCOUNT=<your-aws-account-id> before running.")
    if account != expected:
        sys.exit(f"ABORT: running as account {account or '(unknown)'}, expected {expected}")


def _boto3():
    try:
        import boto3  # lazy: planning and tests need no AWS SDK
    except ImportError:
        sys.exit("boto3 is required to talk to AWS: python3 -m pip install boto3")
    return boto3


def verify_target() -> object:
    """Print who we are and prove the voices exist in-region. Never prints credentials."""
    boto3 = _boto3()
    sts = boto3.client("sts", region_name=REGION)
    who = sts.get_caller_identity()
    expected = os.environ.get("EXPECTED_ACCOUNT", "").strip()
    assert_expected_account(who["Account"], expected)   # refuse before any billable call
    print(f"Account {who['Account']}  Identity {who['Arn'].split('/')[-1]}  Region {REGION}")
    polly = boto3.client("polly", region_name=REGION)
    found: set[str] = set()
    for v in polly.describe_voices(Engine=ENGINE, LanguageCode="en-US").get("Voices", []):
        if v["Id"] in VOICES:
            found.add(v["Id"])
    if found != VOICES:
        sys.exit(f"ABORT: Standard voices missing in {REGION}: {sorted(VOICES - found)} (no substitution)")
    print(f"Verified Standard voices in {REGION}: {sorted(found)}")
    return polly


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--confirm", action="store_true", help="PAID: synthesize missing clips")
    args = ap.parse_args()

    cards = load_cards()
    assert_voice_split(cards)
    items = plan(cards)
    todo = clips_to_synthesize(items, OUT_DIR)
    chars = sum(len(t) for _v, t, _n in todo)
    cost = cost_usd(chars)
    print(f"Plan: {len(items)} clips total; {len(items) - len(todo)} reusable; {len(todo)} to synthesize.")
    print(f"Billable characters: {chars}  ->  ${cost:.4f}  (cap ${COST_CAP_USD:.2f})")
    assert_under_cap(cost)

    polly = verify_target()
    if not args.confirm:
        print("DRY RUN: nothing synthesized. Re-run with --confirm to generate.")
        return
    if not todo:
        print("Nothing to do: all clips already valid.")
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = read_manifest(OUT_DIR)
    for voice, text, name in todo:
        resp = polly.synthesize_speech(Text=text, VoiceId=voice, Engine=ENGINE,
                                       LanguageCode="en-US", OutputFormat="mp3")
        data = resp["AudioStream"].read()
        if len(data) < MIN_VALID_BYTES:
            sys.exit(f"ABORT: {name} came back too small ({len(data)} bytes)")
        with open(os.path.join(OUT_DIR, name), "wb") as f:
            f.write(data)
        manifest[name] = clip_key(voice, text)
        write_manifest(OUT_DIR, manifest)   # persist after each clip so a crash loses nothing
        print(f"wrote {name} ({voice})")
    print(f"Done. Synthesized {len(todo)} clips (~${cost:.4f}).")


if __name__ == "__main__":
    main()
