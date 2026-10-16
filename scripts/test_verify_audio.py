import json
import os
import tempfile
import unittest

import generate_audio as g
import verify_audio as v

MP3 = b"ID3" + b"\x00" * 2000


def cards():
    return [
        {"id": "a01", "deck": "d1", "voice": "Joanna", "term": "alpha", "example": "An alpha example."},
        {"id": "a02", "deck": "d1", "voice": "Joey", "term": "beta", "example": "A beta example."},
    ]


def populate(d, cs, voice_override=None):
    manifest = {}
    for c in cs:
        for suffix, text in (("t", c["term"]), ("e", c["example"])):
            name = f"{c['id']}-{suffix}.mp3"
            open(os.path.join(d, name), "wb").write(MP3)
            manifest[name] = g.clip_key((voice_override or {}).get(name, c["voice"]), text)
    g.write_manifest(d, manifest)


class TestVerify(unittest.TestCase):
    def test_clean_set_passes(self):
        with tempfile.TemporaryDirectory() as d:
            populate(d, cards())
            self.assertEqual(v.verify(cards(), d), [])

    def test_missing_clip_is_reported(self):
        with tempfile.TemporaryDirectory() as d:
            populate(d, cards())
            os.remove(os.path.join(d, "a01-e.mp3"))
            self.assertTrue(any("a01-e.mp3" in p and "missing" in p for p in v.verify(cards(), d)))

    def test_empty_or_non_mp3_is_reported(self):
        with tempfile.TemporaryDirectory() as d:
            populate(d, cards())
            open(os.path.join(d, "a02-t.mp3"), "wb").write(b"<html>" + b"x" * 2000)
            self.assertTrue(any("a02-t.mp3" in p and "not an MP3" in p for p in v.verify(cards(), d)))

    def test_wrong_voice_is_caught(self):
        with tempfile.TemporaryDirectory() as d:
            populate(d, cards(), voice_override={"a01-t.mp3": "Joey"})   # card a01 is Joanna
            self.assertTrue(any("a01-t.mp3" in p and "voice" in p for p in v.verify(cards(), d)))

    def test_term_and_example_must_share_a_voice(self):
        with tempfile.TemporaryDirectory() as d:
            populate(d, cards(), voice_override={"a02-e.mp3": "Joanna"})
            self.assertTrue(any("a02-e.mp3" in p for p in v.verify(cards(), d)))

    def test_stale_text_is_caught(self):
        with tempfile.TemporaryDirectory() as d:
            populate(d, cards())
            cs = cards()
            cs[0]["term"] = "alpha EDITED"
            self.assertTrue(any("a01-t.mp3" in p for p in v.verify(cs, d)))

    def test_unexpected_extra_file_is_reported(self):
        with tempfile.TemporaryDirectory() as d:
            populate(d, cards())
            open(os.path.join(d, "stray.mp3"), "wb").write(MP3)
            self.assertTrue(any("stray.mp3" in p and "unexpected" in p for p in v.verify(cards(), d)))


if __name__ == "__main__":
    unittest.main()
