"use strict";
/* ICLR AC Decision Simulator. Everything runs in the browser.
   The twin search mirrors pipeline/model.py and reads its settings from data/meta.json. */

const RADAR = "https://dipta007.github.io/iclr-2027-rebuttal-radar/data/";
const OUT = { O: "Oral", S: "Spotlight", P: "Poster", R: "Rejected", W: "Withdrew", D: "Desk-rejected" };
const OUT_ORDER = ["O", "S", "P", "R", "W"];
const COLOR = { O: "var(--o-oral)", S: "var(--o-spot)", P: "var(--o-poster)", R: "var(--o-reject)", W: "var(--o-withdraw)", D: "var(--o-desk)" };
const ON = { O: "var(--on-oral)", S: "#fff", P: "var(--on-poster)", R: "#fff", W: "var(--on-withdraw)", D: "#fff" };
const ACC = new Set(["P", "S", "O"]);
const DEC = new Set(["R", "P", "S", "O"]);
const HIST = [2024, 2025, 2026];
const ENG_K = 400; // larger pool for the 2024-only splits, so each group has enough papers

let META, ROWS, TITLES = null, TITLES_PROMISE = null, RADAR_PAPERS = null, LAST = null;
const $ = (id) => document.getElementById(id);
const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

/* ---------- DOM helpers ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const SVGNS = "http://www.w3.org/2000/svg";
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const pct = (x, digits = 0) => {
  if (x == null || Number.isNaN(x)) return "–";
  if (x > 0 && x < 0.005 && digits === 0) return "<1%";
  if (x < 1 && x > 0.995 && digits === 0) return ">99%";
  return (100 * x).toFixed(digits) + "%";
};
const fmt = (n) => n.toLocaleString("en-US");
const chips = (xs, prev) => xs.map((x, i) => h("span", { class: "chip" + (prev && prev[i] != null ? (x > prev[i] ? " up" : x < prev[i] ? " down" : "") : "") }, x));

/* ---------- percentile tables & features (mirror of model.py) ---------- */
const EPS = 1e-6;
const totals = new WeakMap();
function pctOf(table, x) {
  let total = totals.get(table);
  if (total == null) { total = table.reduce((a, [, c]) => a + c, 0); totals.set(table, total); }
  let below = 0, equal = 0;
  for (const [v, c] of table) {
    if (v < x - EPS) below += c;
    else if (v <= x + EPS) equal += c;
    else break;
  }
  return (below + equal / 2) / total;
}
const mean4 = (xs) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1e4) / 1e4;
function features(scores, t) {
  return [pctOf(t.means, mean4(scores)), pctOf(t.reviews, Math.min(...scores)), pctOf(t.reviews, Math.max(...scores)), scores.length];
}
function distance(a, b) {
  const m = META.model;
  return Math.sqrt(m.w_mean * (a[0] - b[0]) ** 2 + m.w_low * (a[1] - b[1]) ** 2 + m.w_high * (a[2] - b[2]) ** 2)
    + m.n_penalty * Math.abs(a[3] - b[3]);
}
function twins(q, pool, key, k = META.model.k) {
  if (!pool.length) return [];
  const scored = pool.map((r) => ({ d: distance(q, r[key]), r }));
  scored.sort((x, y) => x.d - y.d);
  const cut = scored[Math.min(k, scored.length) - 1].d + 1e-9;
  return scored.filter((x) => x.d <= cut);
}
function twinsByYear(q, pools, key, k) {
  return Object.keys(pools).sort().flatMap((y) => twins(q, pools[y], key, k));
}

/* ---------- stats ---------- */
function wilson(x, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = x / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const hw = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - hw), Math.min(1, c + hw)];
}
function outcomeCounts(list) {
  const c = { O: 0, S: 0, P: 0, R: 0, W: 0, D: 0 };
  for (const t of list) c[(t.r || t).o]++;
  return c;
}
const accShare = (list) => list.length ? list.filter((t) => ACC.has((t.r || t).o)).length / list.length : NaN;

/* ---------- data ---------- */
async function getJSON(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}
function unpackRows(doc) {
  const idx = Object.fromEntries(doc.columns.map((c, i) => [c, i]));
  return doc.rows.map((row) => {
    const r = {};
    for (const c of doc.columns) r[c] = row[idx[c]];
    r.ff = r.ff ? [r.ff[0] / 1000, r.ff[1] / 1000, r.ff[2] / 1000, r.f.length] : null;
    r.fi = r.fi ? [r.fi[0] / 1000, r.fi[1] / 1000, r.fi[2] / 1000, r.i.length] : null;
    return r;
  });
}
function radarTables(site) {
  const build = (snap) => ({
    reviews: snap.histograms.rating.map(([v, c]) => [v, c]).sort((a, b) => a[0] - b[0]),
    means: snap.mean_distribution.map(([v, c]) => [Math.round(v * 1e4) / 1e4, c]).sort((a, b) => a[0] - b[0]),
  });
  const snaps = site.snapshots;
  return { init: build(snaps[0]), final: build(snaps[snaps.length - 1]), first: snaps[0].taken_at, latest: snaps[snaps.length - 1].taken_at };
}
function loadTitles() {
  if (!TITLES_PROMISE) TITLES_PROMISE = getJSON("data/titles.json").then((t) => (TITLES = t)).catch(() => (TITLES = {}));
  return TITLES_PROMISE;
}

