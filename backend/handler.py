"""Progress API core logic for english-flashcards (pure Python, no AWS imports).

Runtime target: python3.14 (spec §3). AWS clients are injected by index.py so this
module is unit-testable without credentials.

Routes (HTTP API + Cognito JWT authorizer; every route also requires a scope):
  GET    /api/progress  -> caller's item (empty default if none; GET never writes)
  PUT    /api/progress  -> {baseVersion, ops:[...]}  conditional write
  DELETE /api/account   -> wipe progress, remove the Cognito user, leave a short-lived tombstone

userId ALWAYS comes from the verified JWT `sub` claim, never from the body (spec §7.2).

Conflict + idempotency rules are mirrored in src/progress.ts and BOTH are driven by
test/vectors/progress.json. No device clock is ever read (see the docstring there).
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Callable

log = logging.getLogger(__name__)

MAX_PAYLOAD_BYTES = 32 * 1024
MAX_OPS_PER_REQUEST = 50
MAX_DEVICES = 10                      # per-user dedup window: this many devices, each exact
TOMBSTONE_TTL_SECONDS = 24 * 3600     # > access-token lifetime (60 min), so a stale token cannot outlive it
DELETE_RETRIES = 3
VALID_STATUS = {"learning", "known"}
DEVICE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class ValidationError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def _claim_sub(event: dict[str, Any]) -> str:
    """Read the verified Cognito subject from either API shape:
       HTTP API v2 JWT authorizer -> requestContext.authorizer.jwt.claims.sub
       REST COGNITO_USER_POOLS    -> requestContext.authorizer.claims.sub
    Only the gateway-verified claim is trusted; the body is never consulted."""
    authz = (event.get("requestContext") or {}).get("authorizer") or {}
    claims = authz.get("jwt", {}).get("claims") if isinstance(authz.get("jwt"), dict) else None
    if claims is None:
        claims = authz.get("claims")
    sub = claims.get("sub") if isinstance(claims, dict) else None
    if not isinstance(sub, str) or not sub:
        raise ValidationError(401, "unauthenticated")
    return sub


def _parse_body(event: dict[str, Any]) -> dict[str, Any]:
    raw = event.get("body") or "{}"
    if isinstance(raw, str) and len(raw.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise ValidationError(413, "payload too large")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise ValidationError(400, "invalid json")
    if not isinstance(data, dict):
        raise ValidationError(400, "body must be an object")
    return data


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)    # bool is an int subclass: reject it


def _validate_ops(data: dict[str, Any], valid_ids: set[str]) -> list[dict[str, Any]]:
    ops = data.get("ops")
    if not isinstance(ops, list):
        raise ValidationError(400, "ops must be a list")
    if len(ops) > MAX_OPS_PER_REQUEST:
        raise ValidationError(400, "too many ops")
    cleaned: list[dict[str, Any]] = []
    for op in ops:
        if not isinstance(op, dict):
            raise ValidationError(400, "each op must be an object")
        device, seq, card, kind = op.get("deviceId"), op.get("seq"), op.get("cardId"), op.get("kind")
        if not isinstance(device, str) or not DEVICE_ID.match(device):
            raise ValidationError(400, "invalid deviceId")
        if not _is_int(seq) or seq < 1:
            raise ValidationError(400, "invalid seq")
        if card not in valid_ids:
            raise ValidationError(400, "unknown cardId")
        if kind == "status":
            if op.get("status") not in VALID_STATUS:
                raise ValidationError(400, "invalid status")
            base = op.get("baseRev")
            if not _is_int(base) or base < 0:
                raise ValidationError(400, "invalid baseRev")
            # any clientTime the browser sends is deliberately dropped here
            cleaned.append({"kind": "status", "deviceId": device, "seq": seq, "cardId": card,
                            "status": op["status"], "baseRev": base})
        elif kind == "quiz":
            if not isinstance(op.get("correct"), bool):
                raise ValidationError(400, "invalid correct")
            cleaned.append({"kind": "quiz", "deviceId": device, "seq": seq, "cardId": card,
                            "correct": op["correct"]})
        else:
            raise ValidationError(400, "invalid kind")
    return cleaned


def empty_progress(user_id: str) -> dict[str, Any]:
    return {"userId": user_id, "version": 0, "state": "active", "cards": {}, "quiz": {}, "devices": []}


def apply_ops(prev: dict[str, Any], ops: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Mirror of applyOps in src/progress.ts. Pure; returns (new_state, one result per op)."""
    state = {
        **prev,
        "cards": {k: dict(v) for k, v in prev.get("cards", {}).items()},
        "quiz": {k: dict(v) for k, v in prev.get("quiz", {}).items()},
        "devices": [list(d) for d in prev.get("devices", [])],
    }
    results: list[dict[str, Any]] = []
    changed = False

    for op in ops:
        def done(outcome: str, _op=op) -> None:
            results.append({"deviceId": _op["deviceId"], "seq": _op["seq"], "outcome": outcome})

        at = next((i for i, d in enumerate(state["devices"]) if d[0] == op["deviceId"]), -1)
        if at == -1:
            if op["seq"] != 1:                       # an unknown device may only start at 1
                done("expired")
                continue
            state["devices"].append([op["deviceId"], 0])
            if len(state["devices"]) > MAX_DEVICES:
                state["devices"].pop(0)              # evict least-recently-used
        elif op["seq"] <= state["devices"][at][1]:
            done("duplicate")
            continue

        i = next(i for i, d in enumerate(state["devices"]) if d[0] == op["deviceId"])
        state["devices"].pop(i)
        state["devices"].append([op["deviceId"], op["seq"]])
        changed = True

        if op["kind"] == "status":
            cur = state["cards"].get(op["cardId"], {"status": op["status"], "rev": 0})
            if op["baseRev"] != cur["rev"]:
                done("stale")
                continue
            state["cards"][op["cardId"]] = {"status": op["status"], "rev": cur["rev"] + 1}
        else:
            c = state["quiz"].get(op["cardId"], {"seen": 0, "correct": 0})
            state["quiz"][op["cardId"]] = {"seen": c["seen"] + 1, "correct": c["correct"] + (1 if op["correct"] else 0)}
        done("applied")

    if changed:
        state["version"] = prev["version"] + 1
    return state, results


