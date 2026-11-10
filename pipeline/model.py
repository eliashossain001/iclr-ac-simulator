"""Shared logic for the build, the backtest and the tests.

The page (docs/app.js) repeats the distance and the twin search. Keep the two in step:
tests/test_pipeline.py checks the constants below against docs/app.js.
"""
import bisect
import math

# Paper Copilot status -> one-letter outcome.
OUTCOMES = {
    "Reject": "R",
    "Poster": "P",
    "Spotlight": "S",
    "Oral": "O",
    "Withdraw": "W",
    "Desk Reject": "D",
    "ICLR 2026 ConditionalPoster": "P",
    "ICLR 2026 ConditionalOral": "O",
}
ACCEPTED = frozenset("PSO")
DECIDED = frozenset("RPSO")  # an AC decision was made (desk rejects and withdrawals excluded)

# Twin search. Chosen on 2024 -> 2025 in backtest.py, then checked once on 2026.
K_TWINS = 150
W_MEAN = 1.0
W_LOW = 0.5
W_HIGH = 0.25
N_PENALTY = 0.02  # added distance per review of difference in review count
EPS = 1e-6


def mean4(scores):
    return round(sum(scores) / len(scores), 4)


class Dist:
    """Midpoint percentile of a value within a multiset: (below + equal / 2) / total."""

    def __init__(self, values):
        self.values = sorted(values)
        self.n = len(self.values)
        if not self.n:
            raise ValueError("empty distribution")

    def pct(self, x):
        below = bisect.bisect_left(self.values, x - EPS)
        upto = bisect.bisect_right(self.values, x + EPS)
        return (below + (upto - below) / 2) / self.n

    def table(self):
        """[[value, count], ...] sorted by value. The page rebuilds pct() from this."""
        out = []
        for v in self.values:
            if out and abs(out[-1][0] - v) < EPS:
                out[-1][1] += 1
            else:
                out.append([v, 1])
        return out


def features(scores, review_dist, mean_dist):
    """Scale-free profile: percentile of the mean, the lowest and the highest score."""
    return (
        mean_dist.pct(mean4(scores)),
        review_dist.pct(min(scores)),
        review_dist.pct(max(scores)),
        len(scores),
    )


def distance(a, b):
    """a, b: (mean_pct, low_pct, high_pct, n) with percentiles in 0..1."""
    return math.sqrt(
        W_MEAN * (a[0] - b[0]) ** 2 + W_LOW * (a[1] - b[1]) ** 2 + W_HIGH * (a[2] - b[2]) ** 2
    ) + N_PENALTY * abs(a[3] - b[3])


def twins(query, pool, k=K_TWINS, dist=distance):
    """The k nearest items of pool, plus every item tied with the k-th, so the result
    does not depend on the order of the pool. Each item is (features, payload)."""
    if not pool:
        return []
    scored = sorted((dist(query, f), i) for i, (f, _) in enumerate(pool))
    cut = scored[min(k, len(scored)) - 1][0] + 1e-9
    return [(d, pool[i][1]) for d, i in scored if d <= cut]


def twins_by_year(query, pools, k=K_TWINS, dist=distance):
    """k twins from each year's pool, so every year counts the same."""
    out = []
    for year in sorted(pools):
        out += twins(query, pools[year], k, dist)
    return out


def wilson(successes, n, z=1.96):
    """95% Wilson interval for a proportion."""
    if n == 0:
        return (0.0, 1.0)
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def movement(init, final):
    """How a paper's mean moved between the initial and the final scores."""
    if init is None:
        return None
    a, b = mean4(init), mean4(final)
    return "up" if b > a + EPS else "down" if b < a - EPS else "same"