/* ---------- input ---------- */
const scaleOf = (y) => META.rosetta[y].map((x) => x[0]);
function parseScores(text, year) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  let parts = raw.split(/[\s,;/|]+/).filter(Boolean);
  const scale = scaleOf(year);
  if (parts.length === 1 && /^\d{2,}$/.test(parts[0]) && scale.every((v) => v < 10)) parts = parts[0].split("");
  const xs = parts.map(Number);
  const bad = parts.filter((p, i) => !Number.isInteger(xs[i]) || !scale.includes(xs[i]));
  if (bad.length) throw new Error(`"${bad[0]}" is not a score on the ICLR ${year} scale (${scale.join(", ")}).`);
  if (xs.length > 10) throw new Error("That is more than 10 reviews. Check the separator between scores.");
  return xs;
}
function readForm() {
  const year = Number($("scale").value);
  const initial = parseScores($("initial").value, year);
  if (!initial) throw new Error("Enter your scores before the rebuttal, for example 3, 2, 2.");
  const current = parseScores($("current").value, year) || initial;
  const e = $("engagement").value, w = $("words").value;
  return { year, initial, current, eng: e === "" ? null : Number(e), words: w === "" ? null : Number(w) };
}
function writeHash(st, paper) {
  const p = new URLSearchParams();
  if (paper) p.set("paper", paper);
  else {
    p.set("y", st.year); p.set("s", st.initial.join(","));
    if (st.current.join() !== st.initial.join()) p.set("now", st.current.join(","));
  }
  if (st.eng != null) p.set("e", st.eng);
  if (st.words != null) p.set("w", st.words);
  history.replaceState(null, "", "#" + p.toString());
}

/* ---------- the simulation ---------- */
function simulate(st) {
  const T = META.tables[st.year];
  const qI = features(st.initial, T.init || T.final);
  const qF = features(st.current, T.final);
  const years = HIST.filter((y) => y !== st.year); // a past year never predicts itself
  const acPools = {}, jPools = {};
  for (const y of years) {
    acPools[y] = ROWS.filter((r) => r.y === y && DEC.has(r.o));
    const jp = ROWS.filter((r) => r.y === y && r.fi && r.o !== "D");
    if (jp.length) jPools[y] = jp;
  }
  const ac = twinsByYear(qF, acPools, "ff");
  const journey = twinsByYear(qI, jPools, "fi");
  const eng = acPools[2024] ? twins(qF, acPools[2024].filter((r) => r.r != null), "ff", ENG_K) : [];
  const scale = scaleOf(st.year);
  const whatifs = [];
  const seen = new Set();
  st.current.forEach((v, i) => {
    const up = scale[scale.indexOf(v) + 1];
    if (up == null || seen.has(v)) return;
    seen.add(v);
    const next = st.current.slice(); next[i] = up;
    const tw = twinsByYear(features(next, T.final), acPools, "ff");
    whatifs.push({ from: v, to: up, scores: next, acc: accShare(tw), n: tw.length });
  });
  return { st, qI, qF, years, ac, journey, eng, whatifs };
}

/* ---------- renderers ---------- */
function renderSummary(R) {
  const box = $("summary");
  const n = R.ac.length, acc = R.ac.filter((t) => ACC.has(t.r.o)).length;
  const [lo, hi] = wilson(acc, n);
  const p = acc / n;
  const jn = R.journey.length;
  const jc = outcomeCounts(R.journey);
  const jaccN = jc.P + jc.S + jc.O;
  const [jlo, jhi] = wilson(jaccN, jn);
  const raised = R.journey.filter((t) => t.r.o !== "W" && t.r.mv === "up").length / jn;
  const changed = R.st.current.join() !== R.st.initial.join();
  const tone = p >= 0.75 ? "Most papers like yours were accepted." : p >= 0.5 ? "More papers like yours were accepted than rejected." :
    p >= 0.25 ? "Papers like yours were usually rejected, but a real share got in." : p >= 0.08 ? "Papers like yours were rarely accepted." : "Almost no papers like yours were accepted.";
  const big = (label, value, lo, hi, sub) => h("div", { class: "headline" },
    h("p", { class: "label" }, label),
    h("p", { class: "big" }, value, h("small", {}, ` ${pct(lo)}–${pct(hi)}`)),
    h("p", { class: "sub" }, sub));
  put(box,
    h("p", { class: "profile", style: { marginTop: 0 } }, "Before the rebuttal: ", ...chips(R.st.initial),
      changed ? h("span", {}, " → now: ", ...chips(R.st.current, R.st.initial)) : null,
      ` · mean in the top ${pct(1 - R.qF[0])} of ICLR ${R.st.year} papers now`),
    h("div", { class: "headlines" },
      big("If your scores end where they are now", pct(p), lo, hi,
        `accepted · ${fmt(acc)} of ${fmt(n)} decided twins from ${R.years.join(", ")}`),
      jn ? big("Counting what usually happens in the rebuttal", pct(jaccN / jn), jlo, jhi,
        `accepted · ${fmt(jn)} twins from ${Object.keys(jcYears(R.journey)).join(" and ")}, matched before the rebuttal`) : null,
    ),
    h("p", { class: "verdict" }, `${tone} `, jn ? `Of the papers that started like yours, ${pct(raised)} saw their mean rise in the rebuttal and ${pct(jc.W / jn)} were withdrawn.` : ""),
    h("p", { class: "hint" }, "Ranges are 95% intervals. These are rates for past papers that looked like yours, not a forecast for your paper."),
  );
}
const jcYears = (list) => groupBy(list, (t) => t.r.y);

