# -*- coding: utf-8 -*-
"""异质性系数图（coefplot / 系数比较图）。

《经济研究》那类论文的通行做法：异质性涉及多个维度、每个维度再分高低两组时，
几十个系数排成大表读者没法看，于是改成一张系数比较图——横轴是系数，纵轴按维度
分 Panel，每组画点估计与 95% 置信区间，0 值一条参考线。

两处比 Stata 模板多做一步：

  1. 图上直接给组间差异检验。coefplot 模板只画"各组分别估计"，组间差异是否
     显著要另说；这里给两个口径——全样本交互项，以及两次独立估计之差。
     高低两组样本不重叠时 Var(b_高 − b_低) = Var(b_高) + Var(b_低)，后者是严格的，
     不需要额外假设。两个口径都指向同一结论更稳。
  2. 每个点旁边标该组样本量。高低组样本量常常差很多，不给 N，读者无法判断
     置信区间的宽度是经济含义还是样本问题。
"""
import math
from concurrent.futures import ThreadPoolExecutor
from typing import List, Optional

import numpy as np


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


def _two_sided_p(z):
    from scipy.stats import norm
    if z is None or (isinstance(z, float) and (math.isnan(z) or math.isinf(z))):
        return None
    return float(2 * (1 - norm.cdf(abs(z))))


def _svc():
    from .regression_service import regression_service
    return regression_service


def _pd():
    import pandas as pd
    return pd


def split_masks(df, dim: dict):
    """按维度定义切出高/低两组的布尔掩码。

    split:
      median —— 连续变量按中位数二分（论文最常用）
      mean   —— 按均值二分
      above0 —— 是否大于 0（哑变量 / 指数类）
      values —— 指定两个取值对比（分类变量）
    """
    gv = dim.get("group_var")
    if not gv or gv not in df.columns:
        raise ValueError(f"维度「{dim.get('name') or gv}」的分组变量不存在")
    xn = _pd().to_numeric(df[gv], errors="coerce")
    split = dim.get("split") or "median"

    if split == "values":
        hv, lv = dim.get("high_value"), dim.get("low_value")
        if hv in (None, "") or lv in (None, ""):
            raise ValueError("按取值分组时，需给出高、低两组的取值")
        return (xn == float(hv)), (xn == float(lv))
    if split == "above0":
        return (xn > 0), (xn <= 0)

    vals = xn.dropna()
    if not len(vals):
        raise ValueError(f"维度「{dim.get('name') or gv}」的分组变量没有有效取值")
    cut = float(vals.mean()) if split == "mean" else float(vals.median())
    # 并列在切点上的观测归入低组，保证两组不重叠
    return (xn > cut), (xn <= cut)


def _pick(res: dict, name: str):
    for c in (res.get("coefficients") or []):
        if c.get("variable") == name:
            return c
    # DID 自己构造交互项时，行名是「DID 交互项 (Treat×Post)」，取 att 兜底
    att = res.get("att")
    if att and att.get("estimate") is not None:
        return {"coef": att.get("estimate"), "std_err": att.get("std_err"),
                "p": att.get("p"), "stars": att.get("stars", "")}
    return None


def _row_from(res, name, panel, y, label, kind, n):
    c = _pick(res, name)
    if c is None or c.get("coef") is None or c.get("std_err") is None:
        return {"ok": False, "why": res.get("error") or f"未取到 {name} 的系数（可能被共线剔除）"}
    se = c["std_err"]
    return {"ok": True,
            "row": {"panel": panel, "y": y, "label": label, "kind": kind,
                    "coef": _f(c["coef"]), "se": _f(se),
                    "lo": _f(c["coef"] - 1.96 * se), "hi": _f(c["coef"] + 1.96 * se),
                    "p": _f(c.get("p"), 6),
                    "stars": c.get("stars") or _stars(c.get("p")),
                    "n": int(n)}}


