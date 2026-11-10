#!/usr/bin/env python3
"""Turn raw/ into the data files behind the page (docs/data/).

Output holds only OpenReview forum ids, titles, numeric scores, decisions, reviewer
reply counts and rebuttal word counts. No review text, abstracts or author names.

Run:  python3 pipeline/build.py
"""
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import (ACCEPTED, DECIDED, K_TWINS, N_PENALTY, OUTCOMES, W_HIGH, W_LOW,  # noqa: E402
                   W_MEAN, Dist, features, mean4, movement, wilson)

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
OUT = ROOT / "docs" / "data"

HIST_YEARS = [2024, 2025, 2026]
INSIGHTS = {
    2024: "iclr2024_threshold6_7407_reviewers.json",
    2025: "iclr2025_threshold6_11677_reviewers.json",
}
SCALES = {
    2024: [1, 3, 5, 6, 8, 10],
    2025: [1, 3, 5, 6, 8, 10],
    2026: [0, 2, 4, 6, 8, 10],
    2027: [1, 2, 3, 4],
}
# Bands of the final mean percentile (share of papers with a lower mean).
BANDS = [(0.95, 1.01, "Top 5%"), (0.90, 0.95, "Top 5-10%"), (0.80, 0.90, "Top 10-20%"),
         (0.70, 0.80, "Top 20-30%"), (0.60, 0.70, "Top 30-40%"), (0.50, 0.60, "Top 40-50%"),
         (0.30, 0.50, "Top 50-70%"), (0.00, 0.30, "Bottom 30%")]
SPREADS = [(0.0, 0.25, "Consensus"), (0.25, 0.5, "Mixed"), (0.5, 1.01, "Split")]
ENGAGEMENT = ["No reviewer replied", "Some replied", "All replied"]
WORDS = [(0, 1, "No rebuttal"), (1, 1500, "< 1.5k words"), (1500, 3000, "1.5-3k"),
         (3000, 5000, "3-5k"), (5000, 10**9, "5k+")]


def nums(text):
    return [int(float(x)) for x in str(text or "").split(";") if x.strip() != ""]


def band_of(p):
    return next(i for i, (lo, hi, _) in enumerate(BANDS) if lo <= p < hi)


def spread_of(lo, hi):
    gap = hi - lo
    return next(i for i, (a, b, _) in enumerate(SPREADS) if a <= gap < b)


def engagement_of(replied, n):
    return 0 if replied == 0 else 2 if replied == n else 1


def words_of(w):
    return next(i for i, (a, b, _) in enumerate(WORDS) if a <= w < b)


def load_year(year):
    """One record per reviewed paper (desk rejects before review are dropped)."""
    papers, seen = [], set()
    insights = {}
    if year in INSIGHTS:
        insights = {p["id"]: p for p in json.loads((RAW / INSIGHTS[year]).read_text())}
    checks = Counter()
    for p in json.loads((RAW / f"iclr{year}.json").read_text()):
        if p["id"] in seen or p.get("track", "main") != "main":
            continue
        seen.add(p["id"])
        final = nums(p.get("rating"))
        if not final:
            checks["no_reviews"] += 1
            continue
        outcome = OUTCOMES[p["status"]]
        rec = {"y": year, "id": p["id"], "o": outcome, "f": final, "i": None, "r": None, "w": None,
               "title": " ".join(str(p.get("title", "")).split())}
        ins = insights.get(p["id"])
        if ins and ins["review"]:
            reviewers = p["reviewers"].split(";")
            pairs = [ins["review"].get(r, {}).get("rating", "") for r in reviewers]
            if all(";" in x for x in pairs):
                init = [int(float(x.split(";")[0])) for x in pairs]
                after = [int(float(x.split(";")[1])) for x in pairs]
                if after == final:
                    rec["i"] = init
                    checks["with_initial"] += 1
                else:
                    checks["final_mismatch"] += 1
            else:
                checks["reviewer_mismatch"] += 1
        if year == 2024:
            replies = nums(p.get("reply_reviewers"))
            words = nums(p.get("wc_reply_authors"))
            if len(replies) == len(final):
                rec["r"] = sum(1 for x in replies if x > 0)
                rec["w"] = sum(words)
        papers.append(rec)
    bad = set(s for r in papers for s in (r["f"] + (r["i"] or []))) - set(SCALES[year])
    if bad:
        raise ValueError(f"{year}: scores outside the scale: {bad}")
    if checks["final_mismatch"] or checks["reviewer_mismatch"]:
        raise ValueError(f"{year}: insights do not match the paper list: {dict(checks)}")
    return papers, dict(checks)


def year_tables(papers):
    """Percentile tables. 'init': every paper with initial scores. 'final': every reviewed
    paper except desk rejects, so it matches a live snapshot of active papers."""
    tables = {}
    init = [r["i"] for r in papers if r["i"]]
    if init:
        tables["init"] = (Dist([s for x in init for s in x]), Dist([mean4(x) for x in init]))
    final = [r["f"] for r in papers if r["o"] != "D"]
    tables["final"] = (Dist([s for x in final for s in x]), Dist([mean4(x) for x in final]))
    return tables