function tile(label, value, sub) {
  return h("div", { class: "tile" }, h("p", { class: "label" }, label), h("p", { class: "value" }, value), h("p", { class: "sub" }, sub));
}

function legend(codes) {
  return h("div", { class: "legend" }, codes.map((c) => h("span", {}, h("i", { style: { background: COLOR[c] } }), OUT[c])));
}

function segbar(label, list, opts = {}) {
  const c = outcomeCounts(list), n = list.length;
  const codes = (opts.codes || OUT_ORDER).filter((k) => c[k]);
  const width = opts.width || 600;
  const bar = h("div", { class: "bar", role: "img", "aria-label": `${label}: ` + codes.map((k) => `${OUT[k]} ${pct(c[k] / n)}`).join(", ") });
  for (const k of codes) {
    const share = c[k] / n;
    const text = pct(share);
    const fits = share * width > text.length * 7.5 + 12;
    bar.append(h("div", {
      style: { flex: `${c[k]} 0 0`, background: COLOR[k], color: ON[k] },
      "data-tip": `<b>${OUT[k]}</b><br>${fmt(c[k])} of ${fmt(n)} (${pct(share, 1)})`,
    }, fits ? text : ""));
  }
  return h("div", { class: "segbar" + (opts.you ? " you" : ""), style: opts.you ? { fontWeight: 600 } : null },
    h("span", { class: "lab" }, label), n ? bar : h("div", { class: "hint" }, "no papers"), h("span", { class: "n" }, n ? `n=${fmt(n)}` : ""));
}

function renderSankey(R) {
  const box = $("sankey"), tbl = $("sankeyTable");
  const J = R.journey;
  if (!J.length) {
    put(box, h("p", { class: "hint" }, "There are no pre-rebuttal scores for this comparison."));
    put(tbl, );
    return;
  }
  const mid = (r) => (r.o === "W" ? "W" : r.mv);
  const MID = [["up", "Scores went up"], ["same", "Scores unchanged"], ["down", "Scores went down"], ["W", "Withdrew"]];
  const END = ["O", "S", "P", "R", "W"];
  const n = J.length;
  const midCount = Object.fromEntries(MID.map(([k]) => [k, J.filter((t) => mid(t.r) === k).length]));
  const endCount = Object.fromEntries(END.map((k) => [k, J.filter((t) => t.r.o === k).length]));
  const links = [];
  for (const [m] of MID) for (const e of END) {
    const v = J.filter((t) => mid(t.r) === m && t.r.o === e).length;
    if (v) links.push({ m, e, v });
  }
  const W = Math.max(320, box.clientWidth || 900);
  const narrow = W < 560;
  const H = narrow ? 300 : 340, nw = 12, pad = 10, top = 8;
  const xs = [0, Math.round(W * (narrow ? 0.34 : 0.4)), W - (narrow ? 126 : 150)];
  const avail = (count) => H - top * 2 - pad * (count - 1);
  const scale = Math.min(avail(MID.length), avail(END.length)) / n;
  const place = (keys, counts) => {
    let y = top; const out = {};
    for (const k of keys) { const hgt = Math.max(counts[k] ? 2 : 0, counts[k] * scale); out[k] = { y, h: hgt, inY: y, outY: y }; y += hgt + (counts[k] ? pad : 0); }
    return out;
  };
  const midN = place(MID.map(([k]) => k), midCount);
  const endN = place(END, endCount);
  const startN = { y: top, h: n * scale, outY: top };
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": "Flow from starting scores through the rebuttal to the decision" });
  const band = (x0, y0, x1, y1, hgt, fill, tip, op) => {
    const c = (x0 + x1) / 2;
    svg.append(s("path", {
      d: `M${x0},${y0} C${c},${y0} ${c},${y1} ${x1},${y1} L${x1},${y1 + hgt} C${c},${y1 + hgt} ${c},${y0 + hgt} ${x0},${y0 + hgt} Z`,
      fill, "fill-opacity": op, "data-tip": tip,
    }));
  };
  for (const [m, label] of MID) {
    const v = midCount[m]; if (!v) continue;
    const hgt = v * scale;
    band(xs[0] + nw, startN.outY, xs[1], midN[m].inY, hgt, "var(--flow)", `<b>${label}</b><br>${fmt(v)} of ${fmt(n)} twins (${pct(v / n, 1)})`, 1);
    startN.outY += hgt; midN[m].inY += hgt;
  }
  for (const l of links) {
    const hgt = l.v * scale;
    const ml = MID.find(([k]) => k === l.m)[1];
    band(xs[1] + nw, midN[l.m].outY, xs[2], endN[l.e].inY, hgt, COLOR[l.e],
      `<b>${ml} → ${OUT[l.e]}</b><br>${fmt(l.v)} papers · ${pct(l.v / midCount[l.m], 1)} of “${ml.toLowerCase()}”`, 0.55);
    midN[l.m].outY += hgt; endN[l.e].inY += hgt;
  }
  const node = (x, y, hgt, fill) => svg.append(s("rect", { x, y, width: nw, height: Math.max(hgt, 1), rx: 3, fill }));
  const label = (x, y, hgt, a, b, anchor = "start") => {
    if (hgt < 11) return;
    const t = s("text", { x, y: y + hgt / 2 + 4, "text-anchor": anchor, "paint-order": "stroke", stroke: "var(--surface)", "stroke-width": 4, "stroke-linejoin": "round" },
      s("tspan", { class: "t-strong" }, a), s("tspan", { dx: 6 }, b));
    svg.append(t);
  };
  node(xs[0], startN.y, startN.h, "var(--ink-2)");
  label(xs[0] + nw + 6, startN.y, Math.min(startN.h, 40), narrow ? "Twins" : "Your twins", fmt(n));
  for (const [m, l] of MID) if (midCount[m]) { node(xs[1], midN[m].y, midN[m].h, m === "W" ? COLOR.W : "var(--ink-2)"); label(xs[1] + nw + 6, midN[m].y, midN[m].h, narrow ? l.replace("Scores ", "").replace("went ", "") : l, pct(midCount[m] / n)); }
  for (const e of END) if (endCount[e]) { node(xs[2], endN[e].y, endN[e].h, COLOR[e]); label(xs[2] + nw + 6, endN[e].y, endN[e].h, OUT[e], pct(endCount[e] / n)); }
  put(box, legend(END), svg,
    h("p", { class: "hint" }, `${fmt(n)} twins from ${Object.keys(groupBy(J, (t) => t.r.y)).join(" and ")}, matched on the scores before the rebuttal.`));
  put(tbl, h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "During the rebuttal"), ...END.map((e) => h("th", { class: "r" }, OUT[e])), h("th", { class: "r" }, "Twins"))),
    h("tbody", {}, MID.filter(([m]) => midCount[m]).map(([m, l]) => h("tr", {}, h("td", {}, l),
      ...END.map((e) => h("td", { class: "r" }, fmt((links.find((x) => x.m === m && x.e === e) || { v: 0 }).v))), h("td", { class: "r" }, fmt(midCount[m]))))))));
}
function groupBy(xs, f) { const o = {}; for (const x of xs) (o[f(x)] ||= []).push(x); return o; }