def group_dummy_varies(g, id_index):
    """分组哑变量的组内变异：有多少家企业的分组取值曾经改变过。

    返回的是"跨过组的企业占比"。回到 2% 以下，个体固定效应会把哑变量吸干净，
    交互项无从识别。
    """
    pd = _pd()
    s = pd.Series(np.asarray(g, dtype=float))
    key = pd.Series(np.asarray(id_index))
    n_change = int((s.groupby(key).nunique() > 1).sum())
    n_total = int(key.nunique()) or 1
    return n_change / n_total


def _interaction(df, cfg, g, xcore, group_var=None):
    """全样本交互项回归 y ~ x + g + x·g (+ controls + FE)，交互项即组间差异检验。"""
    from linearmodels.panel import PanelOLS
    pd = _pd()
    svc = _svc()

    # 分组哑变量是分组变量的确定性函数，后者又在控制变量里时两者共线，
    # __g__ / __xg__ 会被整体剔除，交互项就取不到——所以这里把它剔掉。
    if group_var:
        cfg = dict(cfg)
        cfg["controls"] = [c for c in (cfg.get("controls") or []) if c != group_var]
        cfg["core_x"] = [c for c in (cfg.get("core_x") or []) if c != group_var]
    terms = [("__g__", "分组哑变量", g.astype(float)),
             ("__xg__", "核心变量 × 分组", (xcore * g).astype(float))]
    # cfg 是前端语法的配置；_design 要的是 _cfg 处理过的 y/core/ctrl 那一套
    c2 = svc._cfg(df, cfg)
    y, X, side, labels = svc._design(df, c2, extra_terms=terms, keep=list(c2["absorb"]))

    if c2["id_var"] and c2["time_var"]:
        # 必须走 _panel_frame：否则 sort_index 重排索引而 y/X 仍是旧行序，
        # PanelOLS 会按错的行分组算固定效应（详见 regression_service._panel_frame）
        y, X, side, dp = svc._panel_frame(y, X, side, c2)
        yv = pd.Series(np.asarray(y, dtype=float), index=dp)
        Xv = pd.DataFrame(np.asarray(X, dtype=float), index=dp, columns=list(X.columns))
        others = (pd.DataFrame({c: np.asarray(side[c]) for c in c2["absorb"]}, index=dp)
                  if c2["absorb"] else None)
        mod = PanelOLS(yv, Xv, entity_effects=True, time_effects=True,
                       other_effects=others, drop_absorbed=True)
        res = svc._fit_lm(mod, dp, c2, key="twoway_fe")
        names = [str(c) for c in res.params.index]
        if "__xg__" not in names:
            return None
        i = names.index("__xg__")
        return {"coef": _f(res.params.iloc[i]), "se": _f(res.std_errors.iloc[i]),
                "p": _f(res.pvalues.iloc[i], 6)}

    import statsmodels.api as sm
    from .reg_utils import _add_const
    Xc = _add_const(X)
    Xv = Xc.values.astype(float)
    yv = np.asarray(y, dtype=float)
    res = sm.OLS(yv, Xv).fit()
    se_s, _, p_s = svc._se_sm(Xc, yv, Xv, res, side, c2)
    j = list(Xc.columns).index("__xg__")
    return {"coef": _f(res.params[j]), "se": _f(se_s.iloc[j]), "p": _f(p_s.iloc[j], 6)}


