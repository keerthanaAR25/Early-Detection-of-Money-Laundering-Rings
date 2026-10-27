// Data shaping for the Evaluation page. Pure functions: they take the /api/evaluation response and return the series each chart draws.
// Nothing here is typed in as a result; every number comes from the response, and a missing block returns null so the page can say
// "Not yet evaluated" instead of drawing something made up.

export const isNum = (x) => typeof x === "number" && Number.isFinite(x);

export const MODEL_META = {
  static_graph_anomaly_isolation_forest: { label: "Static graph (Isolation Forest)", short: "Static graph", color: "#94a3b8" },
  behavioural_logistic_regression: { label: "Behavioural (logistic regression)", short: "Behavioural", color: "#d97706" },
  temporal_random_forest: { label: "Temporal (random forest)", short: "Temporal RF", color: "#059669" },
  proposed_gradient_boosting: { label: "Proposed (gradient boosting)", short: "Proposed", color: "#2563eb" },
};
export const metaOf = (name) => MODEL_META[name] || { label: String(name).replaceAll("_", " "), short: String(name).replaceAll("_", " "), color: "#64748b" };

export const COLORS = { queue: "#2563eb", alerts: "#ea580c", before: "#16a34a", at: "#f59e0b", after: "#dc2626", none: "#94a3b8", grey: "#94a3b8", run: "#2563eb" };

// ------------------------------------------------------------------------------------------------ number formatting
export const fmt = (x, d = 2) => (isNum(x) ? Number(x).toFixed(d) : "\u2014");
export const pct = (x, d = 0) => (isNum(x) ? `${(x * 100).toFixed(d)}%` : "\u2014");
export const sci = (x) => (isNum(x) ? (x !== 0 && Math.abs(x) < 1e-3 ? x.toExponential(1) : Number(x).toFixed(4)) : "\u2014");
export const int = (x) => (isNum(x) ? Math.round(x).toLocaleString("en-US") : "\u2014");

// ------------------------------------------------------------------------------------------------ statistics
// Wilson 95% interval for a proportion k of n (stays sensible for small counts).
export function wilson(k, n, z = 1.959964) {
  if (!isNum(k) || !isNum(n) || n <= 0) return null;
  const p = k / n, d = 1 + (z * z) / n, c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

// ------------------------------------------------------------------------------------------------ confusion matrices
// Rows are the ACTUAL class, columns the PREDICTED class; each cell also carries its share of its row (recall, miss rate, false-alarm rate, specificity).
export function confusionCells(cm) {
  if (!cm || ![cm.tp, cm.fp, cm.fn, cm.tn].every(isNum)) return null;
  const P = cm.tp + cm.fn, N = cm.fp + cm.tn;
  const cell = (key, count, base, good, row, col) => ({ key, count, rate: base > 0 ? count / base : null, good, row, col });
  return {
    total: P + N, positives: P, negatives: N,
    cells: [cell("tp", cm.tp, P, true, "Actual positive", "Predicted positive"), cell("fn", cm.fn, P, false, "Actual positive", "Predicted negative"),
            cell("fp", cm.fp, N, false, "Actual negative", "Predicted positive"), cell("tn", cm.tn, N, true, "Actual negative", "Predicted negative")],
    precision: cm.tp + cm.fp > 0 ? cm.tp / (cm.tp + cm.fp) : null, recall: P > 0 ? cm.tp / P : null, falsePositiveRate: N > 0 ? cm.fp / N : null,
  };
}

// The point on a curve where the validation-chosen threshold sits, from the test confusion matrix.
export function operatingPoint(cm) {
  const c = confusionCells(cm);
  return c ? { fpr: c.falsePositiveRate, recall: c.recall, precision: c.precision } : null;
}

// ------------------------------------------------------------------------------------------------ curves
export function rocSeries(models) {
  const rows = (models || []).filter((m) => m.curves && Array.isArray(m.curves.roc) && m.curves.roc.length > 1);
  if (!rows.length) return null;
  return rows.map((m) => ({ name: m.name, ...metaOf(m.name), auc: m.curves.roc_auc, points: m.curves.roc.map(([x, y]) => ({ x, y })), op: operatingPoint(m.confusion_matrix) }));
}

// The low false-positive region (an investigator can only review a few flags, so this is where a model is judged); the cut-off point is interpolated.
export function zoomRoc(points, xmax) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.x <= xmax) out.push(p);
    else {
      const q = points[i - 1];
      if (q) out.push({ x: xmax, y: q.y + ((p.y - q.y) * (xmax - q.x)) / (p.x - q.x) });
      break;
    }
  }
  return out;
}

