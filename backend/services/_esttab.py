# -*- coding: utf-8 -*-
"""多模型对照表（esttab 式合并）。

Stata 里把 (1)–(4) 列回归逐个 `eststo` 存起来，最后 `esttab` 一次出表。
本模块是同一件事的服务端实现：把 N 份 (method, config) 顺序跑完，
按**系数显示名**对齐成一张矩阵。

对齐靠 coefficients[].variable，所以系数行必须是给人看的显示名，
不能是 __did__ / __evt-3__ 这类内部列名——那是 regression_service._table
的 labels 参数负责的事，这里只管合并。

三类情况不能默默合并，一律写进 notes，由前端和导出一并展示：
  1. 目标参数不同：TWFE/DID 与 csdid/sunab 估的不是同一个量；
  2. 样本量不一致：各列 N 不同却横向比系数是常见错误；
  3. 被解释变量不一致：此时 R² 不可跨列比较。

rows 全部返回（含控制变量），显示哪些由调用方按 filter_rows 决定——
不然前端切一次「只看核心变量」就要把 5 列回归重跑一遍。
"""
from typing import List, Optional

from .regression_service import regression_service

# 内部会吸收个体/时间固定效应的方法（did_service 的三种也是两向 FE 设定）
ENTITY_FE_KEYS = {"fe", "twoway_fe", "did", "event_study", "gmm", "threshold",
                  "csdid", "sunab", "did2s"}
TIME_FE_KEYS = {"te", "twoway_fe", "did", "event_study", "csdid", "sunab", "did2s"}
# 交错采纳估计量：目标参数是 ATT(g,t)
STAGGERED_KEYS = {"csdid", "sunab", "did2s"}
# TWFE 类：交错采纳下系数是含 forbidden comparison 的加权平均
TWFE_KEYS = {"did", "event_study", "twoway_fe", "fe"}

CONST_NAMES = {"const", "_cons", "Const"}

ROW_MODES = ("core", "core_const", "all")


def filter_rows(rows: List[dict], mode: str = "core") -> List[dict]:
    """core=只看核心变量（默认）｜ core_const=加 _cons ｜ all=全部系数。"""
    if mode not in ROW_MODES:
        mode = "core"
    if mode == "all":
        return list(rows or [])
    if mode == "core_const":
        return [r for r in (rows or []) if r.get("kind") in ("core", "const")]
    return [r for r in (rows or []) if r.get("kind") == "core"]


def _cell(res: dict, names) -> Optional[dict]:
    """从一份回归结果里取名列中的第一个单元格；没有就 None（该列未含此变量）。

    names 可以是字符串或字符串列表——同一个概念在两列里叫不同名字时
    （"Treat×Post" 与 "didvar"），靠 row_aliases 归到一个行上，逐个别名找。
    """
    if isinstance(names, str):
        names = [names]
    for name in names:
        for c in (res.get("coefficients") or []):
            if c.get("variable") == name:
                return {"coef": c.get("coef"), "se": c.get("std_err"),
                        "p": c.get("p"), "stars": c.get("stars") or "",
                        "t": c.get("t")}
    return None


def _col_meta(label: str, res: dict, config: dict) -> dict:
    key = res.get("method_key")
    absorbed = [str(a) for a in (res.get("absorbed") or [])]
    coeffs = res.get("coefficients") or []
    return {
        "label": label,
        "dep_var": res.get("dep_var") or config.get("y_var"),
        "method": res.get("method") or key,
        "method_key": key,
        "nobs": res.get("nobs"),
        "n_entities": res.get("n_entities"),
        "n_periods": res.get("n_periods"),
        "r_squared": res.get("r_squared"),
        "adj_r_squared": res.get("adj_r_squared"),
        "within_r_squared": res.get("within_r_squared"),
        "f_stat": res.get("f_stat"),
        "f_pvalue": res.get("f_pvalue"),
        "se_type": res.get("se_type"),
        "stata_code": res.get("stata_code"),
        "absorbed": absorbed,
        "error": res.get("error"),
        "has_controls": any(c.get("role") == "control" for c in coeffs),
        "has_entity_fe": (key in ENTITY_FE_KEYS or
                          any("个体固定效应已吸收" in a for a in absorbed)),
        "has_time_fe": (key in TIME_FE_KEYS or
                        any("时间固定效应已吸收" in a for a in absorbed)),
        "is_staggered": key in STAGGERED_KEYS,
        "is_twfe": key in TWFE_KEYS,
    }


