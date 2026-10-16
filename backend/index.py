"""Lambda entrypoint: wires real AWS clients into handler.handle().

Environment (set by CloudFormation, none are secrets):
  TABLE_NAME     DynamoDB table
  USER_POOL_ID   Cognito user pool (for account deletion)
Card ids come from cards.json shipped inside the deployment package.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any

import boto3
from botocore.exceptions import ClientError

from handler import handle

_TABLE = os.environ.get("TABLE_NAME", "")
_POOL = os.environ.get("USER_POOL_ID", "")

_ddb = boto3.client("dynamodb")
_cognito = boto3.client("cognito-idp")

with open(os.path.join(os.path.dirname(__file__), "cards.json"), encoding="utf-8") as _f:
    _VALID_IDS = {c["id"] for c in json.load(_f)}


def _get_item(user_id: str) -> dict[str, Any] | None:
    r = _ddb.get_item(TableName=_TABLE, Key={"userId": {"S": user_id}}, ConsistentRead=True)
    item = r.get("Item")
    if not item:
        return None
    return json.loads(item["doc"]["S"])


def _put_item(doc: dict[str, Any], expected_version: int) -> bool:
    """Conditional write: succeeds only if the stored version still equals what we read.
    A 'deleted' tombstone also carries `expiresAt` (epoch seconds) as a top-level number,
    which is the table's TTL attribute; live items never have one."""
    item = {"userId": {"S": doc["userId"]},
            "version": {"N": str(doc["version"])},
            "doc": {"S": json.dumps(doc)}}
    if "expiresAt" in doc:
        item["expiresAt"] = {"N": str(int(doc["expiresAt"]))}
    try:
        _ddb.put_item(
            TableName=_TABLE,
            Item=item,
            ConditionExpression="attribute_not_exists(userId) OR #v = :expected",
            ExpressionAttributeNames={"#v": "version"},
            ExpressionAttributeValues={":expected": {"N": str(expected_version)}},
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def _delete_user(user_id: str) -> None:
    # Username may be the user's `sub` when username is not an alias attribute (AdminDeleteUser docs).
    # An already-deleted user is success, which is what makes the DELETE route safe to retry.
    try:
        _cognito.admin_delete_user(UserPoolId=_POOL, Username=user_id)
    except ClientError as e:
        if e.response["Error"]["Code"] != "UserNotFoundException":
            raise


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    return handle(
        event,
        get_item=_get_item,
        put_item=_put_item,
        delete_user=_delete_user,
        valid_card_ids=_VALID_IDS,
        now_ms=int(time.time() * 1000),
    )