function renderOverrule(R) {
  const box = $("overrule");
  const byYear = groupBy(R.ac, (t) => t.r.y);
  const zone = { 0: [], 1: [], 2: [] };
  for (const t of R.ac) zone[t.r.a].push(t);
  const below = zone[0], above = zone[1], online = zone[2];
  const rescued = below.filter((t) => ACC.has(t.r.o)).length, sunk = above.filter((t) => !ACC.has(t.r.o)).length;
  const onAcc = online.filter((t) => ACC.has(t.r.o)).length;
  const side = [[above.length, "above"], [below.length, "below"], [online.length, "on"]].sort((a, b) => b[0] - a[0])[0][1];
  const n = R.ac.length;
  const share = `${pct(above.length / n)} of your twins sit above the line, ${pct(online.length / n)} on it, ${pct(below.length / n)} below it.`;
  let main;
  if (side === "above") {
    const [lo, hi] = wilson(sunk, above.length);
    main = tile("AC overrule probability", pct(sunk / above.length), `chance of being sunk: ${fmt(sunk)} of ${fmt(above.length)} twins above the line were rejected (95% ${pct(lo)}–${pct(hi)})`);
  } else if (side === "below") {
    const [lo, hi] = wilson(rescued, below.length);
    main = tile("AC overrule probability", pct(rescued / below.length), `chance of a rescue: ${fmt(rescued)} of ${fmt(below.length)} twins below the line were accepted (95% ${pct(lo)}–${pct(hi)})`);
  } else {
    main = tile("Right on the score line", pct(onAcc / online.length), `accepted · the line runs through your twins, so the AC's reading of the reviews decides (${fmt(online.length)} twins)`);
  }
  const sil = META.silent;
  const key = side === "above" ? "above_line" : side === "below" ? "below_line" : "on_line";
  const rate = (c) => (!c.n ? NaN : side === "on" ? c.acc / c.n : c.over / c.n);
  const what = side === "above" ? "Sunk" : side === "below" ? "Rescued" : "Accepted";
  const w = Math.max(300, box.clientWidth || 800) - 180;
  const yearRows = HIST.map((y) => {
    const Y = META.years[y];
    return h("tr", {}, h("td", {}, `ICLR ${y}`), h("td", { class: "r" }, `mean ≥ ${+Y.line.line_mean.toFixed(2)}`), h("td", { class: "r" }, pct(Y.line.agreement)),
      h("td", { class: "r" }, pct(Y.rescued / Y.below_line, 1)), h("td", { class: "r" }, pct(Y.sunk / Y.above_line, 1)),
      h("td", { class: "r" }, Y.on_line ? `${pct(Y.on_line_accepted / Y.on_line)} of ${fmt(Y.on_line)}` : "–"));
  });
  put(box,
    h("div", { class: "tiles" },
      main,
      tile(`${what} when no reviewer replied`, pct(rate(sil[key][0])), `every ICLR 2024 paper ${side === "on" ? "on" : side} the line with silent reviewers, n=${fmt(sil[key][0].n)}`),
      tile(`${what} when all reviewers replied`, pct(rate(sil[key][2])), `every ICLR 2024 paper ${side === "on" ? "on" : side} the line, all reviewers engaged, n=${fmt(sil[key][2].n)}`),
    ),
    h("p", { class: "hint" }, share),
    h("h3", {}, "Decisions for your twins, by year"),
    legend(["O", "S", "P", "R"]),
    Object.keys(byYear).sort().map((y) => segbar(`ICLR ${y}`, byYear[y], { width: w })),
    h("details", {}, h("summary", {}, "Score lines and overrule rates for every paper, by year"),
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Year"), h("th", { class: "r" }, "Score line"), h("th", { class: "r" }, "Decisions it explains"),
          h("th", { class: "r" }, "Rescued (below)"), h("th", { class: "r" }, "Sunk (above)"), h("th", { class: "r" }, "Accepted on the line"))),
        h("tbody", {}, yearRows)))),
  );
}

