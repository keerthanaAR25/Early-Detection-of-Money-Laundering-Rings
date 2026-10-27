"""Evaluation page: the curve computation (src/pipeline_v2/models.curve_data) and the /api/evaluation endpoint."""
import json
from pathlib import Path

import numpy as np
import pytest

from src.pipeline_v2 import models

RES = Path(__file__).resolve().parents[1] / "results"
needs_results = pytest.mark.skipif(not (RES / "evaluation_curves.json").exists(), reason="run: python scripts/rebuild_v2.py models, then export")


def _scores(n=20000, pos=60, seed=0, tied=False):
    rng = np.random.default_rng(seed)
    y = np.zeros(n, int); y[rng.choice(n, pos, replace=False)] = 1
    s = rng.normal(0, 1, n) + 2.2 * y
    return y, (np.round(s, 1) if tied else s)


# ---------------------------------------------------------------------------------------------- the curve computation
@pytest.mark.parametrize("tied", [False, True])
def test_curves_agree_with_the_reference_metrics(tied):
    from sklearn.metrics import average_precision_score, roc_auc_score
    y, s = _scores(tied=tied)
    c = models.curve_data(y, s)
    assert c["roc_auc"] == pytest.approx(roc_auc_score(y, s), abs=1e-12) and c["pr_auc"] == pytest.approx(average_precision_score(y, s), abs=1e-12)
    roc, pr = np.array(c["roc"]), np.array(c["pr"])
    assert roc[0].tolist() == [0, 0] and roc[-1].tolist() == [1, 1]
    assert np.all(np.diff(roc[:, 0]) >= 0) and np.all(np.diff(roc[:, 1]) >= 0) and np.all(np.diff(pr[:, 0]) >= 0)
    assert np.trapezoid(roc[:, 1], roc[:, 0]) == pytest.approx(c["roc_auc"], abs=0.01)            # thinned ROC encloses the exact AUC
    assert float(np.sum(np.diff(pr[:, 0]) * pr[1:, 1])) == pytest.approx(c["pr_auc"], abs=1e-5)    # the PR points are exact up to 6-decimal storage
    assert len(roc) <= models.CURVE_POINTS + 2 and len(pr) <= int(y.sum()) + 1                     # thinned ROC; one PR point per positive


def test_precision_at_k_uses_the_same_ordering_as_the_reported_metric():
    y, s = _scores(tied=True)
    c = models.curve_data(y, s)
    reported = models.metrics_at(y, s, float(np.quantile(s, 0.99)))["top_k_precision"]
    got = dict(c["precision_at_k"])
    for k in (10, 20, 50):
        assert got[k] == pytest.approx(reported[str(k)], abs=1e-12)


def test_prevalence_and_counts():
    y, s = _scores(n=5000, pos=25)
    c = models.curve_data(y, s)
    assert c["n"] == 5000 and c["n_positive"] == 25 and c["prevalence"] == pytest.approx(25 / 5000)


@pytest.mark.parametrize("y", [np.zeros(100, int), np.ones(100, int)])
def test_a_task_with_one_class_has_no_curve_instead_of_a_wrong_one(y):
    assert models.curve_data(y, np.random.default_rng(0).normal(size=100)) is None


# ---------------------------------------------------------------------------------------------- the endpoint
def _fake_files(**over):
    base = {"model_comparison.json": {"m": 1}}
    base.update(over)
    return lambda name: base.get(name)


def test_endpoint_returns_nulls_not_numbers_when_nothing_has_been_computed(monkeypatch):
    from backend.api import extras
    monkeypatch.setattr(extras, "_read_json", lambda name: None)
    out = extras.evaluation()
    assert out["models"] is None and out["alert_confusion"] is None and out["frontier"] is None and out["rings"] is None and out["sources"] is None
    assert out["curves_status"] is None and not any(out["available"].values())


