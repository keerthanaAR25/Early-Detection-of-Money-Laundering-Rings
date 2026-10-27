"""
Extra read-only endpoints (ADDITIVE). They replace numbers that were typed into the dashboard pages as literals
(Overview "Detection Pipeline", Model Performance "evaluation context", Alert Queue "of 142") and serve the new
ring-level evaluation results. Every value is counted from the database or read from a results file; when something is
missing the field is null and the page shows an em dash -- never a made-up number.
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from backend.database.models import Account, GraphWindow, PatternEventRow, RingCandidateRow, Transaction
from backend.database.session import get_db

ROOT = Path(__file__).resolve().parents[2]
router = APIRouter()


def _read_json(name: str):
    p = ROOT / "results" / name
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


@router.get("/pipeline-stats")
def pipeline_stats(db: Session = Depends(get_db)):
    trajectories = _read_json("trajectories.json")
    active = db.execute(text(
        "SELECT COUNT(*) FROM (SELECT sender AS a FROM transactions UNION SELECT receiver FROM transactions)")).scalar()
    first = db.query(GraphWindow).order_by(GraphWindow.window_id.asc()).first()
    last = db.query(GraphWindow).order_by(GraphWindow.window_id.desc()).first()
    window_days = None
    if first is not None and first.window_start is not None and first.window_end is not None:
        window_days = (first.window_end - first.window_start).total_seconds() / 86400.0
    return {
        "window_days": window_days,
        "first_window_start": first.window_start.isoformat() if first is not None and first.window_start else None,
        "last_window_end": last.window_end.isoformat() if last is not None and last.window_end else None,
        "n_transactions": db.query(func.count(Transaction.transaction_id)).scalar(),
        "n_alert_transactions": db.query(func.count(Transaction.transaction_id)).filter(Transaction.label == 1).scalar(),
        "dataset_source": (db.query(Transaction.dataset_source).filter(Transaction.dataset_source.isnot(None)).limit(1).scalar()
                           or db.query(Account.dataset_source).filter(Account.dataset_source.isnot(None)).limit(1).scalar()),
        "n_accounts_total": db.query(func.count(Account.account_id)).scalar(),
        "n_accounts_with_transactions": active,
        "n_graph_windows": db.query(func.count(GraphWindow.window_id)).scalar(),
        "n_pattern_events": db.query(func.count(PatternEventRow.id)).scalar()
        if hasattr(PatternEventRow, "id") else db.query(PatternEventRow).count(),
        "n_trajectories": len(trajectories) if isinstance(trajectories, list) else None,
        "n_candidates": db.query(func.count(RingCandidateRow.candidate_ring_id)).scalar(),
    }


@router.get("/evaluation-context")
def evaluation_context():
    """Test-set size / positives of the account-window evaluation, taken from results/model_comparison.json."""
    mc = _read_json("model_comparison.json")
    test = ((mc or {}).get("proposed_gradient_boosting") or {}).get("test") or {}
    n, p = test.get("n_samples"), test.get("n_positive")
    return {"n_test": n, "n_positive": p, "n_negative": test.get("n_negative"),
            "positive_rate": (p / n) if n and p is not None else None, "threshold": test.get("threshold"),
            "protocol": _read_json("protocol.json")}


@router.get("/warnings")
def warnings_log():
    """Every alert that was given and where it falls on each ground-truth ring (results/warnings.json, written by scripts/rebuild_v2.py)."""
    w = _read_json("warnings.json")
    return w if w is not None else {"available": False}


@router.get("/score-calculation/{ring_id}")
def score_calculation(ring_id: str):
    """How one candidate's risk score was calculated (results/score_calculation.json, written by scripts/rebuild_v2.py)."""
    data = _read_json("score_calculation.json")
    entry = data.get(ring_id) if isinstance(data, dict) else None
    return entry if entry is not None else {"available": False}


@router.get("/supporting-patterns")
def supporting_patterns_endpoint():
    """Other patterns the original detectors saw on each candidate's accounts, for context only (results/supporting_patterns.json)."""
    p = _read_json("supporting_patterns.json")
    return p if p is not None else {"available": False}


