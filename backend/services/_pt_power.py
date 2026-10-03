# -*- coding: utf-8 -*-
"""事前趋势检验的功效层。

Roth (2022, AER: Insights 4(3)) 的核心结论：常规 pre-trends 检验的功效
低到「经济上不可接受的违背，也常常有约一半概率漏检」。所以「事前不显著」
往往是**估计不精确**，而不是假设成立的证据——它是信息量最小的状态。

三件可从 StatsPAI 直接拿到的东西：

  1. pretrends_power      检验对一个假想违背的功效。Roth 的 pretrends 包
                          默认参数下给的是 individual（逐点目视）口径；
                          joint（联合 Wald）口径也一并返回。
  2. pretrends_slope_for_power
                          「功效达到 50% 时，能检出的线性违背斜率」——
                          读者问「你的通过到底排除了什么」时该报的数字。
  3. sensitivity_rr       Rambachan–Roth 的 breakdown 值 M̄：后处理期趋势
                          违背相對最大前置期违背大到多少倍，结论才会翻盘。

诚实的限制（必须在 UI 上标明）：
    did_service.sunab 是按队列单独估 ATT 再加权聚合的，各 k 之间没有
    协方差；StatsPAI 在拿不到 model_info['vcv_pre'] 时会退到**对角协方差**
    并 warn。此时 MDE / 功效 / M̄ 都是**上偏近似**（低估正相关带来的信息），
    不能当精确值展示——所以本模块返回 covariance: "diagonal_fallback"。

引用（已按 StatsPAI CLAUDE.md §10 的零幻觉要求核对过作者/期刊/卷页）：
    Roth, J. (2022). Pretest with Caution: Event-Study Estimates after
        Testing for Parallel Trends. AER: Insights, 4(3), 305–322.
    Rambachan, A., & Roth, J. (2023). A More Credible Approach to
        Parallel Trends. Review of Economic Studies, 90(5), 2555–2591.
    Roth, J., Sant'Anna, P. H. C., Bilinski, A., & Poe, J. (2023).
        What's trending in difference-in-differences? Journal of
        Econometrics, 235(2), 2218–2244.
"""
import warnings
from typing import List, Optional


class _EventStudyShim:
    """只提供 pretrends_* 需要的属性，不必构造完整 CausalResult。

    pretrends_power 走 _extract_event_study(result)：先看
    result.model_info['event_study']，没有再看 result.detail。
    所以一个带 model_info 字典的轻量对象就够。
    """

    def __init__(self, es_df, vcv_pre=None):
        self.model_info = {"event_study": es_df}
        if vcv_pre is not None:
            self.model_info["vcv_pre"] = vcv_pre


def _finite(x):
    """非有限值（inf / nan）降级成 None。

    Rambachan–Roth 在部分不可识别时会给出 ±inf 的置信界，
    这些值过不了 JSON 序列化（FastAPI 直接 500），显示出来也没意义。
    """
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if v != v or v in (float("inf"), float("-inf")):
        return None
    return v


def _round4(x):
    """round 到 4 位，非有限值降级成 None。"""
    v = _finite(x)
    return None if v is None else round(v, 4)


