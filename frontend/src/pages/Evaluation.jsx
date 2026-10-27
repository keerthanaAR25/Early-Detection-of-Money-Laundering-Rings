import React from "react";
import { api } from "../api.js";
import { Loading, ErrorBox, useApi } from "../components/ui.jsx";
import {
  ResponsiveContainer, ScatterChart, Scatter, LineChart, Line, BarChart, Bar, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ReferenceDot, ErrorBar, LabelList,
} from "recharts";
import * as E from "../utils/evaluationCharts.js";

// One page, charts only: every evaluation chart of the project. Each chart reads one block of /api/evaluation, which reads the result
// files the pipeline wrote. A block that does not exist is shown as "Not yet evaluated" with the command that produces it.

const TICK = { fontSize: 11 };
const MARGIN = { top: 8, right: 16, bottom: 24, left: 4 };
const CURVE_CMD = "python scripts/rebuild_v2.py models   then   python scripts/rebuild_v2.py export";
const percentTick = (v) => `${Math.round(v * 100)}%`;

// Charts size themselves to their card. A fixed width can be forced (tests and image export) with window.__EVAL_CHART_WIDTH__.
function Sized({ height, children }) {
  const w = typeof window !== "undefined" ? window.__EVAL_CHART_WIDTH__ : undefined;
  if (w) return <div style={{ height }}>{React.cloneElement(children, { width: w, height })}</div>;
  return <ResponsiveContainer width="100%" height={height}>{children}</ResponsiveContainer>;
}

function NotYet({ cmd, note }) {
  return (
    <div className="text-sm text-muted py-6" data-testid="not-yet">
      <div className="font-semibold">Not yet evaluated</div>
      {note && <div className="mt-1">{note}</div>}
      {cmd && <div className="mt-2 font-mono text-xs">{cmd}</div>}
    </div>
  );
}

// A legend drawn by us (not measured from the DOM), so it sits above the plot and can never collide with an axis label.
function LegendRow({ items }) {
  if (!items || !items.length) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2 text-[11px]" data-testid="legend">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: i.color }} />{i.label}
        </span>
      ))}
    </div>
  );
}

