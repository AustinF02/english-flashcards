"""Tests for the progress handler (pure logic; no AWS, no credentials).

Run:  cd backend && python3 -m unittest -v
The conflict/idempotency rules are driven by the SAME vectors the frontend uses
(test/vectors/progress.json), so the two implementations cannot drift apart.
"""
import json
import os
import unittest

from handler import (handle, apply_ops, empty_progress, MAX_OPS_PER_REQUEST, MAX_DEVICES,
                     TOMBSTONE_TTL_SECONDS)

VECTORS = json.load(open(os.path.join(os.path.dirname(__file__), "..", "test", "vectors", "progress.json")))
VALID_IDS = {"t01", "t02", "c01"}
NOW = 1_700_000_000_000


def status(device="A", seq=1, card="t01", s="known", base=0):
    return {"kind": "status", "deviceId": device, "seq": seq, "cardId": card, "status": s, "baseRev": base}


def quiz(device="A", seq=1, card="t01", correct=True):
    return {"kind": "quiz", "deviceId": device, "seq": seq, "cardId": card, "correct": correct}


def event(route, sub="user-A", body=None):
    e = {"routeKey": route}
    if sub is not None:
        e["requestContext"] = {"authorizer": {"jwt": {"claims": {"sub": sub}}}}
    if body is not None:
        e["body"] = json.dumps(body)
    return e


class FakeBackend:
    """In-memory stand-in for DynamoDB + Cognito. Nothing real is touched."""

    def __init__(self):
        self.store = {}
        self.cognito_users = set()
        self.cognito_fails = 0          # fail the next N delete_user calls
        self.before_put = None          # hook: runs once before the next put (to inject a concurrent write)
        self.calls = []

    def get(self, uid):
        d = self.store.get(uid)
        return json.loads(json.dumps(d)) if d else None

    def put(self, doc, expected_version):
        if self.before_put:
            hook, self.before_put = self.before_put, None
            hook(self)
        cur = self.store.get(doc["userId"])
        if (cur["version"] if cur else 0) != expected_version:
            return False
        self.store[doc["userId"]] = json.loads(json.dumps(doc))
        return True

    def delete_user(self, uid):
        self.calls.append(("delete_user", uid))
        if self.cognito_fails > 0:
            self.cognito_fails -= 1
            raise RuntimeError("cognito down")
        self.cognito_users.discard(uid)         # already-gone is success (index.py treats UserNotFound as success)

    def wire(self, now_ms=NOW):
        return dict(get_item=self.get, put_item=self.put, delete_user=self.delete_user,
                    valid_card_ids=VALID_IDS, now_ms=now_ms)


def put_ops(b, ops, sub="user-A", base=None):
    cur = b.get(sub) or empty_progress(sub)
    return handle(event("PUT /api/progress", sub=sub,
                        body={"baseVersion": cur["version"] if base is None else base, "ops": ops}), **b.wire())


class TestSharedVectors(unittest.TestCase):
    def test_every_vector_matches_the_frontend(self):
        for c in VECTORS["cases"]:
            with self.subTest(c["name"]):
                prev = {**empty_progress("u"), **c["initial"]}
                before = json.dumps(prev, sort_keys=True)
                state, results = apply_ops(prev, c["ops"])
                self.assertEqual([r["outcome"] for r in results], c["results"])
                for k, v in c["expect"].items():
                    self.assertEqual(state[k], v, k)
                self.assertEqual(json.dumps(prev, sort_keys=True), before, "input must not be mutated")


class TestAuthAndIsolation(unittest.TestCase):
    def test_rejects_unauthenticated(self):
        self.assertEqual(handle({"routeKey": "GET /api/progress"}, **FakeBackend().wire())["statusCode"], 401)

    def test_user_id_comes_from_token_not_body(self):
        b = FakeBackend()
        handle(event("PUT /api/progress", sub="user-A", body={"baseVersion": 0, "userId": "user-B", "ops": [status()]}), **b.wire())
        self.assertIn("user-A", b.store)
        self.assertNotIn("user-B", b.store)

    def test_users_are_isolated(self):
        b = FakeBackend()
        put_ops(b, [status()], sub="user-A")
        r = handle(event("GET /api/progress", sub="user-B"), **b.wire())
        self.assertEqual(json.loads(r["body"])["cards"], {})

    def test_two_users_may_reuse_the_same_device_id(self):
        b = FakeBackend()
        put_ops(b, [status("A", 1)], sub="user-A")
        r = put_ops(b, [status("A", 1)], sub="user-B")
        self.assertEqual(json.loads(r["body"])["results"][0]["outcome"], "applied")

    def test_response_never_marks_cacheable(self):
        r = handle(event("GET /api/progress"), **FakeBackend().wire())
        self.assertEqual(r["headers"]["cache-control"], "no-store")


