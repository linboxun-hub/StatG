# -*- coding: utf-8 -*-
"""数据清洗。

这个页面原来是假的：`执行清洗`只在本地数组里追加一条描述，既不调后端
也不改数据。所以同一个步骤能反复出现、缺失值永远不降、日志里"影响 45977"
是页面挂载时那份旧数字（连点三次一模一样），导出的还是原始数据。

这里把每种清洗真正做实。约定：每个方法返回
  {"ok": True,  "df": 新数据, "affected": 真正改变的行数/单元格数, "detail": 给人看的一句话}
  {"ok": False, "error": 为什么做不了}
affected == 0 表示这步什么都没改，调用方不该把它记成一步。
"""
import operator

import pandas as pd

MISSING_STRATEGIES = ("drop", "mean", "median", "mode", "ffill", "constant")
NORMALIZE_METHODS = ("zscore", "minmax")
CONVERT_TARGETS = ("numeric", "text", "datetime")

_OPS = {
    "gt": operator.gt, "lt": operator.lt, "eq": operator.eq,
    "gte": operator.ge, "lte": operator.le, "neq": operator.ne,
}


def _err(msg):
    return {"ok": False, "error": msg}


def _target_cols(df, var):
    """"全部变量"→所有列；具体变量→那一列；变量不在→None。"""
    if not var or var == "全部变量":
        return list(df.columns)
    return [var] if var in df.columns else None


def _numeric_cols(df, cols):
    return [c for c in cols if pd.api.types.is_numeric_dtype(df[c])]


# ── 缺失值 ──

def missing(df, cfg):
    cols = _target_cols(df, cfg.get("var"))
    if cols is None:
        return _err(f"变量 {cfg.get('var')} 不存在")
    strategy = cfg.get("strategy", "drop")
    if strategy not in MISSING_STRATEGIES:
        return _err(f"不支持的缺失值处理方式: {strategy}")

    before = len(df)
    if strategy == "drop":
        out = df.dropna(subset=cols)
        n = before - len(out)
        return {"ok": True, "df": out, "affected": n,
                "detail": f"删除 {n} 行含缺失值的记录（{before} → {len(out)} 行）"}

    total_nan = int(df[cols].isna().sum().sum())
    if total_nan == 0:
        return {"ok": True, "df": df, "affected": 0,
                "detail": "选中的变量已经没有缺失值"}

    out = df.copy()
    if strategy in ("mean", "median"):
        num = _numeric_cols(out, cols)
        if not num:
            return _err("选中的变量里没有数值变量，" +
                        ("均值" if strategy == "mean" else "中位数") + "填充只对数值变量有意义")
        if strategy == "mean":
            out[num] = out[num].fillna(out[num].mean())
        else:
            out[num] = out[num].fillna(out[num].median())
    elif strategy == "mode":
        for c in cols:
            m = out[c].mode(dropna=True)
            if len(m):
                out[c] = out[c].fillna(m.iloc[0])
    elif strategy == "ffill":
        out[cols] = out[cols].ffill()
    else:  # constant
        if cfg.get("constant") is None:
            return _err("常数填充需要填写用来填充的值")
        out[cols] = out[cols].fillna(cfg.get("constant"))

    left = int(out[cols].isna().sum().sum())
    return {"ok": True, "df": out, "affected": total_nan - left,
            "detail": f"填充 {total_nan - left} 个缺失值，还剩 {left} 个"}


# ── 重复行 ──

def duplicates(df, cfg):
    before = len(df)
    out = df.drop_duplicates()
    n = before - len(out)
    if n == 0:
        return {"ok": True, "df": df, "affected": 0, "detail": "没有重复行"}
    return {"ok": True, "df": out, "affected": n,
            "detail": f"删除 {n} 行完全重复的记录（{before} → {len(out)} 行）"}


# ── 异常值（IQR）──

