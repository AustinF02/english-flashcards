import hashlib
import os
import tempfile
import unittest
import zipfile

import build_lambda as b


class TestBuild(unittest.TestCase):
    def build(self, out):
        return b.build(out)

    def test_zip_contains_exactly_the_runtime_files(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.build(d)
            with zipfile.ZipFile(path) as z:
                self.assertEqual(sorted(z.namelist()), ["cards.json", "handler.py", "index.py"])
                self.assertIsNone(z.testzip())

    def test_no_tests_secrets_or_caches_are_packaged(self):
        with tempfile.TemporaryDirectory() as d:
            names = zipfile.ZipFile(self.build(d)).namelist()
            self.assertFalse([n for n in names if n.startswith("test_") or "__pycache__" in n or n.endswith(".env")])

    def test_build_is_deterministic_and_named_by_content_hash(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as c:
            p1, p2 = self.build(a), self.build(c)
            h1 = hashlib.sha256(open(p1, "rb").read()).hexdigest()
            h2 = hashlib.sha256(open(p2, "rb").read()).hexdigest()
            self.assertEqual(h1, h2)
            self.assertEqual(os.path.basename(p1), f"progress-{h1[:16]}.zip")

    def test_packaged_handler_matches_source(self):
        with tempfile.TemporaryDirectory() as d:
            z = zipfile.ZipFile(self.build(d))
            self.assertEqual(z.read("handler.py"), open(os.path.join(b.BACKEND, "handler.py"), "rb").read())


if __name__ == "__main__":
    unittest.main()
