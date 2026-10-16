"""Tests for the audio planner: cost cap, voice split, and clip reuse."""
import os
import tempfile
import unittest

import generate_audio as g


def card(i, deck, voice):
    return {"id": f"x{i:02d}", "deck": deck, "voice": voice,
            "term": "term " + str(i), "example": "An example sentence number " + str(i) + "."}


def cards40():
    out = []
    for d in ("a", "b"):
        for i in range(20):
            out.append(card(len(out), d, "Joanna" if i % 2 == 0 else "Joey"))
    return out


class TestPlan(unittest.TestCase):
    def test_two_clips_per_card_same_voice(self):
        items = g.plan(cards40())
        self.assertEqual(len(items), 80)
        by_card = {}
        for voice, _text, name in items:
            by_card.setdefault(name.rsplit("-", 1)[0], set()).add(voice)
        self.assertTrue(all(len(v) == 1 for v in by_card.values()))

    def test_voice_split_is_20_20(self):
        g.assert_voice_split(cards40())  # must not raise

    def test_unbalanced_split_is_rejected(self):
        cs = cards40()
        cs[1]["voice"] = "Joanna"
        with self.assertRaises(SystemExit):
            g.assert_voice_split(cs)

    def test_unknown_voice_is_rejected(self):
        cs = cards40()
        cs[0]["voice"] = "Ruth"
        with self.assertRaises(SystemExit):
            g.assert_voice_split(cs)


class TestAccountGuard(unittest.TestCase):
    def test_expected_account_passes(self):
        g.assert_expected_account("123456789012", expected="123456789012")

    def test_any_other_account_is_refused(self):
        for other in ("210987654321", "", "123456789013"):
            with self.assertRaises(SystemExit):
                g.assert_expected_account(other, expected="123456789012")

    def test_fails_closed_when_expected_is_unset(self):
        # An unset/empty expectation must never be treated as a match, even if the
        # caller's account string is also empty.
        for acct in ("123456789012", ""):
            with self.assertRaises(SystemExit):
                g.assert_expected_account(acct, expected="")


class TestCostCap(unittest.TestCase):
    def test_cost_is_characters_times_rate(self):
        self.assertAlmostEqual(g.cost_usd(1_000_000), 4.00)

    def test_cap_allows_under_and_blocks_over(self):
        g.assert_under_cap(g.cost_usd(2964))        # ~ $0.012, fine
        with self.assertRaises(SystemExit):
            g.assert_under_cap(g.cost_usd(300_000))  # $1.20, over the $1 cap

    def test_cap_is_checked_against_only_clips_that_need_synthesis(self):
        with tempfile.TemporaryDirectory() as d:
            items = g.plan(cards40())
            for _v, _t, name in items:
                open(os.path.join(d, name), "wb").write(b"ID3" + b"\0" * 2000)
            todo = g.clips_to_synthesize(items, d)
            self.assertEqual(todo, [])


class TestReuse(unittest.TestCase):
    def test_reuses_valid_clip_and_regenerates_missing_or_empty(self):
        with tempfile.TemporaryDirectory() as d:
            items = g.plan(cards40())[:3]
            open(os.path.join(d, items[0][2]), "wb").write(b"ID3" + b"\0" * 2000)  # valid
            open(os.path.join(d, items[1][2]), "wb").write(b"")                      # empty -> redo
            todo = g.clips_to_synthesize(items, d)                                   # items[2] missing
            self.assertEqual([n for _v, _t, n in todo], [items[1][2], items[2][2]])

    def test_changed_text_triggers_regeneration(self):
        with tempfile.TemporaryDirectory() as d:
            items = g.plan(cards40())[:1]
            voice, text, name = items[0]
            open(os.path.join(d, name), "wb").write(b"ID3" + b"\0" * 2000)
            g.write_manifest(d, {name: g.clip_key(voice, text)})
            self.assertEqual(g.clips_to_synthesize(items, d), [])
            changed = [(voice, text + " (edited)", name)]
            self.assertEqual(g.clips_to_synthesize(changed, d), changed)


if __name__ == "__main__":
    unittest.main()
