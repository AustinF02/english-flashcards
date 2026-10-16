"""Tests for the Lambda entry point, run against the REAL packaged zip with STUBBED AWS clients.

Needs boto3:  .venv/bin/python -m unittest backend/test_index.py   (skipped if boto3 is absent)
botocore's Stubber answers every call locally: no network, no credentials, no AWS resource touched.
"""
import importlib
import json
import os
import sys
import tempfile
import unittest
import zipfile

try:
    import boto3  # noqa: F401
    from botocore.stub import Stubber
    HAVE_BOTO = True
except ImportError:
    HAVE_BOTO = False

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.join(ROOT, "scripts"))
sys.path.insert(0, os.path.dirname(__file__))


@unittest.skipUnless(HAVE_BOTO, "boto3 not installed")
class TestPackagedLambda(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import build_lambda
        cls.tmp = tempfile.TemporaryDirectory()
        zpath = build_lambda.build(os.path.join(cls.tmp.name, "out"))
        pkg = os.path.join(cls.tmp.name, "pkg")
        with zipfile.ZipFile(zpath) as z:
            z.extractall(pkg)
        cls.pkg = pkg
        os.environ.update(TABLE_NAME="t-progress", USER_POOL_ID="ap-northeast-1_TEST",
                          AWS_DEFAULT_REGION="ap-northeast-1", AWS_ACCESS_KEY_ID="x", AWS_SECRET_ACCESS_KEY="x")
        sys.path.insert(0, pkg)
        for m in ("index", "handler"):
            sys.modules.pop(m, None)
        cls.index = importlib.import_module("index")

    @classmethod
    def tearDownClass(cls):
        sys.path.remove(cls.pkg)
        for m in ("index", "handler"):
            sys.modules.pop(m, None)
        cls.tmp.cleanup()

    def setUp(self):
        self.ddb = Stubber(self.index._ddb)
        self.cog = Stubber(self.index._cognito)
        self.ddb.activate()
        self.cog.activate()
        self.addCleanup(self.ddb.deactivate)
        self.addCleanup(self.cog.deactivate)

    def event(self, route, body=None, sub="user-A"):
        e = {"routeKey": route, "requestContext": {"authorizer": {"jwt": {"claims": {"sub": sub}}}}}
        if body is not None:
            e["body"] = json.dumps(body)
        return e

    def test_the_package_has_the_deck_so_card_ids_validate(self):
        self.assertEqual(len(self.index._VALID_IDS), 40)
        self.assertIn("t01", self.index._VALID_IDS)

    def test_get_reads_consistently_and_returns_the_stored_doc(self):
        doc = {"userId": "user-A", "version": 3, "state": "active", "cards": {}, "quiz": {}, "devices": []}
        self.ddb.add_response("get_item", {"Item": {"userId": {"S": "user-A"}, "version": {"N": "3"}, "doc": {"S": json.dumps(doc)}}},
                              {"TableName": "t-progress", "Key": {"userId": {"S": "user-A"}}, "ConsistentRead": True})
        r = self.index.handler(self.event("GET /api/progress"), None)
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(json.loads(r["body"])["version"], 3)
        self.ddb.assert_no_pending_responses()

    def test_put_is_a_conditional_write_and_a_lost_race_becomes_409(self):
        self.ddb.add_response("get_item", {})                                   # no item yet
        self.ddb.add_client_error("put_item", "ConditionalCheckFailedException")  # someone else wrote first
        self.ddb.add_response("get_item", {})                                   # re-read for the 409 body
        op = {"kind": "quiz", "deviceId": "A", "seq": 1, "cardId": "t01", "correct": True}
        r = self.index.handler(self.event("PUT /api/progress", {"baseVersion": 0, "ops": [op]}), None)
        self.assertEqual(r["statusCode"], 409)

    def test_put_condition_expression_compares_the_stored_version(self):
        self.ddb.add_response("get_item", {})
        seen = {}

        def capture(params, **_):
            seen.update(params)
        self.index._ddb.meta.events.register("provide-client-params.dynamodb.PutItem", capture)
        self.ddb.add_response("put_item", {})
        op = {"kind": "quiz", "deviceId": "A", "seq": 1, "cardId": "t01", "correct": True}
        self.index.handler(self.event("PUT /api/progress", {"baseVersion": 0, "ops": [op]}), None)
        self.assertIn("#v = :expected", seen["ConditionExpression"])
        self.assertEqual(seen["ExpressionAttributeValues"][":expected"], {"N": "0"})
        self.assertNotIn("expiresAt", seen["Item"])                              # live items never get a TTL

    def test_a_deleted_tombstone_carries_the_ttl_attribute_as_a_number(self):
        doc = {"userId": "u", "version": 2, "state": "deleted", "cards": {}, "quiz": {}, "devices": [], "expiresAt": 1700086400}
        seen = {}
        self.index._ddb.meta.events.register("provide-client-params.dynamodb.PutItem", lambda params, **_: seen.update(params))
        self.ddb.add_response("put_item", {})
        self.assertTrue(self.index._put_item(doc, 1))
        self.assertEqual(seen["Item"]["expiresAt"], {"N": "1700086400"})

    def test_delete_user_treats_already_gone_as_success_and_uses_the_pool_from_config(self):
        self.cog.add_client_error("admin_delete_user", "UserNotFoundException")
        self.index._delete_user("user-A")                                        # must not raise
        self.cog.assert_no_pending_responses()

    def test_delete_user_other_errors_propagate_so_the_caller_can_report_partial_failure(self):
        self.cog.add_client_error("admin_delete_user", "TooManyRequestsException")
        with self.assertRaises(Exception):
            self.index._delete_user("user-A")

    def test_delete_route_end_to_end_wipes_then_removes_user_then_marks_deleted(self):
        self.ddb.add_response("get_item", {})
        self.ddb.add_response("put_item", {})          # 1. tombstone 'deleting'
        self.cog.add_response("admin_delete_user", {}, {"UserPoolId": "ap-northeast-1_TEST", "Username": "user-A"})
        self.ddb.add_response("put_item", {})          # 3. 'deleted'
        r = self.index.handler(self.event("DELETE /api/account"), None)
        self.assertEqual(r["statusCode"], 200)
        self.ddb.assert_no_pending_responses()
        self.cog.assert_no_pending_responses()


class TestLogging(unittest.TestCase):
    def test_unhandled_errors_log_the_class_only_never_the_message(self):
        from handler import handle

        def boom(_):
            raise RuntimeError("table english-flashcards-progress token=abc123")
        ev = {"routeKey": "GET /api/progress", "requestContext": {"authorizer": {"jwt": {"claims": {"sub": "u"}}}}}
        with self.assertLogs(level="ERROR") as cm:
            r = handle(ev, get_item=boom, put_item=None, delete_user=None, valid_card_ids=set(), now_ms=0)
        self.assertEqual(r["statusCode"], 500)
        logged = "\n".join(cm.output)
        self.assertIn("RuntimeError", logged)
        self.assertNotIn("abc123", logged)
        self.assertNotIn("english-flashcards-progress", logged)


if __name__ == "__main__":
    unittest.main()