class TestValidation(unittest.TestCase):
    def put(self, body):
        return handle(event("PUT /api/progress", body=body), **FakeBackend().wire())["statusCode"]

    def test_bad_inputs_are_rejected(self):
        bad = {
            "unknown card": status(card="nope"),
            "bad status": status(s="mastered"),
            "unknown kind": {"kind": "delete", "deviceId": "A", "seq": 1, "cardId": "t01"},
            "quiz correct must be bool": {"kind": "quiz", "deviceId": "A", "seq": 1, "cardId": "t01", "correct": "yes"},
            "baseRev negative": status(base=-1),
            "baseRev not int": status(base="0"),
            "baseRev bool": status(base=True),
            "seq zero": status(seq=0),
            "seq string": status(seq="1"),
            "seq bool": status(seq=True),
            "deviceId empty": status(device=""),
            "deviceId too long": status(device="x" * 65),
            "deviceId bad chars": status(device="a b/c"),
        }
        for name, op in bad.items():
            with self.subTest(name):
                self.assertEqual(self.put({"baseVersion": 0, "ops": [op]}), 400)

    def test_client_time_is_ignored_not_trusted(self):
        op = status()
        op["clientTime"] = "garbage"
        self.assertEqual(self.put({"baseVersion": 0, "ops": [op]}), 200)

    def test_too_many_ops_rejected(self):
        ops = [quiz("A", i + 1) for i in range(MAX_OPS_PER_REQUEST + 1)]
        self.assertEqual(self.put({"baseVersion": 0, "ops": ops}), 400)

    def test_oversize_payload_rejected(self):
        big = {"routeKey": "PUT /api/progress", "requestContext": {"authorizer": {"jwt": {"claims": {"sub": "u"}}}},
               "body": "x" * (32 * 1024 + 1)}
        self.assertEqual(handle(big, **FakeBackend().wire())["statusCode"], 413)

    def test_base_version_validation(self):
        self.assertEqual(self.put({"ops": [status()]}), 400)
        self.assertEqual(self.put({"baseVersion": True, "ops": [status()]}), 400)

    def test_errors_are_sanitized(self):
        def boom(_):
            raise RuntimeError("secret table name leaked")
        r = handle(event("GET /api/progress"), **{**FakeBackend().wire(), "get_item": boom})
        self.assertEqual(r["statusCode"], 500)
        self.assertNotIn("secret", r["body"])

    def test_unknown_route_404(self):
        self.assertEqual(handle(event("GET /api/other"), **FakeBackend().wire())["statusCode"], 404)


