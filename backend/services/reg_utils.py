"""回归与 DID 服务的共享工具函数（避免循环导入）"""
import asyncio
import math
import warnings

import numpy as np
import pandas as pd
import scipy.stats as stats

warnings.filterwarnings("ignore")


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
        ei = np.zeros(k)
        ei[i] = eps[i]
        for j in range(i, k):
            ej = np.zeros(k)
            ej[j] = eps[j]
            if i == j:
                H[i, i] = (f(x + ei) - 2 * f0 + f(x - ei)) / (eps[i] ** 2)
            else:
                H[i, j] = H[j, i] = (
                    f(x + ei + ej) - f(x + ei - ej) - f(x - ei + ej) + f(x - ei - ej)
                ) / (4 * eps[i] * eps[j])
    return np.linalg.pinv(H)


def _hc1_cov(X, resid):
    """HC1 异方差稳健协方差（对 QMLE 类模型通用）"""
    Xv = np.asarray(X, dtype=float)
    r = np.asarray(resid, dtype=float)
    n, k = Xv.shape
    XtX = Xv.T @ Xv
    meat = (Xv * r[:, None]).T @ (Xv * r[:, None])
    return np.linalg.pinv(XtX) @ meat @ np.linalg.pinv(XtX) * (n / max(n - k, 1))


def run_coro(coro):
    """在「可能有也可能没有运行中的事件循环」两种情况下跑一个协程。

    插件和知识沉淀是从 FastAPI 的 async 路由里同步调起来的，直接 asyncio.run
    会报 cannot be called from a running event loop；放在线程池里跑又拿不到结果。
    这里统一处理：已在循环里就丢到子线程的新循环执行。
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=1) as ex:
        return ex.submit(lambda: asyncio.run(coro)).result()


def json_safe(obj):
    """递归把结果转成严格 JSON 可序列化的结构。

    FastAPI 的 JSONResponse 用 allow_nan=False，任何 NaN/Inf/numpy 标量都会让整个
    响应变 500。这里统一清洗：非有限 float → None，numpy 标量 → Python 标量。
    """
    if isinstance(obj, dict):
        return {str(k): json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [json_safe(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        obj = float(obj)
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, np.ndarray):
        return json_safe(obj.tolist())
    if isinstance(obj, (pd.Timestamp,)):
        return obj.isoformat()
    if obj is None or isinstance(obj, (bool, int, str)):
        return obj
    return str(obj)
