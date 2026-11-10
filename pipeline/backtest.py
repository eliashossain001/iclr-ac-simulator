#!/usr/bin/env python3
"""Check the twin method on years it has not seen, and pick its settings.

Tuning:  pool 2024 -> predict 2025.   Test (once, with the chosen settings):
pool 2024 + 2025 -> predict 2026 (AC stage only; 2026 has no pre-rebuttal scores).

Stages:
  ac      final scores of decided papers -> accepted or not
  journey pre-rebuttal scores of every reviewed paper -> accepted / withdrawn
          (2024 -> 2025 only)

Writes docs/data/validation.json, which build.py puts on the page.
Run:  python3 pipeline/backtest.py   then   python3 pipeline/build.py
"""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import model  # noqa: E402
from model import ACCEPTED, DECIDED  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"


def load():
    doc = json.loads((DATA / "papers.json").read_text())
    cols = doc["columns"]
    rows = [dict(zip(cols, r)) for r in doc["rows"]]
    for r in rows:
        r["ff"] = tuple(x / 1000 for x in r["ff"]) + (len(r["f"]),)
        r["fi"] = tuple(x / 1000 for x in r["fi"]) + (len(r["i"]),) if r["fi"] else None
    return rows


def make_dist(w_low, w_high, n_pen):
    def d(a, b):
        return math.sqrt((a[0] - b[0]) ** 2 + w_low * (a[1] - b[1]) ** 2
                         + w_high * (a[2] - b[2]) ** 2) + n_pen * abs(a[3] - b[3])
    return d


def predict(queries, pools, key, label, k, dist):
    """Return [(p, y)] with p = share of twins where label(twin) is true."""
    cache, out = {}, []
    for q in queries:
        f = q[key]
        if f not in cache:
            tw = model.twins_by_year(f, pools, k, dist)
            cache[f] = sum(label(t) for _, t in tw) / len(tw)
        out.append((cache[f], label(q)))
    return out


def auc(pairs):
    """Rank-based AUC with ties counted as half."""
    pos = sum(1 for _, y in pairs if y)
    neg = len(pairs) - pos
    ranked = sorted(pairs, key=lambda t: t[0])
    rank_sum, i = 0.0, 0
    while i < len(ranked):
        j = i
        while j < len(ranked) and ranked[j][0] == ranked[i][0]:
            j += 1
        mid = (i + j + 1) / 2
        rank_sum += mid * sum(1 for t in ranked[i:j] if t[1])
        i = j
    return (rank_sum - pos * (pos + 1) / 2) / (pos * neg)


def brier(pairs):
    return sum((p - y) ** 2 for p, y in pairs) / len(pairs)


def calibration(pairs, bins=10):
    out = []
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        sel = [(p, y) for p, y in pairs if lo <= p < hi or (b == bins - 1 and p == 1)]
        if sel:
            out.append({"bin": [lo, hi], "n": len(sel),
                        "predicted": round(sum(p for p, _ in sel) / len(sel), 3),
                        "observed": round(sum(y for _, y in sel) / len(sel), 3)})
    return out


def score(pairs):
    base = sum(y for _, y in pairs) / len(pairs)
    return {"n": len(pairs), "auc": round(auc(pairs), 4), "brier": round(brier(pairs), 4),
            "brier_base": round(base * (1 - base), 4), "base_rate": round(base, 4)}


def main():
    rows = load()
    by_year = lambda y, cond: [r for r in rows if r["y"] == y and cond(r)]  # noqa: E731
    decided = lambda r: r["o"] in DECIDED  # noqa: E731
    accepted = lambda r: r["o"] in ACCEPTED  # noqa: E731
    withdrew = lambda r: r["o"] == "W"  # noqa: E731
    has_init = lambda r: r["fi"] is not None and r["o"] != "D"  # noqa: E731

    def ac_pools(years):
        return {y: [(r["ff"], r) for r in by_year(y, decided)] for y in years}

    tune_q = by_year(2025, decided)
    tune_pools = ac_pools([2024])
    grid = []
    configs = [(k, wl, wh, 0.02) for k in (50, 150, 400) for wl, wh in
               ((0, 0), (0.5, 0.25), (1, 0.5), (0.25, 0.25))]
    for k, wl, wh, npen in configs:
        res = score(predict(tune_q, tune_pools, "ff", accepted, k, make_dist(wl, wh, npen)))
        grid.append({"k": k, "w_low": wl, "w_high": wh, "n_penalty": npen, **res})
        print(f"tune k={k:3d} w_low={wl} w_high={wh}: AUC {res['auc']:.4f} Brier {res['brier']:.4f}",
              flush=True)

    chosen = make_dist(model.W_LOW, model.W_HIGH, model.N_PENALTY)
    mean_only = make_dist(0, 0, model.N_PENALTY)
    test_q = by_year(2026, decided)
    test_pools = ac_pools([2024, 2025])
    test = predict(test_q, test_pools, "ff", accepted, model.K_TWINS, chosen)
    test_mean_only = predict(test_q, test_pools, "ff", accepted, model.K_TWINS, mean_only)
    tune = predict(tune_q, tune_pools, "ff", accepted, model.K_TWINS, chosen)

    j_q = by_year(2025, has_init)
    j_pools = {2024: [(r["fi"], r) for r in by_year(2024, has_init)]}
    j_acc = predict(j_q, j_pools, "fi", accepted, model.K_TWINS, chosen)
    j_wd = predict(j_q, j_pools, "fi", withdrew, model.K_TWINS, chosen)

    result = {
        "chosen": {"k": model.K_TWINS, "w_low": model.W_LOW, "w_high": model.W_HIGH,
                   "n_penalty": model.N_PENALTY},
        "grid": grid,
        "ac_2025_from_2024": {**score(tune), "calibration": calibration(tune)},
        "ac_2026_from_2024_2025": {**score(test), "calibration": calibration(test)},
        "ac_2026_mean_only": score(test_mean_only),
        "journey_accept_2025_from_2024": {**score(j_acc), "calibration": calibration(j_acc)},
        "journey_withdraw_2025_from_2024": {**score(j_wd), "calibration": calibration(j_wd)},
    }
    (DATA / "validation.json").write_text(json.dumps(result, indent=1))
    for name in ("ac_2025_from_2024", "ac_2026_from_2024_2025", "ac_2026_mean_only",
                 "journey_accept_2025_from_2024", "journey_withdraw_2025_from_2024"):
        r = result[name]
        print(f"{name}: n={r['n']} AUC {r['auc']:.4f} Brier {r['brier']:.4f} (base {r['brier_base']:.4f})")
    for c in result["ac_2026_from_2024_2025"]["calibration"]:
        print("  2026 calib", c)
    return 0


if __name__ == "__main__":
    sys.exit(main())
