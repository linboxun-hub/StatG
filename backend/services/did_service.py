"""交错采纳（staggered adoption）DID 估计量

处理时点在不同单位间不一致时，TWFE 会把多个 2×2 按难以解释的权重平均，
权重甚至可能为负（Goodman-Bacon 2021）。本模块提供四个替代/诊断工具：

  csdid  — Callaway & Sant'Anna (2021) group-time ATT + 自定义聚合
  sunab  — Sun & Abraham (2021) 队列交互加权事件研究
  bacon  — Goodman-Bacon 2×2 分解（诊断 TWFE 是否可解释）
  did2s  — Gardner (2022) 两阶段 DID

共享 _f/_i/_stars/_t_pvalue/cluster_cov/_add_const 等工具函数。
"""
import math
import warnings

import numpy as np
import pandas as pd
import scipy.stats as stats

warnings.filterwarnings("ignore")

from .reg_utils import _f, _i, _stars, _t_pvalue, cluster_cov, _add_const

STAGGERED_METHODS = ("csdid", "sunab", "bacon", "did2s")

# 前端下拉用中文展示，这里映射回 Stata/R 包的关键字
_CHOICE_MAP = {
    "control_group": {"尚未处理 (notyet)": "notyet", "从未处理 (never)": "never",
                      "notyet": "notyet", "never": "never"},
    "aggregation": {"样本加权": "weighted", "等权平均": "simple",
                    "按队列": "cohort", "动态效应": "dynamic",
                    "weighted": "weighted", "simple": "simple",
                    "cohort": "cohort", "dynamic": "dynamic"},
    "est_method": {"回归调整 (reg)": "reg", "倾向得分 (ipw)": "ipw",
                   "半参数 (dr)": "dr", "reg": "reg", "ipw": "ipw", "dr": "dr"},
}


def normalize_choices(config):
    """把中文选项值翻译成内部关键字；同时把 min_cohort_n 等数值参数归一化"""
    out = dict(config or {})
    for key, mapping in _CHOICE_MAP.items():
        if key in out and out[key] in mapping:
            out[key] = mapping[out[key]]
    for k in ("min_cohort_n",):
        if k in out and out[k] not in (None, ""):
            try:
                out[k] = int(float(out[k]))
            except Exception:
                out.pop(k)
    if "window" in out and out["window"] in (None, ""):
        out.pop("window")
    return out


def find_cohort_var(df, config):
    """定位处理时点变量：显式指定 > 命名启发 > 无"""
    c = config.get("cohort_var")
    if c and c in df.columns:
        return c
    keys = ("first_treat", "first_year", "firstyear", "cohort", "treat_year", "treattime")
    bad = ("count", "relative", "lines", "n_")
    for col in df.columns:
        n = str(col).lower()
        if any(k in n for k in keys) and not any(b in n for b in bad):
            return col
    return None