function renderEngagement(R) {
  const box = $("engagementChart"), wbox = $("wordsChart");
  if (!R.eng.length) {
    put(box, h("p", { class: "hint" }, "ICLR 2024 is left out because you chose the 2024 scale, so there is no reply data to compare with."));
    put(wbox, );
    return;
  }
  const w = Math.max(300, box.clientWidth || 800) - 180;
  const eng = (r) => (r.r === 0 ? 0 : r.r === r.f.length ? 2 : 1);
  const groups = [0, 1, 2].map((e) => R.eng.filter((t) => eng(t.r) === e));
  const labels = ["No reviewer", "Some", "All"];
  const accs = groups.map(accShare);
  const pick = R.st.eng;
  const msg = pick == null
    ? `Among your ${fmt(R.eng.length)} closest 2024 twins: ${pct(accs[0])} accepted when no reviewer replied, ${pct(accs[2])} when all of them did.`
    : `You said ${["no reviewer", "some reviewers", "every reviewer"][pick]} replied. Among your closest 2024 twins in that group, ${pct(accs[pick])} were accepted (n=${fmt(groups[pick].length)}).`;
  put(box, 
    h("h3", {}, "Reviewers who replied during the discussion"),
    legend(["O", "S", "P", "R"]),
    ...groups.map((g, i) => segbar(labels[i], g, { width: w, you: pick === i })),
    h("div", { class: "callout" }, h("p", {}, msg)),
  );
  const wb = META.word_edges;
  const wg = wb.map(([a, b]) => R.eng.filter((t) => t.r.w >= a && t.r.w < b));
  put(wbox, 
    h("h3", {}, "Length of the authors' replies"),
    ...wg.map((g, i) => (g.length ? segbar(META.words[i], g, { width: w, you: R.st.words === i }) : null)),
    h("p", { class: "hint" }, "Same 2024 twins. Long rebuttals often answer long, critical reviews, so read this as association, not advice to write more."),
  );
}

let MATRIX_TAB = "band_spread";
function renderMatrix(R) {
  const tabs = [["band_spread", "Rank × reviewer disagreement"], ["band_engagement", "Rank × reviewer replies (2024)"], ["band_words", "Rank × rebuttal length (2024)"]];
  put($("matrixTabs"), ...tabs.map(([k, l]) => h("button", {
    type: "button", role: "tab", "aria-selected": String(k === MATRIX_TAB),
    onclick: () => { MATRIX_TAB = k; renderMatrix(R); },
  }, l)));
  const M = META.matrices[MATRIX_TAB];
  const cols = { band_spread: META.spreads, band_engagement: META.engagement, band_words: META.words }[MATRIX_TAB];
  const colHint = { band_spread: "Disagreement = gap between the percentiles of the lowest and highest score: under 25 points is consensus, over 50 is split.", band_engagement: "Reviewers who posted at least one reply during the discussion.", band_words: "Total words in all author replies." }[MATRIX_TAB];
  const bandIdx = META.band_edges.findIndex(([a, b]) => R.qF[0] >= a && R.qF[0] < b);
  const gap = R.qF[2] - R.qF[1];
  const colIdx = MATRIX_TAB === "band_spread" ? META.spread_edges.findIndex(([a, b]) => gap >= a && gap < b)
    : MATRIX_TAB === "band_engagement" ? R.st.eng : R.st.words;
  const table = h("table", { class: "heat" },
    h("thead", {}, h("tr", {}, h("th", {}, "Final mean"), ...cols.map((c) => h("th", { class: "r" }, c)))),
    h("tbody", {}, M.map((row, i) => h("tr", {}, h("th", { scope: "row" }, META.bands[i] + (i === bandIdx ? " ← you" : "")),
      ...row.map((c, j) => {
        const you = i === bandIdx && j === colIdx;
        if (c.n < 20) return h("td", { class: "r cell empty" + (you ? " you-cell" : ""), "data-tip": c.n ? `Only ${c.n} papers` : "No papers" }, c.n ? "·" : "");
        const p = c.acc / c.n;
        return h("td", {
          class: "r cell" + (you ? " you-cell" : ""),
          style: { background: `color-mix(in oklab, var(--heat-0), var(--heat-1) ${Math.round(p * 100)}%)`, color: p > 0.55 ? "var(--heat-ink-hi)" : "var(--ink)" },
          "data-tip": `<b>${META.bands[i]} · ${cols[j]}</b><br>${pct(p, 1)} accepted (${fmt(c.acc)} of ${fmt(c.n)})<br>95%: ${pct(c.ci[0])}–${pct(c.ci[1])}`,
        }, pct(p), h("small", {}, fmt(c.n)));
      })))));
  put($("matrix"), h("div", { class: "table-wrap" }, table),
    h("p", { class: "hint" }, `${colHint} Rank bands are by final mean within each year. Cells with fewer than 20 papers are left blank.`));
}

