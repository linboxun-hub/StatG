"""
机制检验：中介效应（三步法 + Sobel + 可选 Bootstrap）与调节效应（交互项）。

关键：不自己写估计器，全部复用 regression_service.run —— 保证这里的固定效应、
聚类/稳健标准误与主回归完全同一口径（面板估计此前已修正过，不能各写一套）。

三步法（计量经济圈《TOP5 常用机制分析方法》Method 1/2/3）：
    ① Y ~ X            → 总效应 c
    ② M ~ X            → 路径 a
    ③ Y ~ X + M        → 直接效应 c′ 与路径 b
    间接效应 = a·b（Sobel 推断），并与「总−直接」c−c′ 互为印证。
调节效应（Method 4）：Y ~ X + M + X·M，X·M 显著即 X 的作用随 M 变化。
残差法/Bootstrap（Method 6）：总−直接口径的 cluster/整行重抽样 95% 区间，可选。
因果中介（Method 5）与 KHB 分解不在本模块，属进阶，交由 AI 助手/文献。
"""
import math
import numpy as np
import pandas as pd


def _stars(p):
    try:
        p = float(p)
    except (TypeError, ValueError):
        return ''
    return '***' if p < 0.01 else '**' if p < 0.05 else '*' if p < 0.1 else ''


def _r(v, n=6):
    try:
        v = float(v)
        return round(v, n) if np.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def _coef(res, name):
    for row in (res.get('coefficients') or []):
        if row.get('variable') == name:
            return row
    return None


def _base_cfg(config):
    return {k: config.get(k) for k in ('id_var', 'time_var', 'se_type', 'cluster_vars', 'absorb')}


def _run(reg, ds, method, yvar, core, controls, base):
    conf = dict(base)
    conf.update({'y_var': yvar, 'core_x': core, 'controls': controls})
    return reg.run(method, conf, ds)


class _Swap:
    """临时把 data_service 的当前数据集换成给定 df，退出还原。

    三步法三个回归必须用同一份完整样本（否则「总−直接」与 a·b 会对不上），
    bootstrap 又要反复在重抽样数据上重跑——都需要能指定 df 喂给 regression_service.run，
    而 run 只认当前数据集，所以用这个上下文包一层。
    """

    def __init__(self, ds, df, tag='__mech__'):
        self.ds, self.df, self.tag = ds, df, tag

    def __enter__(self):
        d = self.ds
        self._name = getattr(d, 'current_name', None)
        self._cur = getattr(d, 'current_dataset', None)
        self._existed = self.tag in getattr(d, 'datasets', {})
        self._backup = d.datasets.get(self.tag)
        d.datasets[self.tag] = self.df
        d.current_dataset = self.df
        d.current_name = self.tag
        return self

    def __exit__(self, *a):
        d = self.ds
        d.current_dataset = self._cur
        d.current_name = self._name
        if self._existed:
            d.datasets[self.tag] = self._backup
        else:
            d.datasets.pop(self.tag, None)


def mediation(reg, ds, config):
    cur = ds.get_current()
    if cur is None:
        return {"error": "未加载数据集"}
    y, x, m = config.get('y_var'), config.get('x_var'), config.get('m_var')
    controls = [c for c in (config.get('controls') or []) if c in cur.columns]
    method = config.get('method') or 'twoway_fe'
    if not (y and x and m):
        return {"error": "请选择 因变量Y / 核心解释变量X / 中介变量M"}
    for v in (y, x, m):
        if v not in cur.columns:
            return {"error": f"变量不存在: {v}"}
    base = _base_cfg(config)
    clean = cur.dropna(subset=[c for c in [y, x, m] + controls if c in cur.columns]).reset_index(drop=True)
    if len(clean) < 30:
        return {"error": "完整样本太少（<30）"}
    with _Swap(ds, clean):
        total = _run(reg, ds, method, y, [x], controls, base)
        pae = _run(reg, ds, method, m, [x], controls, base)
        dire = _run(reg, ds, method, y, [x, m], controls, base)
    err = total.get('error') or pae.get('error') or dire.get('error')
    if err:
        return {"error": err}
    c_row, a_row = _coef(total, x), _coef(pae, x)
    cp_row, b_row = _coef(dire, x), _coef(dire, m)
    if not (c_row and a_row and cp_row and b_row):
        return {"error": "取不到关键系数（X 可能被固定效应吸收或与其它项共线）"}
    a, a_se = a_row['coef'], a_row['std_err']
    b, b_se = b_row['coef'], b_row['std_err']
    c, cp = c_row['coef'], cp_row['coef']
    ab, diff = a * b, c - cp
    var_s = (a * a) * (b_se * b_se) + (b * b) * (a_se * a_se)
    se_s = math.sqrt(var_s) if var_s > 0 else 0.0
    from scipy import stats as _st
    z = ab / se_s if se_s else 0.0
    p = 2 * (1 - _st.norm.cdf(abs(z))) if se_s else None
    prop = (ab / c) if c else None
    boot = (_bootstrap(reg, ds, config, clean, y, x, m, controls, method, base)
            if int(config.get('bootstrap') or 0) > 0 else None)
    return {
        "type": "mediation", "dep_var": y, "x": x, "m": m,
        "method": total.get('method'), "n": total.get('nobs'), "se_type": total.get('se_type'),
        "total_effect": c_row, "path_a": a_row, "direct_effect": cp_row, "b_path": b_row,
        "indirect": {"point": _r(ab), "diff_method": _r(diff),
                     "sobel_se": _r(se_s), "sobel_z": _r(z, 4), "sobel_p": _r(p),
                     "stars": _stars(p), "proportion": _r(prop, 4)},
        "bootstrap": boot,
        "notes": [
            "三步法：① Y~X 得总效应 c；② M~X 得路径 a；③ Y~X+M 得直接效应 c′、路径 b。",
            "间接效应 a·b 与「总−直接」c−c′ 互相印证；间接显著即 M 是中介。",
            "Sobel 为标准推断；要更稳可开启下方 Bootstrap 取区间。",
            "因果中介（X/M 内生）与 KHB 分解属进阶，见 AI 助手/文献。",
        ],
    }


