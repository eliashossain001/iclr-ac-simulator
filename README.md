# ICLR AC Decision Simulator

Enter your ICLR review scores and see what Area Chairs decided for the past papers that looked most like yours.

Developed by **Elias Hossain**, Doctoral Researcher, University of Central Florida.

The [ICLR 2027 Rebuttal Radar](https://dipta007.github.io/iclr-2027-rebuttal-radar/) shows where review scores stand. This page asks the next question: what do ACs *do* with a given score profile? It uses 38,256 reviewed ICLR 2024–2026 papers.

## What the page shows

- **Two headline rates.** The accept rate if your scores end where they are now, and the rate counting what usually happens during the rebuttal (from your pre-rebuttal scores).
- **Flow from start to decision.** A Sankey diagram: your twins' starting scores → what happened in the rebuttal (scores up, unchanged, down, withdrew) → the decision (Oral, Spotlight, Poster, Rejected).
- **AC overrule probability.** Each year has one score cut-off that agrees with the most AC decisions (the *score line*). A paper accepted below it was *rescued*, and one rejected above it was *sunk*. Papers exactly on the line count as coin flips, not overrules.
- **Silent reviewers.** ICLR 2024 has public reviewer reply counts, so the page splits decisions by whether no reviewer, some, or all of them replied. It does the same for rebuttal length.
- **Decision matrix.** Accept rate by final rank × reviewer disagreement, by rank × reviewer replies, and by rank × rebuttal length. Your cell is outlined.
- **What one reviewer could change.** The accept rate if one reviewer raises their score by one step.
- **Your closest twins.** Links to the real papers on OpenReview, where you can read their meta-reviews.
- **ICLR 2027 paper lookup.** Type a paper number, or any words from the title, and pick your paper; its scores are filled in from the Rebuttal Radar's public data. Links such as `#paper=8241`, `#q=llm judge consensus` or `#y=2027&s=3,2,1&now=3,3,1` can be shared.

## Method

ICLR changed its scale every year: 1/3/5/6/8/10 in 2024–25, 0–10 in even steps in 2026, and 1–4 in 2027. Raw numbers can't be compared across years, so each score becomes its **midpoint percentile among all reviews that year**. Each paper is then described by three percentiles: its mean, its lowest score and its highest score.

The twins are the 150 nearest papers from each past year, with every tie at the boundary included, so the result never depends on file order. The distance is

```
sqrt(Δmean² + 0.5·Δlow² + 0.25·Δhigh²) + 0.02·|Δ number of reviews|
```

When you enter a past year's scale, that year is left out, so a year never predicts itself.

## Validation

Settings were tuned with 2024 predicting 2025. They were then tested once, with 2024–25 predicting all of 2026 (`pipeline/backtest.py`, results in `docs/data/validation.json`).

| Test | Papers | AUC | Brier score | Brier, constant guess |
|---|---|---|---|---|
| AC stage, 2025 from 2024 | 8,614 | 0.951 | 0.086 | 0.245 |
| **AC stage, held-out 2026** | 13,811 | **0.891** | 0.131 | 0.237 |
| Pre-rebuttal → accepted, 2025 from 2024 | 11,422 | 0.902 | 0.117 | 0.218 |
| Pre-rebuttal → withdrew, 2025 from 2024 | 11,422 | 0.799 | 0.151 | 0.189 |

A lower Brier score is better. ICLR 2026 ACs overruled the scores more often than in earlier years: the score line explains 81% of 2026 decisions, against 87–88% in 2024–25. The low rates in 2026 therefore came true a little more often than stated, and the page's calibration chart shows this.

## Limits

- The rates describe past papers like yours. They are not a forecast for your paper. The AC reads the reviews, the rebuttal and the paper, and none of that is in these numbers.
- 2027 percentiles use the 2027 scores as they are today, and those still move during the rebuttal.
- Reviewer replies and rebuttal length are public only for 2024. They show association, not cause.
- Code links added during the rebuttal are in no public dataset, so they are not used.
- Withdrawn papers are their own outcome. Desk rejects are left out of the AC numbers. ICLR 2026 had no spotlight tier.

## Data and credit

| Source | Used for | License |
|---|---|---|
| [Paper Copilot paper lists](https://github.com/papercopilot/paperlists) | decisions, final scores, 2024 reply counts and word counts | CC BY 4.0 |
| [iclr-insights](https://github.com/papercopilot/iclr-insights), Kargaran et al., [arXiv:2511.15462](https://arxiv.org/abs/2511.15462) | each reviewer's score before and after the rebuttal, 2024–25 | CC BY 4.0 |
| [ICLR 2027 Rebuttal Radar](https://github.com/dipta007/iclr-2027-rebuttal-radar) by dipta007, built on [iclr-2027-scores](https://github.com/shiqiangw/iclr-2027-scores) by shiqiangw | 2027 score distributions and paper lookup | public site data |

All data originally comes from OpenReview. The published files hold only OpenReview forum ids, titles, numeric scores, decisions, reply counts and word counts: no review text, abstracts or author names. The build checks this before it writes the output.

## Build

The pipeline needs only Python 3.10+ and the standard library. The parity test also needs Chrome.

```sh
python3 pipeline/fetch.py      # download sources into raw/ (git-ignored), with checksums
python3 pipeline/backtest.py   # tune and validate, write docs/data/validation.json
python3 pipeline/build.py      # write docs/data/{meta,papers,titles}.json
python3 -m unittest discover -s tests -v
python3 -m http.server -d docs 8000   # open http://localhost:8000
```

`./refresh.sh` runs all of these steps in order. The page also loads the 2027 distributions live from the Rebuttal Radar each time it opens, so the site does not need rebuilding during the rebuttal.

## Deploy on GitHub Pages

Push this repository to GitHub. Then go to Settings → Pages → Build from a branch and choose `main` with the `/docs` folder.