function renderWhatIf(R) {
  const base = accShare(R.ac);
  const box = $("whatif");
  if (!R.whatifs.length) { put(box, h("p", {}, "Every score is already at the top of the scale.")); return; }
  put(box, h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "If a reviewer moves"), h("th", {}, "New scores"), h("th", { class: "r" }, "Accepted"), h("th", { class: "r" }, "Change"))),
    h("tbody", {},
      h("tr", { class: "you" }, h("td", {}, "No change"), h("td", {}, ...chips(R.st.current)), h("td", { class: "r" }, pct(base)), h("td", { class: "r" }, "")),
      R.whatifs.map((w) => {
        const d = Math.round((w.acc - base) * 100);
        return h("tr", {}, h("td", {}, `${w.from} → ${w.to}`), h("td", {}, ...chips(w.scores, R.st.current)), h("td", { class: "r" }, pct(w.acc)),
          h("td", { class: "r", style: { color: d > 0 ? "var(--good)" : d < 0 ? "var(--bad)" : null, fontWeight: 600 } }, (d > 0 ? "+" : "") + d + " pts"));
      })))));
}

function renderTwins(R) {
  const box = $("twinsTable");
  const per = groupBy(R.ac.slice().sort((a, b) => a.d - b.d), (t) => t.r.y);
  const list = [];
  for (let i = 0; list.length < 24 && Object.values(per).some((g) => g[i]); i++)
    for (const y of Object.keys(per).sort().reverse()) if (per[y][i] && list.length < 24) list.push(per[y][i]);
  const draw = () => put(box, h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "Year"), h("th", {}, "Paper"), h("th", {}, "Scores"), h("th", {}, "Decision"))),
    h("tbody", {}, list.map(({ r }) => h("tr", {},
      h("td", {}, r.y),
      h("td", { class: "ttl" }, h("a", { href: `https://openreview.net/forum?id=${encodeURIComponent(r.id)}`, target: "_blank", rel: "noopener" }, (TITLES && TITLES[r.id]) || r.id)),
      h("td", { style: { whiteSpace: "nowrap" } }, r.i && r.i.join() !== r.f.join() ? [...chips(r.i), " → ", ...chips(r.f, r.i)] : chips(r.f)),
      h("td", { style: { whiteSpace: "nowrap" } }, h("span", { class: "dot", style: { background: COLOR[r.o] } }), OUT[r.o],
        (ACC.has(r.o) && r.a === 0) ? h("span", { class: "hint" }, " · rescued") : (!ACC.has(r.o) && r.a === 1) ? h("span", { class: "hint" }, " · sunk") : null))))),
    h("p", { class: "hint" }, `The nearest twins of each year, ${list.length} of ${fmt(R.ac.length)}. Scores are on each paper's own year scale.`)));
  draw();
  if (!TITLES) loadTitles().then(() => { if (LAST === R) draw(); });
}

function renderRosetta() {
  const years = [2027, 2026, 2025, 2024];
  put($("rosetta"), h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "Year"), h("th", {}, "Score → share of that year's reviews below it"))),
    h("tbody", {}, years.map((y) => h("tr", {}, h("td", {}, y),
      h("td", {}, META.rosetta[y].map(([v, p]) => h("span", { style: { marginRight: "12px", whiteSpace: "nowrap" } }, h("span", { class: "chip" }, v), ` ${Math.round(p * 100)}`))))))),
    h("p", { class: "hint" }, "Midpoint percentiles before the rebuttal (2026: final scores). A 2027 “3” sits near a 2025 “6”.")));
}

