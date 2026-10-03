"""数据自动分析 — 规则引擎：检测数据类型，推荐分析流程"""
import pandas as pd
import numpy as np


class ProfileService:

    def profile(self, data_service) -> dict:
        df = data_service.get_current()
        if df is None:
            return {"error": "未加载数据集"}

        info = {
            "rows": len(df),
            "cols": len(df.columns),
            "missing_total": int(df.isnull().sum().sum()),
            "missing_pct": round(df.isnull().sum().sum() / (len(df) * len(df.columns)) * 100, 2),
        }

        # 变量分类
        numeric_cols = list(df.select_dtypes(include="number").columns)
        cat_cols = [c for c in df.columns if c not in numeric_cols]

        var_info = []
        for col in df.columns:
            dtype = str(df[col].dtype)
            nunique = int(df[col].nunique())
            missing = int(df[col].isnull().sum())
            var_info.append({
                "name": col,
                "dtype": "numeric" if col in numeric_cols else "categorical",
                "nunique": nunique,
                "missing": missing,
            })

        info["numeric_cols"] = numeric_cols
        info["cat_cols"] = cat_cols
        info["variables"] = var_info

        # 检测数据结构
        structure = self._detect_structure(df, numeric_cols, cat_cols)
        info["structure"] = structure["type"]
        info["structure_detail"] = structure["detail"]

        # 推荐分析流程
        info["recommendations"] = self._recommend(df, structure, numeric_cols, cat_cols)

        # 推荐回归方案（供回归分析页一键套用）
        info["regression_recommend"] = self._recommend_regression(
            df, structure, numeric_cols, cat_cols)

        # 近似重名的变量名：FIN / Fin_na / Fin_na_robust 这种肉眼分不清的组合
        info["name_risks"] = self._detect_name_risks(df)

        # 交错采纳诊断：判定 TWFE 是否可解释
        info["staggered"] = self._detect_staggered(df, structure, numeric_cols, cat_cols)

        # 内置数据集信息
        info["available_datasets"] = [
            {"name": "card_1995", "desc": "Card (1995) 教育回报率 — NLSYM", "rows": 3010},
            {"name": "nsw_lalonde", "desc": "LaLonde NSW 实验数据", "rows": 722},
            {"name": "lee_2008_senate", "desc": "Lee (2008) 美国参议院 RD 数据", "rows": 6764},
            {"name": "california_prop99", "desc": "加州 Proposition 99 控烟政策", "rows": 38},
            {"name": "castle_doctrine", "desc": "城堡法则面板数据", "rows": 394},
            {"name": "mpdta", "desc": "Callaway-Sant'Anna DID 面板数据", "rows": 5540},
            {"name": "german_reunification", "desc": "德国统一合成控制数据", "rows": 160},
            {"name": "nhefs", "desc": "NHEFS 健康调查数据", "rows": 1629},
        ]

        return info

    def _detect_structure(self, df, numeric_cols, cat_cols) -> dict:
        # 检查是否有 id + time 变量（面板数据特征）
        id_pat = ("id", "county", "firm", "person", "state", "countyreal",
                  "stkcd", "code", "individual", "unit", "province", "city")
        id_candidates = [c for c in df.columns
                         if any(p in c.lower() for p in id_pat)]
        # 个体变量必须真正区分个体：唯一值不能太少
        id_candidates = [c for c in id_candidates if df[c].nunique() >= 5]
        time_candidates = [c for c in numeric_cols if c.lower() in ("year", "time", "date", "month", "quarter")
                           or "year" in c.lower() or "time" in c.lower()]

        if id_candidates and time_candidates:
            # 唯一值最多的更可能是真正的个体标识（如股票代码优于省份）
            id_col = max(id_candidates, key=lambda c: df[c].nunique())
            time_col = time_candidates[0]
            n_entities = df[id_col].nunique()
            n_periods = df[time_col].nunique()
            balanced = len(df) == n_entities * n_periods
            return {
                "type": "panel",
                "detail": {
                    "id_var": id_col,
                    "time_var": time_col,
                    "n_entities": int(n_entities),
                    "n_periods": int(n_periods),
                    "balanced": balanced,
                },
            }

        # 检查是否有连续时间变量（时间序列特征）
        for c in numeric_cols:
            vals = df[c].dropna().unique()
            if len(vals) > 10 and np.issubdtype(df[c].dtype, np.integer):
                if all(vals[i] <= vals[i+1] for i in range(len(vals)-1)):
                    return {
                        "type": "time_series",
                        "detail": {"time_var": c, "n_periods": len(vals)},
                    }

        # 默认为截面数据
        return {"type": "cross_section", "detail": {"n_vars": len(df.columns)}}

    def _recommend(self, df, structure, numeric_cols, cat_cols) -> list:
        recs = []
        stype = structure["type"]

        # 通用步骤
        recs.append({
            "step": 1,
            "action": "描述性统计",
            "command": "summarize",
            "desc": "查看各变量的均值、标准差、最值等基本统计量",
            "auto": True,
        })

        if len(numeric_cols) >= 2:
            recs.append({
                "step": 2,
                "action": "相关性分析",
                "command": "corr",
                "desc": "检查变量间的相关关系，初步判断多重共线性",
                "auto": True,
            })

        # 按数据类型推荐
        if stype == "panel":
            detail = structure["detail"]
            recs.append({
                "step": 3,
                "action": "设置面板结构",
                "command": f"xtset {detail['id_var']} {detail['time_var']}",
                "desc": f"声明面板变量: {detail['id_var']} (个体), {detail['time_var']} (时间), N={detail['n_entities']}, T={detail['n_periods']}",
                "auto": True,
            })
            recs.append({
                "step": 4,
                "action": "豪斯曼检验",
                "command": "hausman",
                "desc": "检验固定效应还是随机效应模型更合适",
                "auto": True,
            })
            recs.append({
                "step": 5,
                "action": "固定效应回归",
                "command": "xtreg, fe",
                "desc": "面板固定效应模型回归",
                "auto": True,
            })
            recs.append({
                "step": 6,
                "action": "聚类稳健标准误",
                "command": "xtreg, fe robust",
                "desc": "添加聚类稳健标准误，提高推断可靠性",
                "auto": True,
            })
            # 检测是否有处理组/对照组（DID 特征）
            treat_candidates = [c for c in cat_cols if "treat" in c.lower() or "post" in c.lower()
                                or "d" == c.lower() or "first_treat" in c.lower()]
            if treat_candidates:
                recs.append({
                    "step": 7,
                    "action": "DID / 事件研究分析",
                    "command": "did",
                    "desc": "检测到处理变量，可进行双重差分分析",
                    "auto": False,
                })

        elif stype == "cross_section":
            y_candidates = [c for c in numeric_cols if "wage" in c.lower() or "income" in c.lower()
                            or "lwage" in c.lower() or "log" in c.lower()]
            x_candidates = [c for c in numeric_cols if c not in y_candidates][:5]

            recs.append({
                "step": 3,
                "action": "OLS 回归",
                "command": "regress",
                "desc": f"截面数据线性回归分析",
                "auto": True,
            })

            # 检测是否有工具变量候选
            iv_candidates = [c for c in numeric_cols if any(k in c.lower() for k in ("nearc", "iv", "instrument", "exog"))]
            if iv_candidates:
                recs.append({
                    "step": 4,
                    "action": "工具变量回归 (IV/2SLS)",
                    "command": "ivregress",
                    "desc": f"检测到可能的工具变量: {', '.join(iv_candidates[:3])}",
                    "auto": False,
                })

            recs.append({
                "step": len(recs) + 1,
                "action": "异方差检验",
                "command": "estat hettest",
                "desc": "检验模型是否存在异方差问题",
                "auto": True,
            })

        elif stype == "time_series":
            recs.append({
                "step": 3,
                "action": "平稳性检验 (ADF)",
                "command": "dfuller",
                "desc": "检验时间序列的单位根/平稳性",
                "auto": True,
            })
            recs.append({
                "step": 4,
                "action": "自相关检验 (ACF/PACF)",
                "command": "ac / pac",
                "desc": "识别自相关阶数，为 ARIMA 建模做准备",
                "auto": True,
            })

        return recs

    # ═════════════════════════════════════════════════════════
    # 回归方案推荐（规则引擎）
    # ═════════════════════════════════════════════════════════

    def _name(self, c):
        return str(c).lower()

    def _looks_id(self, c):
        n = self._name(c)
        return any(k in n for k in ("stkcd", "code", "_id", "symbol", "listedcoid",
                                    "accper", "enddate", "listingdate"))

    def _looks_role(self, c, keys):
        n = self._name(c)
        return any(k in n for k in keys)

    # 不应进入模型的变量：时序/队列构造、标识、时间变量
    _EXCLUDE_PAT = ("first_year", "first_treat", "cohort", "relative_year", "treat_year",
                    "listing_year", "post_year", "year_", "_year", "id", "code", "symbol",
                    "accper", "enddate", "listingdate", "state", "name", "address")

    def _clean_candidates(self, df, numeric_cols, structure):
        """可直接进模型的连续变量候选：排除标识、时间、二值/分组、高缺失"""
        bad = {"treat", "post", "d", "g", "group", "manufacturing", "loss", "black", "south"}
        out = []
        for c in numeric_cols:
            if self._looks_id(c):
                continue
            s = pd.to_numeric(df[c], errors="coerce")
            nn = s.notna().sum()
            if nn < 30 or s.dropna().nunique() < 5:
                continue
            if s.dropna().nunique() <= 5 and set(np.unique(s.dropna().round())) <= {0, 1}:
                continue
            if self._name(c) in bad:
                continue
            # 队列/时序构造变量与 cohort 变量进模型会造成共线
            if any(p in self._name(c) for p in self._EXCLUDE_PAT):
                continue
            out.append(c)
        return out

    # ═════════════════════════════════════════════════════════
    # 交错采纳（staggered adoption）诊断
    # ═════════════════════════════════════════════════════════

    def _detect_name_risks(self, df) -> list:
        u"""找出肉眼分不清的近似变量名。

        用户在变量列表里选错一个字母，结论就会整个反过来，而系统不会提醒。
        三条判据，都能在名字上看出来：
          1. 忽略大小写与分隔符后完全相同 —— FIN 与 fin
          2. 只差一个已知后缀后缀 —— treat 与 treat_B
          3. 归一化后差 1~2 个字符 —— FIN 与 Fin_na（差 na）
        第 3 条是这份数据真正的坑：FIN 均值 -0.35、Fin_na 均值 0.24，
        两个完全不同的变量，名字看起来像一家的。
        """
        import re as _re

        def norm(s):
            return _re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", str(s).lower())

        cols = [str(c) for c in df.columns]
        suffix = _re.compile(r"_(robust|clean|raw|new|old|adj|std|ln|log|lag|lead)"
                             r"|_[abv]\d*$", _re.I)

        pairs = {}

        def add(a, b, kind, hint):
            key = tuple(sorted((a, b)))
            if key in pairs and pairs[key]["kind"] != kind:
                return
            pairs[key] = {"kind": kind, "names": list(key), "hint": hint}

        # 1 + 2：归一化同名、只差一个后缀
        buckets = {}
        for c in cols:
            buckets.setdefault(norm(c), []).append(c)
            stripped = suffix.sub("", str(c))
            if stripped and norm(stripped) != norm(c):
                buckets.setdefault(norm(stripped), []).append(c)
        for _, members in buckets.items():
            u = sorted(set(members))
            if len(u) < 2:
                continue
            same = len({norm(m) for m in u}) < len(u)
            for i in range(len(u)):
                for j in range(i + 1, len(u)):
                    if same:
                        add(u[i], u[j], u"\u5f52\u4e00\u5316\u540e\u540c\u540d",
                            u"\u5ffd\u7565\u5927\u5c0f\u5199\u548c\u5206\u9694\u7b26\u540e\u5b8c\u5168\u76f8\u540c\uff0c"
                            u"\u5728\u53d8\u91cf\u5217\u8868\u91cc\u770b\u8d77\u6765\u5c31\u662f\u4e00\u6837\u7684\u3002")
                    else:
                        add(u[i], u[j], u"\u53ea\u5dee\u4e00\u4e2a\u540e\u7f00",
                            u"\u53ea\u5dee\u4e00\u4e2a\u540e\u7f00\uff0c\u542b\u4e49\u4e0d\u540c\uff0c"
                            u"\u9009\u9519\u4f1a\u8ba9\u7ed3\u8bba\u53cd\u8fc7\u6765\u3002")

        # 3：归一化后差 1~2 个字符（FIN vs Fin_na 差 na）
        keys = sorted(set(norm(c) for c in cols), key=len)
        for i, short in enumerate(keys):
            if len(short) < 3:
                continue
            for long_ in keys[i + 1:]:
                if long_.startswith(short) and 1 <= len(long_) - len(short) <= 2:
                    a = [c for c in cols if norm(c) == short][0]
                    b = [c for c in cols if norm(c) == long_][0]
                    add(a, b, u"\u540d\u5b57\u4e00\u7ec4",
                        u"\u8fd9\u4e24\u4e2a\u540d\u5b57\u53ea\u5dee %d \u4e2a\u5b57\u7b26\uff0c"
                        u"\u4f46\u662f\u4e24\u4e2a\u4e0d\u540c\u7684\u53d8\u91cf\uff0c"
                        u"\u9009\u9519\u4f1a\u8ba9\u7ed3\u8bba\u6574\u4e2a\u53cd\u8fc7\u6765\u3002"
                        % (len(long_) - len(short)))

        risks = list(pairs.values())
        # 差得越多的越危险，排在前面
        risks.sort(key=lambda r: -max(len(n) for n in r["names"]))
        return risks

    def _detect_staggered(self, df, structure, numeric_cols, cat_cols):
        """若处理时点存在多个取值，TWFE 会把多个 2×2 加权平均成一个不可解释的数。

        判定 TWFE 是否可靠的三条：
          1. 处理时点队列数 ≥ 2（真正的交错采纳）
          2. 面板跨度内，晚处理单位的对照期会包含「已处理」的早处理单位
          3. 从未处理单位占比过低时，对照组只能由已处理单位充任
        """
        detail = structure.get("detail", {})
        if structure.get("type") != "panel":
            return {"is_staggered": False, "twfe_reliable": True,
                    "reason": "非面板数据，交错采纳诊断不适用"}

        id_var, time_var = detail.get("id_var"), detail.get("time_var")
        if not id_var or not time_var:
            return {"is_staggered": False, "twfe_reliable": True,
                    "reason": "未识别到个体/时间变量"}

        cohort_col = None
        for c in df.columns:
            n = self._name(c)
            if any(k in n for k in ("first_treat", "first_year", "cohort", "treat_year",
                                    "firstyear", "treattime")):
                if not any(k in n for k in ("count", "relative", "lines")):
                    cohort_col = c
                    break
        if cohort_col is None:
            # 退化：用 treat/post 交互能否在多期上构造处理时点
            inter = self._find(df, ("treat_post", "treatpost", "did"))
            return {"is_staggered": False, "twfe_reliable": True,
                    "reason": "未检测到处理时点变量，无法判定交错采纳",
                    "interaction_candidates": inter[:3]}

        c = pd.to_numeric(df[cohort_col], errors="coerce")
        t = pd.to_numeric(df[time_var], errors="coerce")
        if c.isna().all() or t.isna().all():
            return {"is_staggered": False, "twfe_reliable": True,
                    "reason": f"变量 {cohort_col} 无法解析为处理年份"}
        c = c.fillna(0)
        treated = c[c > 0]
        cohorts = sorted(int(v) for v in treated.unique())
        n_cohort = len(cohorts)
        never_share = float((c == 0).mean())
        t_min, t_max = int(t.min()), int(t.max())
        span = t_max - t_min + 1

        # 每个队列的企业数与起始期
        by_id = pd.DataFrame({"g": c.values, "t": t.values})
        sizes = by_id[by_id.g > 0].groupby("g")["t"].size().to_dict()
        cohort_table = [{"cohort": g, "n_obs": int(sizes.get(g, 0)),
                         "first_period": g, "periods_exposed": int(t_max - g + 1)}
                        for g in cohorts]
        small = [g for g in cohorts if sizes.get(g, 0) < 30]

        staggered = n_cohort >= 2
        # 早处理单位在晚处理单位的对照期内已经「已处理」→ forbidden comparison
        forbidden = bool(staggered and (t_max - min(cohorts)) >= 1 and n_cohort >= 2)
        # 从未处理单位不足以充当唯一干净对照组
        thin_never = never_share < 0.10

        reliable = not (staggered and (forbidden or thin_never))
        reasons = []
        if staggered:
            reasons.append(f"{cohort_col} 有 {n_cohort} 个处理队列（{cohorts[0]}–{cohorts[-1]}）"
                           f"，面板跨度 {span} 期")
            if forbidden:
                reasons.append("晚处理单位的对照期内包含已用处理的早处理单位，"
                               "TWFE 会把这些 2×2 按难以解释的权重平均，权重甚至可能为负")
            if thin_never:
                reasons.append(f"从未处理单位仅占 {never_share*100:.1f}%，"
                               "缺少干净的对照组，建议改用「尚未处理」作为对照")
            if small:
                reasons.append(f"队列 {small} 的样本量 < 30，加权结果对聚合方式敏感")
        else:
            reasons.append(f"仅 {n_cohort} 个处理队列，TWFE 可解释")

        return {
            "is_staggered": staggered,
            "twfe_reliable": reliable,
            "cohort_var": cohort_col,
            "n_cohorts": n_cohort,
            "cohorts": cohorts,
            "cohort_table": cohort_table,
            "never_treated_share": round(never_share, 4),
            "small_cohorts": small,
            "panel_span": span,
            "id_var": id_var, "time_var": time_var,
            "reason": "；".join(reasons),
            "recommended_methods": (
                ["csdid", "sunab", "bacon"] if not reliable else ["did"]
            ),
        }

    def _recommend_y(self, df, cands, structure):
        """挑因变量：优先非政策/非标识、方差大的连续变量"""
        if not cands:
            return None
        scored = []
        for c in cands:
            n = self._name(c)
            pen = 0
            if any(k in n for k in ("treat", "post", "first", "relative", "count")):
                pen += 100
            if any(k in n for k in ("uhv", "hv", "policy", "lines")):
                pen += 100
            if any(k in n for k in ("year", "age")):
                pen += 40
            if any(k in n for k in ("na", "robust")):
                pen += 30
            s = pd.to_numeric(df[c], errors="coerce")
            score = -pen + min(float(s.std() / (abs(float(s.mean())) + 1e-9)), 2.0)
            scored.append((score, c))
        scored.sort(key=lambda x: -x[0])
        return scored[0][1]

    def _find(self, df, keys, numeric_only=True, limit=None):
        hits = []
        for c in df.columns:
            if numeric_only and not pd.api.types.is_numeric_dtype(df[c]):
                continue
            if self._looks_role(c, keys):
                hits.append(c)
        return hits[:limit] if limit else hits

    def _recommend_cluster(self, df, id_var, numeric_cols, cat_cols):
        """聚类层级：优先比个体高一层的行政/行业分组（必须是分组变量）"""
        def is_group_col(c):
            """分组变量：唯一值个数适中，且不是连续型指标"""
            n = df[c].nunique()
            if n < 2 or n > 500:
                return False
            if self._looks_id(c) or c == id_var:
                return False
            # 连续指标（人均 GDP、人口等）不宜作为聚类维度
            if any(k in self._name(c) for k in ("pgdp", "gdp", "pop", "ind", "value",
                                                "amount", "ratio", "rate")):
                return False
            return True

        for keys in (("province",), ("city",), ("state", "region"), ("county",),
                     ("industry",), ("countyreal",)):
            hits = [c for c in df.columns if self._looks_role(c, keys) and is_group_col(c)]
            if hits:
                return max(hits, key=lambda c: -df[c].nunique())
        for keys in (("firm", "company"), ("stock",), ("id",)):
            hits = [c for c in df.columns if self._looks_role(c, keys) and is_group_col(c)]
            hits = [h for h in hits if h != id_var]
            if hits:
                return max(hits, key=lambda c: -df[c].nunique())
        return id_var

    def _recommend_regression(self, df, structure, numeric_cols, cat_cols):
        stype = structure["type"]
        detail = structure.get("detail", {})
        id_var, time_var = detail.get("id_var"), detail.get("time_var")

        cands = self._clean_candidates(df, numeric_cols, structure)
        y = self._recommend_y(df, cands, structure)
        if not y:
            return {"available": False, "reason": "未找到适合作为因变量的连续变量"}

        cluster = self._recommend_cluster(df, id_var, numeric_cols, cat_cols)
        cluster2 = (time_var if cluster and time_var and cluster != time_var else None)

        used = {y}
        if id_var:
            used.add(id_var)
        if time_var:
            used.add(time_var)

        # ── 识别信号 ──
        did_interacts = self._find(df, ("treat_post", "treatpost", "treat×post", "did"))
        treat_vars = self._find(df, ("treat_b", "treat_a", "treat"))
        post_vars = self._find(df, ("post_b", "post_a", "post"))
        cohort_vars = self._find(df, ("first_treat", "first_year", "cohort", "firstyear"))
        # 排除计数型/相对期变量，它们不是处理时点
        cohort_vars = [c for c in cohort_vars
                       if not any(k in self._name(c) for k in ("count", "relative", "n_"))]
        instrument_vars = self._find(df, ("nearc", "iv", "instrument", "nearcol"))
        binary_treat = None
        for c in treat_vars + did_interacts:
            if self._name(c).endswith(("_b", "_a")):
                binary_treat = c
                break

        # 政策强度/核心解释变量
        core = []
        for cand in ([binary_treat] if binary_treat else []) + treat_vars + did_interacts:
            if cand and cand != y and cand not in core:
                core.append(cand)

        # ── 分支 1: 面板 + DID ──
        if stype == "panel" and (did_interacts or (treat_vars and post_vars)):
            did_var = did_interacts[0] if did_interacts else None
            core = [did_var] if did_var else []
            if not core and treat_vars and post_vars:
                core = []
            params = {"treat_var": treat_vars[0] if treat_vars else None,
                      "post_var": post_vars[0] if post_vars else None,
                      "did_var": did_var}
            cluster_vars = [cluster] + ([cluster2] if cluster2 else [])
            return {
                "available": True,
                "method": "did",
                "method_label": "双重差分回归 (DID / TWFE)",
                "method_label_short": "DID",
                "y_var": y, "core_x": core,
                "controls": [c for c in cands if c not in used and c not in core][:24],
                "cluster_vars": cluster_vars, "cluster_label": " + ".join(cluster_vars),
                "id_var": id_var, "time_var": time_var, "absorb": [],
                "se_type": "cluster",
                "params": params,
                "cohort_var": did_var,
                "confidence": "high",
                "reasons": [
                    f"检测到面板数据（{id_var} × {time_var}），"
                    f"共 {detail.get('n_entities')} 个个体 × {detail.get('n_periods')} 期",
                    f"存在处理变量 {params['treat_var'] or '—'} 与政策后变量 "
                    f"{params['post_var'] or '—'}" +
                    (f"，且有交互项 {did_var}" if did_var else ""),
                    f"DID 可同时吸收个体与时间固定效应，识别政策净效应",
                    f"标准误按 {' + '.join(cluster_vars)} 聚类，避免组内相关问题",
                ],
                "alternatives": [
                    {"method": "event_study", "label": "事件研究法",
                     "reason": "用处理时点变量做平行趋势检验与动态效应分解",
                     "params": {"cohort_var": (cohort_vars[0] if cohort_vars else None),
                                "window": "-4,4"}},
                    {"method": "twoway_fe", "label": "双向固定效应",
                     "reason": "若不想做因果解释，可直接看面板固定效应结果"},
                ],
                "cohort_vars": cohort_vars,
            }

        # ── 分支 2: 截面 + 工具变量 ──
        if stype != "panel" and instrument_vars:
            core = [self._best_corr(df, cands, y, used)]
            return {
                "available": True, "method": "iv2sls",
                "method_label": "工具变量回归 (IV/2SLS)", "method_label_short": "IV/2SLS",
                "y_var": y, "core_x": [c for c in core if c],
                "controls": [c for c in cands if c not in used and c not in core][:24],
                "cluster_vars": [cluster], "cluster_label": cluster,
                "id_var": id_var, "time_var": time_var, "absorb": [],
                "se_type": "cluster",
                "params": {"instruments": instrument_vars[:3]},
                "confidence": "medium",
                "reasons": [f"检测到疑似工具变量: {', '.join(instrument_vars[:3])}",
                            "若核心解释变量存在内生性，IV/2SLS 可给出一致估计"],
                "alternatives": [{"method": "ols", "label": "OLS",
                                  "reason": "先看普通最小二乘的基线结果"}],
            }

        # ── 分支 3: 面板固定效应 ──
        if stype == "panel":
            core = [self._best_corr(df, cands, y, used)]
            cluster_vars = [cluster] + ([cluster2] if cluster2 else [])
            return {
                "available": True, "method": "twoway_fe",
                "method_label": "双向固定效应回归", "method_label_short": "双固定效应",
                "y_var": y, "core_x": [c for c in core if c],
                "controls": [c for c in cands if c not in used and c not in core][:24],
                "cluster_vars": cluster_vars, "cluster_label": " + ".join(cluster_vars),
                "id_var": id_var, "time_var": time_var, "absorb": [],
                "se_type": "cluster", "params": {}, "confidence": "high",
                "reasons": [f"检测到面板数据，{id_var} 与 {time_var} 可作为双向固定效应",
                            "双固定效应可同时控制个体异质性与共同时间冲击",
                            f"标准误按 {' + '.join(cluster_vars)} 聚类"],
                "alternatives": [
                    {"method": "fe", "label": "个体固定效应", "reason": "仅控制个体效应"},
                    {"method": "re", "label": "随机效应", "reason": "需豪斯曼检验甄别"},
                ],
            }

        # ── 分支 4: 截面，二元因变量 ──
        yvals = pd.to_numeric(df[y], errors="coerce").dropna().unique()
        if len(yvals) <= 2 and set(np.unique(np.round(yvals))) <= {0, 1}:
            return {
                "available": True, "method": "logit",
                "method_label": "二元 Logit 回归", "method_label_short": "Logit",
                "y_var": y, "core_x": [self._best_corr(df, cands, y, used)],
                "controls": [c for c in cands if c not in used][:24],
                "cluster_vars": [cluster] if cluster else [], "cluster_label": cluster,
                "id_var": None, "time_var": time_var, "absorb": [],
                "se_type": "cluster", "params": {}, "confidence": "high",
                "reasons": [f"{y} 为 0/1 变量，线性概率模型有偏",
                            "Logit/Probit 可将预测概率约束在 (0,1) 内"],
                "alternatives": [{"method": "probit", "label": "Probit",
                                  "reason": "正态潜变量假设"},
                                 {"method": "ols", "label": "OLS", "reason": "看基线对比"}],
            }

        # ── 分支 5: 截面 + 连续驱动变量（疑似 RD） ──
        rd_cands = [c for c in cands if self._looks_role(c, ("score", "margin", "running",
                                                             "rating", "distance", "index"))]
        if rd_cands:
            core = [self._best_corr(df, cands, y, used)]
            return {
                "available": True, "method": "rd",
                "method_label": "断点回归 (RD)", "method_label_short": "RD",
                "y_var": y, "core_x": [c for c in core if c],
                "controls": [], "cluster_vars": [cluster] if cluster else [],
                "cluster_label": cluster, "id_var": None, "time_var": time_var, "absorb": [],
                "se_type": "cluster",
                "params": {"running_var": rd_cands[0], "cutoff": 0,
                           "kernel": "三角", "poly_order": "1"},
                "confidence": "medium",
                "reasons": [f"检测到疑似驱动变量 {rd_cands[0]}",
                            "若存在明确断点（录取线/资格线），断点回归可做局部因果识别"],
                "alternatives": [{"method": "ols", "label": "OLS", "reason": "基线回归"}],
            }

        # ── 分支 6: 普通 OLS ──
        core = [self._best_corr(df, cands, y, used)]
        return {
            "available": True, "method": "ols",
            "method_label": "最小二乘回归 (OLS)", "method_label_short": "OLS",
            "y_var": y, "core_x": [c for c in core if c],
            "controls": [c for c in cands if c not in used and c not in core][:24],
            "cluster_vars": [cluster] if cluster else [], "cluster_label": cluster,
            "id_var": None, "time_var": time_var, "absorb": [],
            "se_type": "cluster", "params": {}, "confidence": "high",
            "reasons": ["截面数据，OLS 是标准基线",
                        f"核心解释变量按与 {y} 的相关性强度挑选"],
            "alternatives": [{"method": "logit", "label": "Logit"},
                            {"method": "quantile", "label": "分位数回归"}],
        }

    def _best_corr(self, df, cands, y, used):
        best, best_abs = None, -1
        yv = pd.to_numeric(df[y], errors="coerce")
        for c in cands:
            if c in used or c == y:
                continue
            cv = pd.to_numeric(df[c], errors="coerce")
            m = yv.notna() & cv.notna()
            if m.sum() < 30:
                continue
            r = abs(float(np.corrcoef(yv[m].values.astype(float),
                                      cv[m].values.astype(float))[0, 1]))
            if r > best_abs:
                best, best_abs = c, r
        return best or (cands[0] if cands else None)


profile_service = ProfileService()
