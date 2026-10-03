# -*- coding: utf-8 -*-
"""双重机器学习（DML）稳健性检验。

定位：DID / 面板回归的稳健性检验，不是另一套平行主回归。理由见模块末尾说明。

做法分两步：
  1. 组内去均值：把 y、处理变量 D、控制变量 X 都减去个体与年份均值
     （交替投影，等价于吸收双向固定效应）。DoubleML 自己没有 absorb
     固定效应的机制，这一步补上，估计量才和 reghdfe 口径可比。
  2. 去均值后的残差上跑 DoubleMLPLR（或 IRM），Neyman 正交化 + 交叉拟合，
     倾向得分/回归 nuisance 用各种学习器各跑一遍——学习器换成"维度"，
     输出直接喂给异质性系数图那个渲染器。

与手算的口径对不上时会写进 notes：
  线性学习器下 DML 应该接近"去均值后再做一次 OLS"，两者差得太远说明
  交叉拟合或聚类标准误哪里出了问题，那种结果不能拿去当稳健性证据。
"""
import math
import warnings
from concurrent.futures import ThreadPoolExecutor
from typing import List, Optional

import numpy as np

warnings.filterwarnings("ignore")


def _f(v, nd=4):
    try:
        v = float(v)
    except Exception:
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    return round(v, nd)


def _stars(p):
    if p is None:
        return ""
    if p < 0.01:
        return "***"
    if p < 0.05:
        return "**"
    if p < 0.10:
        return "*"
    return ""


def demean_two_way(vals, ent, tim, n_iter=60, tol=1e-11):
    """双向固定效应的组内去均值。

    交替投影：先减个体均值，再减年份均值，再减个体均值……非均衡面板下
    减掉一类均值会把手另一类的变动带回来，所以必须迭代到收敛。
    （这里以前在循环里加了一个常数，去均值不干净，和 reghdfe 差出一个量级。）
    """
    v = np.asarray(vals, dtype=float)
    out = v - _group_mean(v, ent)
    for _ in range(n_iter):
        prev = out
        out = out - _group_mean(out, tim)
        out = out - _group_mean(out, ent)
        if float(np.nanmax(np.abs(out - prev))) < tol:
            break
    return out


def _group_mean(v, keys):
    import pandas as pd
    s = pd.Series(np.asarray(v, dtype=float))
    k = pd.Series(np.asarray(keys))
    return k.map(s.groupby(k).mean()).to_numpy(dtype=float)


def learners(with_trees=False):
    """可用的学习器。没装的包自动跳过，不报错。

    默认只给线性族：DML 的意义在"换个 nuisance 拟合方式结论还成立吗"，
    线性族几秒跑完，是最常用的那一档。树模型要开 with_trees——在 3 万行的
    面板上跑交叉拟合要好几分钟，不默认开。
    """
    out = {}
    try:
        from sklearn.linear_model import LinearRegression, LassoCV, RidgeCV, ElasticNetCV
        out["OLS (基线)"] = lambda: LinearRegression()
        out["LassoCV"] = lambda: LassoCV(cv=5, n_alphas=20, max_iter=5000, random_state=0)
        out["RidgeCV"] = lambda: RidgeCV(alphas=np.logspace(-3, 3, 25))
        out["ElasticNetCV"] = lambda: ElasticNetCV(cv=5, max_iter=5000, random_state=0)
    except Exception:
        pass
    if not with_trees:
        return out
    try:
        from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
        out["RandomForest"] = lambda: RandomForestRegressor(
            n_estimators=100, min_samples_leaf=5, random_state=0, n_jobs=-1)
        out["GradientBoosting"] = lambda: GradientBoostingRegressor(
            n_estimators=100, random_state=0)
    except Exception:
        pass
    try:
        from lightgbm import LGBMRegressor
        out["LightGBM"] = lambda: LGBMRegressor(
            n_estimators=100, learning_rate=0.05, num_leaves=15,
            subsample=0.8, random_state=0, verbose=-1, n_jobs=-1)
    except Exception:
        pass
    return out


