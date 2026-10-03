import numpy as np
import pandas as pd
import base64
import io
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager as _fm

# 中文字体按可用性挑：Windows 上认 SimHei / 雅黑，Linux 容器里认 Noto CJK。
# 写死一份列表的话，容器里 SimHei 不存在，中文会渲染成一排方框。
_CJK_CANDIDATES = ['SimHei', 'Microsoft YaHei', 'Noto Sans CJK SC',
                   'Noto Sans CJK JP', 'WenQuanYi Zen Hei', 'Source Han Sans SC']
_available = {f.name for f in _fm.fontManager.ttflist}
matplotlib.rcParams['font.sans-serif'] = (
    [n for n in _CJK_CANDIDATES if n in _available] or _CJK_CANDIDATES
) + ['DejaVu Sans']
matplotlib.rcParams['axes.unicode_minus'] = False

# 面板个体标识的常见命名，按优先级排列。宁可靠命名猜，也不要按
# 「唯一值最多」去挑——那样常把因变量自己排在最前面。
_ID_NAME_HINTS = ("stkcd", "code", "id", "firm", "firmid", "gvkey",
                  "permno", "city", "province", "county", "股票代码", "代码")
_ID_NAME_BAD = ("year", "time", "date", "date_", "_t", "industry", "province_name")


def _id_candidates(df, exclude=()):
    """挑出最像面板个体标识的列。"""
    excluded = set(exclude)
    scored = []
    for c in df.columns:
        if c in excluded:
            continue
        n = str(c).lower()
        if any(b in n for b in _ID_NAME_BAD):
            continue
        if df[c].nunique() < 5:
            continue
        rank = next((i for i, h in enumerate(_ID_NAME_HINTS) if h in n), len(_ID_NAME_HINTS))
        scored.append((rank, -df[c].nunique(), c))
    scored.sort()
    return [c for _, _, c in scored]