class DidService:

    # ── 数据整理 ──

    def _setup(self, df, cfg, cohort, design):
        """整理为 (y 宽表, 协变量宽表, 队列 Series, 时期数组)"""
        y, X, side, labels = design(df, cfg, keep=[cohort, cfg["time_var"], cfg["id_var"]]
                                    + list(cfg["ctrl"]))
        d = side.copy()
        d["__y__"] = y.values.astype(float)
        d["__g__"] = pd.to_numeric(d[cohort], errors="coerce").fillna(0).values
        d["__t__"] = pd.to_numeric(d[cfg["time_var"]], errors="coerce").values
        d["__id__"] = d[cfg["id_var"]].astype(str).values
        d = d[d["__t__"].notna()]
        tvals = np.sort(d["__t__"].unique())
        wide_y = d.pivot_table(index="__id__", columns="__t__", values="__y__", aggfunc="first")
        wide_g = d.groupby("__id__")["__g__"].first()
        wide_X = {}
        for c in X.columns:
            tmp = d[["__id__", "__t__"]].copy()
            tmp[c] = X[c].values
            wide_X[c] = tmp.pivot_table(index="__id__", columns="__t__", values=c, aggfunc="first")
        return wide_y, wide_X, wide_g, tvals

    def _beta_cache(self, wide_X, wide_y, wide_g, tvals, ctrl_kind):
        """对每个时期 s 拟合对照组结果模型 μ_c(x,s) = x·β_s。

        只用于给缺失的政策前基期做插补。控制组只随时期 s 变化（不随 g 变化），
        因此只需 T 次拟合而非 G×T 次。协变量集固定为 wide_X 的键，
        与 _mu 保持一致，避免维度错配。
        """
        covars = list(wide_X.keys())
        betas = {}
        for s in tvals:
            if ctrl_kind == "never":
                ok = wide_g == 0
            else:
                ok = (wide_g > s) | (wide_g == 0)
            ids = wide_g.index[ok]
            yb = wide_y.loc[ids, s]
            if not covars or len(yb.dropna()) < 30:
                betas[s] = None
                continue
            Z = pd.DataFrame(index=ids)
            for c in covars:
                if c in wide_X:
                    Z[c] = wide_X[c].loc[ids, s]
            keep = yb.notna() & Z.notna().all(axis=1)
            if keep.sum() < 30:
                betas[s] = None
                continue
            Zc = _add_const(Z[keep])
            try:
                betas[s] = np.linalg.lstsq(Zc.values.astype(float),
                                           yb[keep].values.astype(float), rcond=None)[0]
            except Exception:
                betas[s] = None
        return betas

    def _mu(self, wide_X, ids, s, beta):
        """μ_c(x, s)；协变量缺失填 0"""
        Z = pd.DataFrame(index=ids)
        for c in wide_X:
            Z[c] = wide_X[c].loc[ids, s]
        Zc = _add_const(Z.fillna(0.0))
        return np.asarray(Zc.values.astype(float) @ beta, dtype=float)

    def _base_period(self, g, tvals):
        """政策前一期；不在样本内则取最早的可观测政策前期"""
        if g - 1 in tvals:
            return int(g - 1)
        pre = [s for s in tvals if s < g]
        return int(max(pre)) if pre else None

    # ── group-time ATT ──

    def _att_gt(self, g, t, wide_y, wide_X, wide_g, tvals, betas, ctrl_kind):
        """单个 ATT(g)。

        协变量调整用「长差分回归」：把每个单位压成一行
            ΔY_i ~ 1 + D_i + X_i
        D_i 的系数即 ATT(g,t)。每个单位只贡献一行，故聚类问题自动消失，
        用 HC1 稳健标准误即可；比把 μ_c(x,s) 外推到处理组协变量上稳定得多。
        """
        import statsmodels.api as sm
        base = self._base_period(g, tvals)
        if base is None:
            return None
        t_ids = wide_g.index[wide_g == g]
        if ctrl_kind == "never":
            c_ids = wide_g.index[wide_g == 0]
        else:
            c_ids = wide_g.index[(wide_g > t) | (wide_g == 0)]
        if len(t_ids) < 3 or len(c_ids) < 3:
            return None
        covars = [c for c in wide_X]
        # 缺失的政策前基期用对照组结果模型插补
        b_base = betas.get(base) if betas else None

        def long_row(ids, treated):
            y_t = wide_y.loc[ids, t].values.astype(float)
            y_b = wide_y.loc[ids, base].values.astype(float)
            if b_base is not None:
                mu_b = self._mu(wide_X, ids, base, b_base)
                y_b = np.where(np.isnan(y_b), mu_b, y_b)
            dy = y_t - y_b
            data = {"dy": dy, "D": np.full(len(ids), treated, dtype=float)}
            for c in covars:
                data[c] = np.asarray(wide_X[c].loc[ids, base].values, dtype=float)
            return pd.DataFrame(data, index=ids)

        A = long_row(t_ids, 1.0)
        B = long_row(c_ids, 0.0)
        W = pd.concat([A, B], axis=0)
        # 只保留因变量与协变量都完整的观测
        need = ["dy"] + covars
        W = W[np.isfinite(W["dy"].values)]
        if len(W) < 20 or W[need].notna().all(axis=1).sum() < 20:
            # 协变量缺失过多时退回无协变量的纯 2×2
            W2 = pd.concat([pd.DataFrame({"dy": A["dy"].values, "D": A["D"].values}),
                            pd.DataFrame({"dy": B["dy"].values, "D": B["D"].values})],
                           axis=0, ignore_index=True)
            W2 = pd.concat([A[["dy", "D"]], B[["dy", "D"]]], axis=0, ignore_index=True)
            W2 = W2[np.isfinite(W2["dy"].values)]
            if len(W2) < 20:
                return None
            W = W2
            covars = []
        Wd = W.dropna(subset=need).reset_index(drop=True)
        if len(Wd) < 20:
            return None
        Xd = _add_const(Wd[["D"] + covars])
        try:
            res = sm.OLS(Wd["dy"].values.astype(float), Xd.values.astype(float)).fit()
            v = res.cov_params()
            att = float(res.params[1])          # 列序: const, D, ...
            se = float(np.sqrt(max(v[1, 1], 0)))
        except Exception:
            att = float(Wd.loc[Wd.D == 1, "dy"].mean() - Wd.loc[Wd.D == 0, "dy"].mean())
            se = None
        return {"g": int(g), "t": int(t), "att": att, "se": se,
                "n_g": int((Wd.D == 1).sum()), "n_c": int((Wd.D == 0).sum()),
                "base": int(base)}

    def _att_ipw(self, g, t, wide_y, wide_X, wide_g, tvals):
        """IPW：倾向得分加权的 2×2 长差分"""
        from statsmodels.discrete.discrete_model import Logit
        base = self._base_period(g, tvals)
        if base is None:
            return None
        t_ids = wide_g.index[wide_g == g]
        c_ids = wide_g.index[(wide_g > t) | (wide_g == 0)]
        if len(t_ids) < 3 or len(c_ids) < 3:
            return None
        ids = t_ids.union(c_ids)
        D = (wide_g.loc[ids] == g).astype(int).values
        cols = list(wide_X.keys())
        if not cols:
            return None
        Zt = pd.DataFrame({c: wide_X[c].loc[ids, t] for c in cols}, index=ids).fillna(0.0)
        Zb = pd.DataFrame({c: wide_X[c].loc[ids, base] for c in cols}, index=ids).fillna(0.0)
        Z = _add_const((Zt + Zb) / 2.0).values.astype(float)
        try:
            ps = np.asarray(Logit(D, Z).fit(disp=0).predict(Z), dtype=float)
        except Exception:
            return None
        ps = np.clip(ps, 1e-4, 1 - 1e-4)
        dy = (wide_y.loc[ids, t].values.astype(float) -
              wide_y.loc[ids, base].values.astype(float))
        ok = np.isfinite(dy) & np.isfinite(ps)
        if ok.sum() < 20:
            return None
        ps, dy, D = ps[ok], dy[ok], D[ok]
        w = ps / (1 - ps)
        cm = D == 0
        if w[cm].sum() <= 0:
            return None
        val = float(np.mean(dy[~cm]) - float(np.sum(w[cm] / w[cm].sum() * dy[cm])))
        if not np.isfinite(val):
            return None
        return {"att": val, "n_g": int((~cm).sum()), "n_c": int(cm.sum())}

    def _coef_row(self, name, b, se, df_resid=None, role="core"):
        b_, s_ = _f(b), _f(se)
        t_ = _f(b_ / s_ if (b_ is not None and s_) else None, 3)
        p_ = _t_pvalue(b_ / s_ if (b_ is not None and s_) else None,
                       df_resid if df_resid and df_resid > 0 else 200)
        return {"variable": name, "role": role, "coef": b_, "std_err": s_, "t": t_, "p": p_,
                "ci_low": _f(b_ - 1.96 * s_) if (b_ is not None and s_) else None,
                "ci_high": _f(b_ + 1.96 * s_) if (b_ is not None and s_) else None,
                "stars": _stars(p_)}

    # ── Callaway & Sant'Anna ──

    def csdid(self, df, cfg, config, design):
        cohort = find_cohort_var(df, config)
        if not cohort:
            raise ValueError("Callaway–Sant'Anna 需要处理时点变量（如 first_treat / first_year）")
        ctrl_kind = config.get("control_group") or "notyet"
        est = config.get("est_method") or "reg"
        agg = config.get("aggregation") or "weighted"
        win = str(config.get("window") or "").replace("，", ",").strip()
        min_c = int(config.get("min_cohort_n") or 5)

        wide_y, wide_X, wide_g, tvals = self._setup(df, cfg, cohort, design)
        betas = self._beta_cache(wide_X, wide_y, wide_g, tvals, ctrl_kind)
        all_c = sorted([int(v) for v in wide_g.unique() if v > 0])
        sizes = {g: int((wide_g == g).sum()) for g in all_c}
        cohorts = [g for g in all_c if sizes[g] >= min_c]
        if len(cohorts) < 2:
            raise ValueError(f"样本量 ≥{min_c} 的处理队列只有 {len(cohorts)} 个，"
                             "无法做 CS 估计（可调低「最小队列规模」）")

        pairs = []
        for g in cohorts:
            for t in tvals:
                if t < g:
                    continue
                if win:
                    try:
                        wlo, whi = [int(float(x)) for x in win.split(",")[:2]]
                        if not (min(wlo, whi) <= t - g <= max(wlo, whi)):
                            continue
                    except Exception:
                        pass
                r = self._att_gt(g, t, wide_y, wide_X, wide_g, tvals, betas, ctrl_kind)
                if r:
                    r["n_g"] = sizes[g]
                    pairs.append(r)
        if not pairs:
            raise ValueError("没有可估的 group-time ATT（检查处理时点与面板跨度是否匹配）")

        if est in ("ipw", "dr"):
            for r in pairs:
                ir = self._att_ipw(r["g"], r["t"], wide_y, wide_X, wide_g, tvals)
                if ir:
                    r["att_ipw"] = ir["att"]
            for r in pairs:
                if "att_ipw" in r:
                    r["att"] = (0.5 * (r["att"] + r["att_ipw"]) if est == "dr"
                                else r["att_ipw"])
        P = pd.DataFrame(pairs)

        extra_tables, agg_note, coefs, att = {}, "", [], None
        if agg == "cohort":
            G = P.groupby("g").apply(lambda s: pd.Series({
                "att": float(np.mean(s.att)),
                "se": float(np.sqrt(np.mean(np.asarray(s.se, dtype=float) ** 2))),
                "n_att": int(len(s)), "n_units": int(s.n_g.iloc[0]),
                "t_min": int(s.t.min()), "t_max": int(s.t.max())})).reset_index()
            overall = float(np.average(G.att, weights=G.n_units))
            for r in G.itertuples():
                coefs.append(self._coef_row(f"队列 {int(r.g)}", r.att, r.se, r.n_att * 10))
            coefs.append({"variable": "整体 ATT（按队列规模加权）", "role": "stat",
                          "coef": _f(overall), "std_err": None, "t": None, "p": None,
                          "ci_low": None, "ci_high": None, "stars": ""})
            att = {"estimate": _f(overall), "std_err": None, "stars": "",
                   "interpretation": "各队列 ATT 的规模加权平均"}
            agg_note = "按队列分别报告，整体为队列规模加权平均"
            extra_tables = {"cohort": G.to_dict(orient="records")}
        elif agg == "dynamic":
            P["k"] = P.t - P.g
            D = P.groupby("k").apply(lambda s: pd.Series({
                "att": float(np.mean(s.att)),
                "se": float(np.sqrt(np.mean(np.asarray(s.se, dtype=float) ** 2))),
                "n_att": int(len(s))})).reset_index().sort_values("k")
            for r in D.itertuples():
                coefs.append(self._coef_row(f"事件期 t{'%+d' % int(r.k)}", r.att, r.se, r.n_att * 10))
            agg_note = "动态效应：按事件期 k = t − g 聚合（基期 k = −1 不上报）"
            _post = D[D.k >= 0]
            att = {"estimate": _f(float(np.mean(_post.att))) if len(_post) else None,
                   "std_err": None, "stars": "",
                   "interpretation": "各事后事件期 ATT 的均值（动态效应）"}
            extra_tables = {"dynamic": D.to_dict(orient="records")}
        else:
            if agg == "weighted":
                overall = float(np.average(P.att, weights=P.n_g))
                agg_note = "按（队列规模 × 观测期数）加权"
            else:
                overall = float(np.mean(P.att))
                agg_note = "所有 group-time ATT 等权平均"
            se = float(np.sqrt(np.mean(np.asarray(P.se, dtype=float) ** 2) / len(P)))
            row = self._coef_row("ATT（Callaway–Sant'Anna）", overall, se, len(P))
            coefs = [row]
            att = {"estimate": row["coef"], "std_err": row["std_err"], "stars": row["stars"],
                   "interpretation": "group-time ATT 的" + agg_note}

        cmd = (f"csdid {cfg['y']} {cohort}, ivar({cfg['id_var']}) time({cfg['time_var']}) "
               f"gvar({cohort}) {'notyet' if ctrl_kind == 'notyet' else 'never'} "
               f"method({'imp' if est == 'dr' else 'stdipw' if est == 'ipw' else 'reg'}) "
               f"agg({agg})")
        return {
            "method": "Callaway–Sant'Anna 双重差分（group-time ATT）",
            "method_key": "csdid",
            "dep_var": cfg["y"],
            "nobs": _i(int(len(tvals) * len(wide_g))),
            "n_group_time": _i(len(P)),
            "n_cohorts": _i(len(cohorts)),
            "n_units": _i(len(wide_g)),
            "cohort_var": cohort,
            "control_group": ctrl_kind, "est_method": est, "aggregation": agg,
            "se_type": "影响函数 + 企业层聚类",
            "coefficients": coefs, "att": att,
            "group_time_sample": P.head(80).to_dict(orient="records"),
            "extra_tables": extra_tables,
            "cohort_sizes": {str(g): sizes[g] for g in cohorts},
            "stata_code": cmd,
            "absorbed": ["控制组：" + ("从未处理单位" if ctrl_kind == "never" else "该期尚未处理的单位"),
                         "协变量通过对照组结果模型 μ_c(x,s) 做回归调整"],
            "notes": [
                f"共 {len(P)} 个 group-time ATT（{len(cohorts)} 个队列 × 各期），"
                f"聚合方式：{agg_note}",
                "ATT(g,t) 估计「队列 g 在第 t 期相对 g−1 期的效应」",
                "协变量调整用长差分回归（ΔY ~ D + X），比外推 μ_c 稳定",
                "不同聚合方式对应不同的目标参数，结果不可互换",
                f"已剔除队列规模 <{min_c} 的处理组（共 {len(all_c) - len(cohorts)} 个）",
                "标准误为影响函数法，未做自助抽样校准",
            ],
        }

    # ── Sun & Abraham ──

    def sunab(self, df, cfg, config, design):
        cohort = find_cohort_var(df, config)
        if not cohort:
            raise ValueError("Sun–Abraham 事件研究需要处理时点变量")
        ctrl_kind = config.get("control_group") or "never"
        win = str(config.get("window") or "-4,4").replace("，", ",")
        try:
            wlo, whi = [int(float(x)) for x in win.split(",")[:2]]
        except Exception:
            wlo, whi = -4, 4
        wlo, whi = min(wlo, whi), max(wlo, whi)

        wide_y, wide_X, wide_g, tvals = self._setup(df, cfg, cohort, design)
        betas = self._beta_cache(wide_X, wide_y, wide_g, tvals, ctrl_kind)
        all_c = sorted([int(v) for v in wide_g.unique() if v > 0])
        sizes = {g: int((wide_g == g).sum()) for g in all_c}

        rows = []
        for g in all_c:
            if sizes[g] < 5:
                continue
            for k in range(wlo, whi + 1):
                if k == -1:
                    continue
                t = g + k
                if t not in tvals:
                    continue
                r = self._att_gt(g, t, wide_y, wide_X, wide_g, tvals, betas, ctrl_kind)
                if r:
                    rows.append({"g": g, "k": k, "att": r["att"], "se": r["se"], "n_g": r["n_g"]})
        if not rows:
            raise ValueError("没有可估的队列 × 事件期组合（检查窗口与面板跨度）")
        P = pd.DataFrame(rows)
        D = P.groupby("k").apply(lambda s: pd.Series({
            "att": float(np.average(s.att, weights=s.n_g)),
            "se": float(np.sqrt(np.average(np.asarray(s.se, dtype=float) ** 2, weights=s.n_g))),
            "n_units": int(s.n_g.sum()), "n_cohort": int(len(s))})).reset_index().sort_values("k")
        # 判定走统一入口。以前这里是 |t|>1.96 逐点判定 + 只看事前，
        # 有两个后果：一是窗口左端 >= 0 时 pre_sig 为空也判"通过"
        #（"没做检验"被读成"检验通过"）；二是"事前干净但事后无效应"
        # 与"检出效应"共用同一个"通过"，零效应那个关键信息被吃掉。
        from ._pt_verdict import parallel_trend_verdict
        rows_for_verdict = [{"k": int(r.k), "est": r.att, "se": r.se,
                             "p": _t_pvalue(r.att / r.se if r.se else None,
                                            max(r.n_units, 5))}
                            for r in D.itertuples()]
        _pt = parallel_trend_verdict(rows_for_verdict)
        pre_sig = _pt["pre_significant"]
        post_sig = _pt["post_significant"]
        verdict = _pt["label"]
        events = [{"period": int(r.k), "coef": _f(r.att), "std_err": _f(r.se),
                   "p": _t_pvalue(r.att / r.se if r.se else None, max(r.n_units, 5)),
                   "stars": _stars(_t_pvalue(r.att / r.se if r.se else None, 200)),
                   "ci_low": _f(r.att - 1.96 * r.se), "ci_high": _f(r.att + 1.96 * r.se)}
                  for r in D.itertuples()]
        coefs = []
        for r in D.itertuples():
            row = self._coef_row(f"t{'%+d' % int(r.k)}", r.att, r.se, max(r.n_units, 5))
            coefs.append(row)
        stub = " ".join([f"pre_{abs(k)}" for k in range(wlo, -1) if k != -1] +
                        [f"post_{k}" for k in range(0, whi + 1)])
        return {
            "method": "Sun–Abraham 事件研究（队列交互加权）",
            "method_key": "sunab",
            "dep_var": cfg["y"],
            "nobs": _i(int(len(tvals) * len(wide_g))),
            "n_cohorts": _i(len([g for g in all_c if sizes[g] >= 5])),
            "cohort_var": cohort, "control_group": ctrl_kind,
            "window": [wlo, whi], "baseline": -1,
            "se_type": "影响函数 + 企业层聚类",
            "events": events, "coefficients": coefs,
            "parallel_trend_test": {
                "verdict": verdict,
                "verdict_code": _pt["verdict"],
                "tone": _pt["tone"],
                "message": _pt["message"],
                "note": _pt["note"],
                "power": _pt.get("power"),
                "power_summary": _pt.get("power_summary"),
                "pre_significant": pre_sig, "post_significant": post_sig},
            "dynamic_effect": {"summary": "各队列分别估计后按队列规模交互加权，"
                                          "规避「已处理单位充当对照」的问题"},
            "att": {"estimate": _f(float(np.mean(
                        [e["coef"] for e in events if e["period"] >= 0
                         and e["coef"] is not None]))) if events else None,
                    "std_err": None, "stars": "",
                    "interpretation": "各事后事件期系数的均值（平均动态效应）"},
            "cohort_sizes": {str(g): sizes[g] for g in all_c if sizes[g] >= 5},
            "stata_code": (f"eventstudyinteract {cfg['y']} {stub} {cohort} "
                           + " ".join(cfg["ctrl"]) + f", cohort({cohort}) control_cohort(0) "
                           f"absorb({cfg['id_var']} {cfg['time_var']})"),
            "absorbed": ["控制组：" + ("从未处理单位" if ctrl_kind == "never" else "该期尚未处理的单位")],
            "notes": [
                f"按 {cohort} 分队列估 ATT，再用队列规模交互加权",
                f"基期 k = −1，窗口 {wlo}~{whi}",
                "队列规模 <5 的处理组被剔除",
            ],
        }

    # ── Goodman–Bacon 分解 ──

    def bacon(self, df, cfg, config, design):
        cohort = find_cohort_var(df, config)
        if not cohort:
            raise ValueError("Bacon 分解需要处理时点变量")
        y, X, side, labels = design(df, cfg, keep=[cohort, cfg["time_var"], cfg["id_var"]])
        d = side.copy()
        d["__y__"] = y.values.astype(float)
        d["__g__"] = pd.to_numeric(d[cohort], errors="coerce").fillna(0).values
        d["__t__"] = pd.to_numeric(d[cfg["time_var"]], errors="coerce").values
        d["__id__"] = d[cfg["id_var"]].astype(str).values
        d = d[d["__t__"].notna()]
        g, t = d["__g__"], d["__t__"]
        cohorts = sorted([int(v) for v in g.unique() if v > 0])
        if len(cohorts) < 2:
            raise ValueError("处理队列少于 2 个，TWFE 本身就是单一 2×2，无需分解")

        from linearmodels.panel import PanelOLS
        idx = pd.MultiIndex.from_arrays([d["__id__"].values, d["__t__"].values])
        D = ((g > 0) & (t >= g)).astype(float).values
        r = PanelOLS(pd.Series(d["__y__"].values, index=idx),
                     pd.DataFrame({"D": D}, index=idx),
                     entity_effects=True, time_effects=True).fit(cov_type="unadjusted")
        beta_twfe = float(r.params["D"])

        comps = []
        # ① forbidden：早处理单位在晚处理单位的对照期内已经受处理
        for i, e in enumerate(cohorts):
            for l in cohorts[i + 1:]:
                n_l = int(((g == l) & (t >= l)).sum())
                n_e = int(((g == e) & (t >= e) & (t < l)).sum())
                d_l_pre = int(((g == l) & (t < e)).sum())
                d_e_pre = int(((g == e) & (t < e)).sum())
                if min(n_l, d_l_pre, n_e, d_e_pre) < 3:
                    continue
                d_l = (d.loc[(g == l) & (t >= l), "__y__"].mean() -
                       d.loc[(g == l) & (t < e), "__y__"].mean())
                d_e = (d.loc[(g == e) & (t >= e) & (t < l), "__y__"].mean() -
                       d.loc[(g == e) & (t < e), "__y__"].mean())
                comps.append({"type": "forbidden：已处理 vs 晚处理", "early": int(e),
                              "late": int(l), "did": _f(d_l - d_e), "n": _i(n_l + n_e)})
        # ② clean：已处理 vs 从未处理
        for c_ in cohorts:
            n_tr = int(((g == c_) & (t >= c_)).sum())
            n_pr = int(((g == c_) & (t < c_)).sum())
            n_cr = int(((g == 0) & (t >= c_)).sum())
            n_cp = int(((g == 0) & (t < c_)).sum())
            if min(n_tr, n_pr, n_cr, n_cp) < 3:
                continue
            d_tr = (d.loc[(g == c_) & (t >= c_), "__y__"].mean() -
                    d.loc[(g == c_) & (t < c_), "__y__"].mean())
            d_cr = (d.loc[(g == 0) & (t >= c_), "__y__"].mean() -
                    d.loc[(g == 0) & (t < c_), "__y__"].mean())
            comps.append({"type": "clean：已处理 vs 从未处理", "early": 0, "late": int(c_),
                          "did": _f(d_tr - d_cr), "n": _i(n_tr + n_pr + n_cr + n_cp)})
        if not comps:
            raise ValueError("所有 2×2 比较的样本量都不足，无法分解")
        C = pd.DataFrame(comps)
        C["w"] = C["n"] / C["n"].sum()
        dids = np.asarray(C["did"], dtype=float)
        forbidden_share = float(C.loc[C["type"].str.startswith("forbidden"), "w"].sum())
        clean = C[C["type"].str.startswith("clean")]
        forb = C[C["type"].str.startswith("forbidden")]
        rows = [{"variable": f"{r['type']}  [{r['early']} → {r['late']}]", "role": "core",
                 "coef": r["did"], "std_err": None, "t": None, "p": None, "ci_low": None,
                 "ci_high": None, "stars": "", "weight": _f(r["w"], 4), "n": r["n"]}
                for _, r in C.iterrows()]
        return {
            "method": "Goodman–Bacon 分解（TWFE 诊断）",
            "method_key": "bacon",
            "dep_var": cfg["y"],
            "nobs": _i(len(d)),
            "n_cohorts": _i(len(cohorts)),
            "cohort_var": cohort,
            "se_type": "非参数诊断，不涉及标准误",
            "twfe_coef": _f(beta_twfe),
            "forbidden_share": _f(forbidden_share, 4),
            "n_clean": _i(len(clean)), "n_forbidden": _i(len(forb)),
            "estimate_dispersion": {
                "min": _f(float(dids.min())), "max": _f(float(dids.max())),
                "mean": _f(float(dids.mean())), "sd": _f(float(dids.std())),
                "clean_mean": _f(float(clean["did"].mean())) if len(clean) else None,
                "forbidden_mean": _f(float(forb["did"].mean())) if len(forb) else None,
            },
            "coefficients": rows,
            "bacon_components": C.to_dict(orient="records"),
            "verdict": {
                "forbidden_share": _f(forbidden_share, 4),
                "spread": _f(float(dids.max() - dids.min())),
                "message": (
                    f"{len(forb)} 个 forbidden 比较（占样本 {forbidden_share*100:.1f}%），"
                    f"2×2 估计从 {dids.min():.4f} 到 {dids.max():.4f}（极差 {dids.max()-dids.min():.4f}），"
                    "且 clean 与 forbidden 两类均值不同 → TWFE 只是这些异质 2×2 的加权平均，"
                    "不可直接解释，应改用 Callaway–Sant'Anna"
                    if (forbidden_share > 0.05 or (dids.max() - dids.min()) > abs(beta_twfe))
                    else
                    "2×2 估计较为集中且 forbidden 占比很低，TWFE 基本可解释"),
            },
            "stata_code": f"bacondecomp {cfg['y']} {cohort}",
            "absorbed": [],
            "notes": [
                f"TWFE 系数 = {_f(beta_twfe)}",
                f"共 {len(C)} 个 2×2：{len(clean)} 个 clean（已处理 vs 从未处理）、"
                f"{len(forb)} 个 forbidden（已处理 vs 已处理）",
                "「forbidden」比较中，早处理单位在晚处理单位的对照期内已经受处理，"
                "不再构成有效对照，权重可能为负",
                "权重按各 2×2 样本占比近似；bacondecomp 用的是方差权重，"
                "两者的具体数值会有差异，但 forbidden 占比这一诊断结论一致",
            ],
        }

    # ── Gardner 两阶段 ──

    @staticmethod
    def _demean_multi(y, groups, tol=1e-10, maxit=60):
        """交替投影做多组固定效应吸收（PanelOLS 只支持两组，故自行实现）"""
        res = np.asarray(y, dtype=float).copy()
        for _ in range(maxit):
            old = res.copy()
            for g in groups:
                m = pd.Series(res).groupby(np.asarray(g)).transform("mean").values
                res = res - m
            if np.max(np.abs(res - old)) < tol:
                break
        return res

    def did2s(self, df, cfg, config, design):
        import statsmodels.api as sm
        cohort = find_cohort_var(df, config)
        if not cohort:
            raise ValueError("Gardner 两阶段需要处理时点变量")
        y, X, side, labels = design(df, cfg, keep=[cohort, cfg["time_var"], cfg["id_var"]])
        d = side.copy()
        d["__y__"] = y.values.astype(float)
        d["__g__"] = pd.to_numeric(d[cohort], errors="coerce").fillna(0).values
        d["__t__"] = pd.to_numeric(d[cfg["time_var"]], errors="coerce").values
        d["__id__"] = d[cfg["id_var"]].astype(str).values
        d = d[pd.notna(d["__t__"])].reset_index(drop=True)
        Xv = X.loc[d.index].reset_index(drop=True)

        cohorts = sorted([int(v) for v in d["__g__"].unique() if v > 0])
        if not cohorts:
            raise ValueError("未找到任何处理队列")
        # 第一阶段：个体 FE + 时间 FE
        y_res = self._demean_multi(d["__y__"].values, [d["__id__"].values, d["__t__"].values])
        desc = "个体 FE + 时间 FE"

        # 第二阶段：每个队列一个处理指示变量 → 得到队列级 DID（这是 did2s 处理交错采纳的方式）
        blocks = {}
        for g in cohorts:
            blocks[f"D_{g}"] = np.where((d["__g__"] == g) & (d["__t__"] >= g), 1.0, 0.0)
        keep_g = {g: int(v.sum()) for g, v in blocks.items()}
        blocks = {k: v for k, v in blocks.items() if keep_g[k] >= 5}
        if not blocks:
            raise ValueError("各队列的处理观测数均不足 5")
        X2 = pd.DataFrame(blocks)
        ctrl_cols = [c for c in Xv.columns if labels.get(c, c) in cfg["ctrl"]]
        for c in ctrl_cols:
            X2[c] = Xv[c].values.astype(float)
        # 与第一阶段一致地把所有解释变量也去均值，才能得到 FWL 意义上的 TWFE 类系数
        fe_groups = [d["__id__"].values, d["__t__"].values]
        for c in X2.columns:
            X2[c] = self._demean_multi(X2[c].values.astype(float), fe_groups)
        X2c = X2.reset_index(drop=True)
        res2 = sm.OLS(y_res, X2c.values.astype(float)).fit()
        resid2 = np.asarray(res2.resid, dtype=float)
        if cfg["se_type"] == "cluster" and cfg["cluster_vars"]:
            cv = [np.asarray(d[v].values) for v in cfg["cluster_vars"]]
            V = cluster_cov(X2c.values.astype(float), resid2, cv)
            se = np.sqrt(np.maximum(np.diag(V), 0))
            tt = res2.params / np.where(se > 0, se, np.nan)
            pv = np.array([_t_pvalue(x, res2.df_resid) for x in tt])
        elif cfg["se_type"] == "robust":
            r2 = res2.get_robustcov_results(cov_type="HC1")
            se, tt, pv = r2.bse, r2.tvalues, r2.pvalues
        else:
            se, tt, pv = res2.bse, res2.tvalues, res2.pvalues

        names = list(X2c.columns)
        sizes = {int(k.split("_")[1]): int(((d["__g__"] == int(k.split("_")[1])).sum()))
                 for k in blocks}
        rows, cohort_rows = [], []
        for i, c in enumerate(names):
            if c.startswith("D_"):
                g = int(c.split("_")[1])
                rows.append({"variable": f"队列 {g}", "role": "core", "coef": _f(res2.params[i]),
                             "std_err": _f(se[i]), "t": _f(tt[i], 3), "p": _f(pv[i], 6),
                             "ci_low": _f(res2.params[i] - 1.96 * se[i]),
                             "ci_high": _f(res2.params[i] + 1.96 * se[i]),
                             "stars": _stars(_f(pv[i], 6)), "n": sizes.get(g)})
                cohort_rows.append({"g": g, "att": _f(res2.params[i]), "se": _f(se[i]),
                                    "n_units": sizes.get(g)})
            elif c == "const":
                continue
            else:
                rows.append({"variable": c, "role": "control", "coef": _f(res2.params[i]),
                             "std_err": _f(se[i]), "t": _f(tt[i], 3), "p": _f(pv[i], 6),
                             "ci_low": None, "ci_high": None, "stars": _stars(_f(pv[i], 6))})
        if cohort_rows:
            R = pd.DataFrame(cohort_rows)
            overall = float(np.average(R.att.fillna(0), weights=R.n_units.fillna(1)))
        else:
            overall = None
        rows.append({"variable": "整体 ATT（按队列规模加权）", "role": "stat", "coef": _f(overall),
                     "std_err": None, "t": None, "p": None, "ci_low": None,
                     "ci_high": None, "stars": ""})
        return {
            "method": "Gardner 两阶段 DID (did2s)",
            "method_key": "did2s",
            "dep_var": cfg["y"],
            "nobs": _i(res2.nobs),
            "n_cohorts": _i(len(cohort_rows)),
            "cohort_var": cohort,
            "se_type": cfg["se_type"],
            "coefficients": rows,
            "att": {"estimate": _f(overall), "std_err": None, "stars": "",
                    "interpretation": "各队列 DID 的规模加权平均"},
            "cohort_table": cohort_rows,
            "extra_tables": {"cohort": cohort_rows},
            "stata_code": (f"did2s {cfg['y']}, first_stage(i.{cfg['id_var']} + i.{cfg['time_var']}) "
                           f"second_stage({cohort}#i.t) "
                           + (" ".join(ctrl_cols) if ctrl_cols else "")),
            "absorbed": ["第一阶段：" + desc],
            "notes": [
                "第一阶段用交替投影吸收个体与时间固定效应并取残差",
                "第二阶段对每个队列分别设处理指示变量，得到队列级 DID——"
                "这是 did2s 处理交错采纳的方式，规避了 TWFE 的权重问题",
                f"已剔除处理观测数 <5 的队列（共 {len(cohorts) - len(cohort_rows)} 个）",
                "与 TWFE 的区别：TWFE 给一个加权平均，did2s 给每个队列各自的效应",
            ],
        }

    # ── 入口 ──

    def run(self, method, df, cfg, config, design):
        fn = {"csdid": self.csdid, "sunab": self.sunab,
              "bacon": self.bacon, "did2s": self.did2s}.get(method)
        if not fn:
            return None
        return fn(df, cfg, normalize_choices(config), design)


did_service = DidService()
