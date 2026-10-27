"""The four model families evaluated under ONE leakage-safe protocol (ADDITIVE). Output matches results/model_comparison.json."""
from __future__ import annotations

import numpy as np

from src.evaluation import account_window_eval as AW

FAMILIES = {
    "static_graph_anomaly_isolation_forest": (["out_to_date", "in_to_date", "cp_to_date", "age"], "isolation_forest"),
    "behavioural_logistic_regression": (["n_today", "out_today", "in_today"], "logistic"),
    "temporal_random_forest": (["n_today", "out_today", "in_today", "n_7d", "n_30d", "idle"], "random_forest"),
    "proposed_gradient_boosting": (AW.FEATURES_HISTORY, "xgboost"),
}


NOISE_DECIMALS = 10      # scores that differ by less than this are ties; guards against floating-point noise (e.g. parallel tree summation)


def metrics_at(y, s, thr):
    from sklearn.metrics import average_precision_score, roc_auc_score
    sr = np.round(s, NOISE_DECIMALS)                                 # thresholding and ranking use noise-free scores; PR-AUC uses the raw ones
    pred = sr >= round(float(thr), NOISE_DECIMALS)
    tp, fp = int((pred & (y == 1)).sum()), int((pred & (y == 0)).sum())
    P, N = int(y.sum()), int((y == 0).sum())
    fn, tn = P - tp, N - fp
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / P if P else 0.0
    top = np.argsort(-sr, kind="stable")
    return {"precision": prec, "recall": rec, "f1": 2 * prec * rec / (prec + rec) if prec + rec else 0.0,
            "roc_auc": float(roc_auc_score(y, s)) if 0 < P < len(y) else None,
            "pr_auc": float(average_precision_score(y, s)) if P else None,
            "false_warning_rate": fp / N if N else None, "n_samples": int(len(y)), "n_positive": P, "n_negative": N,
            "threshold": float(thr), "confusion_matrix": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
            "top_k_precision": {str(k): float(y[top[:k]].sum() / k) for k in (10, 20, 50)}}


CURVE_POINTS = 300                      # a curve is thinned to about this many points so the result file stays small
K_GRID = (5, 10, 20, 30, 50, 75, 100, 150, 200)


def curve_data(y, s):
    """ROC curve, precision-recall curve and precision at K for one model's test scores, for the Evaluation page.

    Computed from the SAME scores as metrics_at(), and checked against it: the average precision of the stored precision-recall
    points equals metrics_at's PR-AUC, and precision at K uses the same ordering. Nothing here is estimated or smoothed.
    The ROC curve is thinned (equal steps along its length); the precision-recall curve keeps every point where a positive is
    found, so it is exact. A mismatch raises, so a curve can never disagree with the reported metric."""
    from sklearn.metrics import average_precision_score, precision_recall_curve, roc_auc_score, roc_curve
    y = np.asarray(y).astype(int)
    s = np.asarray(s, dtype=float)
    P, N = int(y.sum()), int(len(y) - y.sum())
    if P == 0 or N == 0:
        return None
    fpr, tpr, _ = roc_curve(y, s, drop_intermediate=True)
    seg = np.r_[0.0, np.cumsum(np.hypot(np.diff(fpr), np.diff(tpr)))]
    if len(fpr) > CURVE_POINTS:
        pick = np.unique(np.r_[0, np.searchsorted(seg, np.linspace(0, seg[-1], CURVE_POINTS)), len(fpr) - 1])
        pick = pick[pick < len(fpr)]
        fpr, tpr = fpr[pick], tpr[pick]
    prec, rec, _ = precision_recall_curve(y, s)
    prec, rec = prec[::-1], rec[::-1]                                  # ascending recall; starts at recall 0, precision 1
    keep = np.r_[True, np.diff(rec) > 0]                               # one point per positive found
    prec_k, rec_k = prec[keep], rec[keep]
    ap_points = float(np.sum(np.diff(rec_k) * prec_k[1:]))
    ap = float(average_precision_score(y, s))
    if abs(ap_points - ap) > 1e-9:
        raise AssertionError(f"precision-recall points give {ap_points} but average precision is {ap}")
    sr = np.round(s, NOISE_DECIMALS)
    top = np.argsort(-sr, kind="stable")
    cum = np.cumsum(y[top])
    return {"n": int(len(y)), "n_positive": P, "prevalence": P / len(y),
            "roc_auc": float(roc_auc_score(y, s)), "pr_auc": ap,
            "roc": [[round(float(a), 8), round(float(b), 6)] for a, b in zip(fpr, tpr)],
            "pr": [[round(float(a), 6), round(float(b), 6)] for a, b in zip(rec_k, prec_k)],
            "precision_at_k": [[int(k), float(cum[k - 1] / k)] for k in K_GRID if k <= len(y)]}