def radar_tables(site):
    """2027 tables from the Rebuttal Radar's first and latest snapshots."""
    def build(snap):
        reviews = [v for v, c in snap["histograms"]["rating"] for _ in range(c)]
        means = [round(v, 4) for v, c in snap["mean_distribution"] for _ in range(c)]
        return Dist(reviews), Dist(means)
    snaps = site["snapshots"]
    return {"init": build(snaps[0]), "final": build(snaps[-1])}, snaps[0], snaps[-1]


def score_line(decided):
    """The score-only rule "accept if mean >= line" that agrees with the most AC decisions.
    A decision that goes against this rule is counted as an overrule."""
    acc = sum(1 for r in decided if r["o"] in ACCEPTED)
    by_mean = defaultdict(lambda: [0, 0])  # mean -> [accepted, rejected]
    for r in decided:
        by_mean[mean4(r["f"])][0 if r["o"] in ACCEPTED else 1] += 1
    best, errors = None, None
    # errors(t) = accepted below t + rejected at or above t
    acc_below, rej_above = 0, len(decided) - acc
    for m in sorted(by_mean):
        e = acc_below + rej_above
        if errors is None or e < errors:
            best, errors = m, e
        acc_below += by_mean[m][0]
        rej_above -= by_mean[m][1]
    return {"accept_rate": acc / len(decided), "line_mean": best, "decided": len(decided),
            "accepted": acc, "agreement": 1 - errors / len(decided)}


ABOVE, BELOW, ON_LINE = 1, 0, 2


def side_of(mean, line):
    """1 above the score line, 0 below it, 2 exactly on it (a coin flip, never an overrule)."""
    return ON_LINE if abs(mean - line) < 1e-9 else ABOVE if mean > line else BELOW


def is_overrule(r):
    acc = r["o"] in ACCEPTED
    return (acc and r["a"] == BELOW) or (not acc and r["a"] == ABOVE)


def cell(rows):
    n = len(rows)
    acc = sum(1 for r in rows if r["o"] in ACCEPTED)
    over = sum(1 for r in rows if is_overrule(r))
    lo, hi = wilson(acc, n)
    return {"n": n, "acc": acc, "over": over, "ci": [round(lo, 3), round(hi, 3)]}


def matrix(rows, row_key, col_key, n_rows, n_cols):
    grid = [[[] for _ in range(n_cols)] for _ in range(n_rows)]
    for r in rows:
        grid[row_key(r)][col_key(r)].append(r)
    return [[cell(c) for c in row] for row in grid]