function renderValidation() {
  const V = META.validation;
  if (!V) { put($("validationTiles"), h("p", { class: "hint" }, "Validation has not been run.")); return; }
  const t = V.ac_2026_from_2024_2025, j = V.journey_accept_2025_from_2024, a = V.ac_2025_from_2024;
  put($("validationTiles"), 
    tile("Held-out 2026, AC stage", `AUC ${t.auc.toFixed(2)}`, `${fmt(t.n)} papers · Brier ${t.brier.toFixed(3)} vs ${t.brier_base.toFixed(3)} for a constant guess`),
    tile("2025 from 2024, AC stage", `AUC ${a.auc.toFixed(2)}`, `${fmt(a.n)} papers · Brier ${a.brier.toFixed(3)}`),
    tile("Before rebuttal → accepted", `AUC ${j.auc.toFixed(2)}`, `2025 from 2024 · ${fmt(j.n)} papers`),
  );
  const box = $("calibration");
  const W = Math.max(280, Math.min(box.clientWidth || 460, 520)), H = Math.round(W * 0.72), m = { l: 40, r: 12, t: 12, b: 36 };
  const x = (v) => m.l + v * (W - m.l - m.r), y = (v) => H - m.b - v * (H - m.t - m.b);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": "Calibration on held-out 2026: predicted versus observed accept rate" });
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    svg.append(s("line", { class: "gridline", x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    svg.append(s("text", { x: m.l - 6, y: y(v) + 4, "text-anchor": "end" }, `${v * 100}%`));
    svg.append(s("text", { x: x(v), y: H - m.b + 16, "text-anchor": "middle" }, `${v * 100}%`));
  }
  svg.append(s("line", { x1: x(0), y1: y(0), x2: x(1), y2: y(1), stroke: "var(--axis)", "stroke-width": 1 }));
  svg.append(s("text", { x: x(0.5), y: H - 4, "text-anchor": "middle", class: "t-muted" }, "Twins accepted (predicted)"));
  for (const c of t.calibration) {
    svg.append(s("circle", { cx: x(c.predicted), cy: y(c.observed), r: 5 + Math.min(5, Math.sqrt(c.n) / 12), fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 2,
      "data-tip": `<b>${Math.round(c.bin[0] * 100)}–${Math.round(c.bin[1] * 100)}% predicted</b><br>${fmt(c.n)} papers in 2026<br>predicted ${pct(c.predicted, 1)}, actually ${pct(c.observed, 1)}` }));
  }
  put(box, h("h3", {}, "Calibration on 2026 (never seen while tuning)"), svg,
    h("p", { class: "hint" }, "Each dot is a group of 2026 papers; on the diagonal means the stated rate came true. 2026 ACs overruled the scores more often than earlier years, so low rates came true a little more often than stated."));
}

function renderStamp() {
  const r = META.radar;
  const d = (x) => new Date(x).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  $("stamp").textContent = `Historical data built ${d(META.generated_at)}. ICLR 2027 scores: first snapshot ${d(r.first)}, latest ${d(r.latest)}${r.live ? " (live)" : ""}. ` +
    `${fmt(HIST.reduce((a, y) => a + META.years[y].reviewed, 0))} reviewed ICLR 2024-2026 papers.`;
}

/* ---------- run ---------- */
function run() {
  let st;
  try { st = readForm(); $("formError").textContent = ""; }
  catch (e) { $("formError").textContent = e.message; return; }
  const R = simulate(st);
  LAST = R;
  $("results").hidden = false;
  for (const f of [renderSummary, renderSankey, renderOverrule, renderEngagement, renderMatrix, renderWhatIf, renderTwins]) {
    try { f(R); } catch (e) { console.error(f.name, e); }
  }
  writeHash(st, $("paperNo").dataset.active || null);
}
let timer;
const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 200); };

let RADAR_PROMISE = null;
function loadRadar() {
  if (!RADAR_PROMISE) {
    RADAR_PROMISE = getJSON(RADAR + "papers.json").then((doc) => {
      const i = Object.fromEntries(doc.columns.map((c, k) => [c, k]));
      RADAR_PAPERS = new Map(doc.rows.map((r) => {
        const title = String(r[i.title] || "");
        return [String(r[i.number]), { number: r[i.number], forum: r[i.forum], title, key: norm(title),
          ratings: r[i.ratings], first: r[i.first_ratings] }];
      }));
      return RADAR_PAPERS;
    }).catch((e) => { RADAR_PROMISE = null; throw e; });
  }
  return RADAR_PROMISE;
}
const norm = (s) => " " + String(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim() + " ";

/* Every query word must start a word in the title; a whole-phrase match ranks first. */
function searchTitles(query, limit = 8) {
  const q = norm(query).trim();
  const words = q.split(" ").filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const p of RADAR_PAPERS.values()) {
    if (!words.every((w) => p.key.includes(" " + w))) continue;
    const score = (p.key.includes(" " + q + " ") ? 0 : p.key.includes(" " + q) ? 1 : 2) * 1000 + p.key.length / 10;
    hits.push([score, p]);
  }
  hits.sort((x, y) => x[0] - y[0]);
  return { total: hits.length, list: hits.slice(0, limit).map((x) => x[1]) };
}

function showMatches(res, query) {
  const ul = $("matches"), msg = $("lookupMsg");
  if (!res.list.length) {
    ul.hidden = true; put(ul);
    msg.textContent = `No active ICLR 2027 paper has a title matching “${query}”. Check the spelling, or try fewer words.`;
    return;
  }
  put(ul, res.list.map((p) => h("li", {}, h("button", {
    type: "button", class: "match",
    onclick: () => pick(p),
  }, h("span", { class: "num" }, `#${p.number}`), h("span", { class: "t" }, p.title),
    h("span", { class: "sc" }, p.ratings && p.ratings.length ? p.ratings.join(" · ") : "no reviews")))));
  ul.hidden = false;
  msg.textContent = res.total > res.list.length
    ? `${fmt(res.total)} papers match. Showing the best ${res.list.length}; add words to narrow it down.`
    : `${res.total} paper${res.total === 1 ? "" : "s"} match. Pick yours.`;
}

function pick(p) {
  const msg = $("lookupMsg");
  put($("matches")); $("matches").hidden = true;
  if (!p.ratings || !p.ratings.length) { msg.textContent = `Paper ${p.number} has no reviews yet.`; return; }
  $("scale").value = "2027";
  $("scale").dispatchEvent(new Event("change"));
  const first = p.first && p.first.length ? p.first : p.ratings;
  $("initial").value = first.join(", ");
  $("current").value = first.join() === p.ratings.join() ? "" : p.ratings.join(", ");
  $("paperNo").value = String(p.number);
  $("paperNo").dataset.active = String(p.number);
  put(msg, h("span", { class: "paper-found" }, `#${p.number} `, h("a", { href: `https://openreview.net/forum?id=${encodeURIComponent(p.forum)}`, target: "_blank", rel: "noopener" }, p.title)));
  run();
}