def _ols_on_resid(y, d, X, cluster):
    """去均值后直接做一次 OLS + 聚类标准误，用作 DML 的对照基线。"""
    from .reg_utils import cluster_cov, _add_const
    import statsmodels.api as sm
    Z = _add_const(X.copy()) if hasattr(X, "copy") else X
    Zv = np.asarray(Z, dtype=float)
    yv = np.asarray(y, dtype=float)
    dv = np.asarray(d, dtype=float)
    A = np.column_stack([dv, Zv])
    res = sm.OLS(yv, A).fit()
    resid = yv - A @ res.params
    groups = [np.asarray(cluster[c]) for c in cluster] if cluster else []
    V = (cluster_cov(A, resid, groups) if groups
         else (float(resid @ resid) / max(len(yv) - A.shape[1], 1))
         * np.linalg.pinv(A.T @ A))
    i = 0
    b = float(res.params[i])
    se = float(math.sqrt(max(V[i, i], 0.0)))
    from scipy.stats import t as tdist
    dfree = max(len(yv) - A.shape[1], 1)
    if groups:
        g = min(len(np.unique(np.asarray(g))) for g in groups)
        dfree = max(g - 1, 1)
    p = float(2 * (1 - tdist.cdf(abs(b / se) if se > 0 else 0.0, dfree)))
    return b, se, p


