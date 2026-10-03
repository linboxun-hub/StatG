# -*- coding: utf-8 -*-
"""平行趋势检验的结果判定——三处入口共用，避免各写一份。

规范定义（Roth, Sant'Anna, Bilinski & Poe 2023, JoE 235(2), §4.3）：
  "通过" = 所有前置期（k < 0）的事件研究系数在联合判断下均无法拒绝等于 0。
  这是对平行趋势假设的**否证性检验**（placebo test），不是对假设的验证——
  拒绝 ⇒ 假设在某处有问题；不拒绝 ≠ 假设成立。

事后系数**不参与**该假设的判定。原因有三层（Roth et al. §4.4，
Sun & Abraham 2021, JoE 225(2), Assumption 1 与 Prop. 3）：
  1. 假设的论域包含后处理期，但 Y(0) 在后处理期不可观测；
  2. 循环性——后处理系数就是待估参数本身，用它反证假设等于用结论验证前提；
  3. 异质性设计下事后系数本身被其他队列的动态效应污染，并不"干净"。

但"事前干净"不等于"检出效应"。事前不显著而事后也全不显著时，
DID 没有给出任何可报告的效应——这是信息量最小的状态。若此时仍打
"通过"，读者会把零效应当成"检出了效果且假设成立"。

因此这里把结论拆成**两个正交维度**：
  维度 1  假设是否可疑     → violated / 其余
  维度 2  是否检出效应     → detected / not_detected

四态（verdict）：
  violated       事前有显著偏离          → 红
  detected       事前干净 + 事后有显著    → 绿
  not_detected   事前干净 + 事后无显著    → 黄
  indeterminate  无事前期 / se 不可用     → 灰（禁止判"通过"）

阈值统一为 5% 双侧（|t| > 1.96）。此前三处分别是 |t|>1.96（两处）与
p<0.10（一处），同一个"通过"在不同入口标注不同。
"""
from typing import Iterable, List, Optional

THRESHOLD = 1.96          # 5% 双侧
P_CUTOFF = 0.05

_LABELS = {
    "violated": "未通过",
    "detected": "通过",
    "not_detected": "通过（未检出效应）",
    "indeterminate": "无法判断",
}

_TONES = {
    "violated": "red",
    "detected": "green",
    "not_detected": "amber",
    "indeterminate": "grey",
}


def _sig(est: Optional[float], se: Optional[float],
         p: Optional[float]):
    """单个系数是否显著。se 不可用时退回 p 值；两者都缺返回 None（无法判定）。"""
    if se:                       # se 为 0/None 时不能算 t 值
        return abs(est / se) > THRESHOLD
    if p is not None:
        return p < P_CUTOFF
    return None


