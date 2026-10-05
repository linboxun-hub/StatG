"""回归分析服务 — OLS / 面板 / 因果推断 / 非线性模型

统一输出 Stata 风格回归表，支持单聚类与双聚类稳健标准误。
METHOD_CATALOG / PARAM_SPECS 是方法目录，前端据此动态渲染参数项。
"""
import math
import time
import warnings

import numpy as np
import pandas as pd
import scipy.stats as stats

warnings.filterwarnings("ignore")

from .reg_utils import (_f, _i, _stars, _t_pvalue, _meat, cluster_cov, _add_const,
                         _num_hess_inv, _hc1_cov)
from .did_service import STAGGERED_METHODS


# ═════════════════════════════════════════════════════════════
# 工具函数
# ═════════════════════════════════════════════════════════════

def _f(v, nd=4):
    """转 JSON 安全的 float；NaN/Inf → None"""
    try:
        v = float(v)
    except Exception:
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    return round(v, nd)


def _i(v):
    try:
        return int(v)
    except Exception:
        return None


def _disp_name(raw, labels=None):
    """内部列名 → 显示名。

    extra_terms 构造出来的列叫 __did__ / __evt-3__，给人看的名字在 labels 里。
    不翻译的话，表里会露出内部名，而且同一概念在两列回归之间对不到一行——
    多模型对照表（_esttab）就是按这个名字对齐的。
    """
    nm = (labels or {}).get(raw, raw)
    return "_cons" if nm in ("const", "Const") else nm


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


def _t_pvalue(t, df):
    if t is None or df is None or df <= 0:
        return None
    return float(2 * (1 - stats.t.cdf(abs(t), df)))


def _meat(X, resid, groups):
    """单维度聚类 meat + 调整因子，返回 (协方差矩阵, 组数)"""
    Xv = np.asarray(X, dtype=float)
    r = np.asarray(resid, dtype=float)
    n, k = Xv.shape
    A = np.linalg.pinv(Xv.T @ Xv)
    sc = Xv * r[:, None]
    codes = pd.factorize(np.asarray(groups))[0]
    G = int(pd.Series(codes).nunique())
    M = np.zeros((k, k))
    order = np.argsort(codes, kind="stable")
    for chunk in np.split(order, np.flatnonzero(np.diff(codes[order])) + 1):
        s = sc[chunk].sum(axis=0)
        M += np.outer(s, s)
    return A @ M @ A * (G / max(G - 1, 1)) * ((n - 1) / max(n - k, 1)), G


def cluster_cov(X, resid, groups):
    """groups: 1~2 个分组序列。双聚类用 Cameron–Gelbach–Miller: V1+V2−V12"""
    Xv = np.asarray(X, dtype=float)
    r = np.asarray(resid, dtype=float)
    n, k = Xv.shape
    if not groups:
        s2 = float(r @ r) / max(n - k, 1)
        return s2 * np.linalg.pinv(Xv.T @ Xv)
    if len(groups) == 1:
        return _meat(Xv, r, groups[0])[0]
    V1, _ = _meat(Xv, r, groups[0])
    V2, _ = _meat(Xv, r, groups[1])
    inter = pd.Series(list(zip(pd.factorize(np.asarray(groups[0]))[0],
                               pd.factorize(np.asarray(groups[1]))[0])))
    inter = inter.astype("category").cat.codes.values
    V12, _ = _meat(Xv, r, inter)
    return V1 + V2 - V12


def _hc1_cov(X, resid):
    """HC1 异方差稳健协方差（对 QMLE 类模型通用）"""
    Xv = np.asarray(X, dtype=float)
    r = np.asarray(resid, dtype=float)
    n, k = Xv.shape
    XtX = Xv.T @ Xv
    meat = (Xv * r[:, None]).T @ (Xv * r[:, None])
    return np.linalg.pinv(XtX) @ meat @ np.linalg.pinv(XtX) * (n / max(n - k, 1))


def _add_const(df):
    d = df.copy()
    if "const" not in d.columns:
        d.insert(0, "const", 1.0)
    return d


def _num_hess_inv(f, x, eps=None):
    """数值黑塞矩阵的逆（广义逆兜底），用于 MLE 渐近协方差"""
    x = np.asarray(x, dtype=float)
    k = len(x)
    if eps is None:
        eps = np.maximum(1e-5 * np.maximum(np.abs(x), 1.0), 1e-6)
    H = np.zeros((k, k))
    f0 = f(x)
    for i in range(k):
        ei = np.zeros(k); ei[i] = eps[i]
        for j in range(i, k):
            ej = np.zeros(k); ej[j] = eps[j]
            if i == j:
                H[i, i] = (f(x + ei) - 2 * f0 + f(x - ei)) / (eps[i] ** 2)
            else:
                H[i, j] = H[j, i] = (
                    f(x + ei + ej) - f(x + ei - ej) - f(x - ei + ej) + f(x - ei - ej)
                ) / (4 * eps[i] * eps[j])
    return np.linalg.pinv(H)


# ═════════════════════════════════════════════════════════════
# 方法目录
# ═════════════════════════════════════════════════════════════

METHOD_CATALOG = [
    {
        "group": "基础回归",
        "stage": ["baseline"],
        "hint": "适用于横截面/混合数据，是最常用的基线模型",
        "methods": [
            {"key": "ols", "label": "最小二乘回归 (OLS)", "icon": "📈",
             "desc": "经典多元线性回归，支持交互项"},
            {"key": "wls", "label": "加权最小二乘 (WLS)", "icon": "⚖️",
             "desc": "用于缓解异方差，需指定权重变量"},
        ],
    },
    {
        "group": "面板回归",
        "stage": ["baseline"],
        "hint": "需先指定个体变量与时间变量",
        "methods": [
            {"key": "fe", "label": "个体固定效应 (FE)", "icon": "📉",
             "desc": "控制不随时间变化的个体异质性"},
            {"key": "te", "label": "时间固定效应 (TE)", "icon": "🕐",
             "desc": "控制所有个体共同的时间冲击"},
            {"key": "twoway_fe", "label": "双向固定效应", "icon": "📊",
             "desc": "个体+时间双固定效应，当前实证主流设定"},
            {"key": "re", "label": "随机效应 (RE)", "icon": "🎲",
             "desc": "GLS 估计，需豪斯曼检验甄别"},
            {"key": "fd", "label": "一阶差分 (FD)", "icon": "➖",
             "desc": "差分掉个体固定效应"},
            {"key": "between", "label": "组间估计量 (Between)", "icon": "🔁",
             "desc": "仅用组间信息，较少使用"},
            {"key": "gmm", "label": "差分 GMM (动态面板)", "icon": "⚙️",
             "desc": "被解释变量含滞后项时使用"},
        ],
    },
    {
        "group": "因果推断",
        "stage": ["baseline"],
        "hint": "用于识别政策效应；DID/IV/PSM/SCM 既作主识别，也可搬到稳健性里",
        "methods": [
            {"key": "did", "label": "双重差分 (DID)", "icon": "⚖️",
             "desc": "支持单期/多期，输出 ATT"},
            {"key": "event_study", "label": "事件研究法", "icon": "📉",
             "desc": "平行趋势检验 + 动态效应"},
            {"key": "iv2sls", "label": "工具变量 (IV/2SLS)", "icon": "🔌",
             "desc": "处理内生性，需指定工具变量"},
            {"key": "rd", "label": "断点回归 (RD)", "icon": "📌",
             "desc": "Sharp RD，局部线性 + 核加权"},
            {"key": "rd_fuzzy", "label": "模糊断点 (Fuzzy RD)", "icon": "🌀",
             "desc": "断点两侧处理概率发生跳跃"},
            {"key": "psm", "label": "倾向得分匹配 (PSM)", "icon": "🎯",
             "desc": "截面自选择问题的经典处理"},
            {"key": "scm", "label": "合成控制法 (SCM)", "icon": "🧬",
             "desc": "单一处理单位 + 多对照单位"},
        ],
    },
    {
        "group": "交错采纳 DID",
        "stage": ["robust"],
        "hint": "处理时点在不同单位间不一致时使用；此情形下 TWFE 的权重不可解释",
        "methods": [
            {"key": "csdid", "label": "Callaway–Sant'Anna (group-time ATT)", "icon": "🎯",
             "desc": "先估每个 (队列, 时期) 的 ATT，再按选定方式聚合；交错采纳的标准做法"},
            {"key": "sunab", "label": "Sun–Abraham 事件研究", "icon": "🧮",
             "desc": "分队列估计后交互加权，输出干净的事件研究动态路径"},
            {"key": "did2s", "label": "Gardner 两阶段 (did2s)", "icon": "🔧",
             "desc": "第一阶段吸收固定效应，第二阶段回归处理指示变量"},
            {"key": "bacon", "label": "Goodman–Bacon 分解 (诊断)", "icon": "🔍",
             "desc": "把 TWFE 系数拆成 2×2 加权和，量化 forbidden comparison 占比"},
        ],
    },
    {
        "group": "非线性与稳健性",
        "stage": ["robust"],
        "hint": "换模型形式或估计量，验证基准结论稳健与否（因变量非线性时也可作主模型）",
        "methods": [
            {"key": "logit", "label": "二元 Logit", "icon": "🔵", "desc": "0/1 因变量"},
            {"key": "probit", "label": "二元 Probit", "icon": "🔷", "desc": "0/1 因变量，正态假设"},
            {"key": "poisson", "label": "泊松回归", "icon": "🔢", "desc": "计数型因变量"},
            {"key": "tobit", "label": "Tobit 截断回归", "icon": "✂️", "desc": "因变量归并/截断"},
            {"key": "heckman", "label": "Heckman 两步法", "icon": "🚪", "desc": "样本自选择偏误"},
            {"key": "quantile", "label": "分位数回归", "icon": "📶", "desc": "分布不同位置的影响"},
        ],
    },
    {
        "group": "机制与调节",
        "stage": ["mechanism"],
        "hint": "门槛回归检验非线性机制；交互项（X×M）直接在基准回归里加乘积项；中介效应用 AI 助手的 sgmediation / medeff（bootstrap）跑",
        "methods": [
            {"key": "threshold", "label": "门槛回归 (Hansen)", "icon": "🚧",
             "desc": "存在门槛效应的非线性面板"},
        ],
    },
]