// A precision-recall curve is a step curve: precision is constant between two positives and drops vertically as negatives are met.
// Its area under this step form equals the reported average precision exactly (a straight line between points would not).
export function stepPoints(pr) {
  const out = [];
  for (let i = 1; i < pr.length; i++) out.push({ x: pr[i - 1][0], y: pr[i][1] }, { x: pr[i][0], y: pr[i][1] });
  return out;
}
export function stepArea(points) {
  let a = 0;
  for (let i = 1; i < points.length; i++) a += ((points[i].y + points[i - 1].y) / 2) * (points[i].x - points[i - 1].x);
  return a;
}

export function prSeries(models) {
  const rows = (models || []).filter((m) => m.curves && Array.isArray(m.curves.pr) && m.curves.pr.length > 1);
  if (!rows.length) return null;
  return rows.map((m) => ({ name: m.name, ...metaOf(m.name), ap: m.curves.pr_auc, prevalence: m.curves.prevalence, points: stepPoints(m.curves.pr), op: operatingPoint(m.confusion_matrix) }));
}

// ------------------------------------------------------------------------------------------------ model comparison
export function comparisonRows(models) {
  if (!models || !models.length) return null;
  const metrics = [["precision", "Precision"], ["recall", "Recall"], ["f1", "F1"], ["pr_auc", "PR-AUC"], ["roc_auc", "ROC-AUC"]];
  return metrics.map(([key, label]) => ({ metric: label, ...Object.fromEntries(models.map((m) => [metaOf(m.name).short, m.metrics?.[key] ?? null])) }));
}

export function precisionAtKRows(models) {
  if (!models || !models.length) return null;
  const ks = ["10", "20", "50"];
  if (!models.some((m) => m.top_k_precision)) return null;
  return ks.map((k) => ({ k: `Top ${k}`, ...Object.fromEntries(models.map((m) => [metaOf(m.name).short, m.top_k_precision?.[k] ?? null])) }));
}

// ------------------------------------------------------------------------------------------------ early warning
export function thresholdRows(frontier) {
  if (!Array.isArray(frontier) || !frontier.length) return null;
  return frontier.map((r) => ({ threshold: r.threshold, alerts: r.n_alerted, precision: r.alert_precision, seen: r.rings_seen, early: r.warned_before_completion,
                                falsePerDay: r.false_alerts_per_day, lead: r.lead_days_median, configured: !!r.configured, evaluable: r.n_evaluable_rings }));
}

export function outcomeRows(outcomes) {
  if (!outcomes || !outcomes.queue || !outcomes.alert) return null;
  const row = (group, o) => ({ group, before: o.before, at: o.at, after: o.after, none: o.not_seen });
  return [row("Alerts (score 50 or more)", outcomes.alert), row("Whole queue", outcomes.queue)];
}

export function leadRows(rings) {
  if (!Array.isArray(rings) || !rings.length) return null;
  const val = (x) => (isNum(x) ? x : null);
  return rings.map((r) => ({ ring: `Ring ${r.ring_id}`, queue: val(r.queue_lead), alerts: val(r.alert_lead) }))
    .sort((a, b) => (b.queue ?? -99) - (a.queue ?? -99) || (b.alerts ?? -99) - (a.alerts ?? -99));
}

const BINS = [["After completion", (v) => v < 0], ["At completion (0)", (v) => v === 0], ["1 to 2 days", (v) => v >= 1 && v <= 2], ["3 to 5 days", (v) => v >= 3 && v <= 5],
              ["6 to 10 days", (v) => v >= 6 && v <= 10], ["11 to 15 days", (v) => v >= 11 && v <= 15], ["16 days or more", (v) => v >= 16]];
export function leadHistogram(rings) {
  if (!Array.isArray(rings) || !rings.length) return null;
  const count = (key, test) => rings.filter((r) => isNum(r[key]) && test(r[key])).length;
  const rows = BINS.map(([label, test]) => ({ bin: label, queue: count("queue_lead", test), alerts: count("alert_lead", test) }));
  rows.push({ bin: "No warning", queue: rings.filter((r) => !isNum(r.queue_lead)).length, alerts: rings.filter((r) => !isNum(r.alert_lead)).length });
  return rows;
}