def build_hetero(config: dict, data_service) -> dict:
    pd = _pd()
    df = data_service.get_current()
    if df is None:
        return {"error": "未加载数据集"}

    y_vars = [v for v in (config.get("y_vars") or []) if v in df.columns]
    if not y_vars:
        return {"error": "请选择至少一个被解释变量"}
    core = [v for v in (config.get("core_x") or []) if v in df.columns]
    if not core:
        return {"error": "请选择核心解释变量（图上要看的那个系数）"}
    xname = core[0]

    dims = [d for d in (config.get("dimensions") or []) if d.get("group_var")]
    if not dims:
        return {"error": "请至少添加一个异质性维度"}

    id_var = config.get("id_var") if config.get("id_var") in df.columns else None
    time_var = config.get("time_var") if config.get("time_var") in df.columns else None
    se_type = config.get("se_type") or "cluster"
    cluster_vars = [v for v in (config.get("cluster_vars") or []) if v in df.columns]
    method = config.get("method") or ("twoway_fe" if (id_var and time_var) else "ols")
    controls = [v for v in (config.get("controls") or []) if v in df.columns]

    base_cfg = {"core_x": core, "controls": controls,
                "id_var": id_var, "time_var": time_var,
                "absorb": [v for v in (config.get("absorb") or []) if v in df.columns],
                "se_type": se_type, "cluster_vars": cluster_vars}

    # 掩码先全部算好。切分出问题早点报错，别等 48 个回归跑完才发现某一组是空的。
    # 支持域/审计统计：每组样本量、处理比例(核心解释变量>0 占比)、聚类数、期数
    xnum_full = pd.to_numeric(df[xname], errors="coerce")

    def _support(mask):
        xv = xnum_full[mask]
        treated = float((xv > 0).mean()) if xv.notna().any() else None
        n_clusters = int(df[id_var][mask].nunique()) if id_var else int(mask.sum())
        n_periods = int(df[time_var][mask].nunique()) if time_var else None
        return {"treated_share": _f(treated, 3) if treated is not None else None,
                "clusters": n_clusters, "periods": n_periods}

    plans, panels = [], []
    for d in dims:
        try:
            hm, lm = split_masks(df, d)
        except Exception as e:
            return {"error": str(e)}
        nh, nl = int(hm.sum()), int(lm.sum())
        if nh < 20 or nl < 20:
            return {"error": (f"维度「{d.get('name') or d['group_var']}」有一组样本不足 20"
                              f"（高 {nh} / 低 {nl}），系数没有意义，请换切分方式")}
        name = d.get("name") or d["group_var"]
        hi_lab = d.get("high_label") or f"高{name}组"
        lo_lab = d.get("low_label") or f"低{name}组"
        # 分组变量在企业内的时变性——越高越可能是随时间变动的(甚至政策后)变量
        var_share = (group_dummy_varies(pd.to_numeric(df[d["group_var"]], errors="coerce"),
                                        df[id_var]) if id_var else None)
        plans.append({"name": name, "hm": np.asarray(hm), "lm": np.asarray(lm),
                      "hi_lab": hi_lab, "lo_lab": lo_lab})
        panels.append({"name": name, "group_var": d["group_var"],
                       "split": d.get("split") or "median",
                       "n_high": nh, "n_low": nl,
                       "high_label": hi_lab, "low_label": lo_lab,
                       "g_varies": _f(var_share, 3) if var_share is not None else None,
                       "support": {"high": _support(hm), "low": _support(lm)}})

    jobs = []
    for p in plans:
        for y in y_vars:
            cfg = dict(base_cfg, y_var=y)
            jobs.append((p["name"], y, cfg, p["hm"], p["hi_lab"], "high"))
            jobs.append((p["name"], y, cfg, p["lm"], p["lo_lab"], "low"))

    def run_one(job):
        panel, y, cfg, mask, label, kind = job
        try:
            res = _svc().run(method, cfg, data_service, sample=mask)
        except Exception as e:
            return {"ok": False, "why": f"{type(e).__name__}: {e}"}
        return _row_from(res, xname, panel, y, label, kind, int(mask.sum()))

    # 分组回归互不依赖，用线程池并行：linearmodels 的去均值与矩阵运算会放开 GIL。
    # 8 个维度 × 2 个因变量顺序跑要好几分钟，并行能压到一分钟上下。
    try:
        with ThreadPoolExecutor(max_workers=4) as ex:
            results = list(ex.map(run_one, jobs))
    except Exception:
        results = [run_one(j) for j in jobs]

    rows, failed = [], []
    for (panel, y, cfg, mask, label, kind), r in zip(jobs, results):
        if r["ok"]:
            rows.append(r["row"])
        else:
            failed.append({"panel": panel, "y": y, "label": label, "why": r["why"]})

    # 组间差异：全样本交互项 + 两次独立估计之差（高低组样本不重叠，方差可直接相加）
    diffs = []
    for p in plans:
        for y in y_vars:
            cfg = dict(base_cfg, y_var=y)
            d = {"panel": p["name"], "y": y}
            hi = next((r for r in rows if r["y"] == y and r["label"] == p["hi_lab"]), None)
            lo = next((r for r in rows if r["y"] == y and r["label"] == p["lo_lab"]), None)
            if hi and lo:
                diff = hi["coef"] - lo["coef"]
                se = math.sqrt(hi["se"] ** 2 + lo["se"] ** 2)
                pv = _two_sided_p(diff / se) if se > 0 else None
                d.update({"diff": _f(diff), "se": _f(se), "p": _f(pv, 6),
                          "stars": _stars(pv)})
            try:
                gvar = next(x["group_var"] for x in dims
                            if (x.get("name") or x["group_var"]) == p["name"])
                gnum = pd.to_numeric(df[gvar], errors="coerce")
                inter = None
                if not (id_var and time_var):
                    # 截面数据没有个体效应要吸，交互项放心做
                    inter = _interaction(df, cfg, gnum,
                                         pd.to_numeric(df[xname], errors="coerce"),
                                         group_var=gvar)
                else:
                    share = group_dummy_varies(p["hm"], df[id_var])
                    d["g_varies"] = round(share, 4)
                    if share >= 0.02:
                        inter = _interaction(df, cfg, gnum,
                                             pd.to_numeric(df[xname], errors="coerce"),
                                             group_var=gvar)
                    else:
                        d["inter_skipped"] = (
                            "分组哑变量在企业内几乎不变（仅 %.1f%% 的企业跨组），"
                            "会被个体固定效应吸收，交互项不可识别；此处只报分组"
                            "回归之差" % (share * 100))
            except Exception:
                inter = None
            if inter:
                d.update({"inter_coef": inter["coef"], "inter_se": inter["se"],
                          "inter_p": inter["p"], "inter_stars": _stars(inter["p"])})
            # 主检验 p：优先进交互项（合并样本、本文主检验），退回分组之差
            d["base_p"] = d["inter_p"] if d.get("inter_p") is not None else d.get("p")
            if "p" in d or "inter_p" in d:
                d["agree"] = bool(d.get("p") is not None and d.get("inter_p") is not None
                                  and ((d["p"] < 0.1) == (d["inter_p"] < 0.1)))
                diffs.append(d)

    # ── 多重检验校正 + 确认/探索分层 ──
    # 检验族 = 本图所有 维度×被解释变量 的主检验。确认性维度（事前假设）单独成族用 Holm 控 FWER；
    # 其余探索性维合成一族用 BH 控 FDR。原始 p 与校正 p 都给，survive 标“校正后仍 <0.05”。
    conf_dim = config.get("confirmatory_dim") or None
    try:
        from statsmodels.stats.multitest import multipletests
    except Exception:
        multipletests = None

    def _attach(fam, corr, family):
        for k, d in enumerate(fam):
            d["family"] = family
            ph, pb = corr["holm"].get(k), corr["bh"].get(k)
            d["p_holm"] = _f(ph, 4) if ph is not None else None
            d["p_bh"] = _f(pb, 4) if pb is not None else None
            primary = ph if family == "confirmatory" else pb
            d["p_adj"] = _f(primary, 4) if primary is not None else None
            d["adj_method"] = "Holm(FWER)" if family == "confirmatory" else "BH(FDR)"
            d["survive"] = bool(d.get("base_p") is not None and primary is not None
                                and primary < 0.05)

    def _correct(fam):
        idx = [k for k, d in enumerate(fam) if d.get("base_p") is not None]
        corr = {"holm": {}, "bh": {}}
        if multipletests and idx:
            ps = [fam[k]["base_p"] for k in idx]
            ph = multipletests(ps, method="holm")[1]
            pb = multipletests(ps, method="fdr_bh")[1]
            for j, k in enumerate(idx):
                corr["holm"][k], corr["bh"][k] = float(ph[j]), float(pb[j])
        return corr

    fam_conf = [d for d in diffs if conf_dim and d["panel"] == conf_dim]
    fam_expl = [d for d in diffs if not (conf_dim and d["panel"] == conf_dim)]
    _attach(fam_conf, _correct(fam_conf), "confirmatory")
    _attach(fam_expl, _correct(fam_expl), "exploratory")

    notes = []
    for f in failed[:12]:
        notes.append(f"{f['panel']} / {f['y']} / {f['label']}：{f['why']}")
    if len(failed) > 12:
        notes.append(f"另有 {len(failed) - 12} 组未画出，原因同上。")
    notes.append("各组系数为分别估计的结果；组间差异看每个维度后标注的 Δ 检验"
                 "（两次独立估计之差，两组样本不重叠时方差可直接相加）与交互项检验，"
                 "两者都显著才算稳健。")
    for d in diffs:
        if d.get("inter_skipped"):
            notes.append(f"{d['panel']} / {d['y']}：{d['inter_skipped']}")
        elif d.get("agree") is False and d.get("p") is not None and d.get("inter_p") is not None:
            notes.append(
                f"{d['panel']} / {d['y']}：两个口径结论不一致（Δ 检验 p = {d['p']}，"
                f"交互项 p = {d['inter_p']}）。分组变量若是企业特征，哑变量在企业内"
                f"几乎不变，交互项只在少数跨组的企业上有识别力，此时以分组回归之差为准；"
                f"该维度哑变量有组内变异的企业占 "
                f"{(d.get('g_varies') or 0) * 100:.1f}%。")
    weak = [p for p in panels if min(p["n_high"], p["n_low"]) < 200]
    if weak:
        notes.append("样本量偏小的组：" + "、".join(
            f"{p['name']}（高 {p['n_high']} / 低 {p['n_low']}）" for p in weak) +
            "，其置信区间宽度含样本因素，解读需谨慎。")

    n_conf, n_expl = len(fam_conf), len(fam_expl)
    if conf_dim:
        notes.append(f"多重检验校正：确认性维度「{conf_dim}」用 Holm 控 FWER；其余 {n_expl} 个"
                     "探索性检验用 BH 控 FDR。每个 Δ 同时给出原始 p 与校正后 p，✓ = 校正后仍 <0.05。")
    elif n_expl:
        notes.append(f"多重检验校正：未指定确认性维度，全部 {n_expl} 个检验按探索性扫描用 BH 控 FDR；"
                     "更严的 Holm 见各维 p_holm。Δ 同时给出原始 p 与校正后 p，✓ = 校正后仍 <0.05。")
    for p in panels:
        vs = p.get("g_varies")
        if vs is not None and vs >= 0.5:
            notes.append(f"审计提醒：维度「{p['name']}」分组变量在企业内随时间变化约 {vs*100:.0f}%，"
                         "请确认它是否为处理前变量；若为政策后指标，按它分组有处理后偏误。")
    survived = sum(1 for d in diffs if d.get("survive"))
    notes.append(f"多重校正后仍 <0.05 的组间差异：{survived}/{len(diffs)}。"
                 "只在原始 p 下显著的维度属探索线索，不应写成机制结论。")

    return {"chart_type": "coefplot",
            "title": config.get("title") or "异质性系数比较图",
            "y_cols": y_vars, "x_var": xname, "method": method,
            "se_type": (("聚类稳健 (" + " + ".join(cluster_vars) + ")")
                        if (se_type == "cluster" and cluster_vars) else se_type),
            "panels": panels, "rows": rows, "diffs": diffs,
            "failed": failed, "notes": notes}