PARAM_SPECS = {
    "wls": [{"name": "weight_var", "label": "权重变量", "type": "var",
             "hint": "常用频率权重或 1/方差"}],
    "iv2sls": [{"name": "instruments", "label": "工具变量", "type": "vars",
                "hint": "「核心解释变量」中的是内生变量，这里填外生工具变量"}],
    "did": [
        {"name": "treat_var", "label": "处理组变量 (Treat)", "type": "var"},
        {"name": "post_var", "label": "政策后变量 (Post)", "type": "var"},
        {"name": "did_var", "label": "交互项变量", "type": "var",
         "hint": "数据中已有 Treat×Post 就直接选它"},
    ],
    "event_study": [
        {"name": "cohort_var", "label": "处理时点变量", "type": "var",
         "hint": "如 first_treat，0/缺失表示从未处理"},
        {"name": "window", "label": "相对期窗口", "type": "text", "default": "-4,4",
         "hint": "如 -4,4 表示 -4 至 +4 期，超出折叠到端点"},
    ],
    "rd": [
        {"name": "running_var", "label": "驱动变量 (Running Var)", "type": "var"},
        {"name": "cutoff", "label": "断点 (Cutoff)", "type": "number", "default": 0},
        {"name": "bandwidth", "label": "带宽 h", "type": "number", "placeholder": "留空自动选择"},
        {"name": "kernel", "label": "核函数", "type": "select",
         "options": ["三角", "Epanechnikov", "均匀", "高斯"], "default": "三角"},
        {"name": "poly_order", "label": "多项式阶数", "type": "select",
         "options": ["1", "2", "3"], "default": "1"},
    ],
    "rd_fuzzy": [
        {"name": "running_var", "label": "驱动变量 (Running Var)", "type": "var"},
        {"name": "cutoff", "label": "断点 (Cutoff)", "type": "number", "default": 0},
        {"name": "bandwidth", "label": "带宽 h", "type": "number", "placeholder": "留空自动选择"},
        {"name": "treatment_var", "label": "实际处理变量", "type": "var"},
    ],
    "psm": [
        {"name": "treat_var", "label": "处理变量 (0/1)", "type": "var"},
        {"name": "match_method", "label": "匹配方法", "type": "select",
         "options": ["近邻 k=1", "近邻 k=3", "近邻 k=5", "卡尺内匹配", "核匹配"],
         "default": "近邻 k=1"},
        {"name": "caliper", "label": "卡尺宽度", "type": "number", "default": 0.2,
         "hint": "倾向得分标准差的倍数"},
    ],
    "scm": [
        {"name": "treat_var", "label": "处理分组变量", "type": "var"},
        {"name": "treated_unit", "label": "被处理单位", "type": "text",
         "hint": "个体变量的取值，如省市名/股票代码"},
        {"name": "pre_end", "label": "政策前最后一个时期", "type": "number"},
    ],
    "csdid": [
        {"name": "cohort_var", "label": "处理时点变量 (gvar)", "type": "var",
         "hint": "如 first_year，0 或缺失表示从未处理"},
        {"name": "control_group", "label": "对照组", "type": "select",
         "options": ["尚未处理 (notyet)", "从未处理 (never)"], "default": "尚未处理 (notyet)",
         "hint": "notyet 样本更多但可能违反平行趋势；never 更干净但要求有从未处理单位"},
        {"name": "aggregation", "label": "聚合方式", "type": "select",
         "options": ["样本加权", "等权平均", "按队列", "动态效应"], "default": "样本加权",
         "hint": "不同聚合方式对应不同的目标参数，结果不可互换"},
        {"name": "est_method", "label": "估计方法", "type": "select",
         "options": ["回归调整 (reg)", "倾向得分 (ipw)", "半参数 (dr)"], "default": "回归调整 (reg)"},
        {"name": "min_cohort_n", "label": "最小队列规模", "type": "number", "default": 5,
         "hint": "剔除企业数少于此值的队列，避免小样本主导结果"},
        {"name": "window", "label": "事件期窗口", "type": "text", "placeholder": "留空 = 全部",
         "hint": "如 -3,5 只保留相对期 −3 至 5"},
    ],
    "sunab": [
        {"name": "cohort_var", "label": "处理时点变量 (gvar)", "type": "var"},
        {"name": "control_group", "label": "对照组", "type": "select",
         "options": ["从未处理 (never)", "尚未处理 (notyet)"], "default": "从未处理 (never)"},
        {"name": "window", "label": "相对期窗口", "type": "text", "default": "-4,4",
         "hint": "如 -4,4 表示 −4 至 +4 期，超出折叠到端点"},
        {"name": "min_cohort_n", "label": "最小队列规模", "type": "number", "default": 5},
    ],
    "bacon": [
        {"name": "cohort_var", "label": "处理时点变量", "type": "var"},
    ],
    "did2s": [
        {"name": "cohort_var", "label": "处理时点变量", "type": "var"},
    ],
    "gmm": [{"name": "lag_iv", "label": "工具变量滞后阶数", "type": "select",
             "options": ["2", "3", "4"], "default": "2"}],
    "quantile": [{"name": "tau", "label": "分位点 τ", "type": "number", "default": 0.5}],
    "tobit": [
        {"name": "left_censor", "label": "左截断点", "type": "number", "default": 0},
        {"name": "right_censor", "label": "右截断点", "type": "number",
         "placeholder": "留空表示右侧不截断"},
    ],
    "heckman": [{"name": "selection_var", "label": "选择方程因变量 (0/1)", "type": "var",
                 "hint": "1 = 进入样本，0 = 被选择掉"}],
    "threshold": [
        {"name": "threshold_var", "label": "门槛变量", "type": "var"},
        {"name": "trim_pct", "label": "两端剔除比例 %", "type": "number", "default": 10},
        {"name": "n_boot", "label": "自举次数", "type": "number", "default": 200},
    ],
}

PANEL_METHODS = {"fe", "te", "twoway_fe", "re", "fd", "between", "gmm", "threshold", "scm",
                 "did", "event_study"}
SE_LABELS = {"cluster": "聚类稳健", "robust": "异方差稳健 (HC1)", "classical": "普通标准误"}


# ═════════════════════════════════════════════════════════════
# 服务主体
# ═════════════════════════════════════════════════════════════