def outlier(df, cfg):
    cols = _target_cols(df, cfg.get("var"))
    if cols is None:
        return _err(f"变量 {cfg.get('var')} 不存在")
    num = _numeric_cols(df, cols)
    if not num:
        return _err("选中的变量里没有数值变量，IQR 只对数值变量有意义")
    before = len(df)
    keep = pd.Series(True, index=df.index)
    for c in num:
        q1, q3 = df[c].quantile(0.25), df[c].quantile(0.75)
        iqr = q3 - q1
        if iqr == 0:
            continue          # 这个变量四分之一分位到四分之三分位没跨度，判不出异常
        lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
        keep &= df[c].between(lo, hi) | df[c].isna()   # 缺失值不当异常值
    out = df[keep]
    n = before - len(out)
    if n == 0:
        return {"ok": True, "df": df, "affected": 0,
                "detail": "按 IQR 没有找到异常值"}
    return {"ok": True, "df": out, "affected": n,
            "detail": f"按 IQR 删除 {n} 行异常值（{before} → {len(out)} 行）"}


# ── 筛选行 ──

def filter_rows(df, cfg):
    col, op, val = cfg.get("col"), cfg.get("op", "gt"), cfg.get("val")
    if not col or col not in df.columns:
        return _err("请选择要筛选的变量")
    if op not in _OPS:
        return _err(f"不支持的比较符: {op}")
    if val is None or val == "":
        return _err("请填写用来比较的值")
    s = df[col]
    f = _OPS[op]
    try:
        mask = f(s, val)
    except TypeError:
        # 列不是数值而输入是数字（或反过来）时，按文本比一遍
        mask = f(s.astype(str), str(val))
    mask = mask.fillna(False).astype(bool)
    out = df[mask]
    n = len(df) - len(out)
    if n == 0:
        return {"ok": True, "df": df, "affected": 0,
                "detail": "这个条件没有筛掉任何行"}
    return {"ok": True, "df": out, "affected": n,
            "detail": f"保留 {len(out)} 行，筛掉 {n} 行（{len(df)} → {len(out)} 行）"}


# ── 重命名 / 删除变量 ──

def rename(df, cfg):
    old, new = cfg.get("from"), (cfg.get("to") or "").strip()
    if not old or old not in df.columns:
        return _err("请选择要重命名的变量")
    if not new:
        return _err("请填写新的变量名")
    if new != old and new in df.columns:
        return _err(f"新变量名 {new} 已经被占用了")
    if new == old:
        return {"ok": True, "df": df, "affected": 0, "detail": "新名字和旧名字一样，没有改动"}
    return {"ok": True, "df": df.rename(columns={old: new}), "affected": 1,
            "detail": f"{old} → {new}"}


def drop_var(df, cfg):
    var = cfg.get("var")
    if not var or var == "全部变量":
        return _err("删除变量必须选一个具体变量，不能是「全部变量」")
    if var not in df.columns:
        return _err(f"变量 {var} 不存在")
    return {"ok": True, "df": df.drop(columns=[var]), "affected": 1,
            "detail": f"移除变量 {var}"}


def _changed_count(s_before: pd.Series, s_after: pd.Series) -> int:
    """这次转换到底动了多少个值。

    不能只比值的字符串形式：数值 1 转成文本 "1" 时两者字符串一样，
    但类型真的变了，那仍然是一次有效清洗。dtype 变了就按非缺失的个数算。
    """
    if s_after.dtype != s_before.dtype:
        return int(s_before.notna().sum())
    return int((s_after.astype(str) != s_before.astype(str)).sum())


# ── 类型转换 ──

def convert(df, cfg):
    var, to = cfg.get("var"), cfg.get("to", "numeric")
    if not var or var not in df.columns:
        return _err("请选择要转换的变量")
    if to not in CONVERT_TARGETS:
        return _err(f"不支持转换成: {to}")
    s = df[var]
    out = df.copy()
    if to == "numeric":
        conv = pd.to_numeric(s, errors="coerce")
        broken = int(conv.isna().sum() - s.isna().sum())
        out[var] = conv
        d = f"转成数值，{broken} 个无法解析的值变成缺失" if broken else "转成数值"
    elif to == "datetime":
        conv = pd.to_datetime(s, errors="coerce")
        broken = int(conv.isna().sum() - s.isna().sum())
        out[var] = conv
        d = f"转成日期，{broken} 个无法解析的值变成缺失" if broken else "转成日期"
    else:
        txt = s.astype(str).mask(s.isna(), None)
        out[var] = txt
        d = "转成文本"
    changed = _changed_count(s, out[var])
    if changed == 0:
        return {"ok": True, "df": df, "affected": 0,
                "detail": d + "，但没有值发生变化"}
    return {"ok": True, "df": out, "affected": changed, "detail": d}


