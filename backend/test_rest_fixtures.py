"""Real REST (API Gateway v1) Lambda-proxy event fixtures through a {proxy+} resource.
Proves the handler resolves the actual progress/account endpoints from REST events, not just
hand-made route strings. Nothing here touches AWS.
"""
import json, os, unittest
import sys; sys.path.insert(0, os.path.dirname(__file__))
from handler import handle
from test_handler import FakeBackend

VALID={"t01","t02","c01"}
def status(d="A",seq=1,c="t01",s="known",b=0): return {"kind":"status","deviceId":d,"seq":seq,"cardId":c,"status":s,"baseRev":b}

def wire(store=None):
    store=store if store is not None else {}
    def get(u): 
        import copy; return copy.deepcopy(store.get(u))
    def put(doc,ev):
        cur=store.get(doc["userId"]); 
        if (cur["version"] if cur else 0)!=ev: return False
        import copy; store[doc["userId"]]=copy.deepcopy(doc); return True
    return dict(get_item=get,put_item=put,delete_user=lambda u:store.pop(u,None),valid_card_ids=VALID,now_ms=1700000000000), store

# A REST proxy integration routes /api/{proxy+} -> one Lambda. The event carries the FULL path in
# `path`/`resource`, httpMethod, the stage in requestContext, and Cognito claims under authorizer.claims.
def rest_event(method, path, sub="user-A", body=None):
    return {
        "resource": "/api/{proxy+}",
        "path": path,
        "httpMethod": method,
        "pathParameters": {"proxy": path.split("/api/",1)[1]},
        "requestContext": {
            "stage": "prod",
            "resourcePath": "/api/{proxy+}",
            "httpMethod": method,
            "authorizer": {"claims": {"sub": sub, "token_use": "access",
                                      "scope": "english-flashcards/progress"}},
        },
        "headers": {"Authorization": "Bearer <redacted>"},
        "body": json.dumps(body) if body is not None else None,
    }

class TestRestProxyFixtures(unittest.TestCase):
    def test_get_progress_via_proxy(self):
        w,store=wire()
        r=handle(rest_event("GET","/api/progress"),**w)
        self.assertEqual(r["statusCode"],200)
        self.assertEqual(json.loads(r["body"])["version"],0)

    def test_put_progress_via_proxy_applies(self):
        w,store=wire()
        r=handle(rest_event("PUT","/api/progress",body={"baseVersion":0,"ops":[status()]}),**w)
        self.assertEqual(r["statusCode"],200)
        self.assertEqual(store["user-A"]["cards"]["t01"]["status"],"known")

    def test_delete_account_via_proxy(self):
        b=FakeBackend(); b.cognito_users.add("user-A")
        handle(rest_event("PUT","/api/progress",body={"baseVersion":0,"ops":[status()]}),**b.wire())
        r=handle(rest_event("DELETE","/api/account"),**b.wire())
        self.assertEqual(r["statusCode"],200)
        self.assertEqual(b.store["user-A"]["state"],"deleted")

    def test_isolation_proxy_user_from_claims_only(self):
        w,store=wire()
        handle(rest_event("PUT","/api/progress",sub="A",body={"baseVersion":0,"userId":"B","ops":[status()]}),**w)
        self.assertIn("A",store); self.assertNotIn("B",store)

    def test_unknown_proxy_path_404(self):
        w,_=wire()
        self.assertEqual(handle(rest_event("GET","/api/nope"),**w)["statusCode"],404)

    def test_missing_authorizer_claims_401(self):
        w,_=wire()
        e=rest_event("GET","/api/progress"); e["requestContext"]["authorizer"]={}
        self.assertEqual(handle(e,**w)["statusCode"],401)
if __name__=="__main__": unittest.main()