@router.get("/pattern-evidence")
def pattern_evidence_endpoint():
    """How the number and kind of patterns relate to the risk score and the alerts (results/pattern_evidence.json)."""
    p = _read_json("pattern_evidence.json")
    return p if p is not None else {"available": False}


@router.get("/ring-early-warning")
def ring_early_warning():
    """Research comparisons shown on the Ablations and Controls page. The production result is /api/lead-time.
    All three files share one protocol (scored period from day 240, 120-day burn-in), so they cannot disagree with the production result."""
    out = {
        "production_evaluation": _read_json("production_evaluation.json"),     # candidate-source ablation, same rings as the production result
        "ring_lead_time": _read_json("ring_lead_time_summary.json"),           # controls: newness rule, same-day-only model, random
        "account_window": _read_json("account_window_eval_v2.json"),           # sensitivity to the forecast horizon
    }
    out["available"] = any(v is not None for v in out.values())
    return out


# ------------------------------------------------------------------------------------------------------------------------
# Evaluation page: every chart on one page, from one endpoint. Nothing is computed from labels here; everything is read from
# the result files the pipeline wrote, so the page cannot disagree with the Lead-Time, Model Performance or Ablations pages.
# ------------------------------------------------------------------------------------------------------------------------
_MODEL_ORDER = ["static_graph_anomaly_isolation_forest", "behavioural_logistic_regression", "temporal_random_forest", "proposed_gradient_boosting"]
_SOURCE_LABELS = {"structure_only": "Structure only", "novelty_only": "First-time-account groups only",
                  "production_all": "Production queue (both)", "production_alerted": "Production alerts (score 50 or more)"}


def _curve_status(curve, test):
    """A curve is shown only if it was produced from the same scores as the reported metrics (AUC and average precision agree)."""
    if not curve:
        return "missing"
    try:
        same = abs(curve["roc_auc"] - test["roc_auc"]) < 1e-9 and abs(curve["pr_auc"] - test["pr_auc"]) < 1e-9
    except (KeyError, TypeError):
        return "missing"
    return "ok" if same else "mismatch"