async function lookup(query, { live = false } = {}) {
  const msg = $("lookupMsg");
  query = String(query || "").trim();
  const number = query.replace(/^#/, "");
  const isNumber = /^\d+$/.test(number);
  if (!query) { put($("matches")); $("matches").hidden = true; return; }
  if (!isNumber && norm(query).trim().length < 3) { if (!live) msg.textContent = "Type at least 3 letters of the title, or the paper number."; return; }
  if (!RADAR_PAPERS) msg.textContent = "Loading ICLR 2027 papers…";
  try { await loadRadar(); }
  catch (e) { msg.textContent = "Could not reach the Rebuttal Radar data. Type your scores below instead."; return; }
  if ($("paperNo").value.trim() !== query && !live) return; // the box changed while loading
  if (isNumber) {
    const p = RADAR_PAPERS.get(number);
    if (live) { if (p) pick(p); return; } // typing a number loads it once the user pauses
    if (!p) { msg.textContent = `Paper ${number} is not in the active list. It may be withdrawn or desk-rejected, or not yet reviewed.`; return; }
    pick(p);
    return;
  }
  const res = searchTitles(query);
  if (!live && res.list.length === 1) { pick(res.list[0]); return; }
  showMatches(res, query);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get("e") != null) $("engagement").value = p.get("e");
  if (p.get("w") != null) $("words").value = p.get("w");
  if (p.get("q")) { $("paperNo").value = p.get("q"); lookup(p.get("q")); return false; }
  if (p.get("paper")) { $("paperNo").value = p.get("paper"); lookup(p.get("paper")); return true; }
  if (p.get("s")) {
    if (p.get("y") && META.rosetta[p.get("y")]) $("scale").value = p.get("y");
    $("initial").value = p.get("s").split(",").join(", ");
    $("current").value = p.get("now") ? p.get("now").split(",").join(", ") : "";
  }
  return false;
}

function setupTooltip() {
  const tip = $("tip");
  const show = (e) => {
    const t = e.target.closest && e.target.closest("[data-tip]");
    if (!t) { tip.hidden = true; return; }
    tip.innerHTML = t.getAttribute("data-tip");
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
    tip.style.left = Math.max(8, x) + "px"; tip.style.top = Math.max(8, y) + "px";
  };
  document.addEventListener("pointermove", show);
  document.addEventListener("pointerdown", show);
  document.addEventListener("scroll", () => (tip.hidden = true), { passive: true });
}

async function main() {
  $("results").hidden = true;
  try {
    const [meta, papers] = await Promise.all([getJSON("data/meta.json"), getJSON("data/papers.json")]);
    META = meta; ROWS = unpackRows(papers);
  } catch (e) {
    put($("summary"), h("p", { class: "error" }, "The data did not load. Reload the page. " + e.message));
    $("results").hidden = false;
    return;
  }
  document.querySelector("#method p").innerHTML = document.querySelector("#method p").innerHTML.replace("{K}", META.model.k);
  META.words.forEach((w, i) => $("words").append(h("option", { value: i }, w)));
  renderRosetta(); renderValidation(); renderStamp(); setupTooltip();
  const showScale = () => {
    const sc = scaleOf(Number($("scale").value));
    $("scaleHint").textContent = `Allowed scores: ${sc.join(", ")}`;
    $("initial").placeholder = `e.g. ${[sc[sc.length - 2], sc[1], sc[1]].join(", ")}`;
  };
  $("scale").addEventListener("change", showScale);
  // Refresh the 2027 distributions from the live Rebuttal Radar; keep the bundled copy on failure.
  getJSON(RADAR + "site.json").then((site) => {
    const t = radarTables(site);
    META.tables[2027] = { init: t.init, final: t.final };
    META.radar.latest = t.latest; META.radar.live = true;
    renderStamp();
    if (LAST && LAST.st.year === 2027) run();
  }).catch(() => {});
  $("form").addEventListener("input", (e) => {
    if (e.target.id === "paperNo") return;
    if (["initial", "current", "scale"].includes(e.target.id)) delete $("paperNo").dataset.active;
    schedule();
  });
  $("form").addEventListener("submit", (e) => { e.preventDefault(); lookup($("paperNo").value); });
  let searchTimer;
  $("paperNo").addEventListener("input", () => {
    delete $("paperNo").dataset.active;
    clearTimeout(searchTimer);
    const v = $("paperNo").value.trim();
    // numbers wait a little longer, so "82" does not load before "8241" is typed
    searchTimer = setTimeout(() => lookup($("paperNo").value, { live: true }), /^#?\d+$/.test(v) ? 650 : 220);
  });
  $("paperNo").addEventListener("focus", () => loadRadar().catch(() => {}), { once: true });
  $("paperNo").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lookup($("paperNo").value); } });
  let w = innerWidth;
  addEventListener("resize", () => { if (Math.abs(innerWidth - w) > 40 && LAST) { w = innerWidth; renderSankey(LAST); renderOverrule(LAST); renderEngagement(LAST); renderValidation(); } });
  const fromHash = readHash();
  showScale();
  if ($("engagement").value !== "" || $("words").value !== "") $("extra").open = true;
  if (!fromHash) run();
}
main();