class RegressionService:

    # ── 目录 ──

    def list_methods(self):
        return {"catalog": METHOD_CATALOG, "param_specs": PARAM_SPECS,
                "panel_methods": sorted(PANEL_METHODS), "se_labels": SE_LABELS}

    # ── 入口 ──

    def run(self, method: str, config: dict, data_service, sample=None) -> dict:
        df = data_service.get_current()
        if df is None:
            return {"error": "未加载数据集"}
        # sample: 布尔掩码，用于分组回归（异质性分析看高低两组时各跑一次）。
        # 在这里切，比让每个 _m_* 处理器各自支持一个 if 条件可靠得多。
        if sample is not None:
            try:
                m = np.asarray(sample, dtype=bool)
                if m.shape[0] == len(df):
                    df = df[m].reset_index(drop=True)
            except Exception:
                pass
        handler = getattr(self, "_m_" + method, None)
        if handler:
            try:
                out = handler(df, config)
                if isinstance(out, dict) and "error" not in out:
                    # 丢变量这件事在 run() 这层算，不让每个 _m_* 都记得往外传——
                    # 三十个 handler 漏一个是必然的，而漏一个就是一次静默少算。
                    w = self._var_warnings(df, config)
                    if w:
                        out["warnings"] = w
                return out
            except Exception as e:
                return {"error": f"{type(e).__name__}: {e}"}
        if method in STAGGERED_METHODS:
            from .did_service import did_service
            try:
                cfg = self._cfg(df, config, allow_empty_core=True)
                return did_service.run(method, df, cfg, config, self._design)
            except Exception as e:
                return {"error": f"{type(e).__name__}: {e}"}
        return {"error": f"未知回归方法: {method}"}

    # ── 配置解析 ──

    @staticmethod
    def _var_warnings(df, config):
        """请求了但数据集里没有的变量，逐条说清楚。

        之前在 _cfg 里静默过滤掉，前端拿到一张缺行的表还不知道为什么。
        对做实证的人来说，"我控制了这个变量"和"它被悄悄剔掉了"是两回事，
        所以必须显式报出来。
        """
        out = []
        for kind, key in (("核心解释变量", "core_x"),
                          ("控制变量", "controls"),
                          ("聚类变量", "cluster_vars")):
            for v in (config.get(key) or []):
                if v not in df.columns:
                    out.append(f"{kind} {v} 在当前数据集中不存在，已从模型中剔除")
        return out


    def _cfg(self, df, config, allow_empty_core=False):
        y = config.get("y_var")
        if not y or y not in df.columns:
            raise ValueError("请选择因变量")
        # 不存在的变量仍由 _var_warnings() 统一报，这里保持原样过滤即可
        core = [v for v in (config.get("core_x") or []) if v in df.columns]
        ctrl = [v for v in (config.get("controls") or []) if v in df.columns and v not in core]
        if not core and not allow_empty_core:
            raise ValueError("请至少选择一个核心解释变量")
        clusters = [v for v in (config.get("cluster_vars") or []) if v in df.columns]
        return {
            "y": y, "core": core, "ctrl": ctrl,
            "id_var": config.get("id_var") if config.get("id_var") in df.columns else None,
            "time_var": config.get("time_var") if config.get("time_var") in df.columns else None,
            "absorb": [v for v in (config.get("absorb") or []) if v in df.columns],
            "cluster_vars": clusters[:2],
            "se_type": config.get("se_type") or "cluster",
            "weight_var": config.get("weight_var") if config.get("weight_var") in df.columns else None,
            "config": config,
        }

    def _design(self, df, cfg, extra_terms=None, keep=()):
        """构建设计矩阵。

        extra_terms: [(列名, 显示标签, Series)] 自定义项（DID交互项、事件虚拟变量等）。
        列顺序必须是「自定义项在前、core/controls 在后」，与下方列名赋值保持一致。
        返回 (y, X, side, labels)
        """
        base = list(cfg["core"]) + list(cfg["ctrl"])
        missing = [v for v in base if v not in df.columns]
        if missing:
            raise ValueError(f"变量不存在: {', '.join(missing)}")
        labels, series_of = {}, {}
        # ① 先放自定义项，保证列顺序与下方列名一致
        extra_cols = []
        for name, lab, s in (extra_terms or []):
            if name in labels:
                continue
            sv = pd.Series(np.asarray(s, dtype=float), index=df.index)
            # 与已有列数值完全相同的自定义项直接去重，避免完全共线
            if any(np.array_equal(sv.to_numpy(dtype=float),
                                  series_of[c].to_numpy(dtype=float))
                   for c in labels if c in series_of):
                continue
            extra_cols.append(sv)
            labels[name] = lab
            series_of[name] = sv
        # ② 再放 core + controls
        for c in base:
            if c in labels:
                continue
            s = pd.to_numeric(df[c], errors="coerce")
            extra_cols.append(s)
            labels[c] = c
            series_of[c] = s
        X = (pd.concat(extra_cols, axis=1) if extra_cols
             else pd.DataFrame(index=df.index))
        X.columns = list(labels.keys())
        col_order = list(labels.keys())
        y = pd.to_numeric(df[cfg["y"]], errors="coerce")
        side = df[list(dict.fromkeys(list(keep) + list(cfg["cluster_vars"]) + list(cfg["absorb"]) +
                                     [v for v in (cfg["id_var"], cfg["time_var"], cfg["weight_var"]) if v]))]
        mask = y.notna()
        for c in col_order:
            mask &= X[c].notna()
        for c in side.columns:
            mask &= pd.Series(np.asarray(side[c]), index=df.index).notna()
        return y[mask].reset_index(drop=True), X[mask].reset_index(drop=True), \
            side[mask].reset_index(drop=True), labels

    def _roles(self, cfg, cols, labels, core_extra=()):
        """以「显示名」为键的角色映射"""
        r = {}
        for c in cols:
            nm = labels.get(c, c)
            if c == "const" or nm == "const":
                r[nm] = "stat"
                r["_cons"] = "stat"
            elif c in cfg["core"] or nm in cfg["core"]:
                r[nm] = "core"
            elif c in core_extra or nm in core_extra:
                r[nm] = "core"
            else:
                r[nm] = "control"
        return r

    def _table(self, names, beta, se, tvals, pvals, roles, df_resid=None, labels=None):
        """names 是内部列名；labels 给了就翻译成显示名再进表。"""
        rows = []
        for raw, b, s, tv, pv in zip(names, beta, se, tvals, pvals):
            nm = _disp_name(raw, labels)
            b_, s_, tv_ = _f(b), _f(s), _f(tv, 3)
            p_ = _f(pv, 6)
            lo = _f(b_ - 1.96 * s_) if (b_ is not None and s_ is not None) else None
            hi = _f(b_ + 1.96 * s_) if (b_ is not None and s_ is not None) else None
            rows.append({"variable": nm, "role": roles.get(nm, "control"),
                         "coef": b_, "std_err": s_,
                         "t": tv_, "p": p_, "ci_low": lo, "ci_high": hi, "stars": _stars(p_)})
        return rows

    def _se_desc(self, cfg):
        cv = cfg["cluster_vars"]
        if cfg["se_type"] == "cluster" and cv:
            return "聚类稳健 (" + " + ".join(cv) + ")"
        return SE_LABELS.get(cfg["se_type"], cfg["se_type"])

    def _panel_idx(self, d, cfg):
        idv, tv = cfg["id_var"], cfg["time_var"]
        if not idv or not tv:
            raise ValueError("该方法需要指定个体变量与时间变量")
        o = d.copy()
        o[idv] = o[idv].astype(str)
        o[tv] = pd.to_numeric(o[tv], errors="coerce")
        o = o[o[tv].notna()]
        return o.set_index([idv, tv]).sort_index()

    def _panel_frame(self, y, X, side, cfg):
        """把 y / X / side 按同一个 (个体, 时间) 索引排序后一起返回。

        sort_index 只在 side 上做是不够的——y 和 X 还是旧行序，标签就错位了。
        这里先拼成一帧、统一贴索引、再排序，返回的四个对象行序完全一致。
        """
        idx = pd.MultiIndex.from_arrays(
            [side[cfg["id_var"]].astype(str).values,
             pd.to_numeric(side[cfg["time_var"]], errors="coerce").values],
            names=[cfg["id_var"], cfg["time_var"]])
        frame = pd.concat([
            pd.Series(np.asarray(y, dtype=float), name="__y__"),
            X.reset_index(drop=True),
            side.reset_index(drop=True),
        ], axis=1)
        frame.index = idx
        frame = frame.sort_index(kind="stable")
        return frame["__y__"], frame[list(X.columns)], frame[list(side.columns)], frame

    def _stata(self, cfg, cmd, xs=None, absorb=None, extra=None):
        """cmd 不带变量列表；xs 显式指定被解释变量右侧的变量串。"""
        parts = [cmd]
        varlist = xs if xs is not None else " ".join(cfg["core"] + cfg["ctrl"])
        if varlist:
            parts.append(varlist)
        code = " ".join(parts)
        tail = []
        if absorb:
            tail.append(absorb)
        cv = cfg["cluster_vars"]
        if cfg["se_type"] == "cluster" and cv:
            tail.append("vce(cluster " + " ".join(cv) + ")")
        elif cfg["se_type"] == "robust":
            tail.append("robust")
        tail += list(extra or [])
        return code + (", " + " ".join(tail) if tail else "")

    # ═════════════════════════════════════════════════════════
    # 基础回归
    # ═════════════════════════════════════════════════════════

    def _m_ols(self, df, config):
        import statsmodels.api as sm
        cfg = self._cfg(df, config)
        y, X, side, labels = self._design(df, cfg)
        Xc = _add_const(X)
        n, k = Xc.shape
        if n < k + 2:
            raise ValueError("样本量过小，无法估计")
        W = pd.to_numeric(side[cfg["weight_var"]], errors="coerce").values if cfg["weight_var"] else None
        yv = y.values.astype(float)
        Xv = Xc.values.astype(float)
        mod = sm.WLS(yv, Xv, weights=W) if W is not None else sm.OLS(yv, Xv)
        res = mod.fit()
        bse, tv, pv = self._se_sm(Xc, yv, Xv, res, side, cfg)
        roles = self._roles(cfg, Xc.columns, labels)
        tab = self._table(Xc.columns, res.params, bse, tv, pv, roles,
                          res.df_resid, labels)
        cmd = ("pwls " if cfg["weight_var"] else "regress ") + cfg["y"]
        out = {
            "method": "加权最小二乘回归 (WLS)" if cfg["weight_var"] else "最小二乘回归 (OLS)",
            "method_key": "wls" if cfg["weight_var"] else "ols",
            "dep_var": cfg["y"], "nobs": _i(n), "n_terms": _i(k),
            "se_type": self._se_desc(cfg), "coefficients": tab,
            "stata_code": self._stata(cfg, cmd),
            "weight_var": cfg["weight_var"],
        }
        if cfg["weight_var"]:
            out["weight_var"] = cfg["weight_var"]
        out.update(self._fstats(res, n, k))
        return out

    def _m_wls(self, df, config):
        return self._m_ols(df, config)

    def _se_sm(self, Xc, yv, Xv, res, side, cfg):
        """statsmodels 类模型的标准误/t/p，按聚类设置重算"""
        names = list(Xc.columns)
        resid = np.asarray(yv, dtype=float) - Xv @ np.asarray(res.params, dtype=float)
        if cfg["se_type"] == "cluster" and cfg["cluster_vars"]:
            V = cluster_cov(Xv, resid, [np.asarray(side[v]) for v in cfg["cluster_vars"]])
            se = np.sqrt(np.maximum(np.diag(V), 0))
            df_r = max(len(yv) - Xv.shape[1], 1)
            t = res.params / np.where(se > 0, se, np.nan)
            p = [_t_pvalue(ti, df_r) for ti in t]
            return pd.Series(se, index=names), pd.Series(t, index=names), pd.Series(p, index=names)
        if cfg["se_type"] == "robust":
            if hasattr(res, "get_robustcov_results"):
                r2 = res.get_robustcov_results(cov_type="HC1")
                return (pd.Series(r2.bse, index=names), pd.Series(r2.tvalues, index=names),
                        pd.Series(r2.pvalues, index=names))
            # QMLE 类模型（如 Poisson）用通用 HC1 三明治
            V = _hc1_cov(Xv, resid)
            se = np.sqrt(np.maximum(np.diag(V), 0))
            df_r = max(len(yv) - Xv.shape[1], 1)
            t = np.asarray(res.params, dtype=float) / np.where(se > 0, se, np.nan)
            p = [_t_pvalue(x, df_r) for x in t]
            return pd.Series(se, index=names), pd.Series(t, index=names), pd.Series(p, index=names)
        return (pd.Series(res.bse, index=names), pd.Series(res.tvalues, index=names),
                pd.Series(res.pvalues, index=names))

    def _fstats(self, res, n, k, robust=False):
        r2 = _f(res.rsquared)
        adj = _f(1 - (r2 * 100) / 100 + (1 - float(res.rsquared)) * 0) if r2 else None
        try:
            adj = _f(1 - (1 - float(res.rsquared)) * (n - 1) / max(n - k, 1))
        except Exception:
            adj = None
        f, fp = None, None
        try:
            f, fp = _f(res.fvalue, 3), _f(res.f_pvalue, 6)
        except Exception:
            pass
        return {"r_squared": r2, "adj_r_squared": adj, "f_stat": f, "f_pvalue": fp}

    # ═════════════════════════════════════════════════════════
    # 面板回归
    # ═════════════════════════════════════════════════════════

    def _panel(self, df, config, key, label, ent=False, tim=False, extra_terms=None,
               core_cols=(), cmd=None):
        from linearmodels.panel import PanelOLS, RandomEffects, FirstDifferenceOLS, BetweenOLS
        cfg = self._cfg(df, config)
        keep = list(cfg["absorb"])
        y, X, side, labels = self._design(df, cfg, extra_terms=extra_terms, keep=keep)
        y, X, side, dpf = self._panel_frame(y, X, side, cfg)
        dp = dpf.index
        yv = pd.Series(y.values.astype(float), index=dp)
        Xv = pd.DataFrame(X.values.astype(float), index=dp, columns=X.columns)
        others = (pd.DataFrame({c: np.asarray(side[c]) for c in cfg["absorb"]}, index=dp)
                  if cfg["absorb"] else None)

        if key == "re":
            mod = RandomEffects(yv, Xv)
        elif key == "fd":
            mod = FirstDifferenceOLS(yv, Xv)
        elif key == "between":
            mod = BetweenOLS(yv, Xv)
        else:
            mod = PanelOLS(yv, Xv, entity_effects=ent, time_effects=tim,
                           other_effects=others, drop_absorbed=True)
        res = self._fit_lm(mod, dpf, cfg, key=key)
        keep_names = [str(c) for c in res.params.index]
        roles = self._roles(cfg, Xv.columns, labels, core_extra=core_cols)
        tab = self._table(keep_names, res.params.values, res.std_errors.values,
                          res.tstats.values, res.pvalues.values, roles, labels=labels)
        out = {
            "method": label, "method_key": key, "dep_var": cfg["y"],
            "nobs": _i(res.nobs), "n_entities": _i(dp.get_level_values(0).nunique()),
            "n_periods": _i(dp.get_level_values(1).nunique()),
            "id_var": cfg["id_var"], "time_var": cfg["time_var"],
            "se_type": self._se_desc(cfg), "coefficients": tab,
            "stata_code": self._stata(cfg, cmd or ("reghdfe " + cfg["y"]),
                                       absorb=self._absorb(cfg, key, ent, tim)),
            "absorbed": self._absorbed(res, ent, tim, cfg),
        }
        out.update(self._lm_fit(res))
        if self._cluster_fallback_note:
            out.setdefault("notes", []).append(self._cluster_fallback_note)
        return out

    def _fit_lm(self, mod, dp, cfg, key=None):
        """dp 已 set_index([id_var, time_var])；聚类列从列或索引层解析"""
        self._cluster_fallback_note = None
        if cfg["se_type"] == "cluster" and cfg["cluster_vars"]:
            cols = {}
            for v in cfg["cluster_vars"]:
                if v in dp.columns:
                    raw = np.asarray(dp[v])
                elif cfg["id_var"] and v == cfg["id_var"]:
                    # set_index 之后个体变量是索引的第 0 层，不再是列
                    raw = np.asarray(dp.get_level_values(0))
                elif cfg["time_var"] and v == cfg["time_var"]:
                    raw = np.asarray(dp.get_level_values(1))
                else:
                    raise ValueError(f"聚类变量 {v} 不存在")
                # 字符型聚类列统一编码为整数（FD/Between 不接受字符串）
                if raw.dtype == object or str(raw.dtype) == "string":
                    raw = pd.factorize(raw)[0]
                cols[v] = raw
            try:
                return mod.fit(cov_type="clustered", clusters=pd.DataFrame(cols, index=dp.index))
            except Exception:
                # FD / Between 要求聚类变量在个体内恒定；不符时退回按个体聚类
                if key in ("fd", "between") and cfg["id_var"]:
                    self._cluster_fallback_note = (
                        f"聚类变量 {' + '.join(cfg['cluster_vars'])} 在个体内并非恒定，"
                        f"已改用 {cfg['id_var']} 聚类")
                    return mod.fit(cov_type="clustered", clusters=pd.DataFrame(
                        {cfg["id_var"]: pd.factorize(
                            np.asarray(dp.get_level_values(0)))[0]}, index=dp.index))
                raise
        return (mod.fit(cov_type="robust") if cfg["se_type"] == "robust"
                else mod.fit(cov_type="unadjusted"))

    def _lm_fit(self, res):
        f_stat = f_p = None
        try:
            f_stat = _f(res.f_statistic.stat, 3)
            f_p = _f(res.f_statistic.pval, 6)
        except Exception:
            f_stat = _f(getattr(res, "f_statistic", None), 3)
        return {
            "r_squared": _f(getattr(res, "rsquared", None)),
            "adj_r_squared": _f(getattr(res, "rsquared_adj", None)),
            "within_r_squared": _f(getattr(res, "rsquared_within", None)),
            "f_stat": f_stat, "f_pvalue": f_p,
        }

    def _absorb(self, cfg, key, ent, tim):
        if key not in ("fe", "te", "twoway_fe", "did", "event_study"):
            return None
        parts = []
        if ent:
            parts.append(cfg["id_var"])
        if tim:
            parts.append(cfg["time_var"])
        parts += list(cfg["absorb"])
        return "absorb(" + " ".join(p for p in parts if p) + ")" if parts else None

    def _absorbed(self, res, ent, tim, cfg):
        notes = []
        if ent:
            notes.append(f"{cfg['id_var']}: 个体固定效应已吸收")
        if tim:
            notes.append(f"{cfg['time_var']}: 时间固定效应已吸收")
        for a in cfg["absorb"]:
            notes.append(f"{a}: 高维固定效应已吸收")
        try:
            orig = [str(c) for c in res.model.exog.orig_exog.columns]
            kept = [str(c) for c in res.params.index]
            drop = [c for c in orig if c not in kept and c.lower() != "const"]
            if drop:
                notes.append("因共线被剔除: " + ", ".join(drop))
        except Exception:
            pass
        return notes

    def _m_fe(self, df, config):
        return self._panel(df, config, "fe", "个体固定效应回归 (FE)", ent=True,
                           cmd=f"xtreg {config.get('y_var')}")

    def _m_te(self, df, config):
        return self._panel(df, config, "te", "时间固定效应回归 (TE)", tim=True,
                           cmd=f"xtreg {config.get('y_var')}")

    def _m_twoway_fe(self, df, config):
        return self._panel(df, config, "twoway_fe", "双向固定效应回归", ent=True, tim=True)

    def _m_re(self, df, config):
        out = self._panel(df, config, "re", "随机效应回归 (RE/GLS)",
                          cmd=f"xtreg {config.get('y_var')}")
        out["hausman_note"] = ("豪斯曼检验需对比 FE 与 RE：系数差异小则可接受 RE，"
                               "差异大应改用 FE（Hausman p < 0.05 拒绝 RE）")
        return out

    def _m_fd(self, df, config):
        return self._panel(df, config, "fd", "一阶差分回归 (FD)")

    def _m_between(self, df, config):
        return self._panel(df, config, "between", "组间估计量 (Between)")

    def _m_gmm(self, df, config):
        from linearmodels.iv import IV2SLS
        cfg = self._cfg(df, config, allow_empty_core=True)
        lag_n = int(config.get("lag_iv") or 2)
        y, X, side, labels = self._design(df, cfg)
        y, X, side, dpf = self._panel_frame(y, X, side, cfg)
        dp = dpf.index
        idx = dp
        # 位置索引的分组框架，避免 MultiIndex 重复标签问题
        ent_codes = pd.factorize(np.asarray(idx.get_level_values(0)))[0]
        frame = pd.DataFrame({"__g__": ent_codes, "__y__": y.values.astype(float)})
        for c in X.columns:
            frame[c] = X[c].values.astype(float)

        def lg(col, n):
            return frame.groupby("__g__")[col].shift(n)

        y_l1, y_l2, y_l3 = lg("__y__", 1), lg("__y__", 2), lg("__y__", 3)
        dy = pd.Series(y_l1.notna().values & (y_l2.notna().values | lag_n <= 2), index=idx)
        dep = pd.Series(frame["__y__"].values - y_l1.fillna(0).values, index=idx)
        dlag = pd.Series(y_l1.values - y_l2.fillna(0).values, index=idx)
        newX = pd.DataFrame({c: pd.Series(frame[c].values - lg(c, 1).fillna(0).values, index=idx)
                             for c in X.columns})
        insts = {f"dep.L{L}": pd.Series(lg("__y__", L).values, index=idx)
                 for L in range(2, lag_n + 1)}
        inst = pd.DataFrame(insts)
        endog = pd.DataFrame({"L.dep": dlag})
        ok = dep.notna() & dlag.notna() & newX.notna().all(axis=1) & inst.notna().all(axis=1)
        mod = IV2SLS(dep[ok].astype(float), pd.concat([endog, newX], axis=1)[ok].astype(float),
                     None, inst[ok].astype(float))
        res = self._fit_lm(mod, dp[ok], cfg, key="gmm")
        names = [str(c) for c in res.params.index]
        roles = {"const": "stat"}
        roles = self._roles(cfg, X.columns, labels)
        roles["L.dep"] = "core"
        roles.update({n: "stat" for n in names if n.startswith("dep.L")})
        tab = self._table(names, res.params.values, res.std_errors.values,
                          res.tstats.values, res.pvalues.values, roles, labels=labels)
        # AR(2) 检验（残差在个体内的一阶自相关）
        u = pd.Series(np.asarray(res.resids, dtype=float), index=dp[ok].index)
        num = den = 0.0
        for _, v in u.groupby(idx.get_level_values(0)[np.asarray(ok)]):
            if len(v) > 2:
                num += float(np.sum(v[1:] * v[:-1]))
                den += float(np.sum(v[:-1] ** 2))
        rho = num / den if den > 0 else None
        z = rho / math.sqrt(max(1 / max(len(u), 1), 1e-12)) if rho is not None else None
        ar2_p = float(2 * (1 - stats.norm.cdf(abs(z)))) if z is not None else None
        return {
            "method": "差分 GMM (Arellano–Bond)", "method_key": "gmm",
            "dep_var": cfg["y"], "nobs": _i(res.nobs),
            "se_type": self._se_desc(cfg), "coefficients": tab,
            "instruments": [f"dep.L{L}" for L in range(2, lag_n + 1)] + list(X.columns),
            "ar_tests": {"rho": _f(rho), "ar2_p": _f(ar2_p, 6),
                         "note": "AR(2) 的 p 值应大于 0.1，否则扰动项设定有误"},
            "stata_code": (f"xtabond2 {cfg['y']} L.{cfg['y']} " + " ".join(cfg["core"] + cfg["ctrl"]) +
                           ", gmmstyle(L.dep, laglimits(2 " + str(lag_n) + "))"),
            "absorbed": ["残差已按个体分组以计算 AR 检验"],
            "notes": ["本实现为一步差分 GMM，工具变量为被解释变量的滞后水平值",
                      "结论对工具变量集的选择较敏感，建议做稳健性检验"],
        }

    # ═════════════════════════════════════════════════════════
    # 因果推断
    # ═════════════════════════════════════════════════════════

    def _did_terms(self, df, cfg, config):
        """返回 (extra_terms, notes, core_cols)。core_cols 中的列承担 DID 角色。"""
        treat, post, did_var = (config.get("treat_var"), config.get("post_var"),
                                config.get("did_var"))
        # 用户已把交互项放进核心/控制变量时，不重复构造
        if did_var and (did_var in cfg["core"] or did_var in cfg["ctrl"]):
            return [], [f"使用变量 {did_var} 作为 DID 交互项"], [did_var]
        if did_var and did_var in df.columns:
            return ([("__did__", "DID 交互项 (Treat×Post)", df[did_var])],
                    [f"使用数据中的 {did_var} 作为 DID 交互项"], ["__did__"])
        if not treat or not post:
            for c in df.columns:
                cl = c.lower()
                if not treat and cl in ("treat", "treated", "treatment", "g"):
                    treat = c
                if not post and cl in ("post", "after", "period"):
                    post = c
        if not treat or not post:
            raise ValueError("DID 需要指定处理组变量与政策后变量（或直接指定交互项变量）")
        t = pd.to_numeric(df[treat], errors="coerce")
        p = pd.to_numeric(df[post], errors="coerce")
        prod = (t * p).rename("__did__")
        # 用户把算好的 Treat×Post 放进核心变量、又填了 treat/post 时，
        # 自己构造的那一列和它完全相同 → 设计矩阵秩不足，linearmodels 直接报错。
        # 数值比对一遍，相同就复用那一列。
        same = None
        pv = prod.to_numpy(dtype=float)
        for c in list(cfg["core"]) + list(cfg["ctrl"]):
            if c not in df.columns:
                continue
            s = pd.to_numeric(df[c], errors="coerce")
            if len(s) == len(pv) and np.array_equal(s.to_numpy(dtype=float), pv,
                                                    equal_nan=True):
                same = c
                break
        if same:
            return [], [f"使用变量 {same} 作为 DID 交互项（不再重复构造）"], [same]
        terms = [("__did__", "DID 交互项 (Treat×Post)", prod)]
        notes = [f"交互项 = {treat} × {post}"]
        # 面板双固定效应下，Treat 被个体效应吸收、Post 被时间效应吸收，无需再放入
        if cfg["id_var"] is None:
            if treat in df.columns and treat not in cfg["ctrl"] and treat not in cfg["core"]:
                terms.append(("__treat__", "处理组主效应", t))
            if post in df.columns and post not in cfg["ctrl"] and post not in cfg["core"]:
                terms.append(("__post__", "政策后主效应", p))
        else:
            notes.append(f"{treat} 被个体固定效应吸收，{post} 被时间固定效应吸收，故不单独放入")
        return terms, notes, ["__did__"]

    def _m_did(self, df, config):
        from linearmodels.panel import PanelOLS
        cfg = self._cfg(df, config, allow_empty_core=True)
        terms, notes, did_cols = self._did_terms(df, cfg, config)
        y, X, side, labels = self._design(df, cfg, extra_terms=terms, keep=list(cfg["absorb"]))
        y, X, side, dpf = self._panel_frame(y, X, side, cfg)
        dp = dpf.index
        yv = pd.Series(y.values.astype(float), index=dp)
        Xv = pd.DataFrame(X.values.astype(float), index=dp, columns=X.columns)
        others = (pd.DataFrame({c: np.asarray(side[c]) for c in cfg["absorb"]}, index=dp)
                  if cfg["absorb"] else None)
        mod = PanelOLS(yv, Xv, entity_effects=True, time_effects=True,
                       other_effects=others, drop_absorbed=True)
        res = self._fit_lm(mod, dpf, cfg, key="did")
        did_col = next((c for c in did_cols if c in Xv.columns), did_cols[0])
        roles = self._roles(cfg, Xv.columns, labels,
                            core_extra=[did_col, "__treat__", "__post__"])
        roles[labels.get("__treat__", "__treat__")] = "stat"
        roles[labels.get("__post__", "__post__")] = "stat"
        att = _f(res.params.get(did_col))
        att_se = _f(res.std_errors.get(did_col))
        att_t = _f(res.tstats.get(did_col), 3)
        att_p = _f(res.pvalues.get(did_col), 6)
        cmd = "reghdfe " + cfg["y"]
        # did_col 已在核心解释变量中时，变量列表交给 _stata 统一拼，避免重复出现
        cmd_xs = None if did_col in cfg["core"] else " ".join([did_col] + cfg["ctrl"])
        out = {
            "method": "双重差分回归 (DID / TWFE)", "method_key": "did",
            "dep_var": cfg["y"], "nobs": _i(res.nobs),
            "n_entities": _i(dp.get_level_values(0).nunique()),
            "n_periods": _i(dp.get_level_values(1).nunique()),
            "se_type": self._se_desc(cfg),
            "coefficients": self._table([str(c) for c in res.params.index], res.params.values,
                                        res.std_errors.values, res.tstats.values,
                                        res.pvalues.values, roles, labels=labels),
            "stata_code": self._stata(cfg, cmd, xs=cmd_xs,
                                      absorb=self._absorb(cfg, "twoway_fe", True, True)),
            "att": {"estimate": att, "std_err": att_se, "t": att_t, "p": att_p,
                    "stars": _stars(att_p),
                    "interpretation": f"DID 处理效应 ATT = {att}{_stars(att_p)}"},
            "absorbed": self._absorbed(res, True, True, cfg),
            "notes": notes,
        }
        out.update(self._lm_fit(res))
        return out

    def _m_event_study(self, df, config):
        from linearmodels.panel import PanelOLS
        cfg = self._cfg(df, config, allow_empty_core=True)
        cohort = config.get("cohort_var")
        if not cohort or cohort not in df.columns:
            for c in df.columns:
                if any(k in c.lower() for k in ("first_treat", "cohort", "gvar", "treat_year",
                                                "firstyear")):
                    cohort = c
                    break
        if not cohort or cohort not in df.columns:
            raise ValueError("事件研究法需要处理时点变量（如 first_treat）")
        win = str(config.get("window") or "-4,4").replace("，", ",")
        try:
            wlo, whi = [int(float(x)) for x in win.split(",")[:2]]
        except Exception:
            wlo, whi = -4, 4
        wlo, whi = min(wlo, whi), max(wlo, whi)
        c = pd.to_numeric(df[cohort], errors="coerce")
        t = pd.to_numeric(df[cfg["time_var"]], errors="coerce")
        rel = (t - c)
        rel = rel.where(c.notna() & (c > 0))
        relc = rel.clip(wlo, whi)
        periods = [p for p in range(wlo, whi + 1) if p != -1]
        terms = [(f"__evt{p:+d}__", f"{'事前 t' if p < 0 else '事后 t'}{p:+d}", (relc == p).astype(float))
                 for p in periods]
        y, X, side, labels = self._design(df, cfg, extra_terms=terms, keep=list(cfg["absorb"]))
        y, X, side, dpf = self._panel_frame(y, X, side, cfg)
        dp = dpf.index
        yv = pd.Series(y.values.astype(float), index=dp)
        Xv = pd.DataFrame(X.values.astype(float), index=dp, columns=X.columns)
        others = (pd.DataFrame({c2: np.asarray(side[c2]) for c2 in cfg["absorb"]}, index=dp)
                  if cfg["absorb"] else None)
        mod = PanelOLS(yv, Xv, entity_effects=True, time_effects=True,
                       other_effects=others, drop_absorbed=True)
        res = self._fit_lm(mod, dpf, cfg, key="event_study")
        label_of = {t[0]: t[1] for t in terms}
        events, pre_bad, post_bad = [], [], []
        for name in res.params.index:
            if not str(name).startswith("__evt"):
                continue
            try:
                tval = int(str(name).split("t")[-1].replace("__", ""))
            except Exception:
                continue
            b, s = _f(res.params[name]), _f(res.std_errors[name])
            p = _f(res.pvalues[name], 6)
            events.append({"period": tval, "coef": b, "std_err": s, "p": p, "stars": _stars(p),
                           "ci_low": _f(b - 1.96 * s) if b is not None and s is not None else None,
                           "ci_high": _f(b + 1.96 * s) if b is not None and s is not None else None})
            (pre_bad if tval < 0 else post_bad).append((tval, p))
        events.sort(key=lambda e: e["period"])
        # 统一判定入口。这处原来的阈值是 p < 0.10，另两处是 |t| > 1.96（5%），
        # 同一个"通过"在三个入口标注不同；且同样只关前事前、
        # 窗口无事前期时也会打"通过"。现在都由 _pt_verdict 统一处理。
        from ._pt_verdict import parallel_trend_verdict
        _pt = parallel_trend_verdict([{"k": e["period"], "est": e["coef"],
                                       "se": e["std_err"], "p": e["p"]}
                                      for e in events])
        pre_sig = _pt["pre_significant"]
        post_sig = _pt["post_significant"]
        verdict = _pt["label"]
        roles = self._roles(cfg, Xv.columns, labels,
                            core_extra=[t[0] for t in terms])
        cmd = "eventstudyinteract " + cfg["y"]
        n_cohort = _i(pd.to_numeric(df[cohort], errors="coerce")
                      .pipe(lambda s: s[(s > 0) & s.notna()]).nunique())
        return {
            "method": "事件研究法 / 平行趋势检验", "method_key": "event_study",
            "dep_var": cfg["y"], "nobs": _i(res.nobs), "n_cohorts": n_cohort,
            "cohort_var": cohort, "window": [wlo, whi], "baseline": -1,
            "se_type": self._se_desc(cfg), "events": events,
            "coefficients": self._table([str(c) for c in res.params.index], res.params.values,
                                        res.std_errors.values, res.tstats.values,
                                        res.pvalues.values, roles, labels=labels),
            "parallel_trend_test": {
                "verdict": verdict,
                "verdict_code": _pt["verdict"],
                "tone": _pt["tone"],
                "message": _pt["message"],
                "note": _pt["note"],
                "power": _pt.get("power"),
                "power_summary": _pt.get("power_summary"),
                "pre_significant": pre_sig, "post_significant": post_sig,
            },
            "dynamic_effect": {
                "summary": ("政策效应随事件期增强" if events and post_sig and
                            abs((events[-1]["coef"] or 0)) > abs((events[0]["coef"] or 0))
                            else "政策效应无显著时间趋势"),
            },
            "stata_code": self._stata(cfg, cmd, absorb=self._absorb(cfg, "twoway_fe", True, True)),
            "absorbed": self._absorbed(res, True, True, cfg),
            "notes": [f"基期为 t=-1（不生成虚拟变量）", f"共 {n_cohort} 个处理队列",
                      "事前系数显著说明平行趋势假设不成立，DID 结论需谨慎"],
        }

    def _m_iv2sls(self, df, config):
        from linearmodels.iv import IV2SLS
        import statsmodels.api as sm
        cfg = self._cfg(df, config)
        instruments = [v for v in (config.get("instruments") or []) if v in df.columns]
        if not instruments:
            raise ValueError("IV/2SLS 需要至少一个工具变量")
        endog = [v for v in cfg["core"] if v in df.columns]
        if not endog:
            raise ValueError("请把内生变量放入「核心解释变量」")
        y, X, side, labels = self._design(
            df, cfg, keep=list(cfg["absorb"]) + instruments)
        # 有面板结构就按面板索引（可吸收固定效应），否则用截面数据
        if cfg["id_var"] and cfg["time_var"]:
            y, X, side, dpf = self._panel_frame(y, X, side, cfg)
            dp = dpf.index
            idx = dp
            side_for_cluster = side
        else:
            dp = side
            idx = pd.RangeIndex(len(side))
            side_for_cluster = side
        dep = pd.Series(y.values.astype(float), index=idx)
        endo = pd.DataFrame({c: X[c].values.astype(float) for c in endog}, index=idx)
        # 控制变量从 X 中取（X 已按顺序含 core + ctrl）
        exog = pd.DataFrame({labels.get(c, c): X[c].values.astype(float)
                             for c in X.columns if c in cfg["ctrl"]}, index=idx)
        inst = pd.DataFrame({c: np.asarray(side[c]).astype(float) for c in instruments},
                            index=idx)
        if cfg["absorb"] and side_for_cluster is not side:
            for c in cfg["absorb"]:
                exog[c] = np.asarray(side_for_cluster[c])
        mod = IV2SLS(dep, exog, endo, inst)
        res = self._fit_lm(mod, dpf, cfg, key="iv2sls")
        names = [str(c) for c in res.params.index]
        roles = self._roles(cfg, X.columns, labels)
        for c in instruments:
            roles[c] = "stat"
        # 第一阶段
        first = {}
        allz = pd.concat([inst, exog], axis=1).astype(float)
        for c in endog:
            Xf = _add_const(allz)
            try:
                rf = sm.OLS(endo[c].values.astype(float), Xf.values.astype(float)).fit()
                n_, k_ = rf.nobs, Xf.shape[1]
                first[c] = {
                    "coefs": {str(i): _f(v) for i, v in zip(Xf.columns, rf.params)},
                    "f_stat": _f(rf.fvalue, 3), "f_pvalue": _f(rf.f_pvalue, 6),
                    "weak_iv": "存在弱工具变量风险 (F < 10)" if (rf.fvalue or 0) < 10
                               else "不存在弱工具变量问题 (F ≥ 10)",
                }
            except Exception:
                pass
        cmd = (f"ivregress 2sls {cfg['y']} (" + " ".join(endog) + " = " +
               " ".join(instruments) + ") " + " ".join(cfg["ctrl"]))
        out = {
            "method": "工具变量回归 (IV/2SLS)", "method_key": "iv2sls",
            "dep_var": cfg["y"], "nobs": _i(res.nobs), "se_type": self._se_desc(cfg),
            "coefficients": self._table(names, res.params.values, res.std_errors.values,
                                        res.tstats.values, res.pvalues.values, roles,
                                        labels=labels),
            "first_stage": first,
            "stata_code": self._stata(cfg, cmd,
                                       absorb=self._absorb(cfg, "twoway_fe", bool(cfg["absorb"]), False)
                                       if cfg["absorb"] else None),
            "absorbed": self._absorbed(res, bool(cfg["absorb"]), False, cfg),
            "notes": [f"内生变量: {', '.join(endog)}", f"工具变量: {', '.join(instruments)}",
                      "第一阶段 F < 10 时考虑更换工具变量或使用弱工具变量稳健推断"],
        }
        out.update(self._lm_fit(res))
        return out

    # ── RD ──

    def _rd_subset(self, df, cfg, config, for_treatment=False):
        rv = config.get("running_var")
        if not rv or rv not in df.columns:
            raise ValueError("RD 需要指定驱动变量 (Running Variable)")
        cutoff = float(config.get("cutoff") or 0)
        poly = int(config.get("poly_order") or 1)
        kernel = config.get("kernel") or "三角"
        x = pd.to_numeric(df[rv], errors="coerce")
        target = config.get("treatment_var") if for_treatment else cfg["y"]
        bw = config.get("bandwidth")
        if bw in (None, "", 0):
            ok = x.notna() & df[target].notna() if target else x.notna()
            bw = self._ik_bw(x[ok].values, pd.to_numeric(df[target], errors="coerce")[ok].values,
                             cutoff, poly)
        h = float(bw)
        sub = (x - cutoff).abs() <= h
        xs = (x - cutoff)[sub].astype(float)
        cols = {"above": (xs >= 0).astype(float)}
        for p in range(1, poly + 1):
            cols[f"x{p}"] = xs ** p
            cols[f"x{p}_above"] = (xs ** p) * (xs >= 0).astype(float)
        for c in cfg["ctrl"]:
            if c in df.columns:
                cols[c] = pd.to_numeric(df[c], errors="coerce")[sub].astype(float)
        W = pd.DataFrame(cols, index=xs.index)
        yv = pd.to_numeric(df[target], errors="coerce")[sub] if target else None
        tv = (pd.to_numeric(df[config.get("treatment_var")], errors="coerce")[sub]
              if for_treatment else None)
        keep = W.notna().all(axis=1)
        if yv is not None:
            keep &= yv.notna()
        if tv is not None:
            keep &= tv.notna()
        W, yv, tv = W[keep], (yv[keep] if yv is not None else None), (tv[keep] if tv is not None else None)
        w = self._kernel_w(xs[keep].values / h, kernel)
        if len(yv) < 20:
            raise ValueError(
                f"带宽内有效样本仅 {len(yv)} 个，无法估计。请检查驱动变量与断点的设定"
                f"（当前断点 {cutoff}，带宽 {h:.4f}）")
        # 始终同时返回结果变量与处理变量（Fuzzy RD 需要两者）
        yv_out = pd.to_numeric(df[cfg["y"]], errors="coerce")[sub][keep]
        tv_out = (pd.to_numeric(df[config.get("treatment_var")], errors="coerce")[sub][keep]
                  if for_treatment and config.get("treatment_var") in df.columns else None)
        return W, yv_out, tv_out, w, h, cutoff, kernel, poly

    def _ik_bw(self, x, y, cutoff, poly):
        s = float(np.std(x, ddof=1))
        n = len(x)
        h = 1.84 * s * n ** (-1 / 5)
        for _ in range(3):
            f1 = float(np.mean(np.abs(x - cutoff) <= h)) / (2 * h) if h > 0 else 1.0
            med = float(np.median(np.abs(x - cutoff) + 1e-12))
            s2 = float(np.sum(np.abs(x - cutoff) ** 3)) / max(n, 1)
            ck = 3 * (3.4375 ** 2) * med / (n ** 2 * max(f1, 1e-9) * max(s2, 1e-9))
            h = 2.7 * s * n ** (-1 / 5) * max(ck, 1e-4) ** 0.2 if ck > 0 else h
        return float(np.clip(h, 1e-9, max(s, 1e-9)))

    def _kernel_w(self, u, kernel):
        u = np.asarray(u, dtype=float)
        if kernel == "三角":
            return np.clip(1 - np.abs(u), 1e-6, None)
        if "Epan" in kernel:
            return np.clip(0.75 * (1 - u ** 2), 1e-6, None)
        if kernel == "高斯":
            return np.exp(-u ** 2 / 2) + 1e-6
        return np.ones_like(u)

    def _m_rd(self, df, config):
        import statsmodels.api as sm
        cfg = self._cfg(df, config, allow_empty_core=True)
        W, yv, _, w, h, cutoff, kernel, poly = self._rd_subset(df, cfg, config)
        Xc = _add_const(W)
        Xv = Xc.values.astype(float)
        yvv = yv.values.astype(float)
        res = sm.WLS(yvv, Xv, weights=w).fit()
        ia = list(Xc.columns).index("above")
        est, se = _f(res.params[ia]), _f(res.bse[ia])
        p = _f(res.pvalues[ia], 6)
        roles = self._roles(cfg, Xc.columns, {c: c for c in Xc.columns},
                            core_extra=["above"])
        n_left = _i(int(np.sum(np.asarray(W["above"]) == 0)))
        n_right = _i(int(np.sum(np.asarray(W["above"]) == 1)))
        return {
            "method": "断点回归 (Sharp RD)", "method_key": "rd",
            "dep_var": cfg["y"], "nobs": _i(int(res.nobs)), "n_left": n_left, "n_right": n_right,
            "se_type": "局部线性 + 核加权 (非参数)",
            "coefficients": self._table(Xc.columns, res.params, res.bse, res.tvalues,
                                        res.pvalues, roles),
            "rd_effect": {"estimate": est, "std_err": se, "p": p, "stars": _stars(p),
                          "bandwidth": _f(h, 4), "cutoff": cutoff, "kernel": kernel,
                          "poly_order": poly,
                          "interpretation": f"断点处处理效应 = {est}{_stars(p)}"},
            "stata_code": (f"rdrobust {cfg['y']} {config.get('running_var')}, c({cutoff}) "
                           f"p({poly}) h({_f(h, 4)}) "
                           f"kernel({'tri' if kernel == '三角' else 'epan' if 'Epan' in kernel else 'uni'})"),
            "notes": [f"带宽 h = {_f(h, 4)}（{'自动选择 (IK)' if not config.get('bandwidth') else '手动指定'}）",
                      f"{kernel}核加权，{poly} 阶局部多项式",
                      "需检验驱动变量在断点处无操纵 (density test / McCrary",
                      "注意不同带宽估计结果的稳健性"],
        }

    def _m_rd_fuzzy(self, df, config):
        import statsmodels.api as sm
        cfg = self._cfg(df, config, allow_empty_core=True)
        W, yv, tv, w, h, cutoff, kernel, poly = self._rd_subset(df, cfg, config, for_treatment=True)
        if tv is None:
            raise ValueError("模糊断点需要指定实际处理变量")
        Xc = _add_const(W)
        Xv = Xc.values.astype(float)
        rf = sm.WLS(yv.values.astype(float), Xv, weights=w).fit()
        fs = sm.WLS(tv.values.astype(float), Xv, weights=w).fit()
        ia = list(Xc.columns).index("above")
        b_rf, se_rf = float(rf.params[ia]), float(rf.bse[ia])
        b_fs, se_fs = float(fs.params[ia]), float(fs.bse[ia])
        late = b_rf / b_fs
        se_late = abs(late) * math.sqrt((se_rf / b_rf) ** 2 + (se_fs / b_fs) ** 2)
        p_late = _t_pvalue(late / se_late if se_late else None, int(rf.df_resid))
        p_fs = _f(fs.pvalues[ia], 6)
        return {
            "method": "模糊断点回归 (Fuzzy RD)", "method_key": "rd_fuzzy",
            "dep_var": cfg["y"], "nobs": _i(int(rf.nobs)),
            "se_type": f"{kernel}核 + {poly} 阶局部多项式",
            "coefficients": [
                {"variable": "Wald 估计 (LATE)", "role": "core", "coef": _f(late),
                 "std_err": _f(se_late), "t": _f(late / se_late if se_late else None, 3),
                 "p": _f(p_late, 6),
                 "ci_low": _f(late - 1.96 * se_late) if se_late else None,
                 "ci_high": _f(late + 1.96 * se_late) if se_late else None,
                 "stars": _stars(_f(p_late, 6))},
                {"variable": "简化式断点跳跃 (Outcome)", "role": "stat", "coef": _f(b_rf),
                 "std_err": _f(se_rf), "t": _f(b_rf / se_rf if se_rf else None, 3),
                 "p": _f(rf.pvalues[ia], 6), "ci_low": None, "ci_high": None,
                 "stars": _stars(_f(rf.pvalues[ia], 6))},
                {"variable": "第一阶段断点跳跃 (Treatment)", "role": "stat", "coef": _f(b_fs),
                 "std_err": _f(se_fs), "t": _f(b_fs / se_fs if se_fs else None, 3),
                 "p": p_fs, "ci_low": None, "ci_high": None, "stars": _stars(p_fs)},
            ],
            "rd_effect": {"estimate": _f(late), "std_err": _f(se_late), "p": _f(p_late, 6),
                          "stars": _stars(_f(p_late, 6)), "bandwidth": _f(h, 4),
                          "cutoff": cutoff, "kernel": kernel, "poly_order": poly,
                          "type": "LATE (仅对顺从者)",
                          "interpretation": f"断点处局部平均处理效应 LATE = {_f(late)}{_stars(_f(p_late, 6))}"},
            "stata_code": (f"rdrobust {cfg['y']} {config.get('treatment_var')}, "
                           f"c({cutoff}) fuzzy(z {config.get('running_var')}) h({_f(h, 4)})"),
            "notes": [f"第一阶段在断点处处理概率跳跃 {_f(b_fs)}{_stars(p_fs)}",
                      f"带宽 h = {_f(h, 4)}",
                      "第一阶段跳跃不显著则 Fuzzy RD 不成立，应改用 Sharp RD 框架",
                      "Fuzzy RD 估计的是 LATE，外推到全体需谨慎"],
        }

    # ── PSM ──

    def _m_psm(self, df, config):
        import statsmodels.api as sm
        from statsmodels.discrete.discrete_model import Logit
        cfg = self._cfg(df, config, allow_empty_core=True)
        tv = config.get("treat_var")
        if not tv or tv not in df.columns:
            raise ValueError("PSM 需要指定 0/1 处理变量")
        method = config.get("match_method") or "近邻 k=1"
        caliper = float(config.get("caliper") or 0.2)
        k = {"近邻 k=1": 1, "近邻 k=3": 3, "近邻 k=5": 5}.get(method, 1)
        mode = ("kernel" if method == "核匹配" else "radius" if method == "卡尺内匹配" else "knn")
        covars = [c for c in cfg["ctrl"] if c in df.columns]
        if not covars:
            raise ValueError("PSM 至少需要一个协变量（放入「控制变量」）")
        d = df[[tv] + covars + [cfg["y"]]].copy()
        for c in d.columns:
            d[c] = pd.to_numeric(d[c], errors="coerce")
        d = d.dropna()
        if len(d) < 20:
            raise ValueError("有效样本过少，无法进行 PSM")
        treat = d[tv].values.round().astype(int)
        if len(np.unique(treat)) != 2:
            raise ValueError("处理变量必须为 0/1 二值")
        Z = d[covars].values.astype(float)
        Zs = (Z - Z.mean(0)) / np.where(Z.std(0) > 0, Z.std(0), 1)
        Zc = _add_const(pd.DataFrame(Zs, columns=covars)).values.astype(float)
        yv = d[cfg["y"]].values.astype(float)
        try:
            ps = Logit(treat, Zc).fit(disp=0).predict(Zc)
        except Exception:
            ps = np.full(len(d), treat.mean())
        ti, ci = np.flatnonzero(treat == 1), np.flatnonzero(treat == 0)
        if len(ti) < 3 or len(ci) < 3:
            raise ValueError("处理组或对照组样本量过小，无法匹配")
        ps_sd = float(np.std(ps))
        cal = caliper * ps_sd
        o0 = np.argsort(ps[ci])
        s_ps, s_y = ps[ci][o0], yv[ci][o0]

        def match_batch(pq):
            """批量匹配：返回与 query 等长的数组，无法匹配处置 NaN"""
            pq = np.atleast_1d(np.asarray(pq, dtype=float))
            out = np.full(len(pq), np.nan)
            if mode == "radius":
                lo = np.searchsorted(s_ps, pq - cal, "left")
                hi = np.searchsorted(s_ps, pq + cal, "right")
                cnt = hi - lo
                csum = np.concatenate([[0.0], np.cumsum(s_y)])
                good = cnt > 0
                out[good] = (csum[hi[good]] - csum[lo[good]]) / cnt[good]
                return out
            lo = np.searchsorted(s_ps, pq, "left")
            hi = np.searchsorted(s_ps, pq, "right")
            m = len(s_ps)
            ib = lo[:, None] - 1 - np.arange(k)[None, :]
            ia = hi[:, None] + np.arange(k)[None, :]
            ci_ = np.concatenate([np.clip(ib, 0, m - 1), np.clip(ia, 0, m - 1)], axis=1)
            cd = np.concatenate([np.where((ib >= 0), np.abs(s_ps[np.clip(ib, 0, m - 1)] - pq[:, None]), np.inf),
                                 np.where((ia < m), np.abs(s_ps[np.clip(ia, 0, m - 1)] - pq[:, None]), np.inf)],
                                axis=1)
            sel = np.argsort(cd, axis=1)[:, :k]
            d_k = np.take_along_axis(cd, sel, axis=1)
            idx_k = np.take_along_axis(ci_, sel, axis=1)
            ok = np.all(np.isfinite(d_k) & (d_k <= cal), axis=1)
            out[ok] = np.mean(s_y[idx_k[ok]], axis=1)
            return out

        def match_one(p, bps, bys):
            """单个查询点（用于核匹配，样本外排序数组）"""
            if mode == "kernel":
                lo = np.searchsorted(bps, p - 4 * ps_sd, "left")
                hi = np.searchsorted(bps, p + 4 * ps_sd, "right")
                if hi <= lo:
                    return None
                sub = bps[lo:hi]
                wgt = np.exp(-((sub - p) / (0.25 * ps_sd)) ** 2)
                return float(np.average(bys[lo:hi], weights=wgt))
            return None

        if mode == "kernel":
            matched = [m for m in (match_one(p, s_ps, s_y) for p in ps[ti]) if m is not None]
        else:
            matched = list(match_batch(ps[ti])[np.isfinite(match_batch(ps[ti]))])
        raw_diff = float(np.mean(yv[ti]) - np.mean(yv[ci]))
        att = float(np.mean(yv[ti]) - np.mean(matched)) if matched else None

        # 自助标准误：处理组与对照组各自有放回重抽
        rng = np.random.default_rng(42)
        boots = []
        for _ in range(199):
            ic = rng.choice(ci, len(ci), replace=True)
            it = rng.choice(ti, len(ti), replace=True)
            if mode == "kernel":
                oo = np.argsort(ps[ic])
                bs_ps, bs_y = ps[ic][oo], yv[ic][oo]
                m = [x for x in (match_one(p, bs_ps, bs_y) for p in ps[it]) if x is not None]
            else:
                oo = np.argsort(ps[ic])
                s_ps, s_y = ps[ic][oo], yv[ic][oo]
                m = list(match_batch(ps[it])[np.isfinite(match_batch(ps[it]))])
            if m:
                boots.append(float(np.mean(yv[it])) - float(np.mean(m)))
        s_ps, s_y = ps[ci][o0], yv[ci][o0]
        se = float(np.std(boots, ddof=1)) if len(boots) > 10 else None
        p = _t_pvalue(att / se if (att is not None and se) else None,
                      max(len(boots) - 1, 1)) if se else None
        return {
            "method": "倾向得分匹配 (PSM)", "method_key": "psm",
            "dep_var": cfg["y"], "treat_var": tv,
            "nobs": _i(len(d)), "n_treated": _i(int(len(ti))), "n_control": _i(int(len(ci))),
            "n_matched": _i(len(matched)),
            "se_type": "Bootstrap (199 次)",
            "coefficients": [
                {"variable": "ATT 平均处理效应", "role": "core", "coef": _f(att),
                 "std_err": _f(se), "t": _f(att / se if se else None, 3), "p": _f(p, 6),
                 "ci_low": _f(att - 1.96 * se) if (att is not None and se) else None,
                 "ci_high": _f(att + 1.96 * se) if (att is not None and se) else None,
                 "stars": _stars(_f(p, 6))},
                {"variable": "未匹配均值差 (原始)", "role": "stat", "coef": _f(raw_diff),
                 "std_err": None, "t": None, "p": None, "ci_low": None, "ci_high": None,
                 "stars": ""},
            ],
            "common_support": {"min_ps_treated": _f(float(np.min(ps[ti]))),
                               "max_ps_treated": _f(float(np.max(ps[ti]))),
                               "min_ps_control": _f(float(np.min(ps[ci]))),
                               "max_ps_control": _f(float(np.max(ps[ci]))),
                               "overlap_ok": bool(np.min(ps[ti]) < np.max(ps[ci]) and
                                                  np.max(ps[ti]) > np.min(ps[ci]))},
            "match_setting": {"method": method, "k": k, "caliper": caliper, "covariates": covars},
            "stata_code": (f"teffects psmatch ({cfg['y']}) ({tv} {' '.join(covars)}), "
                           f"{'atet' if True else 'ate'} "
                           f"neighbor({k}) caliper({caliper})"),
            "notes": ["共同支撑假设：观察处理组与对照组的倾向得分分布是否重叠",
                      "建议追加平衡性检验：匹配后协变量标准化差异应 < 10%"],
        }

    # ── 合成控制法 ──

    def _m_scm(self, df, config):
        from scipy.optimize import minimize
        cfg = self._cfg(df, config, allow_empty_core=True)
        unit = config.get("treated_unit")
        pre_end = config.get("pre_end")
        if not unit or pre_end in (None, ""):
            raise ValueError("合成控制法需要「被处理单位」与「政策前最后一个时期」")
        pre_end = float(pre_end)
        unit = str(unit)
        d = df.copy()
        d["__y__"] = pd.to_numeric(d[cfg["y"]], errors="coerce")
        d["__t__"] = pd.to_numeric(d[cfg["time_var"]], errors="coerce")
        d["__id__"] = d[cfg["id_var"]].astype(str)
        d = d[d["__y__"].notna() & d["__t__"].notna()]
        tvals = np.sort(d["__t__"].unique())
        pre_t = tvals[tvals <= pre_end]
        post_t = tvals[tvals > pre_end]
        if len(pre_t) < 2 or len(post_t) < 1:
            raise ValueError("政策前需至少 2 期、政策后至少 1 期")
        wide = d.pivot_table(index="__id__", columns="__t__", values="__y__", aggfunc="first")
        ids = list(wide.index)
        if unit not in wide.index:
            raise ValueError(f"未找到被处理单位 {unit}；可用单位示例: {', '.join(map(str, ids[:8]))} …")
        cols = list(pre_t) + list(post_t)
        y1_all = wide.loc[unit, cols].astype(float).values
        y_pre = y1_all[:len(pre_t)]
        # 对照单位必须在政策前与政策后均有完整数据
        donors_all = [i for i in ids if i != unit and
                      int(wide.loc[i, cols].notna().sum()) == len(cols)]
        if len(donors_all) < 2:
            raise ValueError("政策前后均有完整数据的对照单位不足（需至少 2 个）")
        # 对照单位过多时，按「政策前平均距离」预筛选，保证求解速度与稳定性
        MAX_DONOR = 40
        donor_capped = len(donors_all) > MAX_DONOR
        if donor_capped:
            dist = [float(np.nanmean(np.abs(wide.loc[i, pre_t].astype(float).values - y_pre)))
                    for i in donors_all]
            order = np.argsort(dist)[:MAX_DONOR]
            donors = [donors_all[j] for j in sorted(order)]
        else:
            donors = donors_all
        Y0 = wide.loc[donors, cols].astype(float).values
        y1 = y1_all
        if np.isnan(y1[:len(pre_t)]).any() or np.isnan(y1[len(pre_t):]).any():
            raise ValueError("被处理单位的因变量存在缺失，无法构造缺口序列")
        np_, nt = len(pre_t), len(cols)
        X0, y0 = Y0[:, :np_], y1[:np_]
        nd = len(donors)
        G = X0.T  # (np_ × nd)

        def loss(w):
            return float(np.sum((y0 - G @ w) ** 2))

        t_budget = time.time() + 60
        opt = minimize(loss, np.full(nd, 1 / nd), method="SLSQP", bounds=[(0, 1)] * nd,
                       constraints=[{"type": "eq", "fun": lambda w: np.sum(w) - 1}],
                       options={"maxiter": 400, "ftol": 1e-10})
        w = np.clip(opt.x, 0, 1)
        w = w / w.sum() if w.sum() > 0 else w
        y_fit = G @ w
        y_hat = np.concatenate([y_fit, Y0[:, np_:].T @ w])
        pre_mspe = float(np.mean((y1[:np_] - y_fit) ** 2))
        post_mspe = float(np.mean((y1[np_:] - y_hat[np_:]) ** 2))
        gap = y1 - y_hat
        effect = float(np.mean(gap[np_:]))
        dw = sorted([(donors[i], float(w[i])) for i in range(nd) if w[i] > 1e-4], key=lambda x: -x[1])
        ratios = []
        for dn in donors[:20]:
            if time.time() > t_budget:
                break
            yc = wide.loc[dn, cols].astype(float).values
            subs = [s for s in donors if s != dn]
            Gs = wide.loc[subs, cols].astype(float).values[:, :np_].T
            o = minimize(lambda ww: float(np.sum((yc[:np_] - Gs @ ww) ** 2)),
                         np.full(len(subs), 1 / len(subs)), method="SLSQP",
                         bounds=[(0, 1)] * len(subs),
                         constraints=[{"type": "eq", "fun": lambda ww: np.sum(ww) - 1}],
                         options={"maxiter": 200, "ftol": 1e-9})
            wc = np.clip(o.x, 0, 1)
            wc = wc / wc.sum() if wc.sum() > 0 else wc
            pm = float(np.mean((yc[:np_] - Gs @ wc) ** 2))
            qm = float(np.mean((yc[np_:] - wide.loc[subs, cols].astype(float)
                                .values[:, np_:].T @ wc) ** 2))
            if pm > 0:
                ratios.append(qm / pm)
        ratios = np.array(ratios)
        true_r = post_mspe / pre_mspe if pre_mspe > 0 else np.inf
        p_val = float(np.mean(ratios >= true_r)) if len(ratios) else None
        donor_capped = len(donors_all) > MAX_DONOR
        return {
            "method": "合成控制法 (Synthetic Control)", "method_key": "scm",
            "dep_var": cfg["y"], "nobs": _i(len(y1)), "n_donor": _i(nd),
            "treated_unit": unit, "se_type": "安慰剂检验 (置换推断)",
            "coefficients": [{"variable": "平均处理效应", "role": "core", "coef": _f(effect),
                              "std_err": None, "t": None, "p": _f(p_val, 6),
                              "ci_low": None, "ci_high": None, "stars": _stars(_f(p_val, 6))}],
            "pre_mspe": _f(pre_mspe), "post_mspe": _f(post_mspe), "mspe_ratio": _f(true_r, 3),
            "placebo_p": _f(p_val, 4),
            "donor_weights": [{"unit": str(u), "weight": _f(ww, 4)} for u, ww in dw],
            "gap_series": [{"time": _f(t_, 2), "gap": _f(g, 4)} for t_, g in zip(cols, gap)],
            "stata_code": (f"synth {cfg['y']} " + " ".join(cfg["ctrl"]) + ", "
                           f"trunit({unit}) trperiod({int(pre_end)})"),
            "notes": [f"MSPE 比率 = {_f(true_r, 3)}，安慰剂检验 p = {_f(p_val, 4)}",
                      f"p < 0.1 表明真实单位的效果比大多数安慰剂单位更极端",
                      f"对照单位权重之和为 1，共 {len(dw)} 个单位获得正权重"],
        }

    # ═════════════════════════════════════════════════════════
    # 非线性与稳健性
    # ═════════════════════════════════════════════════════════

    def _discrete(self, df, config, kind):
        import statsmodels.api as sm
        cfg = self._cfg(df, config)
        y, X, side, labels = self._design(df, cfg)
        Xc = _add_const(X)
        endog = y.values.astype(float)
        if kind in ("logit", "probit"):
            endog = (endog > 0).astype(float)
            if len(np.unique(endog)) != 2:
                raise ValueError("被解释变量需同时包含 0 和 1")
        elif kind == "poisson" and np.any(endog < 0):
            raise ValueError("泊松回归的被解释变量不能为负")
        Xv = Xc.values.astype(float)
        model = (sm.Logit(endog, Xv) if kind == "logit" else
                 sm.Probit(endog, Xv) if kind == "probit" else sm.Poisson(endog, Xv))
        res = model.fit(disp=0, maxiter=300)
        bse, tv, pv = self._se_sm(Xc, endog, Xv, res, side, cfg)
        roles = self._roles(cfg, Xc.columns, labels)
        label = {"logit": "二元 Logit 回归", "probit": "二元 Probit 回归",
                 "poisson": "泊松回归"}[kind]
        out = {
            "method": label, "method_key": kind, "dep_var": cfg["y"],
            "nobs": _i(int(res.nobs)), "se_type": self._se_desc(cfg),
            "coefficients": self._table(Xc.columns, np.asarray(res.params), np.asarray(bse),
                                        np.asarray(tv), np.asarray(pv), roles,
                                        labels=labels),
            "stata_code": self._stata(cfg, f"{kind} {cfg['y']}"),
        }
        if kind in ("logit", "probit"):
            n = len(endog)
            pbar = float(np.mean(endog))
            # 截距模型的 log-likelihood：n * [p·ln p + (1−p)·ln(1−p)]
            ll0 = n * (pbar * math.log(max(pbar, 1e-12)) +
                       (1 - pbar) * math.log(max(1 - pbar, 1e-12)))
            out["pseudo_r2"] = _f(1 - float(res.llf) / ll0) if abs(ll0) > 1e-9 else None
            out["log_likelihood"] = _f(float(res.llf), 3)
            out["lr_p"] = _f(float(res.llr_pvalue), 6)
            out["notes"] = [
                f"系数为{'对数几率 log-odds' if kind == 'logit' else '潜变量'}的变化，"
                "经济意义需转换为边际效应 dy/dx",
                f"伪 R² (McFadden) = {out['pseudo_r2']}，对数似然 = {out['log_likelihood']}",
                "可点击下方按钮查看各变量在样本均值处的边际效应",
            ]
        elif kind == "poisson":
            out["pseudo_r2"] = _f(getattr(res, "prsquared", None))
            conv = "（注：迭代未完全收敛，请检查自变量量纲或改用负二项回归）" \
                if not getattr(res, "mle_retval", {}).get("converged", True) else ""
            out["notes"] = ["泊松系数需取指数得到发生率比 IRR = exp(coef)",
                            "若存在过度离散，应改用负二项回归", conv] if conv else \
                           ["泊松系数需取指数得到发生率比 IRR = exp(coef)",
                            "若存在过度离散，应改用负二项回归"]
        return out

    def _m_logit(self, df, config):
        return self._discrete(df, config, "logit")

    def _m_probit(self, df, config):
        return self._discrete(df, config, "probit")

    def _m_poisson(self, df, config):
        return self._discrete(df, config, "poisson")

    def _m_tobit(self, df, config):
        from scipy.optimize import minimize
        import statsmodels.api as sm
        cfg = self._cfg(df, config, allow_empty_core=True)
        left = config.get("left_censor")
        left = float(left) if left not in (None, "") else 0.0
        right = config.get("right_censor")
        right = float(right) if right not in (None, "") else None
        y, X, side, labels = self._design(df, cfg)
        Xc = _add_const(X)
        Xv = Xc.values.astype(float)
        yv = y.values.astype(float)

        def negll(th):
            b, ls = th[:-1], th[-1]
            s = math.exp(ls)
            mu = Xv @ b
            ll = 0.0
            unc = ~((yv <= left) | (yv >= right)) if right is not None else (yv > left)
            ll += float(np.sum(np.log(np.maximum(stats.norm.pdf((yv[unc] - mu[unc]) / s) / s, 1e-300))))
            if left is not None and np.any(yv <= left):
                cl = yv <= left
                ll += float(np.sum(np.log(np.maximum(
                    stats.norm.cdf((left - mu[cl]) / max(s, 1e-9)), 1e-300))))
            if right is not None and np.any(yv >= right):
                cr = yv >= right
                ll += float(np.sum(np.log(np.maximum(
                    stats.norm.cdf((mu[cr] - right) / max(s, 1e-9)), 1e-300))))
            return -ll

        ols = sm.OLS(yv, Xv).fit()
        th0 = np.concatenate([ols.params, [math.log(max(float(np.sqrt(ols.mse_resid)), 1e-6))]])
        opt = minimize(negll, th0, method="L-BFGS-B", options={"maxiter": 3000})
        th = opt.x
        b, ls = th[:-1], th[-1]
        # 数值黑塞矩阵求逆，得到 MLE 的渐近协方差
        cov = _num_hess_inv(negll, th)
        se_b = np.sqrt(np.maximum(np.diag(cov)[:-1], 0))
        t = b / np.where(se_b > 0, se_b, np.nan)
        p = np.array([_t_pvalue(ti, len(yv) - len(b)) for ti in t])
        rows = self._table(Xc.columns, b, se_b, t, p,
                           self._roles(cfg, Xc.columns, labels), labels=labels)
        rows.append({"variable": "_sigma (log)", "role": "stat", "coef": _f(float(ls)),
                     "std_err": _f(float(np.sqrt(cov[-1, -1]))),
                     "t": _f(float(ls) / float(np.sqrt(max(cov[-1, -1], 1e-300))), 3),
                     "p": None, "ci_low": None, "ci_high": None, "stars": ""})
        rows.append({"variable": "sigma (exp)", "role": "stat", "coef": _f(math.exp(float(ls))),
                     "std_err": None, "t": None, "p": None, "ci_low": None, "ci_high": None,
                     "stars": ""})
        nl = int(np.sum(yv <= left))
        nr = int(np.sum(yv >= right)) if right is not None else 0
        return {
            "method": "Tobit 截断回归 (MLE)", "method_key": "tobit",
            "dep_var": cfg["y"], "nobs": _i(len(yv)),
            "n_censored_left": _i(nl), "n_censored_right": _i(nr),
            "n_uncensored": _i(len(yv) - nl - nr),
            "se_type": "极大似然渐近标准误",
            "coefficients": rows, "log_likelihood": _f(-float(opt.fun), 3),
            "stata_code": self._stata(cfg, f"tobit {cfg['y']}",
                                      extra=[f"ll({_f(left, 4)})" +
                                             (f" ul({_f(right, 4)})" if right is not None else "")]),
            "notes": [f"左截断 {nl} 个观测，右截断 {nr} 个观测",
                      "Tobit 要求数据为归并 (censoring) 而非断尾 (truncation)",
                      "sigma = exp(_sigma)，即结构方程扰动项标准差"],
        }

    def _m_heckman(self, df, config):
        import statsmodels.api as sm
        cfg = self._cfg(df, config, allow_empty_core=True)
        sv = config.get("selection_var")
        if not sv or sv not in df.columns:
            raise ValueError("Heckman 需要指定选择方程的 0/1 变量")
        full = df[[cfg["y"]] + [v for v in (list(cfg["core"]) + list(cfg["ctrl"]) + [sv]) if v in df.columns]]
        for c in full.columns:
            full[c] = pd.to_numeric(full[c], errors="coerce")
        sel_all = full[sv].values.round().astype(float)
        Zcols = [c for c in full.columns if c not in (cfg["y"], sv)]
        Zf = _add_const(full[Zcols])
        mask_sel = Zf.notna().all(axis=1) & ~np.isnan(sel_all)
        selv = sel_all[mask_sel.values]
        Zv = Zf[mask_sel].values.astype(float)
        if len(np.unique(selv)) != 2:
            raise ValueError("选择变量必须为 0/1 二值")
        pr = sm.Probit(selv, Zv).fit(disp=0)
        zb = Zv @ pr.params
        lam = stats.norm.pdf(zb) / np.maximum(stats.norm.cdf(zb), 1e-9)
        out_mask = mask_sel.values & (~full[cfg["y"]].isna().values) & (selv == 1)
        yo = full[cfg["y"]].values[out_mask].astype(float)
        Zo_base = Zf.values.astype(float)[out_mask]
        lam_o = lam[out_mask]
        Xo = np.column_stack([Zo_base, lam_o])
        names = ["const"] + Zcols + ["IMR (mills)"]
        res = sm.OLS(yo, Xo).fit()
        cv = [np.asarray(df[v].values[out_mask]) for v in cfg["cluster_vars"]]
        if cfg["se_type"] == "cluster" and cv:
            V = cluster_cov(Xo, np.asarray(res.resid, dtype=float), cv)
            se = np.sqrt(np.maximum(np.diag(V), 0))
            df_r = max(len(yo) - Xo.shape[1], 1)
            t = res.params / np.where(se > 0, se, np.nan)
            p = np.array([_t_pvalue(ti, df_r) for ti in t])
        elif cfg["se_type"] == "robust":
            r2 = res.get_robustcov_results(cov_type="HC1")
            se, t, p = r2.bse, r2.tvalues, r2.pvalues
        else:
            se, t, p = res.bse, res.tvalues, res.pvalues
        roles = self._roles(cfg, Zcols + ["IMR (mills)"], {c: c for c in Zcols})
        roles["const"] = "stat"
        roles["IMR (mills)"] = "stat"
        lam_p = _f(p[names.index("IMR (mills)")], 6)
        return {
            "method": "Heckman 两步法 (样本选择纠正)", "method_key": "heckman",
            "dep_var": cfg["y"], "selection_var": sv, "nobs": _i(int(res.nobs)),
            "n_selected": _i(int((selv == 1).sum())), "n_unselected": _i(int((selv == 0).sum())),
            "se_type": self._se_desc(cfg),
            "coefficients": self._table(names, res.params, se, t, p, roles,
                                        labels={c: c for c in Zcols}),
            "selection_test": {
                "imr_coef": _f(res.params[names.index("IMR (mills)")]),
                "imr_se": _f(se[names.index("IMR (mills)")]), "p": lam_p, "stars": _stars(lam_p),
                "verdict": ("存在样本选择偏误（IMR 显著），应使用 Heckman 纠正"
                            if lam_p is not None and lam_p < 0.10 else
                            "IMR 不显著，样本选择偏误不明显，可考虑普通 OLS"),
            },
            "stata_code": (f"heckman {cfg['y']}, "
                           f"select({sv} = {' '.join(cfg['core'] + cfg['ctrl'])})"),
            "notes": ["两步法标准误未做完全修正，推断宜偏保守",
                      "IMR (逆米尔斯比率) 显著说明存在选择性偏误"],
        }

    def _m_quantile(self, df, config):
        import statsmodels.api as sm
        cfg = self._cfg(df, config)
        tau = float(config.get("tau") or 0.5)
        tau = min(max(tau, 0.01), 0.99)
        y, X, side, labels = self._design(df, cfg)
        Xc = _add_const(X)
        res = sm.QuantReg(y.values.astype(float), Xc.values.astype(float)).fit(
            q=tau, max_iter=5000, p_tol=1e-8)
        roles = self._roles(cfg, Xc.columns, labels)
        try:
            u = y.values.astype(float) - Xc.values.astype(float) @ res.params
            rho = np.where(u >= 0, tau * u, (tau - 1) * u)
            rho0 = np.abs(y.values.astype(float) - np.mean(y.values.astype(float)))
            pseudo = float(1 - np.sum(rho) / np.sum(np.minimum(tau, 1 - tau) * np.abs(rho0) * 2))
        except Exception:
            pseudo = None
        return {
            "method": f"分位数回归 (τ = {tau})", "method_key": "quantile",
            "dep_var": cfg["y"], "tau": tau, "nobs": _i(int(res.nobs)),
            "se_type": "Koenker–Bassett 自助标准误",
            "coefficients": self._table(Xc.columns, res.params, res.bse, res.tvalues,
                                        res.pvalues, roles, labels=labels),
            "pseudo_r2": _f(pseudo),
            "stata_code": self._stata(cfg, f"qreg {cfg['y']}", extra=[f"q({tau})"]),
            "notes": ["可在不同 τ 下重复估计，考察效应的分布异质性",
                      "标准误为渐近自助法结果，小样本下谨慎"],
        }

    def _m_threshold(self, df, config):
        cfg = self._cfg(df, config)
        qv = config.get("threshold_var")
        if not qv or qv not in df.columns:
            raise ValueError("门槛回归需要指定门槛变量")
        y, X, side, labels = self._design(df, cfg, keep=[qv])
        y, X, side, dpf = self._panel_frame(y, X, side, cfg)
        dp = dpf.index
        yv = pd.Series(y.values.astype(float), index=dp)
        Xv = pd.DataFrame(X.values.astype(float), index=dp, columns=X.columns)
        qs = pd.Series(np.asarray(side[qv], dtype=float), index=dp)
        g = np.asarray(dp.get_level_values(0))
        yw = yv - yv.groupby(g).transform("mean")
        Xw = Xv.apply(lambda c: c - c.groupby(g).transform("mean"))
        qw = qs - qs.groupby(g).transform("mean")
        trim = min(max(float(config.get("trim_pct") or 10) / 100, 0.01), 0.45)
        nb = int(min(max(config.get("n_boot") or 200, 0), 500))
        cand = np.unique(np.quantile(qw.dropna().values, np.linspace(trim, 1 - trim, 300)))
        Xa = Xw.values

        ywv = yw.values
        qv_vals = qw.values
        k_ = Xa.shape[1]

        def ne_rss(ZtZ, Zty, yty):
            """由正规方程求 RSS"""
            try:
                b = np.linalg.solve(ZtZ, Zty)
            except Exception:
                b = np.linalg.pinv(ZtZ) @ Zty
            return yty - 2 * float(b @ Zty) + float(b @ ZtZ @ b)

        def build_norms(Xb, h, yb):
            """组装双区制设计矩阵的 ZtZ（2k×2k）与 Zty"""
            Xh = Xb * h[:, None]
            A = Xb.T @ Xb
            D = Xh.T @ Xb
            E = Xh.T @ Xh
            ZtZ = np.empty((2 * Xb.shape[1], 2 * Xb.shape[1]))
            ZtZ[:k_, :k_] = A
            ZtZ[:k_, k_:] = D
            ZtZ[k_:, :k_] = D.T
            ZtZ[k_:, k_:] = E
            return ZtZ, np.concatenate([Xb.T @ yb, Xh.T @ yb])

        # ── 无门槛（线性）基准 ──
        lin_ZtZ = Xa.T @ Xa
        lin_Zty = Xa.T @ ywv
        yty = float(ywv @ ywv)
        lin_rss = ne_rss(lin_ZtZ, lin_Zty, yty)
        try:
            lin_b = np.linalg.solve(lin_ZtZ, lin_Zty)
        except Exception:
            lin_b = np.linalg.pinv(lin_ZtZ) @ lin_Zty

        def rss_at(c, Xb=None, yb=None, qb=None):
            h = ((qw.values if qb is None else qb) > c).astype(float)
            if h.sum() < 15 or (1 - h).sum() < 15:
                return None, h
            Xuse = Xa if Xb is None else Xb
            yuse = ywv if yb is None else yb
            ZtZ, Zty = build_norms(Xuse, h, yuse)
            try:
                return ne_rss(ZtZ, Zty, float(yuse @ yuse)), h
            except Exception:
                return None, h

        best_rss, best_c, best_h = np.inf, None, None
        for c in cand:
            r, h = rss_at(c)
            if r is not None and r < best_rss:
                best_rss, best_c, best_h = r, c, h
        if best_c is None:
            raise ValueError("门槛变量取值过于集中，无法搜索到有效门槛")

        # ── 最终估计 ──
        Z = np.column_stack([Xa, best_h[:, None] * Xa])
        try:
            beta = np.linalg.solve(Z.T @ Z, Z.T @ ywv)
        except Exception:
            beta = np.linalg.lstsq(Z, ywv, rcond=None)[0]
        resid = ywv - Z @ beta
        n, kk = Z.shape
        s2 = float(resid @ resid) / max(n - kk, 1)
        V = s2 * np.linalg.pinv(Z.T @ Z)
        if cfg["se_type"] == "cluster" and cfg["cluster_vars"]:
            V = cluster_cov(Z, resid, [np.asarray(dp[v]) for v in cfg["cluster_vars"]])
        se = np.sqrt(np.maximum(np.diag(V), 0))
        tv = beta / np.where(se > 0, se, np.nan)
        p = np.array([_t_pvalue(x, n - kk) for x in tv])
        names = [str(c) for c in Xv.columns] + [f"{c} | {qv}>{_f(best_c, 3)}" for c in Xv.columns]
        roles = {nm: ("core" if nm.split(" |")[0] in cfg["core"] else "control") for nm in names}

        # ── 自举辅助检验：H0「不存在门槛效应」──
        stat0 = (lin_rss - best_rss) / max(s2, 1e-12)
        step = max(1, len(cand) // 20)
        grid_boot = cand[::step][:20]
        # 预建分组索引，避免每轮重建（factorize 比逐组比较快得多）
        gv = np.asarray(g)
        codes, uniq = pd.factorize(gv)
        gidx = {u: np.flatnonzero(codes == j) for j, u in enumerate(uniq)}
        nb_eff = nb
        if nb_eff and grid_boot.size:
            nb_eff = min(nb_eff, 100)
        count, valid = 0, 0
        t_start = time.time()
        if nb_eff > 0:
            rng = np.random.default_rng(42)
            for _ in range(int(nb_eff)):
                if time.time() - t_start > 40:
                    break
                idx = np.concatenate([gidx[uniq[j]] for j in
                                      rng.choice(len(uniq), len(uniq), replace=True)])
                yb, Xb, qb = ywv[idx], Xa[idx], qw.values[idx]
                rb = np.inf
                for c in grid_boot:
                    r, _ = rss_at(c, Xb, yb, qb)
                    if r is not None and r < rb:
                        rb = r
                if rb == np.inf:
                    continue
                hw = (qb > best_c).astype(float)
                if hw.sum() < 10 or (1 - hw).sum() < 10:
                    continue
                ZtZw, Ztyw = build_norms(Xb, hw, yb)
                try:
                    rw = ne_rss(ZtZw, Ztyw, float(yb @ yb))
                    lr = ne_rss(Xb.T @ Xb, Xb.T @ yb, float(yb @ yb))
                except Exception:
                    continue
                vm = max(len(yb) - 2 * k_, 1)
                valid += 1
                if (lr - rb) / max(rw / vm, s2, 1e-12) >= stat0:
                    count += 1
        boot_p = (count / valid) if valid else None
        ywv = yw.values
        qv_vals = qw.values

        def fit(Z, y):
            """正规方程 OLS，奇异时退回广义逆"""
            ZtZ, Zty = Z.T @ Z, Z.T @ y
            try:
                b = np.linalg.solve(ZtZ, Zty)
            except Exception:
                b = np.linalg.pinv(ZtZ) @ Zty
            return b, (float(y @ y) - 2 * float(b @ Zty) + float(b @ ZtZ @ b))

        try:
            lin_b, lin_rss = fit(Xa, ywv)
        except Exception:
            lin_b = np.linalg.lstsq(Xa, ywv, rcond=None)[0]
            lin_rss = float(np.sum((ywv - Xa @ lin_b) ** 2))

        def rss_at(c, Xb, yb, qb):
            h = (qb > c).astype(float)
            if h.sum() < 15 or (1 - h).sum() < 15:
                return None, h
            Z = np.column_stack([Xb, h[:, None] * Xb])
            try:
                _, r = fit(Z, yb)
                return r, h
            except Exception:
                return None, h

        best_rss, best_c, best_h = np.inf, None, None
        for c in cand:
            r, h = rss_at(c, Xa, ywv, qw.values)
            if r is not None and r < best_rss:
                best_rss, best_c, best_h = r, c, h
        if best_c is None:
            raise ValueError("门槛变量取值过于集中，无法搜索到有效门槛")

        Z = np.column_stack([Xa, best_h[:, None] * Xa])
        beta, _ = fit(Z, ywv)
        resid = ywv - Z @ beta
        n, k = Z.shape
        s2 = float(resid @ resid) / max(n - k, 1)
        V = s2 * np.linalg.pinv(Z.T @ Z)
        if cfg["se_type"] == "cluster" and cfg["cluster_vars"]:
            V = cluster_cov(Z, resid, [np.asarray(dp[v]) for v in cfg["cluster_vars"]])
        se = np.sqrt(np.maximum(np.diag(V), 0))
        t = beta / np.where(se > 0, se, np.nan)
        p = np.array([_t_pvalue(ti, n - k) for ti in t])
        names = [str(c) for c in Xv.columns] + [f"{c} | {qv}>{_f(best_c, 3)}" for c in Xv.columns]
        roles = {nm: ("core" if nm.split(" |")[0] in cfg["core"] else "control") for nm in names}

        # 自举辅助检验：H0「不存在门槛效应」
        stat0 = (lin_rss - best_rss) / max(s2, 1e-12)
        step = max(1, len(cand) // 20)
        grid_boot = cand[::step][:20]
        # 预建分组索引，避免每轮重建（factorize 比逐组比较快得多）
        codes, uniq = pd.factorize(g)
        gidx = {u: np.flatnonzero(codes == j) for j, u in enumerate(uniq)}
        nb_eff = min(nb, 100) if nb else 0
        count, valid = 0, 0
        t_start = time.time()
        if nb_eff > 0:
            rng = np.random.default_rng(42)
            for _ in range(int(nb_eff)):
                if time.time() - t_start > 40:
                    break
                pick = rng.choice(len(uniq), len(uniq), replace=True)
                idx = np.concatenate([gidx[uniq[j]] for j in pick])
                yb, Xb, qb = ywv[idx], Xa[idx], qv_vals[idx]
                rb = np.inf
                for c in grid_boot:
                    r, _ = rss_at(c, Xb, yb, qb)
                    if r is not None and r < rb:
                        rb = r
                if rb == np.inf:
                    continue
                hw = (qb > best_c).astype(float)
                if hw.sum() < 10 or (1 - hw).sum() < 10:
                    continue
                ZtZw, Ztyw = build_norms(Xb, hw, yb)
                try:
                    rw = ne_rss(ZtZw, Ztyw, float(yb @ yb))
                    lr = ne_rss(Xb.T @ Xb, Xb.T @ yb, float(yb @ yb))
                except Exception:
                    continue
                vm = max(len(yb) - 2 * k_, 1)
                valid += 1
                if (lr - rb) / max(rw / vm, s2, 1e-12) >= stat0:
                    count += 1
        boot_p = (count / valid) if valid else None
        return {
            "method": "门槛回归 (Hansen 面板门槛)", "method_key": "threshold",
            "dep_var": cfg["y"], "nobs": _i(n), "threshold_var": qv,
            "threshold_value": _f(best_c, 4), "bootstrap_p": _f(boot_p, 4),
            "n_regime_low": _i(int((h == 0).sum())), "n_regime_high": _i(int((h == 1).sum())),
            "se_type": self._se_desc(cfg),
            "coefficients": self._table(names, beta, se, t, p, roles, labels=labels),
            "threshold_effect": ("门槛效应显著" if (boot_p is not None and boot_p < 0.10)
                                 else "门槛效应不显著"),
            "stata_code": (f"xthreg {cfg['y']} {' '.join(cfg['core'] + cfg['ctrl'])}, "
                           f"qx({qv}) thnum(1) grid(300) trim({config.get('trim_pct') or 10}) bs({nb})"),
            "absorbed": [f"{cfg['id_var']}: 已按个体去均值吸收个体固定效应"],
            "notes": [f"门槛估计值 γ = {_f(best_c, 4)}",
                      f"自举 {valid} 轮的辅助 p 值 = {_f(boot_p, 4)}",
                      "若 p < 0.1 说明存在显著门槛效应",
                      "可继续搜索双门槛（thnum(2)）以检验门槛个数"],
        }


regression_service = RegressionService()