def _align(results: List[dict], aliases: Optional[dict] = None) -> List[dict]:
    """收行顺序：先所有核心变量，再控制变量，最后 _cons。

    不用「按第一个出现的列」那种朴素顺序——那样第 2 列新增的核心变量会被
    排到第 1 列的常数项后面，表头顶上就不是核心变量了。

    aliases 把不同列里的不同名字归到同一行（esttab 的 rename 干的事）：
    {"didvar": "DID 交互项 (Treat×Post)"} 会让第 3 列那个 didvar 与
    前两列的交互项并到一行。
    """
    aliases = {str(k): str(v) for k, v in (aliases or {}).items() if v}
    buckets = {"core": [], "control": [], "const": []}
    seen_names = set()
    key_raws = {}

    for res in results:
        if res.get("error"):
            continue
        seen = set()
        for c in (res.get("coefficients") or []):
            name = str(c.get("variable") or "").strip()
            if not name or name in seen:
                continue
            seen.add(name)
            if name in CONST_NAMES:
                kind = "const"
            else:
                kind = c.get("role") or "control"
                # stat 行（Treat 主效应、sigma 等）不进合并表
                if kind not in ("core", "control"):
                    continue
            key = aliases.get(name, name)
            key_raws.setdefault(key, [])
            if name not in key_raws[key]:
                key_raws[key].append(name)
            if key not in seen_names:
                seen_names.add(key)
                buckets[kind].append(key)

    rows = []
    for kind in ("core", "control", "const"):
        for key in buckets[kind]:
            raws = key_raws[key]
            rows.append({
                "name": key,
                "raw_name": raws[0],
                "raw_names": raws,
                "kind": kind,
                "cells": [_cell(r, raws) for r in results],
            })
    return rows


def _spec_rows(cols: List[dict]) -> List[dict]:
    """控制变量 / 固定效应的「是/否」行。

    论文里的基准表不把 10 个控制变量的系数全摊开，压成表尾几行是/否。
    """

    def row(name, key):
        return {"name": name, "kind": "spec",
                "cells": [{"value": "是" if c.get(key) else "否"} for c in cols]}

    return [row("控制变量", "has_controls"),
            row("个体固定效应", "has_entity_fe"),
            row("时间固定效应", "has_time_fe")]


def _fmt_int(v):
    if v is None:
        return ""
    try:
        return f"{int(v):,}"
    except Exception:
        return str(v)


def _fmt_num(v, nd=4):
    if v is None:
        return ""
    try:
        return f"{float(v):.{nd}f}"
    except Exception:
        return str(v)


def _stat_rows(cols: List[dict]) -> List[dict]:
    """数值统计量行。某列没有该统计量就留空，不填 0。"""

    def row(name, key, fmt=_fmt_int):
        return {"name": name, "kind": "stat",
                "cells": [{"value": "" if c.get("error") else fmt(c.get(key))}
                          for c in cols]}

    return [row("Observations", "nobs"),
            row("R²", "r_squared", lambda v: _fmt_num(v, 4)),
            row("调整 R²", "adj_r_squared", lambda v: _fmt_num(v, 4)),
            row("Within R²", "within_r_squared", lambda v: _fmt_num(v, 4)),
            row("个体数", "n_entities"),
            row("期数", "n_periods"),
            row("F 统计量", "f_stat", lambda v: _fmt_num(v, 3))]