function ChartCard({ id, title, reading, wide, children, cmd, note, legend }) {
  return (
    <div data-testid={`chart-${id}`} className={`card ${wide ? "md:col-span-2" : ""}`}>
      <div className="text-xs uppercase text-muted tracking-wide font-semibold">{title}</div>
      {reading && <div className="text-xs text-muted mt-1 mb-3" data-testid={`reading-${id}`}>{reading}</div>}
      {!reading && <div className="mb-3" />}
      {children ? <><LegendRow items={legend} />{children}</> : <NotYet cmd={cmd} note={note} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ confusion matrix
const CELL_NAME = { tp: "True positive", fn: "False negative", fp: "False positive", tn: "True negative" };
const CELL_RATE = { tp: "recall", fn: "missed", fp: "false-alarm rate", tn: "specificity" };
const rateText = (r) => (!E.isNum(r) ? "\u2014" : r > 0 && r < 0.0001 ? `${(r * 100).toFixed(4)}%` : E.pct(r, r < 0.01 ? 3 : 1));

function ConfusionMatrix({ id, title, cm, reading, actual = ["Actual positive", "Actual negative"], predicted = ["Predicted positive", "Predicted negative"], proposed }) {
  const c = E.confusionCells(cm);
  return (
    <div data-testid={`cm-${id}`} className={`card ${proposed ? "risk-glow" : ""}`}>
      <div className="text-xs uppercase text-muted tracking-wide font-semibold">{title}</div>
      {c ? (
        <>
          <div className="text-xs text-muted mt-1 mb-3" data-testid={`cm-reading-${id}`}>{reading || `Precision ${E.pct(c.precision, 1)}, recall ${E.pct(c.recall, 1)}, false-positive rate ${rateText(c.falsePositiveRate)} (${E.int(c.total)} rows).`}</div>
          <div className="grid gap-1" style={{ gridTemplateColumns: "88px 1fr 1fr" }}>
            <div />
            <div className="text-[11px] text-muted text-center">{predicted[0]}</div>
            <div className="text-[11px] text-muted text-center">{predicted[1]}</div>
            {[0, 1].map((r) => (
              <React.Fragment key={r}>
                <div className="text-[11px] text-muted flex items-center">{actual[r]}</div>
                {c.cells.slice(r * 2, r * 2 + 2).map((x) => {
                  const a = x.good ? 0.14 + 0.78 * (x.rate || 0) : 0.1 + 0.7 * (x.rate || 0);
                  const bg = x.good ? `rgba(37,99,235,${a})` : `rgba(234,88,12,${a})`;
                  return (
                    <div key={x.key} data-cell={x.key} data-count={x.count} className="rounded-md px-2 py-2 text-center" style={{ background: bg, color: a > 0.6 ? "#fff" : "#0f172a" }}>
                      <div className="text-lg font-bold leading-tight">{E.int(x.count)}</div>
                      <div className="text-[10px] opacity-90">{CELL_NAME[x.key]}</div>
                      <div className="text-[10px] opacity-90">{rateText(x.rate)} {CELL_RATE[x.key]}</div>
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </>
      ) : (
        <NotYet cmd="python scripts/rebuild_v2.py all" />
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the page
export default function Evaluation() {
  const { data, loading, error } = useApi(() => api.evaluation(), []);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data || {};
  const models = d.models || null;
  const proposed = (models || []).find((m) => m.proposed);
  const curveNote = d.curves_status === "mismatch" ? "The curve file was produced by a different run than the metrics shown elsewhere. Re-run the commands below so both come from one run." : null;

  const roc = E.rocSeries(models), pr = E.prSeries(models);
  const cmp = E.comparisonRows(models), pk = E.precisionAtKRows(models);
  const thr = E.thresholdRows(d.frontier), outcomes = E.outcomeRows(d.outcomes), leads = E.leadRows(d.rings), hist = E.leadHistogram(d.rings);
  const stabCount = E.stabilityRows(d.stability, E.COUNT_STABILITY.map((x) => x[0]), Object.fromEntries(E.COUNT_STABILITY));
  const stabRatio = E.stabilityRows(d.stability, E.RATIO_STABILITY.map((x) => x[0]), Object.fromEntries(E.RATIO_STABILITY));
  const intervals = E.intervalRows(d.counts), sources = E.sourceRows(d.sources);
  const ctrlDetect = E.controlSeries(d.controls, "detection_rate"), ctrlEarly = E.controlSeries(d.controls, "early_rate");
  const horPr = E.horizonRows(d.horizon, "pr_auc"), horPrec = E.horizonRows(d.horizon, "precision"), ranking = E.rankingRows(d.ranking);
  const configured = d.alert_threshold;
  const LG = { queue: { label: "Whole queue", color: E.COLORS.queue }, alerts: { label: "Alerts", color: E.COLORS.alerts } };
  const modelLegend = (models || []).map((m) => ({ label: E.metaOf(m.name).short, color: E.metaOf(m.name).color }));
  const curveLegend = (roc || pr || []).map((r) => ({ label: r.short, color: r.color }));
  const runLegend = [{ label: "This run", color: E.COLORS.run }, { label: "Median (whisker: range over retrainings)", color: "#cbd5e1" }];
  const n = d.counts?.n_evaluable;
  const first = proposed?.confusion_matrix ? E.confusionCells(proposed.confusion_matrix) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Evaluation</h1>
        <p className="text-sm text-muted">Every evaluation chart on one page. AMLSim ground-truth labels are used only to evaluate; they never build a candidate or a score.</p>
      </div>

      {first && (
        <div className="flex flex-wrap gap-x-8 gap-y-1 text-sm" data-testid="task-strip">
          <span><b>{E.int(first.total)}</b> test rows</span>
          <span><b>{E.int(first.positives)}</b> positives ({E.pct(first.positives / first.total, 4)})</span>
          {d.curve_task?.horizon_days != null && <span><b>{d.curve_task.horizon_days}-day</b> forecast horizon</span>}
          {E.isNum(configured) && <span>alert threshold <b>{configured}</b></span>}
          <span>threshold rule: {d.curve_task?.threshold_rule || "max F1 on validation"}</span>
        </div>
      )}

      {/* ---------------------------------------------------------------- confusion matrices */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="section-confusion">
        {models
          ? models.map((m) => <ConfusionMatrix key={m.name} id={m.name} title={`Confusion matrix: ${E.metaOf(m.name).label}`} cm={m.confusion_matrix} proposed={m.proposed} />)
          : <ConfusionMatrix id="models" title="Confusion matrices: the four models" cm={null} />}
        <ConfusionMatrix id="alerts" title="Confusion matrix: alerts on the candidate queue" cm={d.alert_confusion?.confusion_matrix}
          actual={["Holds a ring transaction", "Holds none"]} predicted={["Alert given", "No alert"]}
          reading={d.alert_confusion ? `${d.alert_confusion.n_alerts} alerts among ${d.alert_confusion.n_candidates} candidates; ${d.alert_confusion.n_ring_candidates} candidates hold a ring transaction.` : null} />
      </div>

      {/* ---------------------------------------------------------------- curves and model comparison */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="section-curves">
        <ChartCard id="roc" legend={curveLegend} title="ROC curves (all four models)" cmd={CURVE_CMD} note={curveNote}
          reading={roc ? `ROC-AUC: ${roc.map((r) => `${r.short} ${E.fmt(r.auc, 4)}`).join(", ")}. Dots mark each model at its validation-chosen threshold.` : null}>
          {roc && (
            <Sized height={300}>
              <ScatterChart margin={MARGIN}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" dataKey="x" name="False-positive rate" domain={[0, 1]} tick={TICK} tickFormatter={percentTick} label={{ value: "False-positive rate", position: "insideBottom", offset: -12, fontSize: 11 }} />
                <YAxis type="number" dataKey="y" name="True-positive rate" domain={[0, 1]} tick={TICK} tickFormatter={percentTick} />
                <Tooltip cursor={{ strokeDasharray: "3 3" }} formatter={(v) => E.fmt(v, 4)} />
                <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="#cbd5e1" strokeDasharray="5 5" />
                {roc.map((r) => <Scatter key={r.name} name={r.short} data={r.points} line={{ stroke: r.color, strokeWidth: r.name.startsWith("proposed") ? 3 : 2 }} lineType="joint" shape={() => null} legendType="line" fill={r.color} isAnimationActive={false} />)}
                {roc.filter((r) => r.op && E.isNum(r.op.fpr)).map((r) => <ReferenceDot key={r.name} x={r.op.fpr} y={r.op.recall} r={5} fill={r.color} stroke="#fff" />)}
              </ScatterChart>
            </Sized>
          )}
        </ChartCard>

        <ChartCard id="roc-zoom" legend={curveLegend} title="ROC curves, low false-positive region" cmd={CURVE_CMD} note={curveNote}
          reading={roc ? "The same curves up to a 2% false-positive rate: the region an investigator can actually review." : null}>
          {roc && (
            <Sized height={300}>
              <ScatterChart margin={MARGIN}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" dataKey="x" name="False-positive rate" domain={[0, 0.02]} tick={TICK} tickFormatter={(v) => `${(v * 100).toFixed(1)}%`} label={{ value: "False-positive rate", position: "insideBottom", offset: -12, fontSize: 11 }} />
                <YAxis type="number" dataKey="y" name="True-positive rate" domain={[0, 1]} tick={TICK} tickFormatter={percentTick} />
                <Tooltip cursor={{ strokeDasharray: "3 3" }} formatter={(v) => E.fmt(v, 4)} />
                {roc.map((r) => <Scatter key={r.name} name={r.short} data={E.zoomRoc(r.points, 0.02)} line={{ stroke: r.color, strokeWidth: r.name.startsWith("proposed") ? 3 : 2 }} lineType="joint" shape={() => null} legendType="line" fill={r.color} isAnimationActive={false} />)}
              </ScatterChart>
            </Sized>
          )}
        </ChartCard>

        <ChartCard id="pr" legend={curveLegend} title="Precision-recall curves (all four models)" cmd={CURVE_CMD} note={curveNote}
          reading={pr ? `Average precision: ${pr.map((r) => `${r.short} ${E.fmt(r.ap, 4)}`).join(", ")}. The dashed line is chance: the share of positives (${E.pct(pr[0].prevalence, 4)}).` : null}>
          {pr && (
            <Sized height={300}>
              <ScatterChart margin={MARGIN}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" dataKey="x" name="Recall" domain={[0, 1]} tick={TICK} tickFormatter={percentTick} label={{ value: "Recall", position: "insideBottom", offset: -12, fontSize: 11 }} />
                <YAxis type="number" dataKey="y" name="Precision" domain={[0, 1]} tick={TICK} tickFormatter={percentTick} />
                <Tooltip cursor={{ strokeDasharray: "3 3" }} formatter={(v) => E.fmt(v, 4)} />
                <ReferenceLine y={pr[0].prevalence} stroke="#94a3b8" strokeDasharray="5 5" />
                {pr.map((r) => <Scatter key={r.name} name={r.short} data={r.points} line={{ stroke: r.color, strokeWidth: r.name.startsWith("proposed") ? 3 : 2 }} lineType="joint" shape={() => null} legendType="line" fill={r.color} isAnimationActive={false} />)}
                {pr.filter((r) => r.op && E.isNum(r.op.recall) && E.isNum(r.op.precision)).map((r) => <ReferenceDot key={r.name} x={r.op.recall} y={r.op.precision} r={5} fill={r.color} stroke="#fff" />)}
              </ScatterChart>
            </Sized>
          )}
        </ChartCard>

        <ChartCard id="metrics" legend={modelLegend} title="Model comparison: five metrics, four models"
          reading={cmp && proposed ? `Same chronological protocol for every model. Proposed: precision ${E.fmt(proposed.metrics.precision, 3)}, recall ${E.fmt(proposed.metrics.recall, 3)}, PR-AUC ${E.fmt(proposed.metrics.pr_auc, 4)}.` : null}>
          {cmp && (
            <Sized height={300}>
              <BarChart data={cmp} margin={MARGIN}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="metric" tick={TICK} />
                <YAxis domain={[0, 1]} tick={TICK} tickFormatter={percentTick} />
                <Tooltip formatter={(v) => E.fmt(v, 4)} />
                {models.map((m) => <Bar key={m.name} dataKey={E.metaOf(m.name).short} fill={E.metaOf(m.name).color} isAnimationActive={false} />)}
              </BarChart>
            </Sized>
          )}
        </ChartCard>

        <ChartCard id="precision-k" legend={modelLegend} title="Precision at K: are the top-ranked items positive?"
          reading={pk ? "Share of the K highest-scored test rows that are true positives (K = 10, 20, 50)." : null}>
          {pk && (
            <Sized height={280}>
              <BarChart data={pk} margin={MARGIN}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="k" tick={TICK} />
                <YAxis domain={[0, 1]} tick={TICK} tickFormatter={percentTick} />
                <Tooltip formatter={(v) => E.pct(v, 0)} />
                {models.map((m) => <Bar key={m.name} dataKey={E.metaOf(m.name).short} fill={E.metaOf(m.name).color} isAnimationActive={false} />)}
              </BarChart>
            </Sized>
          )}
        </ChartCard>

        <ChartCard id="ranking" title="Ranking quality of the candidate queue"
          reading={ranking ? `Share of the top K candidates that hold a ring transaction, against the overall share (${E.pct(ranking.base, 1)}, dashed).` : null}>
          {ranking && (
            <Sized height={280}>
              <BarChart data={ranking.rows} margin={MARGIN}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="k" tick={TICK} />
                <YAxis domain={[0, 1]} tick={TICK} tickFormatter={percentTick} />
                <Tooltip formatter={(v) => E.pct(v, 0)} />
                {E.isNum(ranking.base) && <ReferenceLine y={ranking.base} stroke="#64748b" strokeDasharray="5 5" />}
                <Bar dataKey="precision" name="Precision" fill={E.COLORS.queue} isAnimationActive={false} />
              </BarChart>
            </Sized>
          )}
        </ChartCard>
      </div>

      {/* ---------------------------------------------------------------- early warning */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="section-early">
        <ChartCard id="threshold" legend={[{ label: "Rings seen", color: E.COLORS.queue }, { label: "Warned before completion", color: E.COLORS.before }]} title="Alert threshold: rings seen and warned before completion"
          reading={thr ? `Out of ${thr[0].evaluable} evaluable rings. The configured threshold (${configured}) was fixed before the evaluation.` : null}>
          {thr && (
            <Sized height={280}>
              <LineChart data={thr} margin={MARGIN}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="threshold" tick={TICK} label={{ value: "Alert threshold (risk score)", position: "insideBottom", offset: -12, fontSize: 11 }} />
                <YAxis domain={[0, thr[0].evaluable || "auto"]} tick={TICK} tickCount={7} allowDecimals={false} />
                <Tooltip />
                {E.isNum(configured) && <ReferenceLine x={configured} stroke="#64748b" strokeDasharray="5 5" />}
                <Line type="linear" dataKey="seen" name="Rings seen" stroke={E.COLORS.queue} strokeWidth={2} isAnimationActive={false} />
                <Line type="linear" dataKey="early" name="Warned before completion" stroke={E.COLORS.before} strokeWidth={2} isAnimationActive={false} />
              </LineChart>
            </Sized>
          )}
        </ChartCard>

        <ChartCard id="tradeoff" legend={[{ label: "Alert precision (left axis)", color: E.COLORS.alerts }, { label: "False alerts per day (right axis)", color: "#64748b" }]} title="Alert threshold: precision against false alerts per day"
          reading={thr ? "A lower threshold sees more rings but raises more false alerts; a higher one does the opposite." : null}>
          {thr && (
            <Sized height={280}>
              <ComposedChart data={thr} margin={{ ...MARGIN, right: 24 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="threshold" tick={TICK} label={{ value: "Alert threshold (risk score)", position: "insideBottom", offset: -12, fontSize: 11 }} />
                <YAxis yAxisId="l" domain={[0, 1]} tick={TICK} tickFormatter={percentTick} />
                <YAxis yAxisId="r" orientation="right" tick={TICK} tickFormatter={(v) => v.toFixed(2)} />
                <Tooltip formatter={(v, name) => (name === "False alerts per day" ? E.fmt(v, 4) : E.pct(v, 0))} />
                {E.isNum(configured) && <ReferenceLine yAxisId="l" x={configured} stroke="#64748b" strokeDasharray="5 5" />}
                <Line yAxisId="l" type="linear" dataKey="precision" name="Alert precision" stroke={E.COLORS.alerts} strokeWidth={2} isAnimationActive={false} />
                <Line yAxisId="r" type="linear" dataKey="falsePerDay" name="False alerts per day" stroke="#64748b" strokeWidth={2} strokeDasharray="4 3" isAnimationActive={false} />
              </ComposedChart>
            </Sized>
          )}
        </ChartCard>

        <ChartCard id="outcomes" legend={[{ label: "Before completion", color: E.COLORS.before }, { label: "At completion", color: E.COLORS.at }, { label: "After completion", color: E.COLORS.after }, { label: "No warning", color: E.COLORS.none }]} title="Warning outcome for every evaluable ring"
          reading={outcomes ? `Each bar is the ${n} evaluable rings: warned before completion, at completion, after, or never.` : null}>
          {outcomes && (
            <Sized height={220}>
              <BarChart data={outcomes} layout="vertical" margin={{ ...MARGIN, left: 90 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" domain={[0, n || "auto"]} tick={TICK} />
                <YAxis type="category" dataKey="group" tick={TICK} width={130} />
                <Tooltip />
                <Bar dataKey="before" name="Before completion" stackId="o" fill={E.COLORS.before} isAnimationActive={false} />
                <Bar dataKey="at" name="At completion" stackId="o" fill={E.COLORS.at} isAnimationActive={false} />
                <Bar dataKey="after" name="After completion" stackId="o" fill={E.COLORS.after} isAnimationActive={false} />
                <Bar dataKey="none" name="No warning" stackId="o" fill={E.COLORS.none} isAnimationActive={false} />
              </BarChart>
            </Sized>
          )}
        </ChartCard>

        <ChartCard id="lead-hist" legend={[LG.queue, LG.alerts]} title="Distribution of lead time (days before ring completion)"
          reading={hist ? "How many of the evaluable rings fall in each lead-time band, for the queue and for the alerts." : null}>
          {hist && (
            <Sized height={260}>
              <BarChart data={hist} margin={{ ...MARGIN, bottom: 44 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="bin" tick={{ fontSize: 10 }} interval={0} angle={-25} textAnchor="end" height={60} />
                <YAxis allowDecimals={false} tick={TICK} />
                <Tooltip />
                <Bar dataKey="queue" name="Whole queue" fill={E.COLORS.queue} isAnimationActive={false} />
                <Bar dataKey="alerts" name="Alerts" fill={E.COLORS.alerts} isAnimationActive={false} />
              </BarChart>
            </Sized>
          )}
        </ChartCard>

        <ChartCard id="lead-rings" wide legend={[LG.queue, LG.alerts]} title="Lead time of every evaluable ring (days before completion)"
          reading={leads ? "Longer bars mean earlier warnings. The label is the lead in days: 0 means warned exactly at completion; no label means that ring never raised a warning." : null}>
          {leads && (
            <Sized height={Math.max(360, leads.length * 22 + 60)}>
              <BarChart data={leads} layout="vertical" margin={{ ...MARGIN, left: 20 }} barCategoryGap={3}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={TICK} label={{ value: "Lead time (days)", position: "insideBottom", offset: -12, fontSize: 11 }} />
                <YAxis type="category" dataKey="ring" tick={{ fontSize: 10 }} width={64} interval={0} />
                <Tooltip />
                <ReferenceLine x={0} stroke="#334155" />
                <Bar dataKey="queue" name="Whole queue" fill={E.COLORS.queue} isAnimationActive={false}><LabelList dataKey="queue" position="right" style={{ fontSize: 9, fill: "#475569" }} /></Bar>
                <Bar dataKey="alerts" name="Alerts" fill={E.COLORS.alerts} isAnimationActive={false}><LabelList dataKey="alerts" position="right" style={{ fontSize: 9, fill: "#475569" }} /></Bar>
              </BarChart>
            </Sized>
          )}
        </ChartCard>
      </div>

      {/* ---------------------------------------------------------------- stability and uncertainty */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="section-uncertainty">
        <ChartCard id="stability-counts" legend={runLegend} title="Stability over retrainings: counts"
          reading={stabCount ? `Behavioural model retrained with ${d.stability?.seeds?.length || d.stability?.n_retrainings} seeds. Blue is this run; grey is the median, with its range as the whisker.` : null}>
          {stabCount && (
            <Sized height={280}>
              <BarChart data={stabCount} margin={{ ...MARGIN, bottom: 44 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="metric" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={56} />
                <YAxis tick={TICK} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="run" name="This run" fill={E.COLORS.run} isAnimationActive={false} />
                <Bar dataKey="median" name="Median (range)" fill="#cbd5e1" isAnimationActive={false}><ErrorBar dataKey="err" width={5} stroke="#334155" /></Bar>
              </BarChart>
            </Sized>
          )}
        </ChartCard>

        <ChartCard id="stability-ratios" legend={runLegend} title="Stability over retrainings: precision and ranking"
          reading={stabRatio ? "The same comparison for the ratios: alert precision, precision at 10 and the ranking AUC." : null}>
          {stabRatio && (
            <Sized height={280}>
              <BarChart data={stabRatio} margin={MARGIN}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="metric" tick={TICK} />
                <YAxis domain={[0, 1]} tick={TICK} tickFormatter={percentTick} />
                <Tooltip formatter={(v) => E.pct(v, 1)} />
                <Bar dataKey="run" name="This run" fill={E.COLORS.run} isAnimationActive={false} />
                <Bar dataKey="median" name="Median (range)" fill="#cbd5e1" isAnimationActive={false}><ErrorBar dataKey="err" width={5} stroke="#334155" /></Bar>
              </BarChart>
            </Sized>
          )}
        </ChartCard>

        <ChartCard id="intervals" wide title="How sure are these proportions? (Wilson 95% intervals)"
          reading={intervals ? `With only ${n} evaluable rings the intervals are wide: quote the interval, not the single number.` : null}>
          {intervals && (
            <Sized height={260}>
              <BarChart data={intervals} layout="vertical" margin={{ ...MARGIN, left: 30 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" domain={[0, 1]} tick={TICK} tickFormatter={percentTick} />
                <YAxis type="category" dataKey="label" tick={TICK} width={210} />
                <Tooltip formatter={(v) => E.pct(v, 0)} />
                <Bar dataKey="p" name="Observed share" fill={E.COLORS.queue} barSize={14} isAnimationActive={false}><ErrorBar dataKey="err" width={6} stroke="#0f172a" direction="x" /></Bar>
              </BarChart>
            </Sized>
          )}
        </ChartCard>
      </div>

      {/* ---------------------------------------------------------------- sources, controls, horizon */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="section-controls">
        <ChartCard id="sources" wide legend={[{ label: "Rings seen", color: E.COLORS.queue }, { label: "Warned before completion", color: E.COLORS.before }]} title="Candidate sources on the same rings"
          reading={sources ? `Rings seen and warned before completion, out of ${sources[0].evaluable}, for each way of building candidates.` : null}>
          {sources && (
            <Sized height={240}>
              <BarChart data={sources} layout="vertical" margin={{ ...MARGIN, left: 30 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" domain={[0, sources[0].evaluable || "auto"]} tick={TICK} allowDecimals={false} />
                <YAxis type="category" dataKey="source" tick={TICK} width={220} />
                <Tooltip />
                <Bar dataKey="seen" name="Rings seen" fill={E.COLORS.queue} isAnimationActive={false} />
                <Bar dataKey="early" name="Warned before completion" fill={E.COLORS.before} isAnimationActive={false} />
              </BarChart>
            </Sized>
          )}
        </ChartCard>

        {[["controls-detect", "Controls: rings detected as the daily flag budget grows", ctrlDetect, "Share of rings detected when only the top K transactions per day are flagged."],
          ["controls-early", "Controls: rings warned before completion", ctrlEarly, "The same budget, counting only warnings that came before the ring completed."]].map(([id, title, s, reading]) => (
          <ChartCard key={id} id={id} legend={s ? s.models.map((m) => ({ label: E.CONTROL_META[m].label, color: E.CONTROL_META[m].color })) : null} title={title} reading={s ? reading : null} note="This control is produced by scripts/run_ring_lead_time.py." cmd="python scripts/run_ring_lead_time.py">
            {s && (
              <Sized height={280}>
                <LineChart data={s.rows} margin={MARGIN}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="perDay" tick={TICK} label={{ value: "Flagged transactions per day", position: "insideBottom", offset: -12, fontSize: 11 }} />
                  <YAxis domain={[0, 1]} tick={TICK} tickFormatter={percentTick} />
                  <Tooltip formatter={(v) => E.pct(v, 0)} />
                  {s.models.map((m) => <Line key={m} type="linear" dataKey={m} name={E.CONTROL_META[m].label} stroke={E.CONTROL_META[m].color} strokeWidth={m === "xgb_with_novelty" ? 3 : 2} connectNulls isAnimationActive={false} />)}
                </LineChart>
              </Sized>
            )}
          </ChartCard>
        ))}

        {[["horizon-pr", "Forecast horizon: PR-AUC", horPr, E.fmt, "Rows with a different horizon are different tasks. More days means more positives, which raises these numbers without a better model."],
          ["horizon-precision", "Forecast horizon: precision", horPrec, (v) => E.pct(v, 0), "Precision of the model at its validation-chosen threshold, with and without account history."]].map(([id, title, rows, f, reading]) => (
          <ChartCard key={id} id={id} legend={[{ label: "No account history", color: "#94a3b8" }, { label: "With account history", color: E.COLORS.queue }]} title={title} reading={rows ? reading : null} note="This sensitivity analysis is produced by scripts/run_account_window_eval.py." cmd="python scripts/run_account_window_eval.py">
            {rows && (
              <Sized height={260}>
                <BarChart data={rows} margin={MARGIN}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="horizon" tick={TICK} />
                  <YAxis tick={TICK} tickFormatter={id === "horizon-precision" ? percentTick : undefined} domain={id === "horizon-precision" ? [0, 1] : [0, "auto"]} />
                  <Tooltip formatter={(v) => f(v, 4)} />
                  <Bar dataKey="No account history" fill="#94a3b8" isAnimationActive={false} />
                  <Bar dataKey="With account history" fill={E.COLORS.queue} isAnimationActive={false} />
                </BarChart>
              </Sized>
            )}
          </ChartCard>
        ))}
      </div>

      <div className="card text-xs text-muted" data-testid="responsible-use">
        <div className="font-semibold text-sm mb-1">Important interpretation</div>
        These are experimental evaluation metrics for the current AMLSim configuration. They should not be read as evidence that the system is production-ready or as legal confirmation of suspicious activity. A risk score indicates investigative priority, not criminal guilt.
      </div>
    </div>
  );
}