def r3(x):
    return round(x, 3)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    site = json.loads((RAW / "site.json").read_text())
    manifest = json.loads((RAW / "manifest.json").read_text())

    all_papers, meta_years, tables_json, checks = [], {}, {}, {}
    for year in HIST_YEARS:
        papers, chk = load_year(year)
        checks[year] = chk
        tables = year_tables(papers)
        decided = [r for r in papers if r["o"] in DECIDED]
        line = score_line(decided)
        for r in papers:
            rev, mean = tables["final"]
            r["ff"] = features(r["f"], rev, mean)
            r["fi"] = features(r["i"], *tables["init"]) if r["i"] and "init" in tables else None
            r["a"] = side_of(mean4(r["f"]), line["line_mean"]) if r["o"] in DECIDED else None
            r["mv"] = movement(r["i"], r["f"])
        all_papers += papers
        counts = Counter(r["o"] for r in papers)
        with_init = [r for r in papers if r["i"]]
        raised = sum(1 for r in with_init for a, b in zip(r["i"], r["f"]) if b > a)
        lowered = sum(1 for r in with_init for a, b in zip(r["i"], r["f"]) if b < a)
        n_reviews = sum(len(r["i"]) for r in with_init)
        rescued = sum(1 for r in decided if r["o"] in ACCEPTED and r["a"] == BELOW)
        sunk = sum(1 for r in decided if r["o"] not in ACCEPTED and r["a"] == ABOVE)
        on_line = [r for r in decided if r["a"] == ON_LINE]
        meta_years[year] = {
            "scale": SCALES[year], "reviewed": len(papers), "outcomes": dict(counts),
            "with_initial": len(with_init), "reviews_raised": raised, "reviews_lowered": lowered,
            "reviews_paired": n_reviews, "has_engagement": year == 2024,
            "line": line, "rescued": rescued, "sunk": sunk,
            "below_line": sum(1 for r in decided if r["a"] == BELOW),
            "above_line": sum(1 for r in decided if r["a"] == ABOVE),
            "on_line": len(on_line),
            "on_line_accepted": sum(1 for r in on_line if r["o"] in ACCEPTED),
        }
        tables_json[year] = {k: {"reviews": v[0].table(), "means": v[1].table()}
                             for k, v in tables.items()}

    t27, first, latest = radar_tables(site)
    tables_json[2027] = {k: {"reviews": v[0].table(), "means": v[1].table()} for k, v in t27.items()}

    # Rosetta stone: each score's percentile among that year's reviews.
    rosetta = {}
    for year in HIST_YEARS:
        papers = [r for r in all_papers if r["y"] == year]
        t = year_tables(papers)
        stage = "init" if "init" in t else "final"
        rosetta[year] = [[s, r3(t[stage][0].pct(s))] for s in SCALES[year]]
    rosetta[2027] = [[s, r3(t27["init"][0].pct(s))] for s in SCALES[2027]]

    decided = [r for r in all_papers if r["o"] in DECIDED]
    d24 = [r for r in decided if r["y"] == 2024 and r["r"] is not None]
    matrices = {
        "band_spread": matrix(decided, lambda r: band_of(r["ff"][0]),
                              lambda r: spread_of(r["ff"][1], r["ff"][2]), len(BANDS), len(SPREADS)),
        "band_engagement": matrix(d24, lambda r: band_of(r["ff"][0]),
                                  lambda r: engagement_of(r["r"], len(r["f"])), len(BANDS), 3),
        "band_words": matrix(d24, lambda r: band_of(r["ff"][0]),
                             lambda r: words_of(r["w"]), len(BANDS), len(WORDS)),
    }
    # Engagement of the whole 2024 decided set, for the headline numbers.
    eng = defaultdict(list)
    for r in d24:
        eng[engagement_of(r["r"], len(r["f"]))].append(r)
    silent = {
        "below_line": [cell([r for r in eng[e] if r["a"] == BELOW]) for e in range(3)],
        "above_line": [cell([r for r in eng[e] if r["a"] == ABOVE]) for e in range(3)],
        "on_line": [cell([r for r in eng[e] if r["a"] == ON_LINE]) for e in range(3)],
        "share": [r3(len(eng[e]) / len(d24)) for e in range(3)],
    }

    validation = None
    vpath = OUT / "validation.json"
    if vpath.exists():
        validation = json.loads(vpath.read_text())

    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": manifest["files"],
        "model": {"k": K_TWINS, "w_mean": W_MEAN, "w_low": W_LOW, "w_high": W_HIGH,
                  "n_penalty": N_PENALTY},
        "years": meta_years,
        "checks": checks,
        "tables": tables_json,
        "rosetta": rosetta,
        "radar": {"first": first["taken_at"], "latest": latest["taken_at"],
                  "first_papers": first["papers_with_ratings"], "latest_papers": latest["papers_with_ratings"],
                  "first_reviews": first["reviews"]},
        "bands": [b[2] for b in BANDS], "band_edges": [[b[0], b[1]] for b in BANDS],
        "spreads": [s[2] for s in SPREADS], "spread_edges": [[s[0], s[1]] for s in SPREADS],
        "engagement": ENGAGEMENT,
        "words": [w[2] for w in WORDS], "word_edges": [[w[0], w[1]] for w in WORDS],
        "matrices": matrices,
        "silent": silent,
        "validation": validation,
    }

    q = lambda f: [round(x * 1000) for x in f[:3]] if f else None  # noqa: E731
    cols = ["y", "id", "o", "i", "f", "fi", "ff", "a", "mv", "r", "w"]
    rows = [[r["y"], r["id"], r["o"], r["i"], r["f"], q(r["fi"]), q(r["ff"]),
             r["a"], r["mv"], r["r"], r["w"]] for r in all_papers]
    papers_doc = {"columns": cols, "rows": rows}
    titles = {r["id"]: r["title"] for r in all_papers}

    write(OUT / "meta.json", meta)
    write(OUT / "papers.json", papers_doc)
    write(OUT / "titles.json", titles)
    check_output(papers_doc, meta)
    for year in HIST_YEARS:
        y = meta_years[year]
        print(f"{year}: {y['reviewed']} reviewed, accept {y['line']['accept_rate']:.1%}, "
              f"line {y['line']['line_mean']}, rescued {y['rescued']}/{y['below_line']}, "
              f"sunk {y['sunk']}/{y['above_line']}, on line {y['on_line_accepted']}/{y['on_line']}, initial {y['with_initial']}, checks {checks[year]}")
    print(f"2027 radar: first {first['taken_at']}, latest {latest['taken_at']}")
    for name in ("meta.json", "papers.json", "titles.json"):
        print(f"  {name}: {(OUT / name).stat().st_size / 1e6:.2f} MB")


def write(path, obj):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))
    tmp.replace(path)


def check_output(papers_doc, meta):
    """Stop the build if the page data holds anything but ids, numbers and outcomes."""
    for row in papers_doc["rows"]:
        y, pid, o = row[0], row[1], row[2]
        assert y in HIST_YEARS and isinstance(pid, str) and len(pid) <= 16 and o in "RPSOWD"
        for v in row[3:]:
            assert v is None or isinstance(v, (int, list, str)) and (not isinstance(v, str) or v in ("up", "down", "same"))
    text = json.dumps(meta)
    assert "abstract" not in text and "author" not in text


if __name__ == "__main__":
    main()