// ------------------------------------------------------------------------------------------------ stability and uncertainty
// A whisker of exactly zero length would give its two end-caps identical coordinates (and a duplicate React key), so whiskers are never shorter than this.
const MIN_WHISKER = 1e-6;
const whisker = (lo, hi) => [Math.max(MIN_WHISKER, lo), Math.max(MIN_WHISKER, hi)];

export function stabilityRows(stability, keys, labels) {
  const m = stability?.metrics;
  if (!m) return null;
  const rows = keys.filter((k) => m[k]).map((k) => ({ metric: labels[k] || k, run: m[k].production, median: m[k].median, min: m[k].min, max: m[k].max,
                                                      err: whisker(m[k].median - m[k].min, m[k].max - m[k].median) }));
  return rows.length ? rows : null;
}
export const COUNT_STABILITY = [["alerts", "Alerts raised"], ["seen", "Rings seen (of 30)"], ["early", "Warned before completion"], ["high", "HIGH candidates"]];
export const RATIO_STABILITY = [["precision", "Alert precision"], ["p10", "Precision at 10"], ["auc", "Ranking AUC"]];

export function intervalRows(counts) {
  if (!counts) return null;
  const items = [["Queue sees the ring", counts.queue_seen, counts.n_evaluable], ["Queue warns before completion", counts.queue_early, counts.n_evaluable],
                 ["Alerts see the ring", counts.alerts_seen, counts.n_evaluable], ["Alerts warn before completion", counts.alerts_early, counts.n_evaluable],
                 ["Alerts that hold a ring transaction", counts.alerts_with_ring_tx, counts.alerts]];
  const rows = items.map(([label, k, n]) => ({ label, k, n, ci: wilson(k, n) })).filter((r) => r.ci)
    .map((r) => ({ label: r.label, k: r.k, n: r.n, p: r.ci.p, lo: r.ci.lo, hi: r.ci.hi, err: whisker(r.ci.p - r.ci.lo, r.ci.hi - r.ci.p) }));
  return rows.length ? rows : null;
}

// ------------------------------------------------------------------------------------------------ sources, controls, horizon, ranking
export function sourceRows(sources) {
  if (!Array.isArray(sources) || !sources.length) return null;
  return sources.map((s) => ({ source: s.label, seen: s.rings_seen, early: s.early, candidates: s.n_candidates, evaluable: s.n_evaluable }));
}

export const CONTROL_META = { xgb_with_novelty: { label: "Model with novelty features", color: "#2563eb" }, newness_rule: { label: "Newness rule (2-bit)", color: "#059669" },
                              xgb_without_novelty: { label: "Model without novelty", color: "#d97706" }, random: { label: "Random", color: "#94a3b8" } };
export function controlSeries(controls, field) {
  if (!Array.isArray(controls) || !controls.length) return null;
  const ks = [...new Set(controls.map((c) => c.per_day))].sort((a, b) => a - b);
  const rows = ks.map((k) => ({ perDay: k, ...Object.fromEntries(Object.keys(CONTROL_META).map((m) => [m, controls.find((c) => c.model === m && c.per_day === k)?.[field] ?? null])) }));
  return { rows, models: Object.keys(CONTROL_META).filter((m) => controls.some((c) => c.model === m)) };
}

export function horizonRows(horizon, field) {
  if (!Array.isArray(horizon) || !horizon.length) return null;
  const hs = [...new Set(horizon.map((h) => h.horizon_days))].sort((a, b) => a - b);
  const pick = (h, withHistory) => horizon.find((r) => r.horizon_days === h && (/no account history/i.test(r.name || "") ? !withHistory : withHistory));
  return hs.map((h) => ({ horizon: `${h} days`, positives: pick(h, false)?.n_test_pos ?? pick(h, true)?.n_test_pos ?? null,
                          "No account history": pick(h, false)?.[field] ?? null, "With account history": pick(h, true)?.[field] ?? null }));
}

export function rankingRows(ranking) {
  const p = ranking?.precision_at_k;
  if (!p) return null;
  const base = isNum(ranking.n_containing_ring_tx) && ranking.n_candidates > 0 ? ranking.n_containing_ring_tx / ranking.n_candidates : null;
  return { base, rows: Object.keys(p).sort((a, b) => Number(a) - Number(b)).map((k) => ({ k: `Top ${k}`, precision: p[k] })) };
}