def test_curves_from_another_run_are_refused(monkeypatch):
    from backend.api import extras
    test = {"roc_auc": 0.9, "pr_auc": 0.1, "precision": 1, "recall": 1, "f1": 1, "false_warning_rate": 0, "confusion_matrix": {"tp": 1, "fp": 0, "fn": 0, "tn": 9}, "n_samples": 10, "n_positive": 1, "threshold": 0.5, "top_k_precision": {}}
    mc = {"proposed_gradient_boosting": {"test": test}}
    ok = {"proposed_gradient_boosting": {"roc_auc": 0.9, "pr_auc": 0.1, "roc": [[0, 0], [1, 1]], "pr": [[0, 1], [1, 0.1]]}}
    bad = {"proposed_gradient_boosting": {"roc_auc": 0.9 + 1e-6, "pr_auc": 0.1, "roc": [[0, 0], [1, 1]], "pr": [[0, 1], [1, 0.1]]}}
    for curves, status in ((ok, "ok"), (bad, "mismatch")):
        monkeypatch.setattr(extras, "_read_json", _fake_files(**{"model_comparison.json": mc, "evaluation_curves.json": {"models": curves, "horizon_days": 14}}))
        m = extras.evaluation()["models"][0]
        assert m["curves_status"] == status and (m["curves"] is not None) == (status == "ok")
    monkeypatch.setattr(extras, "_read_json", _fake_files(**{"model_comparison.json": mc}))
    assert extras.evaluation()["models"][0]["curves_status"] == "missing"


def test_an_impossible_alert_matrix_is_dropped_not_shown(monkeypatch):
    from backend.api import extras
    pe = {"ablations": {"production_all": {"n_candidates": 10, "candidates_with_any_ring_tx": 3}}}
    lt = {"alerted_candidates": {"n_alerted": 4, "alerted_containing_ring_tx": 5}}            # more true alerts than alerts: contradictory
    monkeypatch.setattr(extras, "_read_json", _fake_files(**{"production_evaluation.json": pe, "lead_time_summary.json": lt}))
    assert extras.evaluation()["alert_confusion"] is None


@needs_results
def test_endpoint_agrees_with_the_result_files_it_reads():
    from backend.api import extras
    out = extras.evaluation()
    mc = json.load(open(RES / "model_comparison.json")); lt = json.load(open(RES / "lead_time_summary.json")); wn = json.load(open(RES / "warnings.json"))
    assert [m["name"] for m in out["models"]] == list(mc)
    for m in out["models"]:
        t = mc[m["name"]]["test"]
        assert m["confusion_matrix"] == t["confusion_matrix"] and sum(m["confusion_matrix"].values()) == t["n_samples"]
        assert m["curves_status"] == "ok" and m["curves"]["pr_auc"] == t["pr_auc"] and m["curves"]["roc_auc"] == t["roc_auc"]
    a = out["alert_confusion"]
    assert sum(a["confusion_matrix"].values()) == a["n_candidates"] == lt["all_candidates"]["n_candidates"]
    assert a["confusion_matrix"]["tp"] + a["confusion_matrix"]["fp"] == lt["alerted_candidates"]["n_alerted"]
    ev = [r for r in wn["rings"] if r["evaluable"]]
    assert len(out["rings"]) == len(ev) == out["counts"]["n_evaluable"]
    for grp in ("queue", "alert"):
        assert sum(out["outcomes"][grp].values()) == out["counts"]["n_evaluable"]
    assert [s["key"] for s in out["sources"]] == ["structure_only", "novelty_only", "production_all", "production_alerted"]    # the retired v1 baseline is not on this page
    assert out["curves_status"] == "ok"


@needs_results
def test_the_curve_file_covers_every_model_and_leaves_model_comparison_untouched():
    cv = json.load(open(RES / "evaluation_curves.json")); mc = json.load(open(RES / "model_comparison.json"))
    assert set(cv["models"]) == set(mc)
    assert all(set(v) == {"val", "test", "threshold_selection"} for v in mc.values())            # the existing file keeps exactly its old shape