@router.get("/evaluation")
def evaluation():
    mc, cv = _read_json("model_comparison.json"), _read_json("evaluation_curves.json")
    lt, wn, pe = _read_json("lead_time_summary.json"), _read_json("warnings.json"), _read_json("production_evaluation.json")
    rl, aw = _read_json("ring_lead_time_summary.json"), _read_json("account_window_eval_v2.json")

    models = None
    if mc:
        models = []
        for name in _MODEL_ORDER:
            t = (mc.get(name) or {}).get("test")
            if not t:
                continue
            curve = ((cv or {}).get("models") or {}).get(name)
            status = _curve_status(curve, t)
            models.append({"name": name, "proposed": name == "proposed_gradient_boosting",
                           "metrics": {k: t.get(k) for k in ("precision", "recall", "f1", "roc_auc", "pr_auc", "false_warning_rate")},
                           "confusion_matrix": t.get("confusion_matrix"), "n_samples": t.get("n_samples"), "n_positive": t.get("n_positive"),
                           "threshold": t.get("threshold"), "top_k_precision": t.get("top_k_precision"),
                           "curves_status": status, "curves": curve if status == "ok" else None})

    # candidate-level confusion matrix for the alerts: an alert is "positive", a candidate holding a ring transaction is "actual positive"
    alert_cm = None
    prod_all = ((pe or {}).get("ablations") or {}).get("production_all") or {}
    al = (lt or {}).get("alerted_candidates") or {}
    if prod_all and al and None not in (prod_all.get("n_candidates"), prod_all.get("candidates_with_any_ring_tx"), al.get("n_alerted"), al.get("alerted_containing_ring_tx")):
        n, n_ring, n_alert, tp = prod_all["n_candidates"], prod_all["candidates_with_any_ring_tx"], al["n_alerted"], al["alerted_containing_ring_tx"]
        cm = {"tp": tp, "fp": n_alert - tp, "fn": n_ring - tp, "tn": n - n_alert - (n_ring - tp)}
        if min(cm.values()) >= 0 and sum(cm.values()) == n:
            alert_cm = {"confusion_matrix": cm, "n_candidates": n, "n_alerts": n_alert, "n_ring_candidates": n_ring,
                        "threshold": al.get("threshold"), "false_alerts_per_day": al.get("false_alerts_per_day")}

    outcomes = rings = None
    if wn:
        s = wn.get("summary") or {}
        outcomes = {"n_evaluable": s.get("n_evaluable"), "queue": s.get("queue"), "alert": s.get("alert")}
        rings = [{"ring_id": r["ring_id"], "type": r.get("type"), "completion_day": r.get("completion_day"),
                  "queue_lead": (r.get("queue") or {}).get("lead_days"), "queue_status": (r.get("queue") or {}).get("status"),
                  "alert_lead": (r.get("alert") or {}).get("lead_days"), "alert_status": (r.get("alert") or {}).get("status")}
                 for r in wn.get("rings", []) if r.get("evaluable")]

    sources = None
    if pe and pe.get("ablations"):
        sources = []
        for key, label in _SOURCE_LABELS.items():
            a = pe["ablations"].get(key)
            if not a:
                continue
            g = (a.get("by_typology") or {}).get("all") or {}
            sources.append({"key": key, "label": label, "n_candidates": a.get("n_candidates"), "ring_tx_share": a.get("ring_tx_share_of_evidence"),
                            "n_evaluable": g.get("n_evaluable_rings"), "rings_seen": g.get("n_with_any_tx_in_candidate"),
                            "early": g.get("n_warned_before_observable"), "median_lead": g.get("lead_days_median"),
                            "false_candidates_per_day": a.get("false_candidates_per_day")})

    controls = None
    if rl and isinstance(rl.get("results"), dict):
        controls = []
        for model, by_k in rl["results"].items():
            for k, v in (by_k or {}).items():
                a, f = ((v or {}).get("summary") or {}).get("all") or {}, (v or {}).get("flag_stats") or {}
                controls.append({"model": model, "per_day": int(k), "detection_rate": a.get("detection_rate"), "early_rate": a.get("warned_before_observable_rate"),
                                 "lead_median": a.get("lead_days_median"), "false_per_day": f.get("false_alerts_per_day"), "precision": f.get("precision_of_flags")})

    horizon = None
    if aw and aw.get("results"):
        horizon = [{"name": r.get("name"), "horizon_days": r.get("horizon_days"), "n_test_pos": r.get("n_test_pos"), "pr_auc": r.get("pr_auc"),
                    "precision": r.get("precision"), "precision_wilson95": r.get("precision_wilson95"), "tp": r.get("tp"), "fp": r.get("fp")}
                   for r in aw["results"]]

    allc = (lt or {}).get("all_candidates") or {}
    rg = (lt or {}).get("rings") or {}
    counts = None
    if lt and wn:
        counts = {"n_evaluable": rg.get("n_evaluable"), "queue_seen": allc.get("rings_seen"), "queue_early": allc.get("warned_before_completion"),
                  "alerts_seen": rg.get("n_seen"), "alerts_early": rg.get("n_warned_before_completion"),
                  "alerts": al.get("n_alerted"), "alerts_with_ring_tx": al.get("alerted_containing_ring_tx")}

    out = {"models": models, "curves_status": None if models is None else ("ok" if all(m["curves_status"] == "ok" for m in models) else
                                                                           "missing" if all(m["curves_status"] == "missing" for m in models) else "mismatch"),
           "curve_task": None if not cv else {"horizon_days": cv.get("horizon_days"), "split": cv.get("split"), "threshold_rule": cv.get("threshold_rule")},
           "alert_confusion": alert_cm, "frontier": (lt or {}).get("frontier"), "outcomes": outcomes, "rings": rings,
           "stability": (lt or {}).get("stability"), "sources": sources, "controls": controls, "horizon": horizon,
           "ranking": (lt or {}).get("ranking"), "counts": counts, "protocol": _read_json("protocol.json"),
           "alert_threshold": ((lt or {}).get("protocol") or {}).get("alert_threshold")}
    out["available"] = {k: v is not None for k, v in out.items() if k not in ("available", "curves_status", "curve_task", "protocol", "alert_threshold")}
    return out