# ── 标准化 / 归一化 ──

def normalize(df, cfg):
    var, method = cfg.get("var"), cfg.get("method", "zscore")
    if not var or var not in df.columns:
        return _err("请选择要标准化的变量")
    if method not in NORMALIZE_METHODS:
        return _err(f"不支持的标准化方法: {method}")
    if not pd.api.types.is_numeric_dtype(df[var]):
        return _err(f"{var} 不是数值变量")
    s = df[var].astype(float)
    out = df.copy()
    if method == "zscore":
        sd = s.std(ddof=0)
        if not sd or pd.isna(sd):
            return _err(f"{var} 没有变异（所有值相同），无法做 Z-Score")
        out[var] = (s - s.mean()) / sd
        d = f"{var} 做 Z-Score 标准化（均值 0，标准差 1）"
    else:
        lo, hi = s.min(), s.max()
        if hi == lo:
            return _err(f"{var} 没有变异（所有值相同），无法做 Min-Max")
        out[var] = (s - lo) / (hi - lo)
        d = f"{var} 做 Min-Max 归一化（0~1）"
    return {"ok": True, "df": out, "affected": int(s.notna().sum()), "detail": d}


# ── 缩尾（Winsorize）──

def winsorize(df, cfg):
    """按分位数把极端值压回分位数边界。

    顶刊惯例：1%/99% 是最常见的上下界（Stata winsor2 默认就是这个）。
    实现跟 Stata 一致——超过 99% 分位数的值变成 99% 分位数本身，
    低于 1% 的变成 1% 分位数本身，不是删除行。

    缺失值不动（缺失不该被错误地顶成边界值）。
    多变量分位数各自独立计算。
    """
    cols = _target_cols(df, cfg.get("var"))
    if cols is None:
        return _err(f"变量 {cfg.get('var')} 不存在")
    num = _numeric_cols(df, cols)
    if not num:
        return _err("选中的变量里没有数值变量，缩尾只对数值变量有意义")
    try:
        lo_q = float(cfg.get("lower", 0.01))
        hi_q = float(cfg.get("upper", 0.99))
    except (TypeError, ValueError):
        return _err("上下分位数必须是数字")
    if not (0 < lo_q < 1 and 0 < hi_q < 1):
        return _err("上下分位数必须都在 (0, 1) 之间")
    if lo_q >= hi_q:
        return _err("下分位数必须小于上分位数")

    out = df.copy()
    changed_cells = 0
    affected_vars = []
    for c in num:
        s = out[c]
        valid = s.dropna()
        if len(valid) < 2:
            continue
        lo = valid.quantile(lo_q)
        hi = valid.quantile(hi_q)
        if pd.isna(lo) or pd.isna(hi) or lo == hi:
            continue
        n_above = int(((s > hi) & s.notna()).sum())
        n_below = int(((s < lo) & s.notna()).sum())
        if n_above == 0 and n_below == 0:
            continue
        # 只对非缺失值压尾
        clipped = s.where(s.isna() | (s >= lo), lo).where(s.isna() | (s <= hi), hi)
        if not clipped.equals(s):
            out[c] = clipped
            changed_cells += n_above + n_below
            affected_vars.append(
                f"{c}: {n_below} 个下限、{n_above} 个上限 ({lo_q*100:.0f}%/{hi_q*100:.0f}%)"
            )
    if changed_cells == 0:
        return {"ok": True, "df": df, "affected": 0,
                "detail": f"按 {lo_q*100:.0f}% / {hi_q*100:.0f}% 没找到极端值"}
    return {"ok": True, "df": out, "affected": changed_cells,
            "detail": "缩尾 " + str(changed_cells) + " 个值；" + "；".join(affected_vars)}


DISPATCH = {
    "missing": missing,
    "duplicate": duplicates,
    "outlier": outlier,
    "filter": filter_rows,
    "rename": rename,
    "drop_var": drop_var,
    "convert": convert,
    "normalize": normalize,
    "winsorize": winsorize,
}


def run(method: str, df, cfg: dict) -> dict:
    fn = DISPATCH.get(method)
    if fn is None:
        return _err(f"不支持的清洗方式: {method}")
    try:
        return fn(df, cfg or {})
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}")