def parallel_trend_verdict(items: Iterable[dict],
                           threshold: float = THRESHOLD,
                           with_power: bool = True) -> dict:
    """判定平行趋势检验结果。

    items: 可迭代，每项需含
        k    相对时点（int，事前为负）
        est  系数
        se   标准误（可为 None）
        p    p 值（可为 None，se 缺失时兜底）
    with_power: 是否附带 Roth (2022) 功效层。功效计算要调 StatsPAI，
        较慢且非必需，默认开；调用方可按需关掉。

    返回 dict：
        verdict          四态之一
        label            给用户看的中文标签
        tone             red / green / amber / grey
        message          一句话结论
        note             补充说明（只在需要警示时非空）
        power            功效层（with_power=False 时为 None）
        power_summary    功效层的一句话概括（无则 None）
        has_pre          是否真的做了事前检验
        pre_significant  显著偏离 0 的事前期
        post_significant 显著的事后期
    """
    pre_sig: List[int] = []
    post_sig: List[int] = []
    n_pre_with_se = 0          # 真正能检验的事前期个数
    n_pre_no_se = 0            # 有事前期但标准误不可用
    collected = []             # items 可能是生成器，循环里顺手留一份给功效层

    for it in items:
        collected.append(it)
        k = it.get("k")
        if k is None:
            continue
        try:
            k = int(k)
        except (TypeError, ValueError):
            continue
        est, se, p = it.get("est"), it.get("se"), it.get("p")
        sig = _sig(est, se, p)          # None 表示这一期无法判定
        if k < 0:
            if se:
                n_pre_with_se += 1
            else:
                # 事前期标准误不可用：它进不了判定，也不能就此算"通过"
                n_pre_no_se += 1
                continue
        if sig is None:
            continue
        if sig:
            (pre_sig if k < 0 else post_sig).append(k)

    # ── 功效层（Roth 2022）：只在真的做了事前检验时才算 ──
    # 拿不到就置 None——功效是补充信息，不该让判定失败。
    power = None
    power_line = None
    if with_power and n_pre_with_se >= 2:
        try:
            from ._pt_power import pre_trend_power, power_summary
            power = pre_trend_power(collected)
            power_line = power_summary(power)
        except Exception:
            power, power_line = None, None

    base = {
        "power": power,
        "power_summary": power_line,
        "pre_significant": pre_sig,
        "post_significant": post_sig,
    }

    # ── 第四态：什么都没检验 ──
    # 窗口左端 >= 0（例如 0,5）时 range() 里没有任何负期，pre_sig 会是空的，
    # 旧代码此时判"通过"——把"没做检验"读成了"检验通过"。
    if n_pre_with_se == 0:
        detail = ("窗口内没有事前期" if n_pre_no_se == 0 else
                  "事前期的标准误不可用")
        return {
            "verdict": "indeterminate",
            "label": _LABELS["indeterminate"],
            "tone": _TONES["indeterminate"],
            "message": f"无法做平行趋势检验：{detail}。",
            "note": ("平行趋势检验比较的是政策实施前的系数。请把「事件窗口」"
                     "的左端调到政策实施之前，例如 -3,1（事前四期、当期一期、"
                     "事后一期）或 -5,5。"),
            "has_pre": False,
            **base,
        }

    # ── 第一态：事前有显著偏离 → 假设可疑 ──
    if pre_sig:
        return {
            "verdict": "violated",
            "label": _LABELS["violated"],
            "tone": _TONES["violated"],
            "message": (f"{len(pre_sig)} 个事前系数显著异于 0"
                        f"（k={pre_sig}），两组在政策实施前走势已不同，"
                        "平行趋势假设不成立。"),
            "note": ("注意：事前系数显著只说明平行趋势在**某处**有问题，"
                     "无法区分是趋势不平行还是政策已被预期"
                     "（Sun & Abraham 2021, Assumption 2）。"
                     "建议改用 Callaway–Sant'Anna 或 Rambachan–Roth 敏感性分析。"),
            "has_pre": True,
            **base,
        }

    # ── 第二态：事前干净 + 事后有显著 → 检出效应 ──
    if post_sig:
        return {
            "verdict": "detected",
            "label": _LABELS["detected"],
            "tone": _TONES["detected"],
            "message": (f"所有事前系数均不显著，平行趋势假设未被拒绝；"
                        f"且 {len(post_sig)} 个事后系数显著（k={post_sig}）。"),
            "note": "",
            "has_pre": True,
            **base,
        }

    # ── 第三态：事前干净 + 事后也干净 → 未检出效应 ──
    note = ("这不违反 DID 假设，但也不构成「检出效果」的证据。"
            "常见成因：政策确实无效、样本功效不足（power）、"
            "处理时点或处理变量构造有误、或模型设定需要调整。"
            "报告时应写明未检出效应，不要只写「平行趋势通过」——"
            "pre-trends 检验通过的条件下，事后虚假显著的概率并不会降低"
            "（Roth 2022, AER: Insights 4(3)）。")
    return {
        "verdict": "not_detected",
        "label": _LABELS["not_detected"],
        "tone": _TONES["not_detected"],
        "message": ("所有事前系数均不显著，平行趋势假设未被拒绝；"
                    "但事后系数无一显著——未检出处理效应。"),
        # 功效层紧跟其后：这一态最该问的就是"是不是功效不够"
        "note": note + (("功效诊断：" + power_line) if power_line else ""),
        "has_pre": True,
        **base,
    }