def pre_trend_power(items: List[dict]) -> dict:
    """算功效层。items 同 parallel_trend_verdict：k / est / se / p。

    失败不抛异常——功效是加分项，拿不到就只返回 unavailable，
    不该让整张图出不来。
    """
    import numpy as np
    import pandas as pd

    pre_rows = [{"relative_time": int(it["k"]),
                 "estimate": float(it["est"]),
                 "se": float(it["se"])}
                for it in items
                if it.get("k") is not None and int(it["k"]) < 0
                and it.get("se")]
    if len(pre_rows) < 2:
        return {"available": False,
                "reason": "事前期不足 2 期，无法计算功效"}

    # 事后期的行数决定 sensitivity_rr 能不能算（它需要 relative_time >= 1）
    post_rows = [{"relative_time": int(it["k"]),
                  "estimate": float(it["est"]),
                  "se": float(it["se"])}
                 for it in items
                 if it.get("k") is not None and int(it["k"]) >= 1
                 and it.get("se")]

    out = {"available": True}
    try:
        import statspai as sp
        # pretrends_power 只用事前期；sensitivity_rr 要全期。
        # 传全期给两者，pretrends_power 自己会 _split_pre_post。
        es = pd.DataFrame(pre_rows + post_rows).sort_values("relative_time")

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            pw = sp.pretrends_power(_EventStudyShim(es))
            # 对角协方差近似时 StatsPAI 会 warn，这里如实记录下来
            out["covariance"] = (
                "diagonal_fallback"
                if any("vcv_pre" in str(c.message) for c in caught)
                else "reported"
            )

        # _finite 先挡掉 inf/nan，再 round；返回的仍是原始浮点
        out["power"] = _round4(pw["power"])
        out["power_joint"] = _round4(pw["power_joint"])
        out["power_under_null"] = _round4(pw["power_under_null"])
        out["bayes_factor"] = _round4(pw["bayes_factor"])
        out["test"] = pw.get("test", "individual")
        out["n_pre"] = int(pw.get("df", len(pre_rows)))
        out["warning"] = pw.get("warning") or ""

        # 功效 50% 时能检出的最小线性违背斜率
        try:
            with warnings.catch_warnings(record=True):
                warnings.simplefilter("ignore")
                sl = sp.pretrends_slope_for_power(_EventStudyShim(es))
            out["slope_for_half_power"] = _finite(sl["slope"])
            if out["slope_for_half_power"] is not None:
                out["slope_for_half_power"] = round(out["slope_for_half_power"], 6)
            out["slope_target_power"] = float(sl.get("target_power", 0.5))
        except Exception:
            out["slope_for_half_power"] = None

        # Rambachan–Roth breakdown 值
        # 需要 k >= 1 的期才能算，没有就明说，别静默 None
        if not post_rows:
            out["breakdown_mbar"] = None
            out["mbar_note"] = "窗口内没有事后期，无法计算 breakdown M̄"
        else:
            try:
                with warnings.catch_warnings(record=True):
                    warnings.simplefilter("ignore")
                    sr = sp.sensitivity_rr(_EventStudyShim(es), n_grid=16)
                out["breakdown_mbar"] = _finite(sr.breakdown_mbar)
                if out["breakdown_mbar"] is not None:
                    out["breakdown_mbar"] = round(out["breakdown_mbar"], 5)
                mbar = np.asarray(sr.mbar_grid, dtype=float)
                lo = np.asarray(sr.ci_lower, dtype=float)
                hi = np.asarray(sr.ci_upper, dtype=float)
                # Rambachan–Roth 在部分不可识别时会给 ±inf / nan，
                # 这些值过不了 JSON 序列化（FastAPI 直接 500），
                # 也不该原样显示——统一降级成 None。
                out["mbar_grid"] = [_round4(x) for x in mbar]
                out["ci_at_mbar"] = [[_round4(a), _round4(b)]
                                     for a, b in zip(lo, hi)]
                out["att"] = _round4(sr.att)
                out["att_se"] = _round4(sr.att_se)
            except Exception:
                out["breakdown_mbar"] = None

    except Exception as e:
        return {"available": False, "reason": f"{type(e).__name__}: {e}"}

    return out


def power_summary(pw: dict) -> Optional[str]:
    """把功效层压成一句话，接到 verdict 的 note 后面。

    unavailable（/ 数据不够）时返回 None，不要硬凑一句话。
    """
    if not pw.get("available"):
        return None
    if pw.get("covariance") == "diagonal_fallback":
        # 必须说清这是近似，否则读者会拿它当精确量
        head = "（注：各事件期协方差不可得，功效为对角近似的上偏估计）"
    else:
        head = ""

    bits = []
    p = pw.get("power")
    if p is not None:
        lvl = "低" if p < 0.5 else ("中等" if p < 0.8 else "充足")
        bits.append(f"事前趋势检验功效 {p:.2f}（{lvl}）")
    j = pw.get("power_joint")
    if j is not None:
        bits.append(f"联合 Wald 口径 {j:.2f}")
    s = pw.get("slope_for_half_power")
    if s is not None:
        bits.append(f"要有一半概率检出，事前违背斜率需达到 {s:.4f}/期")
    m = pw.get("breakdown_mbar")
    if m is not None:
        if m <= 0:
            bits.append("Rambachan–Roth breakdown M̄ = 0（任何同向违背都会翻盘）")
        else:
            bits.append(f"breakdown M̄ = {m:.3f}（后处理期违背达此前置期违背 "
                        f"{m:.2f} 倍以上结论才翻盘）")
    elif pw.get("mbar_note"):
        bits.append(pw["mbar_note"])

    if not bits:
        return None
    return head + "；".join(bits) + "。"
