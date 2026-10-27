# EVALUATION PAGE (one page, charts only)

Open **Evaluation** in the sidebar (`/#/evaluation`). It shows every evaluation chart of the project on one page. Each chart reads one block of
`GET /api/evaluation`, which reads the result files the pipeline already wrote. Nothing on the page is typed in: titles, readings and legends are
generated from the data, and a chart whose data does not exist says **Not yet evaluated** with the command that produces it.

## Charts

| Group | Chart | Source |
|---|---|---|
| Confusion matrices | The four models on the 14-day test set (counts and the share of each row) | `model_comparison.json` |
| | Alerts on the candidate queue (alert or not, against holds a ring transaction or not) | `production_evaluation.json`, `lead_time_summary.json` |
| Curves | ROC (all four models, with the operating point), ROC at low false-positive rate, precision-recall (step curve, with chance level) | `evaluation_curves.json` |
| Models | Five metrics side by side; precision at K | `model_comparison.json` |
| | Ranking quality of the candidate queue | `lead_time_summary.json` |
| Early warning | Rings seen and warned early against the alert threshold; precision against false alerts per day | `lead_time_summary.json` |
| | Warning outcome for every evaluable ring; lead-time distribution; lead time of every ring | `warnings.json` |
| Uncertainty | Stability over five retrainings (counts and ratios); Wilson 95% intervals | `lead_time_summary.json` |
| Sources and controls | Candidate sources; controls (detection and early-warning against the daily flag budget); forecast-horizon sensitivity | `production_evaluation.json`, `ring_lead_time_summary.json`, `account_window_eval_v2.json` |

The retired v1 baseline is not shown on this page.

## One extra step: the ROC and precision-recall curves

A curve needs the model's scores, which the earlier runs did not save. The models stage now also writes the curves, and `export` stores them in a **new** file,
`results/evaluation_curves.json`. No existing result file changes (`model_comparison.json` stays byte-identical).

```powershell
python scripts/rebuild_v2.py models      # about 1 minute
python scripts/rebuild_v2.py export      # seconds
```

Until you run these, the three curve charts show "Not yet evaluated" and every other chart works.

## Why the curves can be trusted

- They are computed from the same scores as the reported metrics. The stage raises an error if the ROC-AUC of the curve differs from the reported ROC-AUC, or if the
  average precision of the precision-recall points differs from the reported PR-AUC.
- The API shows a curve only if its AUC and average precision match the metrics in `model_comparison.json`; a curve file from a different run is refused with an explanation.
- The precision-recall curve is drawn as a step curve (precision is constant between two positives), because its area is then exactly the reported average precision.
- Lines between alert thresholds are straight: nothing is smoothed between points that were not evaluated.

## Tests

`frontend/vtest/pages.test.jsx` (20 new tests) and `tests/test_evaluation_page.py` (11 new tests). They check that the confusion matrices add up to the test set, that each
curve ends where it must and encloses the reported AUC, that the Wilson intervals match SciPy, that every ring is accounted for in every outcome chart, and that missing or
mismatched data shows "Not yet evaluated". Charts are drawn at a fixed width in tests through `window.__EVAL_CHART_WIDTH__` (a test and image-export hook; unset in the browser).