def _resp(status: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "no-store"},
        "body": json.dumps(body),
    }


def _tombstone(user_id: str, version: int, state: str, now_ms: int) -> dict[str, Any]:
    doc = {**empty_progress(user_id), "version": version, "state": state}
    if state == "deleted":
        doc["expiresAt"] = now_ms // 1000 + TOMBSTONE_TTL_SECONDS    # DynamoDB TTL attribute (epoch seconds)
    return doc


def _delete_account(user_id: str, get_item, put_item, delete_user, now_ms: int) -> dict[str, Any]:
    """Retry-safe, proportionate deletion:
       1. wipe + block  (conditional write -> a concurrent PUT either loses or is wiped)
       2. delete the Cognito user (already-gone counts as success)
       3. mark 'deleted' with a TTL
     A failure after (1) leaves a blocked, empty account; calling DELETE again resumes."""
    cur = get_item(user_id) or empty_progress(user_id)
    for _ in range(DELETE_RETRIES):
        if cur["state"] != "active":
            break
        tomb = _tombstone(user_id, cur["version"] + 1, "deleting", now_ms)
        if put_item(tomb, cur["version"]):
            cur = tomb
            break
        cur = get_item(user_id) or empty_progress(user_id)       # lost a race: re-read and retry
    else:
        raise ValidationError(409, "concurrent update, retry")

    if cur["state"] == "deleted":                                 # idempotent re-run: only make sure Cognito is clean
        delete_user(user_id)
        return _resp(200, {"deleted": True})

    try:
        delete_user(user_id)
    except Exception:
        return _resp(502, {"error": "account deletion incomplete, retry"})
    final = _tombstone(user_id, cur["version"] + 1, "deleted", now_ms)
    if not put_item(final, cur["version"]):
        return _resp(502, {"error": "account deletion incomplete, retry"})
    return _resp(200, {"deleted": True})


def handle(
    event: dict[str, Any],
    *,
    get_item: Callable[[str], dict[str, Any] | None],
    put_item: Callable[[dict[str, Any], int], bool],
    delete_user: Callable[[str], None],
    valid_card_ids: set[str],
    now_ms: int,
) -> dict[str, Any]:
    """put_item(doc, expected_version) must be a CONDITIONAL write returning False on a
    version conflict. delete_user must treat 'user not found' as success.
    Errors are sanitized: internals are never returned."""
    try:
        # HTTP API v2 gives routeKey ("GET /api/progress"). REST proxy gives httpMethod + a
        # resource of "/api/{proxy+}"; the concrete endpoint is in `path`. Prefer path for REST
        # so a single {proxy+} integration still resolves the real /api/progress|/api/account.
        if event.get("routeKey"):
            route = event["routeKey"]
        else:
            method = event.get("httpMethod", "")
            res = event.get("resource", "")
            endpoint = event.get("path", res) if "{" in res else res
            route = f"{method} {endpoint}".strip()
        user_id = _claim_sub(event)

        if route == "DELETE /api/account":
            return _delete_account(user_id, get_item, put_item, delete_user, now_ms)

        if route not in ("GET /api/progress", "PUT /api/progress"):
            raise ValidationError(404, "no such route")

        current = get_item(user_id) or empty_progress(user_id)
        if current.get("state", "active") != "active":
            raise ValidationError(410, "account deleted")          # never recreate a deleted account's data

        if route == "GET /api/progress":
            return _resp(200, current)

        data = _parse_body(event)
        base_version = data.get("baseVersion")
        if not _is_int(base_version) or base_version < 0:
            raise ValidationError(400, "baseVersion required")
        ops = _validate_ops(data, valid_card_ids)
        if current["version"] != base_version:
            return _resp(409, current)
        updated, results = apply_ops(current, ops)
        if updated["version"] != current["version"] and not put_item(updated, base_version):
            return _resp(409, get_item(user_id) or empty_progress(user_id))
        return _resp(200, {**updated, "results": results})
    except ValidationError as e:
        return _resp(e.status, {"error": e.message})
    except Exception as e:
        # Class name only: messages can carry table names, ids or token fragments.
        log.error("unhandled error: %s", type(e).__name__)
        return _resp(500, {"error": "internal error"})