class TestSyncThroughTheHandler(unittest.TestCase):
    def test_get_returns_empty_without_persisting(self):
        b = FakeBackend()
        r = handle(event("GET /api/progress"), **b.wire())
        self.assertEqual(json.loads(r["body"])["version"], 0)
        self.assertEqual(b.store, {})

    def test_stale_base_version_returns_409_with_the_current_item(self):
        b = FakeBackend()
        put_ops(b, [status("A", 1)])
        r = put_ops(b, [status("B", 1, card="t02")], base=0)
        self.assertEqual(r["statusCode"], 409)
        self.assertEqual(json.loads(r["body"])["version"], 1)

    def test_lost_response_retry_does_not_double_count(self):
        b = FakeBackend()
        ops = [quiz("A", 1)]
        put_ops(b, ops, base=0)                          # commits; client never sees the 200
        r = put_ops(b, ops, base=0)                      # naive retry with the old base -> 409
        self.assertEqual(r["statusCode"], 409)
        cur = json.loads(r["body"])
        r2 = put_ops(b, ops, base=cur["version"])        # retry with the fresh base -> duplicate
        body = json.loads(r2["body"])
        self.assertEqual(r2["statusCode"], 200)
        self.assertEqual([x["outcome"] for x in body["results"]], ["duplicate"])
        self.assertEqual(body["quiz"]["t01"], {"seen": 1, "correct": 1})

    def test_two_concurrent_retries_of_one_batch_count_once(self):
        b = FakeBackend()
        ops = [quiz("A", 1)]
        # the second request lands between the first request's read and write
        b.before_put = lambda be: be.store.update({"user-A": {**empty_progress("user-A"), "version": 1,
                                                              "quiz": {"t01": {"seen": 1, "correct": 1}},
                                                              "devices": [["A", 1]]}})
        r1 = put_ops(b, ops, base=0)
        self.assertEqual(r1["statusCode"], 409)           # lost the race
        r2 = put_ops(b, ops, base=1)
        self.assertEqual([x["outcome"] for x in json.loads(r2["body"])["results"]], ["duplicate"])
        self.assertEqual(b.store["user-A"]["quiz"]["t01"], {"seen": 1, "correct": 1})

    def test_counter_totals_are_unchanged_by_a_thousand_replays(self):
        b = FakeBackend()
        put_ops(b, [quiz("A", 1), quiz("A", 2, correct=False)])
        for _ in range(1000):
            put_ops(b, [quiz("A", 1), quiz("A", 2, correct=False)])
        self.assertEqual(b.store["user-A"]["quiz"]["t01"], {"seen": 2, "correct": 1})
        self.assertEqual(b.store["user-A"]["version"], 1)   # replays never bump the version

    def test_old_op_is_still_a_duplicate_after_many_newer_ones(self):
        b = FakeBackend()
        put_ops(b, [quiz("A", 1)])
        for chunk in range(0, 300, 50):                      # 300 later ops: far past the old 200-op window
            put_ops(b, [quiz("A", chunk + i + 2) for i in range(50)])
        before = json.loads(json.dumps(b.store["user-A"]["quiz"]))
        put_ops(b, [quiz("A", 1)])
        self.assertEqual(b.store["user-A"]["quiz"], before)

    def test_device_state_stays_bounded(self):
        b = FakeBackend()
        for i in range(MAX_DEVICES + 5):
            put_ops(b, [quiz(f"dev{i}", 1)])
        self.assertEqual(len(b.store["user-A"]["devices"]), MAX_DEVICES)