class GraphService:

    def generate(self, chart_type: str, config: dict, data_service) -> dict:
        df = data_service.get_current()
        if df is None:
            return {"error": "未加载数据集"}

        try:
            handler = getattr(self, f"_chart_{chart_type}", None)
            if not handler:
                return {"error": f"不支持的图表类型: {chart_type}"}
            return handler(df, config)
        except Exception as e:
            return {"error": str(e)}

    def _chart_line(self, df, config):
        x_var = config.get("x_var")
        y_var = config.get("y_var")
        group_var = config.get("group_var")

        if not x_var or not y_var:
            return {"error": "请设置 X 轴和 Y 轴变量"}

        if group_var and group_var in df.columns:
            groups = df[group_var].unique()
            series = []
            for g in groups:
                sub = df[df[group_var] == g].sort_values(x_var)
                series.append({
                    "name": str(g),
                    "x": sub[x_var].tolist(),
                    "y": sub[y_var].tolist(),
                })
        else:
            sub = df.sort_values(x_var)
            series = [{"name": y_var, "x": sub[x_var].tolist(), "y": sub[y_var].tolist()}]

        return {"chart_type": "line", "x_var": x_var, "y_var": y_var, "series": series}

    def _chart_bar(self, df, config):
        x_var = config.get("x_var")
        y_var = config.get("y_var")
        if not x_var or not y_var:
            return {"error": "请设置 X 轴和 Y 轴变量"}

        grouped = df.groupby(x_var)[y_var].mean().sort_index()
        return {
            "chart_type": "bar",
            "x_var": x_var,
            "y_var": y_var,
            "labels": [str(k) for k in grouped.index.tolist()],
            "values": [round(float(v), 4) for v in grouped.values],
        }

    def _chart_area(self, df, config):
        return self._chart_line(df, config)

    def _chart_scatter(self, df, config):
        x_var = config.get("x_var")
        y_var = config.get("y_var")
        if not x_var or not y_var:
            return {"error": "请设置 X 轴和 Y 轴变量"}

        data = df[[x_var, y_var]].dropna()
        corr = float(data.corr().iloc[0, 1])
        return {
            "chart_type": "scatter",
            "x_var": x_var,
            "y_var": y_var,
            "points": [{"x": round(float(r[x_var]), 4), "y": round(float(r[y_var]), 4)} for _, r in data.iterrows()],
            "correlation": round(corr, 4),
        }

    def _chart_histogram(self, df, config):
        y_var = config.get("y_var") or config.get("x_var")
        if not y_var or y_var not in df.columns:
            return {"error": "请设置变量"}

        s = df[y_var].dropna()
        counts, bin_edges = np.histogram(s, bins=20)
        labels = [f"{bin_edges[i]:.1f}-{bin_edges[i+1]:.1f}" for i in range(len(counts))]
        return {
            "chart_type": "histogram",
            "var": y_var,
            "labels": labels,
            "values": counts.tolist(),
            "stats": {
                "mean": round(float(s.mean()), 4),
                "std": round(float(s.std()), 4),
                "n": int(len(s)),
            },
        }

    def _es_core(self, df, config, want_type="event_study"):
        """事件研究 / 平行趋势共用的系数计算。

        数据里有处理时点变量（first_treat / first_year 一类）→ 交错 DID，
        走 Sun & Abraham 队列交互加权；没有但给了政策实施时点 → 单一
        政策时点的双向固定效应事件研究。两条路都给「按相对时点的系数 +
        95% 置信区间」，这才是平行趋势检验该看的东西。
        """
        from .did_service import did_service, find_cohort_var

        y_var = config.get("y_var")
        time_var = config.get("x_var")
        group_var = config.get("group_var")
        id_var = config.get("id_var")

        if not all([y_var, time_var, group_var]):
            return {"error": "需要 Y 轴、时间变量和分组变量"}
        missing = [v for v in (y_var, time_var, group_var) if v not in df.columns]
        if missing:
            return {"error": f"变量不存在：{', '.join(missing)}"}

        cohort = find_cohort_var(df, {"cohort_var": config.get("cohort_var")})
        if cohort:
            base = self._es_staggered(df, config, cohort, id_var, want_type)
            if base is not None:
                return base
            # 交错估计失败时不要就此放弃，下面还有单一政策时点这条路
            fallback_err = base if isinstance(base, dict) else None

        policy_time = config.get("policy_time")
        if policy_time in (None, ""):
            # 尝试从 Post / post / D（常见 DID 指示变量）自动推断政策时点：
            # Post=1 的最小年份即为政策实施年。
            for post_cand in ["Post", "post", "D", "d"]:
                if post_cand in df.columns and time_var in df.columns:
                    tmp = df[[time_var, post_cand]].dropna()
                    tmp[post_cand] = pd.to_numeric(tmp[post_cand], errors="coerce")
                    tmp[time_var] = pd.to_numeric(tmp[time_var], errors="coerce")
                    post_years = tmp[tmp[post_cand] == 1][time_var]
                    if len(post_years) > 0:
                        policy_time = int(post_years.min())
                        break
        if policy_time in (None, ""):
            err = ("找不到处理时点变量（如 first_treat / first_year），"
                   "所以请在「政策实施时点」里指定政策是哪一年实施的；"
                   "事件研究要知道每个单位从哪一年开始受处理，"
                   "只有一个 0/1 处理指示不够。")
            if isinstance(locals().get("fallback_err"), dict):
                err = fallback_err.get("error", err) + "；" + err
            return {"error": err}
        return self._es_single(df, config, policy_time, id_var, want_type)

    def _es_prepare(self, df, y_var, time_var, group_var, id_var, err_label):
        """校验 ID 变量。返回 (cfg, error)。"""
        cfg = {
            "y": y_var, "core": [], "ctrl": [],
            "id_var": id_var if (id_var and id_var in df.columns) else None,
            "time_var": time_var,
            "cluster_vars": [], "se_type": "cluster",
            "weight_var": None, "absorb": [],
        }
        if cfg["id_var"]:
            cfg["cluster_vars"] = [cfg["id_var"]]
        else:
            cands = _id_candidates(df, exclude=[y_var, time_var, group_var])
            return cfg, {"error": f"请指定个体 ID 变量（面板个体标识）{err_label}。"
                                   + (f"可试试：{', '.join(cands[:4])}" if cands else "")}
        return cfg, None

    @staticmethod
    def _es_pack(coefs, meta, want_type="event_study"):
        """把 [(k, est, se, lo, hi, p)] 整成图要的形状，并给出平行趋势判断。

        相对时点的排布按参考图：事前从大到小（d_4 d_3 d_2）在左，
        current 居中，事后从小到大（d_1 d_2 …）在右。基期 k = −1 不估计。

        判定走统一的 _pt_verdict.parallel_trend_verdict，四态。
        此前这里只关前事前就判"通过"，把「事前干净 + 无事后效应」
        和「检出效应」混成同一个词，后者那个零效应的关键信息被吃掉了。
        """
        from ._pt_verdict import parallel_trend_verdict

        coefs = sorted(coefs, key=lambda c: c[0])
        events = [{
            "rel_time": int(k), "term": "t%+d" % int(k),
            "estimate": est, "std_error": se,
            "ci_low": lo, "ci_high": hi, "p_value": p,
        } for k, est, se, lo, hi, p in coefs]
        v = parallel_trend_verdict([{
            "k": e["rel_time"], "est": e["estimate"],
            "se": e["std_error"], "p": e["p_value"],
        } for e in events])
        meta = dict(meta)
        meta["chart_type"] = want_type
        meta["coefficients"] = events
        meta["parallel_trend"] = {
            # label 仍是"通过/未通过"，是为了不破坏前端按 verdict 字符串判断的地方；
            # verdict 是四态，新增字段给前端做精细展示。
            "verdict": v["label"],
            "verdict_code": v["verdict"],
            "tone": v["tone"],
            "pre_significant": v["pre_significant"],
            "post_significant": v["post_significant"],
            "message": v["message"],
            "note": v["note"],
            # 功效层（Roth 2022）：回答"这个通过到底排除了什么"
            "power": v.get("power"),
            "power_summary": v.get("power_summary"),
        }
        return meta

    def _es_staggered(self, df, config, cohort, id_var, want_type="event_study"):
        """交错 DID：Sun & Abraham 队列交互加权事件研究"""
        from .did_service import did_service

        y_var, time_var, group_var = (config.get("y_var"), config.get("x_var"),
                                      config.get("group_var"))
        cfg, err = self._es_prepare(df, y_var, time_var, group_var, id_var,
                                    "（面板个体标识）")
        if err:
            return err
        win = str(config.get("window") or "-4,4").replace("，", ",")
        r = did_service.sunab(df, cfg, {"control_group": "never", "window": win},
                              self._identity_design)
        if "error" in r:
            return r
        coefs = [(e["period"], e["coef"], e["std_err"], e["ci_low"], e["ci_high"], e["p"])
                 for e in r.get("events", [])]
        if not coefs:
            return {"error": "没有可估的事件期系数（检查处理时点与面板跨度）"}
        return self._es_pack(coefs, want_type=want_type, meta={
            "x_var": time_var, "y_var": y_var,
            "cohort_var": cohort, "id_var": cfg["id_var"],
            "baseline": r.get("baseline", -1),
            "window": r.get("window", [-4, 4]),
            "design": "staggered",
            "method": "Sun & Abraham (2021) 队列交互加权事件研究",
            "n_cohorts": r.get("n_cohorts"), "nobs": r.get("nobs"),
            "control_group": r.get("control_group", "never"),
            "stata_code": r.get("stata_code"),
        })

    def _es_single(self, df, config, policy_time, id_var, want_type="event_study"):
        """单一政策时点：treat × 相对时点 交互，吸收个体与时间固定效应。

        没有 first_treat 这类变量时（最常见的就是一份普通面板加一个
        政策年份），这是画平行趋势的标准做法。基期取政策前一期
        （k = −1），它的系数被固定效应吸收，所以图上不出现。
        """
        import numpy as np
        import statsmodels.api as sm
        from linearmodels.panel import PanelOLS

        y_var, time_var, group_var = (config.get("y_var"), config.get("x_var"),
                                      config.get("group_var"))
        cfg, err = self._es_prepare(df, y_var, time_var, group_var, id_var,
                                    "（面板个体标识）")
        if err:
            return err

        try:
            p0 = float(policy_time)
        except (TypeError, ValueError):
            return {"error": f"政策实施时点无法解析为年份/数字：{policy_time}"}
        d = df[[y_var, time_var, group_var, cfg["id_var"]]].copy()
        d[time_var] = pd.to_numeric(d[time_var], errors="coerce")
        d[y_var] = pd.to_numeric(d[y_var], errors="coerce")
        d = d.dropna(subset=[y_var, time_var, group_var])
        if len(d) < 30:
            return {"error": "去缺失后可用的观测不足 30，无法估计"}

        vals = sorted(pd.unique(d[group_var]))
        if len(vals) != 2:
            return {"error": f"分组变量 {group_var} 有 {len(vals)} 个取值，"
                             "单一政策时点只支持二分组；多种子请提供处理时点变量"}
        s = pd.Series(vals)
        treat_val = 1.0 if 1.0 in list(s) else vals[-1]
        win = str(config.get("window") or "-4,4").replace("，", ",")
        try:
            wlo, whi = sorted(int(float(x)) for x in win.split(",")[:2])
        except Exception:
            wlo, whi = -4, 4

        d["__k__"] = d[time_var] - p0
        d["__D__"] = (d[group_var] == treat_val).astype(float)

        # 事件虚拟变量：只留窗口内、且不是基期 k = −1 的
        ks = [k for k in range(wlo, whi + 1) if k != -1]
        terms = {}
        for k in ks:
            terms["k%+d" % k] = ((d["__D__"] == 1) & (d["__k__"] == k)).astype(float).values
        X = pd.DataFrame(terms)
        # 至少要有事前一期和事后一期，否则谈不上「趋势」
        if not any(k < 0 for k in ks) or not any(k >= 0 for k in ks):
            return {"error": f"窗口 [{wlo}, {whi}] 里没有同时含政策前和取政策后的期数"}

        idx = pd.MultiIndex.from_arrays([d[cfg["id_var"]].astype(str).values,
                                         d[time_var].values])
        yv = pd.Series(d[y_var].values.astype(float), index=idx)
        Xv = X.set_index(idx)
        # 丢掉全为 0 的列（该相对期在处理组里没人）
        keep = [c for c in Xv.columns if Xv[c].abs().sum() > 0]
        if not keep:
            return {"error": "窗口内没有处理组观测，无法估计"}
        Xv = Xv[keep]

        try:
            res = PanelOLS(yv, Xv, entity_effects=True, time_effects=True).fit(
                cov_type="clustered", cluster_entity=True)
        except Exception as e:
            return {"error": f"事件研究回归失败：{type(e).__name__}: {e}"}

        coefs, se_all = [], np.asarray(res.std_errors, dtype=float)
        for i, c in enumerate(Xv.columns):
            k = int(c.replace("k", ""))
            b, se = float(res.params[c]), float(se_all[i])
            if not np.isfinite(se) or se <= 0:
                coefs.append((k, b, None, None, None, None))
                continue
            t = b / se
            from scipy import stats as _st
            p = float(2 * (1 - _st.t.cdf(abs(t), max(res.df_resid, 1))))
            coefs.append((k, b, se, b - 1.96 * se, b + 1.96 * se, p))

        return self._es_pack(coefs, {
            "x_var": time_var, "y_var": y_var,
            "cohort_var": None, "id_var": cfg["id_var"],
            "baseline": -1, "window": [wlo, whi],
            "design": "single",
            "policy_time": p0,
            "treat_value": str(treat_val),
            "method": "双向固定效应事件研究（单一政策时点）",
            "n_cohorts": 1, "nobs": int(res.nobs),
            "control_group": "另一分组",
            "stata_code": (f"reghdfe {y_var} {' '.join(Xv.columns)}, "
                           f"absorb({cfg['id_var']} {time_var}) "
                           f"vce(cluster {cfg['id_var']})"),
        })

    def _ds(self):
        from .data_service import data_service
        return data_service

    def _chart_dml(self, df, config):
        """DML 稳健性：组内去均值吸收固定效应后跑 DoubleML，学习器各跑一遍。

        返回的 payload 就是异质性系数图的形状（chart_type == 'coefplot'），
        前端直接复用同一个渲染器，不必再写一套。
        """
        from ._dml import build_dml
        return build_dml(config, self._ds())

    def _chart_heterogeneity(self, df, config):
        """异质性系数图：每个维度分高低两组各跑一次，系数与置信区间画在同一坐标轴上。

        Stata 的 coefplot 模板只画各组分别估计的结果；这里另外给出组间差异检验，
        并标注每组样本量——理由见 _heterogeneity 模块开头。
        """
        from ._heterogeneity import build_hetero
        return build_hetero(config, self._ds())

    def _chart_did(self, df, config):
        """保留旧入口以兼容外部脚本——等价于 _chart_parallel_trends 的「事前检验」段。"""
        cfg = dict(config or {})
        cfg.setdefault("window", "-3,1")
        return self._chart_parallel_trends(df, cfg).get("pre_test", {"error": "生成失败"})

    def _chart_event_study(self, df, config):
        """保留旧入口——等价于「动态效应」段。"""
        cfg = dict(config or {})
        cfg.setdefault("window", "-5,5")
        out = self._chart_parallel_trends(df, cfg)
        if "error" in out:
            return {"error": out.get("error", "生成失败")}
        return out.get("dynamic", {"error": "生成失败"})

    def _chart_parallel_trends(self, df, config):
        """一次跑两段：事前检验（窄窗口）+ 动态效应（宽窗口）。

        顶刊惯例：事前单独做 + 全期动态展示分别画。两次都用同一份配置和
        回归路径，差别只在 window。响应里同时给两份完整 payload，渲染
        上各占一段，中间用分割线隔开。AI 诊断只看事前那段，过没过来触发。

        window 字段支持两种格式：
        - 单个窗口 `-3,1` —— 两段都用这个（=传统事件研究图）
        - 两个窗口用 `;` 分隔 `-3,1;-5,5` —— 段 1 用前面，段 2 用后面
          （标准顶刊分工：段 1 事前检验 / 段 2 动态效应）
        """
        # 解析窗口：双窗口（前窄后宽）按 ; 分给两段；
        # 单窗口则两段共用同一个窗口——用户传 0,3 就是想要 0,3，
        # 不能像之前那样在 else 分支里悄悄换成默认值。
        raw_win = config.get("window") if config else None
        parts = [p.strip() for p in str(raw_win).split(";")] if raw_win else []
        parts = [p for p in parts if p]
        if len(parts) >= 2:
            pre_win, dyn_win = parts[0], parts[1]
        elif len(parts) == 1:
            pre_win = dyn_win = parts[0]
        else:
            pre_win, dyn_win = "-3,1", "-5,5"

        cfg_pre = dict(config or {})
        cfg_pre["window"] = pre_win   # 强制覆盖，不能 setdefault
        cfg_pre["id_var"] = config.get("id_var") if config else None
        cfg_pre["cohort_var"] = config.get("cohort_var") if config else None

        cfg_dyn = dict(config or {})
        cfg_dyn["window"] = dyn_win   # 强制覆盖
        cfg_dyn["id_var"] = config.get("id_var") if config else None
        cfg_dyn["cohort_var"] = config.get("cohort_var") if config else None

        pre = self._es_core(df, cfg_pre, "did")
        if "error" not in pre:
            pre["emphasis"] = "pre"
        dyn = self._es_core(df, cfg_dyn, "event_study")

        # 任一段失败就整体报错，UI 上不至于半截图、半截错位
        if "error" in pre:
            return {"error": pre["error"]}
        if "error" in dyn:
            return {"error": dyn["error"]}

        return {
            "chart_type": "parallel_trends",
            "pre_test": pre,
            "dynamic": dyn,
            "pre_window": cfg_pre["window"],
            "dynamic_window": cfg_dyn["window"],
            # 顶层也带一份 parallel_trend 给 AI 诊断沿用——取事前那段
            "parallel_trend": pre.get("parallel_trend"),
        }

    def _chart_event_study(self, df, config):
        """事件研究系数图（交错 DID / 多期 DID）。

        原先走 StatsPAI 的 sp.did()。那条路在真实面板上基本跑不通——
        实测报 "No valid (group, time) pairs to estimate"：它需要
        (group, time) 组合里有可估的 2x2，而 treat 一个 0/1 指示撑不起
        交错设计；而且即便跑通，拿到的也不是按事件期聚合的系数。

        改用本项目自己的 did_service.sunab：按队列分别估 ATT，再用队列规模
        交互加权，天然规避「已处理单位充当对照」，且直接给出每个事件期的
        95% 置信区间。它还会一并返回平行趋势检验结论。
        """
        from .did_service import did_service, find_cohort_var

        y_var = config.get("y_var")
        time_var = config.get("x_var")
        group_var = config.get("group_var")
        id_var = config.get("id_var")

        if not all([y_var, time_var, group_var]):
            return {"error": "事件研究需要 Y 轴、时间变量和分组变量"}
        missing = [v for v in (y_var, time_var, group_var) if v not in df.columns]
        if missing:
            return {"error": f"变量不存在：{', '.join(missing)}"}

        cfg = {
            "y": y_var, "core": [], "ctrl": [],
            "id_var": id_var if (id_var and id_var in df.columns) else None,
            "time_var": time_var,
            "cluster_vars": [], "se_type": "cluster",
            "weight_var": None, "absorb": [],
        }
        if cfg["id_var"]:
            cfg["cluster_vars"] = [cfg["id_var"]]

        # sunab 需要显式的个体标识。原来的启发式是「唯一值最多的列」，
        # 在本项目数据上会把证券代码 Stkcd 排在不同名的 FIN 后面，
        # 于是提示用户去选一个因变量当 ID。改成按常见命名优先。
        if not cfg["id_var"]:
            cands = _id_candidates(df, exclude=[y_var, time_var, group_var])
            return {"error": "请指定个体 ID 变量（面板个体标识）。"
                             + (f"可试试：{', '.join(cands[:4])}" if cands else "")}

        cohort = find_cohort_var(df, {"cohort_var": config.get("cohort_var")})
        if not cohort:
            # group_var 通常是个 0/1 处理指示，本身不含「哪一年开始受处理」。
            # 事件研究必须知道每单位的处理时点，只有一个指示变量不够。
            return {"error": "找不到处理时点变量（如 first_treat / first_year）。"
                             "事件研究要知道每个单位从哪一年开始受处理，"
                             "只有一个 0/1 处理指示不够"}

        win = str(config.get("window") or "-4,4").replace("，", ",")
        r = did_service.sunab(df, cfg, {"control_group": "never", "window": win},
                              self._identity_design)
        if "error" in r:
            return r

        events = [{
            "rel_time": e["period"],
            "term": "t%+d" % e["period"],
            "estimate": e["coef"], "std_error": e["std_err"],
            "ci_low": e["ci_low"], "ci_high": e["ci_high"],
            "p_value": e["p"], "stars": e.get("stars", ""),
        } for e in r.get("events", [])]
        if not events:
            return {"error": "没有可估的事件期系数（检查处理时点与面板跨度）"}

        pt = r.get("parallel_trend_test") or {}
        return {
            "chart_type": "event_study",
            "x_var": time_var, "y_var": y_var,
            "cohort_var": cohort, "id_var": cfg["id_var"],
            "baseline": r.get("baseline", -1),
            "window": r.get("window", [-4, 4]),
            "coefficients": sorted(events, key=lambda x: x["rel_time"]),
            "method": "Sun & Abraham (2021) 队列交互加权事件研究",
            "n_cohorts": r.get("n_cohorts"), "nobs": r.get("nobs"),
            "parallel_trend": pt,
            "att": r.get("att"),
            "stata_code": r.get("stata_code"),
        }

    @staticmethod
    def _identity_design(df, cfg, extra_terms=None, keep=()):
        """did_service 要求的 design 接口。

        sunab 只用 side 里的 cohort / time / id 三列和 y 本身，
        不构建设计矩阵，所以原样把 df 交回去即可。
        """
        return df[cfg["y"]], df.iloc[:, :0], df, {}

    def export_png(self, chart_type: str, config: dict, data_service) -> bytes:
        result = self.generate(chart_type, config, data_service)
        if "error" in result:
            raise ValueError(result["error"])

        fig, ax = plt.subplots(figsize=(10, 6))

        if chart_type == "line" or chart_type == "area":
            for s in result["series"]:
                ax.plot(s["x"], s["y"], marker="o", label=s["name"], linewidth=2)
            ax.legend()

        elif chart_type == "bar":
            ax.bar(result["labels"], result["values"], color="#6366f1")

        elif chart_type == "scatter":
            points = result["points"]
            ax.scatter([p["x"] for p in points], [p["y"] for p in points], alpha=0.6, color="#6366f1")
            ax.set_xlabel(result["x_var"])
            ax.set_ylabel(result["y_var"])

        elif chart_type == "histogram":
            ax.bar(range(len(result["values"])), result["values"], color="#6366f1")
            ax.set_xticks(range(len(result["labels"])))
            ax.set_xticklabels(result["labels"], rotation=45, fontsize=7)

        elif chart_type == "did":
            # 平行趋势：事前系数应围绕 0。用系数图而不是两组均值线。
            # 事前升序（d_5 … d_2）排在左，越早的在越左边，和 Stata 的
            # event_plot 一致；降序会把最靠近政策的一期顶到最左，横轴看起来
            # 像时间倒流。
            coefs = result.get("coefficients", [])
            pre = sorted([c for c in coefs if c["rel_time"] < 0],
                         key=lambda c: c["rel_time"])
            post = sorted([c for c in coefs if c["rel_time"] >= 0],
                          key=lambda c: c["rel_time"])
            ordered = pre + post
            xs = list(range(len(ordered)))
            ys = [c["estimate"] for c in ordered]
            lo = [c["estimate"] - c["ci_low"] for c in ordered]
            hi = [c["ci_high"] - c["estimate"] for c in ordered]
            # 事前用实心圆、事后空心，一眼看出检验看的是哪一段
            for i, c in enumerate(ordered):
                ax.errorbar([xs[i]], [ys[i]], yerr=[[lo[i]], [hi[i]]], fmt="none",
                            ecolor="#6366f1", elinewidth=1.5, capsize=4)
            ax.plot(xs, ys, "-", color="#6366f1", linewidth=2, zorder=1)
            pre_x = [x for x, c in zip(xs, ordered) if c["rel_time"] < 0]
            pre_y = [y for y, c in zip(ys, ordered) if c["rel_time"] < 0]
            post_x = [x for x, c in zip(xs, ordered) if c["rel_time"] >= 0]
            post_y = [y for y, c in zip(ys, ordered) if c["rel_time"] >= 0]
            ax.plot(pre_x, pre_y, "o", color="#6366f1", markersize=7, zorder=3)
            if post_x:
                ax.plot(post_x, post_y, "o", color="#6366f1", markersize=7,
                        markerfacecolor="white", zorder=3)
            ax.axhline(0, color="#94a3b8", linewidth=1)
            zero = [i for i, c in enumerate(ordered) if c["rel_time"] == 0]
            if zero:
                ax.axvline(zero[0], color="#94a3b8", linewidth=1)
            pt = result.get("parallel_trend") or {}
            ax.set_xticks(xs)
            ax.set_xticklabels([("current" if c["rel_time"] == 0
                                 else "d_%d" % abs(c["rel_time"])) for c in ordered],
                               fontsize=9)
            ax.set_xlabel("政策实施相对时间", fontsize=12)
            ax.set_ylabel("回归系数", fontsize=12)
            verdict = pt.get("verdict")
            ax.set_title("平行趋势检验（事前系数应围绕 0）" if verdict == "通过"
                         else "平行趋势检验（事前系数显著，假设存疑）", fontsize=14)
            ax.grid(True, alpha=0.3)

        elif chart_type == "event_study":
            # 事件研究：相对时点上的浮动误差须 + current 竖线
            # 事前同样升序，与 did 分支保持一致
            coefs = result.get("coefficients", [])
            pre = sorted([c for c in coefs if c["rel_time"] < 0],
                         key=lambda c: c["rel_time"])
            post = sorted([c for c in coefs if c["rel_time"] >= 0],
                          key=lambda c: c["rel_time"])
            ordered = pre + post
            labels = [("current" if c["rel_time"] == 0 else "d_%d" % abs(c["rel_time"]))
                      for c in ordered]
            xs = list(range(len(ordered)))
            ys = [c["estimate"] for c in ordered]
            lo = [c["estimate"] - c["ci_low"] for c in ordered]
            hi = [c["ci_high"] - c["estimate"] for c in ordered]
            ax.errorbar(xs, ys, yerr=[lo, hi], fmt="-o", color="#6366f1",
                        ecolor="#6366f1", elinewidth=1.5, capsize=4, markersize=6)
            ax.axhline(0, color="#94a3b8", linewidth=1)
            zero = [i for i, c in enumerate(ordered) if c["rel_time"] == 0]
            if zero:
                ax.axvline(zero[0], color="#94a3b8", linewidth=1)
            ax.set_xticks(xs)
            ax.set_xticklabels(labels, fontsize=9)
            ax.set_xlabel("政策实施相对时间", fontsize=12)
            ax.set_ylabel("回归系数", fontsize=12)
            ax.set_title("事件研究系数（95% 置信区间）", fontsize=14)
            ax.grid(True, alpha=0.3)

        elif chart_type == "heterogeneity":
            self._png_coefplot(fig, ax, result)

        else:
            ax.set_title(f"{chart_type.upper()} Chart", fontsize=14)
        ax.grid(True, alpha=0.3)
        fig.tight_layout()

        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=150)
        plt.close(fig)
        return buf.getvalue()


    @staticmethod
    def _png_coefplot(fig, ax, result):
        """heterogeneity 图的 PNG 版：每个被解释变量一栏，并排画。

        各栏共用同一套系数刻度——不共享的话读者会在两栏之间做出离谱的横向比较。
        """
        ycols = result.get("y_cols") or [None]
        per_y = {y: [r for r in (result.get("rows") or []) if r.get("y") == y]
                 for y in ycols}
        n_row = max((len(v) for v in per_y.values()), default=0)
        if not n_row:
            ax.set_title("没有可画的系数")
            return

        # 所有栏共用一个定义域
        lo, hi = float("inf"), float("-inf")
        for rs in per_y.values():
            for r in rs:
                if r.get("lo") is not None:
                    lo = min(lo, r["lo"])
                if r.get("hi") is not None:
                    hi = max(hi, r["hi"])
        if not (lo < hi):
            lo, hi = -1.0, 1.0
        pad = (hi - lo) * 0.08 or 0.1
        lo, hi = lo - pad, hi + pad
        if lo > 0:
            lo = -pad
        if hi < 0:
            hi = pad

        fig.clear()
        axes = fig.subplots(1, len(ycols), sharex=True, squeeze=False)[0]
        width = 5.0 * len(ycols)
        fig.set_size_inches(max(width, 8), max(4.2, 0.42 * n_row + 2.0))

        for k, (y, rs) in enumerate(per_y.items()):
            a = axes[k]
            if not rs:
                a.axis("off")
                continue
            xs, ys, xlo, xhi, kinds, ticks, labels = [], [], [], [], [], [], []
            for i, pname in enumerate([p["name"] for p in (result.get("panels") or [])]):
                prs = [r for r in rs if r["panel"] == pname]
                for r in prs:
                    xs.append(r["coef"])
                    xlo.append(r["coef"] - r["lo"] if r.get("lo") is not None else 0)
                    xhi.append(r["hi"] - r["coef"] if r.get("hi") is not None else 0)
                    ys.append(n_row - len(xs) + 0.5)
                    kinds.append(r.get("kind"))
                    ticks.append(n_row - len(xs) + 1)
                    labels.append("{}({:.4f}{}, N={})".format(
                        r["label"], r["coef"], r.get("stars") or "", r.get("n")))
                if i < len([p for p in (result.get("panels") or [])]) - 1:
                    a.axhline(n_row - len(xs) + 0.5, color="#e2e8f0",
                              linestyle="--", linewidth=1)
            a.errorbar(xs, ys, xerr=[xlo, xhi], fmt="none", ecolor="#94a3b8",
                       elinewidth=1.4, capsize=3, zorder=1)
            for x, yy, kind in zip(xs, ys, kinds):
                a.scatter([x], [yy], s=64, zorder=3,
                          color="#2563eb" if kind == "high" else "#b45309",
                          marker="o" if kind == "high" else "D",
                          edgecolors="white", linewidths=1)
            a.axvline(0, color="#a16207", linestyle="--", linewidth=1.2)
            a.set_yticks(ticks)
            a.set_yticklabels(labels, fontsize=8.5)
            a.set_ylim(0.2, n_row + 1.4)
            a.set_xlim(lo, hi)
            a.set_xlabel("系数估计值", fontsize=10)
            a.set_title(y or "", fontsize=11, fontweight="bold")
            a.grid(True, axis="x", alpha=0.3)
            # 维度（Panel）标题：贴在每栏右侧，坐标用数据单位，不是比例
            pos = 0
            for p in (result.get("panels") or []):
                n_in = len([r for r in rs if r["panel"] == p["name"]])
                if not n_in:
                    continue
                a.text(0.995, n_row - pos + 0.9, "Panel：" + p["name"],
                       transform=a.get_yaxis_transform(), ha="right", va="top",
                       fontsize=9, color="#475569")
                pos += n_in
        fig.suptitle(result.get("title") or "异质性系数比较图", fontsize=13, y=0.99)
        fig.tight_layout(rect=(0, 0, 1, 0.96))


graph_service = GraphService()