def _subsample(X, y, n_neg, seed):
    rng = np.random.default_rng(seed)
    pos = np.flatnonzero(y == 1)
    neg = np.flatnonzero(y == 0)
    keep = np.concatenate([pos, rng.choice(neg, size=min(n_neg, len(neg)), replace=False)])
    return X[keep], y[keep]


def fit_scores(kind, Xtr, ytr, others, seed, n_estimators):
    if kind == "xgboost":
        return AW.fit_score(Xtr, ytr, others, seed, n_estimators)
    if kind == "isolation_forest":
        from sklearn.ensemble import IsolationForest
        rng = np.random.default_rng(seed)
        idx = rng.choice(len(Xtr), size=min(300_000, len(Xtr)), replace=False)
        m = IsolationForest(n_estimators=100, random_state=seed, n_jobs=2).fit(Xtr[idx])
        m.set_params(n_jobs=1)                                       # fixed summation order -> repeatable scores
        return [-m.score_samples(X) for X in others]
    X, y = _subsample(Xtr, ytr, 400_000 if kind == "logistic" else 300_000, seed)
    if kind == "logistic":
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import make_pipeline
        from sklearn.preprocessing import StandardScaler
        m = make_pipeline(StandardScaler(), LogisticRegression(class_weight="balanced", max_iter=300)).fit(np.log1p(X), y)
        return [m.predict_proba(np.log1p(Z))[:, 1] for Z in others]
    from sklearn.ensemble import RandomForestClassifier
    m = RandomForestClassifier(n_estimators=100, max_depth=10, min_samples_leaf=20, class_weight="balanced_subsample",
                               n_jobs=2, random_state=seed).fit(X, y)
    m.set_params(n_jobs=1)                                           # a fixed summation order makes predictions bit-for-bit repeatable
    return [m.predict_proba(Z)[:, 1] for Z in others]


def evaluate_family(state, Y, name, s):
    cols, kind = FAMILIES[name]
    b = AW.split_bounds(state["W"], s.horizon, s.burn_in)
    tr, va, te = (AW.make_rows(state, Y, cols, *b[k]) for k in ("train", "val", "test"))
    sv, st = fit_scores(kind, tr[0], tr[1], [va[0], te[0]], s.seed, 300)
    thr = AW.choose_threshold(va[1], sv)                               # validation only
    test_metrics = metrics_at(te[1], st, thr)
    curves = curve_data(te[1], st)
    if curves and abs(curves["roc_auc"] - test_metrics["roc_auc"]) > 1e-12:      # same scores, same metric: they must agree exactly
        raise AssertionError("ROC-AUC of the curve differs from the reported ROC-AUC")
    return {"val": metrics_at(va[1], sv, thr), "test": test_metrics, "curves": curves,
            "threshold_selection": {"rule": "max F1 on validation", "value": float(thr)},
            "protocol": {"model_family": kind, "features": cols, "horizon_days": s.horizon, "train_days": list(b["train"]),
                         "validation_days": list(b["val"]), "test_days": list(b["test"])}}