def _bootstrap(reg, ds, config, clean, y, x, m, controls, method, base):
    reps = min(int(config.get('bootstrap') or 0), 2000)
    clustered = base.get('se_type') == 'cluster' and bool(base.get('cluster_vars')) \
        and base.get('cluster_vars')[0] in clean.columns
    rng = np.random.default_rng(int(config.get('seed') or 20240607))
    n = len(clean)
    samples = []
    if clustered:
        g = clean[base['cluster_vars'][0]].values
        uniq = np.unique(g)
        for _ in range(reps):
            pick = rng.choice(uniq, size=len(uniq), replace=True)
            samples.append(np.concatenate([np.where(g == u)[0] for u in pick]))
    else:
        for _ in range(reps):
            samples.append(rng.integers(0, n, size=n))
    vals = []
    for take in samples:
        samp = clean.iloc[take].reset_index(drop=True)
        try:
            with _Swap(ds, samp):
                total = _run(reg, ds, method, y, [x], controls, base)
                dire = _run(reg, ds, method, y, [x, m], controls, base)
            cr, cpr = _coef(total, x), _coef(dire, x)
            if cr and cpr and cr['coef'] is not None and cpr['coef'] is not None:
                vals.append(cr['coef'] - cpr['coef'])
        except Exception:
            continue
    if len(vals) < 50:
        return {"error": "Bootstrap 有效重复过少，未给出区间", "n_ok": len(vals)}
    arr = np.asarray(vals, dtype=float)
    lo, hi = np.percentile(arr, [2.5, 97.5])
    return {"reps": reps, "n_ok": len(vals), "ci_low": _r(lo), "ci_high": _r(hi),
            "note": "按「总−直接」口径做聚类/整行重抽样得到的间接效应 95% 区间"}


def moderation(reg, ds, config):
    cur = ds.get_current()
    if cur is None:
        return {"error": "未加载数据集"}
    y, x, m = config.get('y_var'), config.get('x_var'), config.get('m_var')
    controls = [c for c in (config.get('controls') or []) if c in cur.columns]
    method = config.get('method') or 'twoway_fe'
    center = config.get('center', True)
    if not (y and x and m):
        return {"error": "请选择 因变量Y / 核心解释变量X / 调节变量M"}
    for v in (y, x, m):
        if v not in cur.columns:
            return {"error": f"变量不存在: {v}"}
    base = _base_cfg(config)
    clean = cur.dropna(subset=[c for c in [y, x, m] + controls if c in cur.columns]).reset_index(drop=True)
    if len(clean) < 30:
        return {"error": "完整样本太少（<30）"}
    mc_col, xmc_col = '__mc__', '__xmc__'
    mv = pd.to_numeric(clean[m], errors='coerce')
    mean_m = float(np.nanmean(mv.values))
    sd_m = float(np.nanstd(mv.values))
    clean = clean.copy()
    clean[mc_col] = (mv - mean_m) if center else mv
    clean[xmc_col] = pd.to_numeric(clean[x], errors='coerce') * clean[mc_col]
    with _Swap(ds, clean):
        res = _run(reg, ds, method, y, [x, mc_col, xmc_col], controls, base)
    if res.get('error'):
        return {"error": res['error']}
    bx, bxm, bm = _coef(res, x), _coef(res, xmc_col), _coef(res, mc_col)
    if not (bx and bxm):
        return {"error": "取不到交互系数（X/M 可能被固定效应吸收或共线）"}

    def row(r, label, role):
        return {"variable": label, "role": role, "coef": _r(r['coef'], 4),
                "std_err": _r(r['std_err'], 4), "t": _r(r.get('t'), 3),
                "p": r.get('p'), "stars": _stars(r.get('p'))}

    eff_hi = bx['coef'] + bxm['coef'] * sd_m
    eff_lo = bx['coef'] - bxm['coef'] * sd_m
    rows = [row(bx, f"{x}（在 M 均值处）", 'core'), row(bxm, f"{x}×{m}", 'core')]
    if bm:
        rows.insert(1, row(bm, m, 'control'))
    return {
        "type": "moderation", "dep_var": y, "x": x, "m": m,
        "method": res.get('method'), "n": res.get('nobs'), "se_type": res.get('se_type'),
        "center": bool(center), "mean_m": _r(mean_m, 4), "sd_m": _r(sd_m, 4),
        "coefficients": rows,
        "interaction": {"coef": _r(bxm['coef'], 4), "std_err": _r(bxm['std_err'], 4),
                        "p": bxm.get('p'), "stars": _stars(bxm.get('p'))},
        "effect_at_mean": _r(bx['coef'], 4),
        "simple_slope_hi": _r(eff_hi, 4), "simple_slope_lo": _r(eff_lo, 4),
        "notes": [
            "调节效应：Y ~ X + M + X·M（+ 控制 + FE），X·M 显著 ⇒ X 的作用随 M 变化（机制/调节）。",
            ("已对 M 按均值中心化；X 的系数即 M 取均值时 X 的效应。"
             + f"简单斜率：M 高于均值一个标准差 ≈ {_r(eff_hi, 4)}，低一个标准差 ≈ {_r(eff_lo, 4)}。"),
            "中心化可缓解交互项与主项的共线性；审稿人较看重这一点。",
        ],
    }
