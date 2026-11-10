"""Tests for the pipeline, the published data and page/backtest parity.

Run:  python3 -m unittest discover -s tests -v
The parity test needs google-chrome (or set CHROME=/path/to/chrome) and skips without it.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
import model  # noqa: E402

DATA = ROOT / "docs" / "data"


class ModelTests(unittest.TestCase):
    def test_midpoint_percentile(self):
        d = model.Dist([1, 2, 2, 3])
        self.assertAlmostEqual(d.pct(1), 0.125)
        self.assertAlmostEqual(d.pct(2), 0.5)
        self.assertAlmostEqual(d.pct(3), 0.875)
        self.assertAlmostEqual(d.pct(2.5), 0.75)  # between values: everything below
        self.assertEqual(d.table(), [[1, 1], [2, 2], [3, 1]])

    def test_twins_include_ties_and_ignore_order(self):
        pool = [((0.5, 0.5, 0.5, 3), i) for i in range(5)] + [((0.9, 0.9, 0.9, 3), 9)]
        got = model.twins((0.5, 0.5, 0.5, 3), pool, k=2)
        self.assertEqual(len(got), 5)  # all five tied twins, not just two
        self.assertEqual(sorted(p for _, p in got), [0, 1, 2, 3, 4])
        got_rev = model.twins((0.5, 0.5, 0.5, 3), pool[::-1], k=2)
        self.assertEqual(sorted(p for _, p in got), sorted(p for _, p in got_rev))

    def test_wilson(self):
        lo, hi = model.wilson(50, 100)
        self.assertAlmostEqual(lo, 0.404, places=3)
        self.assertAlmostEqual(hi, 0.596, places=3)
        self.assertEqual(model.wilson(0, 0), (0.0, 1.0))

    def test_movement(self):
        self.assertEqual(model.movement([3, 5], [5, 5]), "up")
        self.assertEqual(model.movement([5, 5], [5, 5]), "same")
        self.assertEqual(model.movement([6, 5], [5, 5]), "down")
        self.assertIsNone(model.movement(None, [5]))


@unittest.skipUnless((DATA / "meta.json").exists(), "run pipeline/build.py first")
class OutputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.meta = json.loads((DATA / "meta.json").read_text())
        cls.papers = json.loads((DATA / "papers.json").read_text())

    def test_page_uses_model_settings_from_meta(self):
        m = self.meta["model"]
        self.assertEqual((m["k"], m["w_mean"], m["w_low"], m["w_high"], m["n_penalty"]),
                         (model.K_TWINS, model.W_MEAN, model.W_LOW, model.W_HIGH, model.N_PENALTY))
        js = (ROOT / "docs" / "app.js").read_text()
        self.assertIn("META.model.k", js)
        for name in ("w_mean", "w_low", "w_high", "n_penalty"):
            self.assertIn(f"m.{name}", js)

    def test_sizes_and_counts(self):
        years = self.meta["years"]
        self.assertGreater(years["2024"]["reviewed"], 7000)
        self.assertGreater(years["2025"]["reviewed"], 11000)
        self.assertGreater(years["2026"]["reviewed"], 19000)
        for y in ("2024", "2025"):
            self.assertGreater(years[y]["with_initial"] / years[y]["reviewed"], 0.9)
        self.assertEqual(len(self.papers["rows"]), sum(v["reviewed"] for v in years.values()))

    def test_rows_hold_only_numbers_and_ids(self):
        cols = self.papers["columns"]
        self.assertEqual(cols, ["y", "id", "o", "i", "f", "fi", "ff", "a", "mv", "r", "w"])
        for row in self.papers["rows"]:
            r = dict(zip(cols, row))
            self.assertRegex(r["id"], r"^[A-Za-z0-9_-]{6,16}$")
            self.assertIn(r["o"], "RPSOWD")
            scale = self.meta["years"][str(r["y"])]["scale"]
            self.assertTrue(all(s in scale for s in r["f"]))
            if r["i"]:
                self.assertEqual(len(r["i"]), len(r["f"]))
            self.assertTrue(all(0 <= v <= 1000 for v in r["ff"]))
            self.assertEqual(r["a"] is None, r["o"] not in "RPSO")

    def test_score_line_explains_most_decisions(self):
        for y in ("2024", "2025", "2026"):
            line = self.meta["years"][y]["line"]
            self.assertGreater(line["agreement"], 0.75)
            self.assertTrue(0.3 < line["accept_rate"] < 0.5)

    def test_validation_present_and_useful(self):
        v = self.meta["validation"]
        self.assertIsNotNone(v, "run pipeline/backtest.py, then build.py")
        self.assertGreater(v["ac_2026_from_2024_2025"]["auc"], 0.85)
        self.assertLess(v["ac_2026_from_2024_2025"]["brier"], v["ac_2026_from_2024_2025"]["brier_base"])


def chrome():
    return os.environ.get("CHROME") or shutil.which("google-chrome") or shutil.which("chromium")


@unittest.skipUnless(chrome() and (DATA / "meta.json").exists(), "needs Chrome and built data")
class ParityTest(unittest.TestCase):
    """The page and the Python model must give the same twins for the same input."""

    def python_answer(self, year, scores):
        meta = json.loads((DATA / "meta.json").read_text())
        cols = json.loads((DATA / "papers.json").read_text())
        rows = [dict(zip(cols["columns"], r)) for r in cols["rows"]]
        t = meta["tables"][str(year)]["final"]
        rev = model.Dist([v for v, c in t["reviews"] for _ in range(c)])
        mean = model.Dist([v for v, c in t["means"] for _ in range(c)])
        q = model.features(scores, rev, mean)
        pools = {}
        for r in rows:
            if r["y"] != year and r["o"] in model.DECIDED:
                f = tuple(x / 1000 for x in r["ff"]) + (len(r["f"]),)
                pools.setdefault(r["y"], []).append((f, r))
        tw = model.twins_by_year(q, pools)
        return sum(1 for _, r in tw if r["o"] in model.ACCEPTED), len(tw)

    def test_page_matches_python(self):
        class Quiet(SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass
        handler = partial(Quiet, directory=str(ROOT / "docs"))
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            # Past-year scales only: their tables are bundled, so the live 2027 refresh can't interfere.
            for year, scores in ((2025, [5, 6, 6]), (2024, [3, 5, 6, 8]), (2026, [2, 4, 6])):
                url = f"http://127.0.0.1:{server.server_port}/#y={year}&s={','.join(map(str, scores))}"
                dom = subprocess.run([chrome(), "--headless=new", "--disable-gpu", "--no-sandbox",
                                      "--virtual-time-budget=20000", "--dump-dom", url],
                                     capture_output=True, text=True, timeout=120).stdout
                m = re.search(r"accepted · ([\d,]+) of ([\d,]+) decided twins", dom)
                self.assertIsNotNone(m, f"no headline for {year} {scores}")
                page = tuple(int(x.replace(",", "")) for x in m.groups())
                self.assertEqual(page, self.python_answer(year, scores), f"{year} {scores}")
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