class TestAccountDeletion(unittest.TestCase):
    def delete(self, b, sub="user-A"):
        return handle(event("DELETE /api/account", sub=sub), **b.wire())

    def setUp(self):
        self.b = FakeBackend()
        self.b.cognito_users.add("user-A")
        put_ops(self.b, [status(), quiz("A", 2)])

    def test_happy_path_wipes_data_removes_user_and_leaves_only_a_tombstone(self):
        r = self.delete(self.b)
        self.assertEqual(r["statusCode"], 200)
        doc = self.b.store["user-A"]
        self.assertEqual(doc["state"], "deleted")
        self.assertEqual((doc["cards"], doc["quiz"], doc["devices"]), ({}, {}, []))
        self.assertNotIn("user-A", self.b.cognito_users)
        self.assertEqual(doc["expiresAt"], NOW // 1000 + TOMBSTONE_TTL_SECONDS)

    def test_progress_is_wiped_BEFORE_the_cognito_call(self):
        seen = {}
        orig = self.b.delete_user
        self.b.delete_user = lambda uid: (seen.update(state=self.b.store["user-A"]["state"],
                                                      cards=self.b.store["user-A"]["cards"]), orig(uid))
        self.delete(self.b)
        self.assertEqual(seen, {"state": "deleting", "cards": {}})

    def test_cognito_failure_is_reported_and_leaves_a_blocked_account_not_live_data(self):
        self.b.cognito_fails = 1
        r = self.delete(self.b)
        self.assertEqual(r["statusCode"], 502)
        self.assertEqual(json.loads(r["body"]), {"error": "account deletion incomplete, retry"})
        self.assertEqual(self.b.store["user-A"]["state"], "deleting")
        self.assertEqual(self.b.store["user-A"]["cards"], {})
        self.assertNotIn("expiresAt", self.b.store["user-A"])      # no TTL while unfinished

    def test_retry_after_partial_failure_completes(self):
        self.b.cognito_fails = 1
        self.delete(self.b)
        r = self.delete(self.b)
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(self.b.store["user-A"]["state"], "deleted")
        self.assertNotIn("user-A", self.b.cognito_users)

    def test_deleting_twice_is_idempotent(self):
        self.delete(self.b)
        self.assertEqual(self.delete(self.b)["statusCode"], 200)
        self.assertEqual(self.b.store["user-A"]["state"], "deleted")

    def test_progress_cannot_be_resurrected_after_deletion(self):
        self.delete(self.b)
        for ops, base in (([status("Z", 1, card="t02")], 0), ([quiz("Z", 1)], 99)):
            r = handle(event("PUT /api/progress", body={"baseVersion": base, "ops": ops}), **self.b.wire())
            self.assertEqual(r["statusCode"], 410)
        self.assertEqual(self.b.store["user-A"]["quiz"], {})
        self.assertEqual(handle(event("GET /api/progress"), **self.b.wire())["statusCode"], 410)

    def test_a_blocked_account_in_deleting_state_also_refuses_writes(self):
        self.b.cognito_fails = 1
        self.delete(self.b)
        r = put_ops(self.b, [quiz("A", 3)])
        self.assertEqual(r["statusCode"], 410)

    def test_a_write_racing_the_tombstone_cannot_survive(self):
        # a normal PUT lands between our read and our tombstone write
        self.b.before_put = lambda be: be.store["user-A"].update(version=be.store["user-A"]["version"] + 1,
                                                                  quiz={"t01": {"seen": 99, "correct": 99}})
        r = self.delete(self.b)
        self.assertEqual(r["statusCode"], 200)               # retried against the fresh version
        self.assertEqual(self.b.store["user-A"]["quiz"], {})
        self.assertEqual(self.b.store["user-A"]["state"], "deleted")

    def test_gives_up_with_409_if_it_keeps_losing_the_race(self):
        def always_race(be):
            be.store["user-A"]["version"] += 1
            be.before_put = always_race
        self.b.before_put = always_race
        self.assertEqual(self.delete(self.b)["statusCode"], 409)
        self.assertEqual(self.b.calls, [])                    # never reached Cognito with live data

    def test_deleting_a_user_who_never_wrote_anything_still_blocks_and_finishes(self):
        b = FakeBackend()
        b.cognito_users.add("fresh")
        self.assertEqual(handle(event("DELETE /api/account", sub="fresh"), **b.wire())["statusCode"], 200)
        self.assertEqual(b.store["fresh"]["state"], "deleted")

    def test_one_users_deletion_does_not_touch_another(self):
        put_ops(self.b, [status()], sub="user-B")
        self.delete(self.b)
        self.assertEqual(self.b.store["user-B"]["cards"], {"t01": {"status": "known", "rev": 1}})
        self.assertEqual(self.b.calls, [("delete_user", "user-A")])


class TestRestEventShape(unittest.TestCase):
    """REST (COGNITO_USER_POOLS authorizer + Lambda proxy) delivers a different event than HTTP API v2:
    claims at requestContext.authorizer.claims.<x>, and httpMethod+resource instead of routeKey.
    The handler must accept BOTH shapes so the same business logic serves either API type."""

    def rest(self, method, resource, sub="user-A", body=None):
        e = {"httpMethod": method, "resource": resource,
             "requestContext": {"authorizer": {"claims": {"sub": sub}}}}
        if body is not None:
            e["body"] = json.dumps(body)
        return e

    def test_rest_get_is_recognized_and_isolated(self):
        b = FakeBackend()
        put_ops(b, [status()], sub="user-A")
        r = handle(self.rest("GET", "/api/progress", sub="user-B"), **b.wire())
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(json.loads(r["body"])["cards"], {})

    def test_rest_put_applies_and_derives_user_from_claims_only(self):
        b = FakeBackend()
        body = {"baseVersion": 0, "userId": "user-B", "ops": [status()]}
        r = handle(self.rest("PUT", "/api/progress", sub="user-A", body=body), **b.wire())
        self.assertEqual(r["statusCode"], 200)
        self.assertIn("user-A", b.store)
        self.assertNotIn("user-B", b.store)

    def test_rest_delete_account(self):
        b = FakeBackend(); b.cognito_users.add("user-A"); put_ops(b, [status()])
        self.assertEqual(handle(self.rest("DELETE", "/api/account"), **b.wire())["statusCode"], 200)

    def test_rest_unauthenticated_rejected(self):
        r = handle({"httpMethod": "GET", "resource": "/api/progress", "requestContext": {}}, **FakeBackend().wire())
        self.assertEqual(r["statusCode"], 401)

    def test_rest_unknown_route_404(self):
        self.assertEqual(handle(self.rest("GET", "/api/other"), **FakeBackend().wire())["statusCode"], 404)

    def test_http_v2_shape_still_works(self):
        b = FakeBackend()
        r = handle(event("GET /api/progress"), **b.wire())   # original HTTP API event
        self.assertEqual(r["statusCode"], 200)


if __name__ == "__main__":
    unittest.main()