def _notes(cols: List[dict]) -> List[str]:
    notes = []
    ok = [c for c in cols if not c.get("error")]

    for i, c in enumerate(cols):
        if c.get("error"):
            notes.append(f"第 ({i + 1}) 列「{c['label']}」运行失败：{c['error']}")

    if len(ok) >= 2:
        nobs = {c["nobs"] for c in ok if c.get("nobs") is not None}
        if len(nobs) > 1:
            notes.append("各列样本量不一致（最小 {:,}，最大 {:,}）：横向比较系数前需确认"
                         "样本差异来自哪里（缺失、剔除、窗口不同）。".format(
                             min(nobs), max(nobs)))
        deps = {str(c.get("dep_var")) for c in ok if c.get("dep_var")}
        if len(deps) > 1:
            notes.append("各列被解释变量不同（{}）：R² 与常数项不可跨列比较。".format(
                "、".join(sorted(deps))))
        ses = {str(c.get("se_type")) for c in ok if c.get("se_type")}
        if len(ses) > 1:
            notes.append("各列标准误口径不一致（{}），显著性星号不可直接横向比较。".format(
                "；".join(sorted(ses))))
        if any(c.get("is_staggered") for c in ok) and any(
                c.get("is_twfe") for c in ok):
            notes.append(
                "表中混用了 TWFE/DID 与交错采纳估计量（Callaway–Sant'Anna、"
                "Sun–Abraham、Gardner 两阶段）：TWFE 系数在交错采纳下是含 "
                "forbidden comparison 的加权平均，后三者估的是 ATT(g,t)，"
                "并列展示不等于可比。")

    if any(c.get("absorbed") for c in ok):
        notes.append("固定效应吸收情况见各列「等价的 Stata 命令」，已吸收的变量不单独成行。")
    return notes


def build_esttab(models: list, data_service=None, row_aliases: dict = None) -> dict:
    """models: [{"label": "(1)", "method": "twoway_fe", "config": {...}}, ...]

    row_aliases: {原始变量名: 表里显示的名字}，把不同列里同一概念的不同名字
    并到一行。单列失败不掀翻整张表：该列系数全空，notes 里记下原因。
    """
    cols, results = [], []
    for i, m in enumerate(models or []):
        label = str(m.get("label") or "").strip() or f"({i + 1})"
        method = m.get("method")
        config = m.get("config") or {}
        try:
            res = regression_service.run(method, config, data_service)
        except Exception as e:
            res = {"error": f"{type(e).__name__}: {e}"}
        cols.append(_col_meta(label, res, config))
        results.append(res)

    return {
        "kind": "esttab",
        "columns": cols,
        "rows": _align(results, row_aliases),
        "spec_rows": _spec_rows(cols),
        "stat_rows": _stat_rows(cols),
        "notes": _notes(cols),
        "n_cols": len(cols),
    }


def standard_sequence(config: dict) -> list:
    """基准表经典五列：无控制 → 加控制 → 个体 FE → 双向 FE → 双 FE + 聚类。

    只改需要在当前设定上改的字段，因变量、核心变量、面板变量、聚类层级
    都保持用户在页面上选的样子。当前已用聚类标准误时不出第 5 列（前 4 列
    本来就是聚类口径，再加一列纯属重复）。
    """
    base = dict(config or {})
    id_var, time_var = base.get("id_var"), base.get("time_var")
    controls = base.get("controls") or []
    se_type = base.get("se_type") or "robust"

    plan = [
        ("(1)", dict(method="ols", controls=[], panel=None)),
        ("(2)", dict(method="ols", controls=controls, panel=None)),
        ("(3)", dict(method="fe", controls=controls, panel=True)),
        ("(4)", dict(method="twoway_fe", controls=controls, panel=True)),
    ]
    if se_type != "cluster":
        plan.append(("(5)", dict(method="twoway_fe", controls=controls,
                                 panel=True, cluster=True)))

    out = []
    for label, p in plan:
        cfg = dict(base)
        cfg["method"] = p["method"]
        cfg["controls"] = list(p["controls"] or [])
        if p["panel"]:
            cfg["id_var"], cfg["time_var"] = id_var, time_var
        else:
            cfg["id_var"], cfg["time_var"] = None, None
            cfg["absorb"] = []
        cfg["se_type"] = ("cluster" if p.get("cluster") else se_type)
        out.append({"label": label, "method": p["method"], "config": cfg})
    return out