def build_dml(config: dict, data_service) -> dict:
    import pandas as pd
    from doubleml import DoubleMLData, DoubleMLPLR, DoubleMLIRM

    df = data_service.get_current()
    if df is None:
        return {"error": "未加载数据集"}

    y_var = config.get("y_var")
    d_var = config.get("d_var")
    if not y_var or y_var not in df.columns:
        return {"error": "请选择被解释变量"}
    if not d_var or d_var not in df.columns:
        return {"error": "请选择处理变量"}
    ctrl = [v for v in (config.get("controls") or []) if v in df.columns]
    id_var = config.get("id_var") if config.get("id_var") in df.columns else None
    time_var = config.get("time_var") if config.get("time_var") in df.columns else None
    cluster_all = [v for v in (config.get("cluster_vars") or []) if v in df.columns]
    # DoubleML 不支持 CGM 双聚类：给两个 cluster_cols 它按交互维度处理，
    # 标准误虚高约 3 倍，和 reghdfe 的 vce(cluster a b) 不可比。只取第一个。
    cluster_cols = cluster_all[:1]
    dropped = cluster_all[1:]
    model = config.get("model") or "plr"
    n_folds = int(config.get("n_folds") or 5)
    n_rep = int(config.get("n_rep") or 1)
    only = config.get("learners") or None

    y = pd.to_numeric(df[y_var], errors="coerce")
    d = pd.to_numeric(df[d_var], errors="coerce")
    keep = y.notna() & d.notna()
    for c in ctrl:
        keep &= pd.to_numeric(df[c], errors="coerce").notna()
    for c in cluster_cols:
        keep &= df[c].notna()
    sub = df[keep].reset_index(drop=True)
    if len(sub) < 100:
        return {"error": f"有效样本仅 {len(sub)} 行，无法做交叉拟合"}
    y = pd.to_numeric(sub[y_var], errors="coerce").to_numpy(float)
    d = pd.to_numeric(sub[d_var], errors="coerce").to_numpy(float)
    X = pd.DataFrame({c: pd.to_numeric(sub[c], errors="coerce").to_numpy(float)
                      for c in ctrl})

    if id_var and time_var:
        how = "组内去均值（吸收 {} 与 {} 固定效应）".format(id_var, time_var)
        ent, tim = sub[id_var], sub[time_var]
        y = demean_two_way(y, ent, tim)
        d = demean_two_way(d, ent, tim)
        if X.shape[1]:
            X = pd.DataFrame({c: demean_two_way(X[c].to_numpy(float), ent, tim)
                              for c in X.columns})
    else:
        how = "不去均值（未指定面板结构）"

    # 二值判断必须在去均值之前做——去均值后 d 有几千个取值，IRM 会永远退化
    d_raw = pd.to_numeric(df[d_var], errors="coerce")
    binary = int(pd.unique(np.round(d_raw.dropna().to_numpy(float), 6)).size) <= 2
    if model == "irm" and not binary:
        model = "plr"

    # DoubleML 的输入
    dml_data = pd.DataFrame({"__y__": y, "__d__": d})
    for c in X.columns:
        dml_data[c] = X[c].to_numpy(float)
    for c in cluster_cols:
        dml_data["__cl_" + c + "__"] = sub[c].astype(str).to_numpy()
    try:
        ddata = DoubleMLData(dml_data, y_col="__y__", d_cols="__d__",
                             x_cols=list(X.columns),
                             cluster_cols=["__cl_" + c + "__" for c in cluster_cols]
                             if cluster_cols else None)
    except Exception as e:
        return {"error": f"构造 DoubleMLData 失败：{type(e).__name__}: {e}"}

    pool = learners(with_trees=bool(config.get("with_trees")))
    if only:
        pool = {k: v for k, v in pool.items() if k in only}
    if not pool:
        return {"error": "没有可用的学习器（sklearn / lightgbm 都没装上？）"}

    def run_one(item):
        name, factory = item
        try:
            common = dict(obj_dml_data=ddata, n_folds=n_folds, n_rep=n_rep)
            if model == "irm":
                m = DoubleMLIRM(ml_g=factory(), ml_m=factory(),
                                score="ATE", **common)
            else:
                m = DoubleMLPLR(ml_l=factory(), ml_m=factory(), **common)
            m.fit()
            ci = m.confint()
            return name, {"coef": float(m.coef[0]), "se": float(m.se[0]),
                          "p": float(m.pval[0]),
                          "lo": float(ci["2.5 %"].iloc[0]),
                          "hi": float(ci["97.5 %"].iloc[0])}
        except Exception as e:
            return name, {"error": f"{type(e).__name__}: {e}"}

    results = {}
    try:
        with ThreadPoolExecutor(max_workers=2) as ex:
            for name, r in ex.map(run_one, list(pool.items())):
                results[name] = r
    except Exception:
        for item in list(pool.items()):
            name, r = run_one(item)
            results[name] = r

    ok = {k: v for k, v in results.items() if "coef" in v}
    bad = {k: v for k, v in results.items() if "coef" not in v}

    rows = []
    for name, r in ok.items():
        rows.append({"panel": name, "y": y_var, "label": name, "kind": "high",
                     "coef": _f(r["coef"]), "se": _f(r["se"]),
                     "lo": _f(r["lo"]), "hi": _f(r["hi"]),
                     "p": _f(r["p"], 6), "stars": _stars(r["p"]),
                     "n": int(len(sub))})

    notes = []
    if cluster_cols:
        notes.append("标准误由 DoubleML 按单聚类（{}）计算；它的小样本校正与 reghdfe / "
                     "本仓库 cluster_cov 的写法略有差异（同一份数据上两者相差约 10%），"
                     "系数才是这张图要对照的东西。".format("、".join(cluster_cols)))
    if dropped:
        notes.append("注：DoubleML 不支持 Cameron–Gelbach–Miller 双聚类，填了 "
                     + "、".join(dropped) + "，实际只按第一个聚类维度 "
                     + "、".join(cluster_cols) + " 计算标准误；要双聚类口径请看基准回归。")
    notes.append("做法：" + how + "，再跑 DoubleML" +
                 ("IRM(ATE)" if model == "irm" else "PLR") +
                 f"，{n_folds} 折交叉拟合 × {n_rep} 次重复；标准误为聚类口径。")
    # 线性学习器应当接近"去均值后 OLS"，差太远就是交叉拟合/聚类哪里出了问题
    base = _ols_on_resid(y, d, X, {c: dml_data["__cl_" + c + "__"].to_numpy()
                                   for c in cluster_cols})
    notes.append("对照：去均值后直接做一次 OLS = {:.4f}（se {:.4f}，p {:.4f}）。"
                 "线性学习器的 DML 结果应当与它接近；差得远说明交叉拟合或聚类"
                 "标准误有问题，这个数不能拿去当稳健性证据。".format(base[0], base[1], base[2]))
    for name, r in bad.items():
        notes.append(f"{name} 跑失败：{r.get('error')}")
    if len(ok) > 1:
        vals = [r["coef"] for r in ok.values()]
        notes.append("各学习器系数跨度 {:.4f}（{:.4f} ~ {:.4f}）：跨度小说明结论"
                     "不依赖学习器选择；跨度大则结论对 nuisance 设定敏感，"
                     "需在图注里说明。".format(max(vals) - min(vals), min(vals), max(vals)))

    return {
        "chart_type": "coefplot",
        "title": config.get("title") or "DML 稳健性：不同学习器下的处理效应",
        "y_cols": [y_var],
        "x_var": d_var,
        "method": "DoubleML " + ("IRM (ATE)" if model == "irm" else "PLR"),
        "se_type": ("聚类稳健 (" + " + ".join(cluster_cols) + ")") if cluster_cols else "异方差稳健",
        "panels": [{"name": n, "group_var": n, "split": "learner",
                    "n_high": int(len(sub)), "n_low": 0,
                    "high_label": n, "low_label": ""} for n in ok],
        "rows": rows,
        "diffs": [],
        "failed": [],
        "notes": notes,
    }
