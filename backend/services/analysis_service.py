"""统计分析服务 — 与回归引擎共用同一套估计

这里的方法分为两类：
  真正的统计方法（描述统计 / 交叉表 / 相关性 / 假设检验 / 方差分析）自己实现；
  凡是「回归」，一律转交 regression_service——那边有 27 个经过交叉验证的估计量、
  标准误类型、聚类和 Stata 代码生成。早期版本在这个文件里又写了一遍 OLS，
  结果稳健标准误是假的、面板回归只是改了方法名的 OLS，都会给出错误结论。
"""
import numpy as np
import pandas as pd
import scipy.stats as stats


class AnalysisService:

    def run_analysis(self, method: str, config: dict, data_service) -> dict:
        df = data_service.get_current()
        if df is None:
            return {"error": "未加载数据集"}

        method_map = {
            "descriptive": self._descriptive,
            "cross_tab": self._cross_tab,
            "correlation": self._correlation,
            "hypothesis_test": self._hypothesis_test,
            "anova": self._anova,
            # 回归类 → 转交回归引擎
            "linear_regression": self._regression,
            "panel_regression": self._panel_regression,
            "fixed_effect": self._panel_regression,
            "hausman": self._hausman,
        }
        handler = method_map.get(method)
        if not handler:
            return {"error": f"未知分析方法: {method}"}
        try:
            return handler(df, config)
        except Exception as e:
            return {"error": f"{type(e).__name__}: {e}"}

    # ── 回归类：全部转交 regression_service ──

    def _reg(self, df, config, method, se_key="robust"):
        from .regression_service import regression_service

        y = config.get("y_var")
        xs = [v for v in (config.get("x_vars") or config.get("core_x") or [])
              if v and v != y]
        if not y or y not in df.columns:
            return {"error": "请选择因变量"}
        if not xs:
            return {"error": "请至少选择一个解释变量"}
        missing = [v for v in xs if v not in df.columns]
        if missing:
            return {"error": f"变量不存在: {', '.join(missing)}"}

        se_type = config.get("se_type")
        if not se_type:
            se_type = "robust" if config.get("robust") else "plain"

        cfg = {
            "y_var": y, "core_x": xs,
            "controls": [v for v in (config.get("controls") or [])
                         if v and v not in xs],
            "id_var": config.get("id_var") if config.get("id_var") in df.columns else None,
            "time_var": config.get("time_var") if config.get("time_var") in df.columns else None,
            "cluster_vars": [v for v in (config.get("cluster_vars") or []) if v in df.columns][:2],
            "se_type": se_type,
        }

        r = regression_service.run(method, cfg, _DSP(config, df))
        if isinstance(r, dict) and r.get("error"):
            return r
        return self._to_stat_view(r)

    @staticmethod
    def _to_stat_view(r: dict) -> dict:
        """把回归引擎的输出改写成统计分析页已经在渲染的那套键名"""
        out = {
            "method": r.get("method"),
            "method_key": r.get("method_key"),
            "dep_var": r.get("dep_var"),
            "nobs": r.get("nobs"),
            "n_entities": r.get("n_entities"),
            "n_periods": r.get("n_periods"),
            "id_var": r.get("id_var"),
            "time_var": r.get("time_var"),
            "r_squared": r.get("r_squared"),
            "adj_r_squared": r.get("adj_r_squared"),
            "f_stat": r.get("f_stat"),
            "f_pvalue": r.get("f_pvalue"),
            "se_type": r.get("se_type"),
            "coefficients": r.get("coefficients") or [],
            "stata_code": r.get("stata_code"),
            "notes": r.get("notes") or [],
            "absorbed": r.get("absorbed") or [],
        }
        if r.get("att") is not None:
            out["att"] = r["att"]
        if r.get("events"):
            out["events"] = r["events"]
        return {k: v for k, v in out.items() if v is not None}

    def _regression(self, df, config):
        return self._reg(df, config, "ols")

    def _panel_regression(self, df, config):
        """固定效应回归。有 id/time 就走双向固定效应，否则个体固定效应。"""
        idv = config.get("id_var") if config.get("id_var") in df.columns else None
        tv = config.get("time_var") if config.get("time_var") in df.columns else None
        if idv and tv:
            cfg = dict(config, id_var=idv, time_var=tv)
            return self._reg(df, cfg, "twoway_fe")
        if idv:
            return self._reg(df, config, "fe")
        r = self._reg(df, config, "ols")
        if r.get("error"):
            return r
        r["notes"] = list(r.get("notes") or []) + [
            "数据里没识别出个体变量和时间变量，退回普通 OLS。"
            "要跑固定效应，请在变量设置里指定个体变量与时间变量。"]
        return r

    def _hausman(self, df, config):
        """Hausman 检验：FE 与 RE 系数差异是否显著。

        H = (b_fe - b_re)' [V_fe - V_re]^{-1} (b_fe - b_re)，大样本下服从
        卡方分布，自由度为共同解释变量个数。V_fe - V_re 可能不正定，
        所以用 Moore-Penrose 广义逆而不是硬求逆。
        """
        from .regression_service import regression_service

        y = config.get("y_var")
        xs = [v for v in (config.get("x_vars") or config.get("core_x") or []) if v and v != y]
        idv = config.get("id_var") if config.get("id_var") in df.columns else None
        tv = config.get("time_var") if config.get("time_var") in df.columns else None
        if not y or y not in df.columns:
            return {"error": "请选择因变量"}
        if not xs:
            return {"error": "请至少选择一个解释变量"}
        missing = [v for v in xs if v not in df.columns]
        if missing:
            return {"error": f"变量不存在: {', '.join(missing)}"}
        if not idv or not tv:
            return {"error": "豪斯曼检验需要面板数据，请在变量设置里指定个体变量与时间变量"}

        dsp = _DSP(config, df)
        cfg = {"y_var": y, "core_x": xs, "id_var": idv, "time_var": tv,
               "se_type": "cluster" if config.get("robust") else "plain",
               "cluster_vars": [c for c in (config.get("cluster_vars") or []) if c in df.columns][:2]}

        fe = regression_service.run("fe", cfg, dsp)
        re_ = regression_service.run("re", cfg, dsp)
        for nm, r in (("固定效应", fe), ("随机效应", re_)):
            if isinstance(r, dict) and r.get("error"):
                return {"error": f"{nm}估计失败: {r['error']}"}

        bf = {c["variable"]: c["coef"] for c in (fe.get("coefficients") or [])}
        br = {c["variable"]: c["coef"] for c in (re_.get("coefficients") or [])}
        vf = {c["variable"]: (c["std_err"] or 0) ** 2 for c in (fe.get("coefficients") or [])}
        vr = {c["variable"]: (c["std_err"] or 0) ** 2 for c in (re_.get("coefficients") or [])}
        common = [k for k in bf if k in br and k == "_cons" or (k in br and k != "_cons")]
        common = [k for k in bf if k in br and not k.startswith("_")]

        if len(common) < 1:
            return {"error": "FE 与 RE 没有共同解释变量，无法比较"}

        B = np.array([[bf[k] - br[k]] for k in common], dtype=float)
        V = np.array([[vf[k] - vr[k]] for k in common], dtype=float)
        # 只在两侧方差都有限的项上做检验，避免 NaN 顺着矩阵传播
        keep = np.where(np.isfinite(B.ravel()) & np.isfinite(V.ravel()))[0]
        dropped = [common[i] for i in range(len(common)) if i not in set(keep.tolist())]
        B, V = B[keep], V[keep]
        if len(B) == 0:
            return {"error": "没有可比较的系数，无法计算 Hausman 统计量"}

        H, singular = None, False
        try:
            H = float(B.T @ np.linalg.pinv(V) @ B)
        except Exception:
            singular = True
        if H is None or not np.isfinite(H) or H < 0:
            singular = True

        p = None if singular else float(1 - stats.chi2.cdf(H, len(B)))

        comparison = [{
            "variable": k,
            "fe_coef": round(float(bf[k]), 4),
            "re_coef": round(float(br[k]), 4),
            "diff": round(float(bf[k] - br[k]), 4),
        } for k in common]
        notes = [
            f"H = {H:.4f}，χ²({len(B)})，p = {p:.4f}" if not singular else
            "V_fe − V_re 奇异（固定效应把该变量的组间变异吸收干净时常见），"
            "标准 Hausman 统计量不可用",
            "实践中两法系数差异小就直接用 RE；差异大且 H 显著则用 FE",
            "系数差异是否重要，看下面 comparison 表比看 p 值更可靠",
        ]
        if dropped:
            notes.insert(1, f"以下变量因方差不可估计未参与检验：{', '.join(dropped)}")

        if singular:
            return {
                "method": "豪斯曼检验 (FE vs RE) — 统计量不可用",
                "dep_var": y, "id_var": idv, "time_var": tv,
                "nobs": fe.get("nobs"), "n_entities": fe.get("n_entities"),
                "n_periods": fe.get("n_periods"),
                "chi2": None, "df": len(B), "reject_re": None,
                "f_stat": None, "p_value": None, "obs": fe.get("nobs"),
                "conclusion": "统计量不可用：请看系数差异表判断该用 FE 还是 RE",
                "comparison": comparison, "notes": notes,
            }

        return {
            "method": "豪斯曼检验 (FE vs RE)",
            "dep_var": y, "id_var": idv, "time_var": tv,
            "nobs": fe.get("nobs"), "n_entities": fe.get("n_entities"),
            "n_periods": fe.get("n_periods"),
            "f_stat": round(H, 4),
            "p_value": round(p, 6),
            "obs": fe.get("nobs"),
            "chi2": round(H, 4), "df": len(B),
            "reject_re": bool(p < 0.05),
            "conclusion": ("p < 0.05，拒绝随机效应，应使用固定效应" if p < 0.05
                           else "p ≥ 0.05，不能拒绝随机效应，RE 与 FE 都可用"),
            "comparison": comparison, "notes": notes,
        }

        return {
            "method": "豪斯曼检验 (FE vs RE)",
            "dep_var": y,
            "id_var": idv,
            "time_var": tv,
            "nobs": fe.get("nobs"),
            "n_entities": fe.get("n_entities"),
            "n_periods": fe.get("n_periods"),
            "f_stat": round(H, 4),          # 前端把这个字段当「统计量」显示
            "p_value": round(p, 6),
            "obs": fe.get("nobs"),
            "chi2": round(H, 4),
            "df": len(common),
            "reject_re": bool(p < 0.05),
            "conclusion": ("p < 0.05，拒绝随机效应，应使用固定效应" if p < 0.05
                           else "p ≥ 0.05，不能拒绝随机效应，RE 与 FE 都可用"),
            "comparison": [{
                "variable": k,
                "fe_coef": round(float(bf[k]), 4),
                "re_coef": round(float(br[k]), 4),
                "diff": round(float(bf[k] - br[k]), 4),
            } for k in common],
            "notes": [
                f"H = {H:.4f}，χ²({len(common)})，p = {p:.4f}",
                "V_fe − V_re 用 Moore-Penrose 广义逆求逆；该差矩阵在部分情形下不正定，"
                "此时 Hausman 统计量需谨慎解读",
                "实践中两法系数差异小就直接用 RE；差异大且 H 显著则用 FE",
            ],
        }

    # ── 纯统计方法 ──

    def _descriptive(self, df, config):
        cols = config.get("x_vars") or config.get("columns") or None
        numeric = df.select_dtypes(include="number")
        if cols:
            numeric = numeric[[c for c in cols if c in numeric.columns]]
        table = {}
        for c in numeric.columns:
            s = numeric[c].dropna()
            if len(s) == 0:
                continue
            table[c] = {
                "obs": int(len(s)),
                "mean": round(float(s.mean()), 4),
                "std": round(float(s.std()), 4),
                "min": round(float(s.min()), 4),
                "p25": round(float(s.quantile(.25)), 4),
                "p50": round(float(s.quantile(.50)), 4),
                "p75": round(float(s.quantile(.75)), 4),
                "max": round(float(s.max()), 4),
            }
        if not table:
            return {"error": "没有可分析的数量变量"}
        return {"method": "描述性统计", "table": table, "variables": list(table.keys()),
                "n_vars": len(table)}

    def _cross_tab(self, df, config):
        v1 = config.get("row_var") or (config.get("x_vars") or [None])[0]
        v2 = config.get("col_var") or config.get("y_var")
        if not v1 or not v2:
            return {"error": "请选择两个变量"}
        for v in (v1, v2):
            if v not in df.columns:
                return {"error": f"变量不存在: {v}"}
        if v1 == v2:
            return {"error": "行变量和列变量不能是同一个"}
        ct = pd.crosstab(df[v1], df[v2])
        chi2, p, dof, _ = stats.chi2_contingency(ct)
        return {
            "method": "交叉表分析",
            "row_var": v1, "col_var": v2,
            "table": ct.to_dict(),
            "row_names": [str(x) for x in ct.index.tolist()],
            "col_names": [str(x) for x in ct.columns.tolist()],
            "chi2": round(float(chi2), 4),
            "df": int(dof),
            "p_value": round(float(p), 6),
            "independent": bool(p >= 0.05),
            "notes": [f"χ² = {chi2:.4f}，df = {dof}，p = {p:.4f}",
                      "p < 0.05 表示两变量不独立"],
        }

    def _correlation(self, df, config):
        vars_ = list(config.get("x_vars") or [])
        if config.get("y_var"):
            vars_ = [config["y_var"]] + vars_
        vars_ = [v for v in dict.fromkeys(vars_) if v in df.columns]
        if len(vars_) < 2:
            return {"error": "需要至少两个变量"}
        num = df[vars_].select_dtypes(include="number")
        if len(num.columns) < 2:
            return {"error": "选中的变量里数量变量不足两个"}
        corr = num.corr().round(4)
        return {"method": "相关性分析", "variables": list(num.columns),
                "matrix": corr.to_dict(), "n_obs": int(num.dropna().shape[0]),
                "notes": ["Pearson 相关系数，|r| > 0.5 视为强相关"]}

    def _hypothesis_test(self, df, config):
        y = config.get("y_var")
        kind = config.get("test_kind") or "one_sample"
        if not y or y not in df.columns:
            return {"error": "请选择检验变量"}
        s = pd.to_numeric(df[y], errors="coerce").dropna()
        if len(s) < 3:
            return {"error": "有效观测不足 3 个，无法检验"}

        if kind == "two_sample":
            g = config.get("group_var")
            if not g or g not in df.columns:
                return {"error": "两组比较请选择分组变量"}
            cats = df[g].dropna().unique()
            if len(cats) != 2:
                return {"error": f"分组变量 {g} 有 {len(cats)} 个取值，两组比较要求恰好 2 组"}
            a = pd.to_numeric(df.loc[df[g] == cats[0], y], errors="coerce").dropna()
            b = pd.to_numeric(df.loc[df[g] == cats[1], y], errors="coerce").dropna()
            if len(a) < 2 or len(b) < 2:
                return {"error": "至少有一组观测不足 2 个"}
            t, p = stats.ttest_ind(a, b, equal_var=False)
            return {
                "method": "独立样本 T 检验 (Welch)",
                "y_var": y, "group_var": g,
                "f_stat": round(float(t), 4),
                "p_value": round(float(p), 6),
                "obs": int(len(a) + len(b)),
                "groups": [
                    {"name": str(cats[0]), "n": int(len(a)), "mean": round(float(a.mean()), 4)},
                    {"name": str(cats[1]), "n": int(len(b)), "mean": round(float(b.mean()), 4)},
                ],
                "notes": ["Welch 检验不假设两组方差齐性",
                          "H0：两组均值相等"],
            }

        mu0 = config.get("test_value")
        mu0 = float(mu0) if mu0 not in (None, "") else 0.0
        t, p = stats.ttest_1samp(s, mu0)
        lo = float(s.mean() - 1.96 * s.std() / len(s) ** 0.5)
        hi = float(s.mean() + 1.96 * s.std() / len(s) ** 0.5)
        return {
            "method": f"单样本 T 检验 (H0: μ = {mu0:g})",
            "y_var": y, "test_value": mu0,
            "f_stat": round(float(t), 4),
            "p_value": round(float(p), 6),
            "obs": int(len(s)),
            "mean": round(float(s.mean()), 4),
            "std": round(float(s.std()), 4),
            "ci": [round(lo, 4), round(hi, 4)],
            "notes": [f"H0：{y} 的均值等于 {mu0:g}",
                      f"95% 置信区间 [{lo:.4f}, {hi:.4f}]"],
        }

    def _anova(self, df, config):
        y = config.get("y_var")
        g = config.get("group_var") or (config.get("x_vars") or [None])[0]
        if not y or not g:
            return {"error": "请选择数值变量和分组变量"}
        if y not in df.columns or g not in df.columns:
            return {"error": "变量不存在"}
        sub = df[[y, g]].dropna()
        groups = [pd.to_numeric(v[y], errors="coerce").dropna().values
                  for _, v in sub.groupby(g)]
        groups = [x for x in groups if len(x) >= 1]
        if len(groups) < 2:
            return {"error": "分组变量至少需要 2 组"}
        f, p = stats.f_oneway(*groups)
        return {
            "method": "单因素方差分析 (ANOVA)",
            "y_var": y, "group_var": g,
            "f_stat": round(float(f), 4),
            "p_value": round(float(p), 6),
            "obs": int(len(sub)),
            "n_groups": len(groups),
            "groups": [
                {"name": str(name), "n": int(len(v)), "mean": round(float(np.mean(v)), 4)}
                for (name, _), v in zip(sub.groupby(g), groups)
            ],
            "notes": ["H0：各组均值相等；p < 0.05 表示至少有两组均值不同"],
        }


class _DSProxy:
    """只把 current dataset 交给回归引擎的极简 data_service 适配器"""

    def __init__(self, df):
        self._df = df

    def get_current(self):
        return self._df


def _DSP(config, df):
    return _DSProxy(df)


analysis_service = AnalysisService()
