"""FastAPI 后端 — 集成 StatsPAI 统计引擎"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from fastapi import FastAPI, UploadFile, File, Query, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel
from typing import Optional
import io
import json

from services.data_service import data_service
from services.code_service import code_service
from services.analysis_service import analysis_service
from services.regression_service import regression_service
from services.graph_service import graph_service
from services.export_service import export_service
from services.profile_service import profile_service
from services.ai_service import ai_service
from services.project_service import project_service
from services.file_browser import file_browser
from services import kb_service as kb_service_mod
from services import kb_ingest as kb_ingest_mod
from services import doc_extract as doc_extract_mod
from services.reg_utils import json_safe

app = FastAPI(title="Stata 实证数据分析助手 API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    """启动时加载 StatsPAI 内置数据集"""
    try:
        import statspai as sp
        # Load the card_1995 dataset as default
        df = sp.datasets.card_1995()
        data_service.datasets["card_1995"] = df
        data_service.current_dataset = df
        data_service.current_name = "card_1995"
        print(f"✅ StatsPAI loaded: card_1995 ({len(df)} rows, {len(df.columns)} cols)")
    except Exception as e:
        print(f"⚠️ StatsPAI startup warning: {e}")


def _bind_to_project(name: str, df) -> dict:
    """数据加载后归入项目。

    早版本数据只进 data_service，没有绑到 project_service
    的任何项目，所以侧边栏显示「未选择项目」，
    而切项目之后这份数据就悬空了。
    这里在没有当前项目时自动建一个以数据集命名的项目。
    """
    from services.dataset_io import display_parts
    base, folder = display_parts(name)

    # 数据集已经在某个项目里（比如另一个项目的文件、上次上传留下的），
    # 就归到那个项目；否则归到当前项目；都没有才新建。
    pid = None
    for k, v in project_service.projects.items():
        if name in (v.get("datasets") or {}):
            pid = k
            break
    if pid is None:
        pid = project_service.current_project_id
        if pid is None or pid not in project_service.projects:
            # 数据集名可能带子目录（"机制检验/利润表/FS_Comins.dta"），
            # 项目名用短名，不然界面上出现带斜杠的怪名字
            proj = project_service.create((base or "data").rsplit(".", 1)[0],
                                          "由数据导入自动建立")
            pid = proj["id"]
        project_service.select(pid)

    proj = project_service.projects[pid]
    entry = proj.setdefault("datasets", {}).get(name)
    if entry is None or not entry.get("path"):
        # 没有这个数据集（上传、外部路径、StatsPAI 内置）时才新建一条。
        # 已经由目录扫描登记过的（有磁盘路径）绝不能覆盖：那会把 path、size_kb
        # 一起冲掉，后果一是大小栏掉回内存占用，二是缓存被逐出之后
        # load_known 找不到源文件，明明在磁盘上的文件再也读不回来。
        entry = {
            "path": None, "rel": name, "folder": folder, "ext": "",
            "size_kb": None, "rows": None, "cols": None, "columns": [],
            "ok": True, "error": "", "frame": None,
        }
        proj["datasets"][name] = entry
    if df is not None:
        entry["frame"] = df
        # 只补扫描时拿不到的，不覆盖已有的
        if entry.get("rows") is None:
            entry["rows"] = len(df)
        if entry.get("cols") is None:
            entry["cols"] = len(df.columns)
        if not entry.get("columns"):
            entry["columns"] = list(df.columns)
        entry["ok"] = True
        entry["error"] = ""
    # 关键：当前数据集要跟着实际选择走。
    # 原来只在为空时写一次，而导入扫描早就把它设成了文件夹里排序第一的
    # 文件，所以之后再也不会更新。于是 save_to_data_service（进数据管理页
    # 的 sync-project、重新选项目、重扫都会调它）永远按那个旧值恢复，
    # 用户切过去的文件被静默换掉——回归跑在另一份数据上都不知情。
    proj["current_dataset"] = name
    return {"bound": True, "project": project_service.get(pid)}



# ── Data ──

@app.post("/api/data/upload")
async def upload_data(file: UploadFile = File(...)):
    content = await file.read()
    r = data_service.load_from_bytes(content, file.filename)
    if "error" not in r and data_service.current_name:
        _bind_to_project(data_service.current_name, data_service.current_dataset)
    return r


@app.get("/api/data/list")
async def list_datasets():
    """工作台「当前数据集」用：已加载的 + 项目清单里还没读的。

    只回已加载的话，项目文件夹里扫出来的几十个文件在界面上看不到，
    用户会以为没导进来——这正是之前的 bug。
    """
    from services.dataset_io import display_parts
    seen, out = set(), []
    for name, df in data_service.datasets.items():
        base, folder = display_parts(name)
        out.append({"name": name, "file": base, "folder": folder,
                    "rows": len(df), "cols": len(df.columns),
                    "loaded": True, "ok": True, "error": "",
                    "current": name == data_service.current_name})
        seen.add(name)
    for name, c in data_service.catalog.items():
        if name in seen:
            continue
        base, folder = display_parts(name)
        out.append({"name": name, "file": base,
                    "folder": c.get("folder") or folder,
                    "rows": c.get("rows"), "cols": c.get("cols"),
                    "loaded": False, "ok": bool(c.get("ok")),
                    "error": c.get("error") or "",
                    "current": False})
    out.sort(key=lambda d: (not d["current"], d["folder"], d["file"].lower()))
    return {"datasets": out, "current": data_service.current_name}


@app.get("/api/data/statspai_datasets")
async def list_statspai_datasets():
    """获取 StatsPAI 内置数据集列表"""
    try:
        import statspai as sp
        ds_df = sp.datasets.list_datasets()
        return {"datasets": ds_df.to_dict(orient="records")}
    except Exception as e:
        return {"error": str(e)}


class LoadStatsPAIRequest(BaseModel):
    name: str

@app.post("/api/data/load_statspai")
async def load_statspai_dataset(req: LoadStatsPAIRequest):
    r = data_service.load_statspai_dataset(req.name)
    if "error" not in r and data_service.current_name:
        _bind_to_project(data_service.current_name, data_service.current_dataset)
    return r


@app.post("/api/data/select/{name:path}")
async def select_dataset(name: str):
    """切换当前数据集。name 是相对路径，带 "/"，所以路由用 :path。

    项目清单里还没读的文件在这里触发真正读取——这是懒加载的唯一入口，
    之前是导入时一次读完全部（这个目录 507 MB）。
    """
    if name not in data_service.datasets and name not in data_service.catalog:
        return {"error": f"数据集不存在：{name}"}
    if name in data_service.datasets:
        data_service.current_dataset = data_service.datasets[name]
        data_service.current_name = name
        data_service.panel_config = None
        data_service._forget_clean_state()
        _bind_to_project(name, data_service.current_dataset)
        df = data_service.current_dataset
        # 缓存命中也把行数列数带上，和 load_known 的分支保持同一形状
        return {"ok": True, "name": name, "rows": len(df), "cols": len(df.columns)}
    r = data_service.load_known(name)
    if "error" in r:
        return r
    _bind_to_project(name, data_service.current_dataset)
    return {"ok": True, "name": name, "rows": r.get("rows"), "cols": r.get("cols")}


@app.get("/api/data")
async def get_data(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    search: str = Query(""),
):
    return data_service.get_page(page, page_size, search)


@app.get("/api/data/info")
async def dataset_info():
    if data_service.current_dataset is None:
        return {"error": "未加载数据集"}
    return data_service._dataset_info(data_service.current_name, data_service.current_dataset)


@app.get("/api/data/variables")
async def get_variables():
    return {"variables": data_service.get_variables()}


@app.get("/api/data/summary")
async def get_summary():
    return {"summary": data_service.get_summary()}


@app.get("/api/data/datasets")
async def list_loaded_datasets():
    """数据库页签用：列出所有可用数据集及其与当前选择的关系。

    缺失值只有真读过的才算得出来；清单里的文件还没读，就照实显示 null，
    不编一个数字——要用它的缺失值得先切换过去。
    """
    from services.dataset_io import display_parts
    out = []
    for name, df in data_service.datasets.items():
        base, folder = display_parts(name)
        # 大小一律报磁盘文件大小。之前已加载的报内存占用、没加载的报磁盘
        # 大小，同一个文件切一次前后能差一倍，看着像 bug。
        c = data_service.catalog.get(name) or {}
        size_kb = c.get("size_kb")
        if size_kb is None:
            size_kb = round(df.memory_usage(deep=True).sum() / 1024, 1)
        out.append({
            "name": name, "file": base, "folder": folder,
            "rows": len(df), "cols": len(df.columns),
            "missing": int(df.isnull().sum().sum()),
            "size_kb": size_kb,
            "ram_kb": round(df.memory_usage(deep=True).sum() / 1024, 1),
            "source": "StatsPAI 内置" if name == "card_1995" else "导入",
            "loaded": True, "current": name == data_service.current_name,
            "ok": True, "error": "",
            "columns": list(df.columns)[:300],
        })
    seen = {d["name"] for d in out}
    for name, c in data_service.catalog.items():
        if name in seen:
            continue
        base, folder = display_parts(name)
        out.append({
            "name": name, "file": base, "folder": c.get("folder") or folder,
            "rows": c.get("rows"), "cols": c.get("cols"), "missing": None,
            "size_kb": c.get("size_kb"),
            "source": "项目目录", "loaded": False,
            "ok": bool(c.get("ok")), "error": c.get("error") or "",
            "current": False,
            "columns": (c.get("columns") or [])[:300],
        })
    out.sort(key=lambda d: (not d["current"], not d["loaded"], d["folder"], d["file"].lower()))
    return {"datasets": out, "current": data_service.current_name}


@app.post("/api/data/switch/{name:path}")
async def switch_dataset(name: str):
    if name in data_service.datasets:
        data_service.current_dataset = data_service.datasets[name]
        data_service.current_name = name
        data_service.panel_config = None
        data_service._forget_clean_state()
        df = data_service.current_dataset
        return {"ok": True, "name": name, "rows": len(df), "cols": len(df.columns)}
    r = data_service.load_known(name)
    return r


@app.delete("/api/data/datasets/{name:path}")
async def drop_dataset(name: str):
    """从可用列表里移除。磁盘上的原文件不动，重新扫一遍还会回来。"""
    return data_service.forget(name)


@app.post("/api/data/load-path")
async def load_dataset_from_path(req: dict):
    """从本地路径加载数据文件（数据库页签用）"""
    import pandas as pd
    from services.dataset_io import safe_filename
    path = req.get("path") or ""
    if not path or not os.path.isfile(path):
        return {"error": f"文件不存在: {path}"}
    ext = path.rsplit(".", 1)[-1].lower()
    name = os.path.basename(path)
    try:
        if ext == "csv":
            df = pd.read_csv(path)
        elif ext in ("xlsx", "xls"):
            df = pd.read_excel(path)
        elif ext == "dta":
            import pyreadstat
            df, _ = pyreadstat.read_dta(path)
        elif ext in ("txt", "dat"):
            df = pd.read_csv(path, sep=None, engine="python")
        else:
            return {"error": f"不支持的格式: .{ext}"}
    except Exception as e:
        return {"error": f"加载失败: {type(e).__name__}: {e}"}
    data_service.datasets[name] = df
    data_service.current_dataset = df
    data_service.current_name = name
    data_service.panel_config = None
    data_service._forget_clean_state()
    _bind_to_project(name, df)
    return {"ok": True, "name": name, "rows": len(df), "cols": len(df.columns)}


@app.get("/api/data/export/csv")
async def export_csv():
    from services.dataset_io import safe_filename
    content = data_service.export_csv()
    # 数据集名现在带 "/"（相对路径），直接塞进 Content-Disposition 会生成
    # 带路径的文件名；而且中文要先按 UTF-8 百分号编码，否则 latin-1 报错。
    from urllib.parse import quote
    fn = (safe_filename(data_service.current_name) or "data")
    if not fn.lower().endswith(".csv"):
        fn += ".csv"
    return StreamingResponse(
        io.BytesIO(content),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(fn)}"},
    )


# ── Code Editor ──

class CodeRunRequest(BaseModel):
    code: str

@app.post("/api/code/run")
async def run_code(req: CodeRunRequest):
    return code_service.run(req.code, data_service)


@app.get("/api/code/history")
async def code_history():
    return {"history": code_service.get_history()}


@app.get("/api/code/variables")
async def code_variables():
    return {"variables": code_service.get_variables(data_service)}


# ── Analysis ──

class AnalysisRequest(BaseModel):
    method: str
    config: dict = {}

@app.post("/api/analysis/run")
async def run_analysis(req: AnalysisRequest):
    return analysis_service.run_analysis(req.method, req.config, data_service)


# ── Graph ──

class GraphRequest(BaseModel):
    chart_type: str
    config: dict = {}

@app.post("/api/graph/generate")
async def generate_graph(req: GraphRequest):
    return graph_service.generate(req.chart_type, req.config, data_service)


@app.post("/api/graph/export-png")
async def export_graph_png(req: GraphRequest):
    img_bytes = graph_service.export_png(req.chart_type, req.config, data_service)
    return StreamingResponse(io.BytesIO(img_bytes), media_type="image/png")


class AIDiagnoseRequest(BaseModel):
    chart_data: dict
    api_config: dict = {}

@app.post("/api/graph/ai-diagnose")
async def ai_diagnose_parallel_trend(req: AIDiagnoseRequest):
    """平行趋势未通过时，自动调 AI 分析原因并给出修改建议。"""
    cd = req.chart_data
    pt = cd.get("parallel_trend", {})
    coefficients = cd.get("coefficients", [])
    chart_type = cd.get("chart_type", "")
    method = cd.get("method", "")
    config = cd.get("config", {})

    # 拼系数表
    coef_lines = []
    for c in coefficients:
        k = c.get("rel_time", "?")
        est = c.get("estimate")
        lo = c.get("ci_low")
        hi = c.get("ci_high")
        p = c.get("p_value")
        sig = "显著" if (p is not None and p < 0.05) else ""
        coef_lines.append(f"  k={k:+d}  系数={est:.6f}  95%CI=[{lo:.6f}, {hi:.6f}]  p={p:.4f} {sig}")

    pre_sig = pt.get("pre_significant", [])
    post_sig = pt.get("post_significant", [])

    user_msg = f"""请分析以下{'平行趋势检验' if chart_type == 'did' else '事件研究'}结果，诊断未通过的原因，并给出具体的模型修改建议。

## 图表信息
- 图表类型: {chart_type}（{'平行趋势检验' if chart_type == 'did' else '事件研究'}）
- 估计方法: {method}
- Y 变量: {config.get('y_var', '?')}
- X 变量(时间): {config.get('x_var', '?')}
- 分组变量: {config.get('group_var', '?')}
- 事件窗口: {config.get('window', '?')}

## 检验结论
- 结论: {pt.get('verdict', '?')}
- 事前显著偏离的期数: {pre_sig if pre_sig else '无'}
- 事后显著的期数: {post_sig if post_sig else '无'}

## 各期系数
{chr(10).join(coef_lines)}

请按以下结构回答：
1. **问题诊断**：哪些事前系数显著偏离 0，偏离方向和幅度说明什么
2. **可能原因**：从数据、模型设定、样本选择等角度分析为什么平行趋势不成立
3. **修改建议**：给出 2-3 条具体可操作的改进方案（如加控制变量、换样本窗口、换方法等），每条给出对应的 Stata 命令
4. **替代方案**：如果平行趋势确实无法满足，推荐替代的因果推断策略"""

    result = await ai_service.raw_chat(
        system="你是计量经济学专家，擅长 DID（双重差分）和事件研究的模型诊断。回答要专业、具体、可操作。",
        user=user_msg,
        api_config=req.api_config,
        max_tokens=2000,
        temperature=0.3,
    )
    return result


# ── Regression ──

@app.get("/api/regression/methods")
async def list_regression_methods():
    """回归方法目录与参数定义"""
    return regression_service.list_methods()


class RegressionRequest(BaseModel):
    method: str
    config: dict = {}


@app.post("/api/regression/run")
async def run_regression(req: RegressionRequest):
    try:
        from services.reg_utils import json_safe
        result = regression_service.run(req.method, req.config, data_service)
        return json_safe(result)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"error": f"{type(e).__name__}: {e}"}


# ── Mechanism（机制检验：中介效应 / 调节效应）──

@app.post("/api/mechanism/mediation")
async def mechanism_mediation(req: dict):
    from services._mechanism import mediation
    from services.reg_utils import json_safe
    try:
        return json_safe(mediation(regression_service, data_service, req))
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"error": f"{type(e).__name__}: {e}"}


@app.post("/api/mechanism/moderation")
async def mechanism_moderation(req: dict):
    from services._mechanism import moderation
    from services.reg_utils import json_safe
    try:
        return json_safe(moderation(regression_service, data_service, req))
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"error": f"{type(e).__name__}: {e}"}


class EsttabRequest(BaseModel):
    models: list = []      # [{"label": "(1)", "method": "twoway_fe", "config": {...}}]
    row_aliases: dict = {}  # {原始变量名: 表里显示的名字}


@app.post("/api/regression/standard-sequence")
async def standard_sequence_api(req: dict):
    """基准表经典序列：无控制 → 加控制 → 个体 FE → 双向 FE → 双 FE + 聚类。

    收裸 dict（不是 RegressionRequest）：这里只需要 config，让 method 也必填
    只会逼着调用方编一个用不上的值。序列规则只有一份，放后端。
    """
    from services._esttab import standard_sequence
    return {"models": standard_sequence(req.get("config") or {})}


@app.post("/api/regression/esttab")
async def run_esttab(req: EsttabRequest):
    """多模型对照表：把 N 份 (method, config) 顺序跑完，按系数显示名对齐成一张矩阵。

    单列失败不掀翻整张表——该列系数全空，notes 里记下失败原因。
    """
    if not req.models:
        return {"error": "没有任何模型"}
    try:
        from services._esttab import build_esttab
        from services.reg_utils import json_safe
        return json_safe(build_esttab(req.models, data_service, req.row_aliases))
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"error": f"{type(e).__name__}: {e}"}


# ── Knowledge Base ──

# ── Knowledge Base（知识库 / 文件夹） ──

@app.get("/api/kb/kbs")
async def kb_list_kbs():
    """顶层知识库卡片：文档数、字符数、被引用次数、关联方法"""
    return {"kbs": kb_service_mod.kb_service.list_kbs()}


class KBCreateRequest(BaseModel):
    name: str
    about: str = ""


@app.post("/api/kb/kbs")
async def kb_create_kb(req: KBCreateRequest):
    r = kb_service_mod.kb_service.create_kb(req.name, req.about)
    if r.get("error"):
        return r
    return {**r, "kbs": kb_service_mod.kb_service.list_kbs()}


class KBUpdateRequest(BaseModel):
    name: str = ""
    about: str = None


@app.put("/api/kb/kbs/{name}")
async def kb_update_kb(name: str, req: KBUpdateRequest):
    r = kb_service_mod.kb_service.rename_kb(name, req.name or name, req.about)
    if r.get("error"):
        return r
    return {**r, "kbs": kb_service_mod.kb_service.list_kbs()}


@app.delete("/api/kb/kbs/{name}")
async def kb_delete_kb(name: str):
    return kb_service_mod.kb_service.delete_kb(name)


@app.get("/api/kb/kbs/{name}")
async def kb_get_kb(name: str):
    k = kb_service_mod.kb_service.get_kb(name)
    if not k:
        return {"error": "知识库不存在"}
    return {**k, "docs": kb_service_mod.kb_service.list_docs(kb=name)}


@app.get("/api/kb/stats")
async def kb_stats(kb: str = ""):
    return kb_service_mod.kb_service.stats(kb or None)


@app.get("/api/kb/docs")
async def kb_list(dtype: str = "", tag: str = "", keyword: str = "",
                  verified: str = "", kb: str = ""):
    v = None
    if verified in ("true", "false"):
        v = (verified == "true")
    return {"docs": kb_service_mod.kb_service.list_docs(dtype or None, tag or None,
                                                        keyword or None, v, kb or None)}


@app.get("/api/kb/docs/{doc_id}")
async def kb_get(doc_id: str):
    r = kb_service_mod.kb_service.get_doc(doc_id)
    return r if "error" in r else json_safe(r)


@app.post("/api/kb/docs")
async def kb_create(req: dict):
    return kb_service_mod.kb_service.save_doc(req.get("type", "paper"), req.get("meta") or {},
                                              req.get("body") or "", req.get("kb"))


@app.put("/api/kb/docs/{doc_id}")
async def kb_update(doc_id: str, req: dict):
    return kb_service_mod.kb_service.update_doc(doc_id, req.get("meta"), req.get("body"))


@app.delete("/api/kb/docs/{doc_id}")
async def kb_delete(doc_id: str):
    return kb_service_mod.kb_service.delete_doc(doc_id)


@app.post("/api/kb/docs/{doc_id}/verify")
async def kb_verify(doc_id: str, req: dict = {}):
    return kb_service_mod.kb_service.verify_doc(doc_id, req.get("verified", True))


@app.get("/api/kb/search")
async def kb_search(q: str = "", k: int = 8, dtype: str = "", kb: str = ""):
    if not q:
        return {"error": "缺少查询词"}
    return json_safe(kb_service_mod.kb_service.search(
        q, k=k, dtype=dtype or None, kb=kb or None))


class KBIngestRequest(BaseModel):
    url: str = ""
    text: str = ""
    kb: str = ""
    api_config: dict = {}


@app.post("/api/kb/ingest")
async def kb_ingest(req: KBIngestRequest):
    if not (req.url or req.text):
        return {"error": "请提供 URL 或粘贴正文"}
    try:
        ex = doc_extract_mod.extract(url=req.url or None, text=req.text or None)
    except Exception as e:
        return {"error": f"读取失败: {type(e).__name__}: {e}"}
    snap = None
    try:
        if req.url:
            snap = kb_service_mod.kb_service.save_source("url.txt", req.url.encode("utf-8"))
        else:
            snap = kb_service_mod.kb_service.save_source("pasted.txt",
                                                         req.text.encode("utf-8"))
    except Exception:
        pass
    draft = kb_ingest_mod.make_draft(req.url or "粘贴文本", ex, req.api_config, req.kb)
    draft["_snapshot_path"] = snap
    kb_ingest_mod.store_draft(draft, snap)
    return json_safe(draft)


@app.post("/api/kb/ingest-file")
async def kb_ingest_file(file: UploadFile = File(...), api_config: str = Form("{}"),
                        kb: str = Form("")):
    content = await file.read()
    cfg = {}
    try:
        cfg = json.loads(api_config or "{}")
    except Exception:
        pass
    try:
        ex = doc_extract_mod.extract(data=content, filename=file.filename)
    except Exception as e:
        return {"error": f"读取失败: {type(e).__name__}: {e}"}
    snap = kb_service_mod.kb_service.save_source(file.filename, content)
    draft = kb_ingest_mod.make_draft(file.filename, ex, cfg)
    draft["_snapshot_path"] = snap
    kb_ingest_mod.store_draft(draft, snap)
    return json_safe(draft)


@app.get("/api/kb/source/{name}")
async def kb_source(name: str):
    """取回导入时保存的原文，供核对笔记里的论断"""
    data = kb_service_mod.kb_service.read_source(name)
    if not data:
        return {"error": "原文快照不存在"}
    ext = os.path.splitext(name)[1].lower()
    media = {".pdf": "application/pdf",
             ".docx": "application/vnd.openxmlformats-officedocument"
                      ".wordprocessingml.document",
             ".txt": "text/plain; charset=utf-8"}.get(ext, "text/plain; charset=utf-8")
    # 下载文件名含中文，而 HTTP 头只接受 latin-1，必须编码
    from urllib.parse import quote
    fn = os.path.basename(name)
    disp = f"inline; filename*=UTF-8''{quote(fn)}"
    return StreamingResponse(io.BytesIO(data), media_type=media,
                             headers={"Content-Disposition": disp})


@app.post("/api/kb/ingest-batch")
async def kb_ingest_batch(files: list[UploadFile] = File(...),
                          api_config: str = Form("{}"), kb: str = Form("")):
    """批量导入：一次多份 PDF / Word，各自生成一份草稿。

    研究者的参考文献通常是一整个文件夹，一篇篇导太慢。
    这里顺序处理，失败的那份只记录原因，不影响其余。
    """
    cfg = {}
    try:
        cfg = json.loads(api_config or "{}")
    except Exception:
        pass
    out = {"drafts": [], "failed": []}
    for f in files:
        content = await f.read()
        try:
            ex = doc_extract_mod.extract(data=content, filename=f.filename)
        except Exception as e:
            out["failed"].append({"file": f.filename,
                                  "error": f"{type(e).__name__}: {e}"})
            continue
        snap = kb_service_mod.kb_service.save_source(f.filename, content)
        draft = kb_ingest_mod.make_draft(f.filename, ex, cfg, kb or None)
        draft["_snapshot_path"] = snap
        kb_ingest_mod.store_draft(draft, snap)
        out["drafts"].append({"draft_id": draft["draft_id"], "title": draft.get("title"),
                              "kind": draft["kind"], "chars": draft.get("chars"),
                              "recs": [i["type"] for i in draft.get("items", [])],
                              "duplicates": draft.get("duplicates"),
                              "file": f.filename})
    return json_safe(out)


@app.get("/api/kb/drafts/{draft_id}")
async def kb_draft(draft_id: str):
    return json_safe(kb_ingest_mod.get_draft(draft_id))


@app.post("/api/kb/drafts/{draft_id}/commit")
async def kb_commit(draft_id: str, req: dict):
    return json_safe(kb_ingest_mod.commit_draft(
        draft_id, req.get("chosen") or [], req.get("meta_extra"), req.get("kb")))


# ── Export ──

class ExportRequest(BaseModel):
    name: str
    format: str
    content: str
    source: str = ""

@app.post("/api/exports/create")
async def create_export(req: ExportRequest):
    return export_service.create(req.name, req.format, req.content, req.source)


class ExportResultRequest(BaseModel):
    name: str
    result: dict
    title: str = ""
    source: str = ""
    row_mode: str = "core_const"


@app.post("/api/exports/result/{fmt}")
async def export_result(fmt: str, req: ExportResultRequest):
    """把一份分析结果导出成真实文件：docx / latex / zip / md

    fmt 以 esttab 开头时，把 result 当多模型对照表矩阵（kind == "esttab"）处理，
    与单模型结果走的是两条渲染路径。矩阵就是前端看到的那份，这里只渲染，
    不重跑回归——否则导一次就是把五列回归再跑一遍。
    """
    fmt = fmt.lower()
    if fmt.startswith("esttab"):
        return export_service.create_esttab(req.name, req.result, req.row_mode, fmt)
    if fmt == "docx":
        return export_service.create_docx(req.name, req.result, req.title, req.source)
    if fmt in ("latex", "tex"):
        return export_service.create_latex(req.name, req.result, req.source)
    if fmt == "zip":
        return export_service.create_zip(req.name, req.result, req.source)
    if fmt in ("md", "markdown"):
        secs = export_service.to_sections(req.result)
        body = "\n\n".join(("## " + s["heading"] + "\n\n" + s["body"]) for s in secs)
        return export_service.create(req.name, "md", body, req.source)
    return {"error": f"不支持的导出格式: {fmt}"}


@app.get("/api/exports/download/{filename}")
async def download_export(filename: str):
    p = export_service.file_path(filename)
    if not p:
        return {"error": "文件不存在"}
    from urllib.parse import quote
    fn = os.path.basename(p)
    return FileResponse(p, filename=fn,
                        headers={"Content-Disposition":
                                 f"attachment; filename*=UTF-8''{quote(fn)}"})


@app.get("/api/exports")
async def list_exports():
    return {"exports": export_service.list_all()}


@app.delete("/api/exports/{export_id}")
async def delete_export(export_id: int):
    ok = export_service.delete(export_id)
    return {"ok": ok}


# ── Profile / Auto-detect ──

@app.get("/api/profile")
async def get_profile():
    """自动分析数据结构，推荐分析流程"""
    return profile_service.profile(data_service)


# ── AI Assistant ──

class AIChatRequest(BaseModel):
    messages: list
    api_config: dict = {}
    page: str = ""

@app.post("/api/ai/chat")
async def ai_chat(req: AIChatRequest):
    return await ai_service.chat(req.messages, req.api_config, req.page)


# ── 内置知识（种子条目） ──

@app.post("/api/kb/seed-builtins")
async def kb_seed_builtins():
    """把内置方法知识写进「Stata命令速查」库。只补缺失，不覆盖手改过的。"""
    r = kb_service_mod.kb_service.ensure_builtins()
    if r.get("error"):
        return r
    return {**r, "kbs": kb_service_mod.kb_service.list_kbs()}


# ── Project Management ──

class ProjectCreateRequest(BaseModel):
    name: str
    description: str = ""

class ProjectImportRequest(BaseModel):
    path: str
    name: str = ""

@app.get("/api/projects")
async def list_projects():
    projects = project_service.list_all()
    return {"projects": projects, "current_id": project_service.current_project_id}

@app.post("/api/projects")
async def create_project(req: ProjectCreateRequest):
    return project_service.create(req.name, req.description)

@app.get("/api/projects/{pid}")
async def get_project(pid: str):
    p = project_service.get(pid)
    if not p:
        return {"error": "项目不存在"}
    return {k: v for k, v in p.items() if k not in ("datasets",)}

@app.post("/api/projects/{pid}/select")
async def select_project(pid: str):
    p = project_service.select(pid)
    if not p:
        return {"error": "项目不存在"}
    # 将项目数据同步到 data_service
    result = project_service.save_to_data_service(pid, data_service)
    return result

@app.delete("/api/projects/{pid}")
async def delete_project(pid: str):
    ok = project_service.delete(pid)
    return {"ok": ok}

@app.post("/api/projects/import")
async def import_project(req: ProjectImportRequest):
    result = project_service.import_folder(req.path, req.name)
    # 导入成功后同步数据到 data_service
    if "project" in result and "error" not in result:
        pid = result["project"]["id"]
        sync = project_service.save_to_data_service(pid, data_service)
        if "error" in sync:
            result["sync_error"] = sync["error"]
    return result


@app.post("/api/projects/{pid}/rescan")
async def rescan_project(pid: str):
    """重新扫项目文件夹。

    用户的文件一直在加（特高压 / _v2 / _v3 / 方案A / 方案B…），
    每次改完都得重新导入一次，而重新导入会另建一个项目、名字重名的
    数据集还会互相覆盖。有了重扫，同一个项目原地更新。

    注意「磁盘新增」和「列表里恢复」是两件事：用户可能在数据库页签上
    手动移除过某个文件，那时 data_service.catalog 里没有了、项目目录里
    还有。重扫必须把这种也补回来，否则它就从列表里永远消失了。
    """
    r = project_service.rescan(pid)
    if "error" in r:
        return r
    restored = []
    if project_service.current_project_id == pid:
        before = set(data_service.catalog.keys())
        sync = project_service.save_to_data_service(pid, data_service)
        if "error" in sync:
            r["sync_error"] = sync["error"]
        restored = sorted(set(data_service.catalog.keys()) - before)
    r["restored"] = restored
    r["changed"] = bool(r.get("added") or r.get("removed")
                        or r.get("failed") or restored)
    return r


@app.get("/api/projects/{pid}/catalog")
async def project_catalog(pid: str):
    p = project_service.get(pid)
    if not p:
        return {"error": "项目不存在"}
    return {"catalog": project_service.catalog(pid), "source_path": p.get("source_path")}

@app.get("/api/projects/{pid}/datasets")
async def list_datasets(pid: str):
    p = project_service.get(pid)
    if not p:
        return {"error": "项目不存在"}
    return {"datasets": list(p.get("datasets", {}).keys())}

@app.get("/api/projects/{pid}/datasets/{name}")
async def get_dataset_info(pid: str, name: str):
    return project_service.load_dataset(pid, name)


# ── File Browser ──

# 文件浏览器的起始目录。Windows 本地是 D:\；容器里挂载点不同，
# 所以允许用环境变量覆盖，前端通过 /api/config 拿到它。
DATA_ROOT = os.environ.get("STATA_DATA_ROOT") or "D:\\"


@app.get("/api/config")
async def get_config():
    return {"data_root": DATA_ROOT}


@app.get("/api/browse")
async def browse_dir(path: str = Query("")):
    return file_browser.list_dir(path or DATA_ROOT)

@app.post("/api/data/sync-project")
async def sync_project_data():
    """将当前项目的数据同步到 data_service。

    数据管理页每次挂载都会调它。它只该做「补齐」——把项目清单里的文件
    登记到 data_service，缺当前数据集时读一个。绝不能覆盖当前选择，
    否则用户在界面上挑的文件一进数据管理页就被打回导入时排序第一的那个。
    """
    pid = project_service.current_project_id
    if not pid:
        return {"error": "未选择项目"}
    result = project_service.save_to_data_service(pid, data_service)
    if "error" not in result:
        result["kept_current"] = data_service.current_name
    return result


# ── 数据清洗 ──

class CleanRequest(BaseModel):
    method: str
    config: dict = {}


@app.post("/api/data/clean")
async def clean_data(req: CleanRequest):
    """真正执行一步清洗，并回报它到底改了什么。

    之前这一步是假的：前端只在本地数组里追加一条描述，数据一个字节都没动。
    所以同一个步骤能反复出现（连点三次日志三行一模一样的"影响 45977"）、
    缺失值永远不降、导出的还是原始数据。现在 affected == 0 就告诉前端
    「这步什么都没改」，由前端决定要不要记账。
    """
    from services import clean_service as cs
    df = data_service.current_dataset
    if df is None:
        return {"error": "没有正在使用的数据集，请先导入或切换"}
    r = cs.run(req.method, df, req.config or {})
    if "error" in r:
        return {"error": r["error"]}
    state = data_service.clean_state()
    resp = {"ok": True, "method": req.method,
            "affected": r["affected"], "detail": r["detail"],
            "rows": len(df), "steps_done": state["steps"]}
    if r["affected"] == 0:
        # 什么都没改：不snapshot、不计步数，让前端提示但不记账
        resp["applied"] = False
        return resp
    data_service.snapshot_current()
    rep = data_service.replace_current(r["df"])
    if "error" in rep:
        return {"error": rep["error"]}
    data_service._clean_steps += 1
    resp["applied"] = True
    resp["step"] = data_service._clean_steps
    resp["rows"] = rep["rows"]
    resp["cols"] = rep["cols"]
    resp["missing"] = rep["missing"]
    resp["can_undo"] = True
    return resp


@app.post("/api/data/clean/undo")
async def undo_clean():
    """撤销全部清洗：把第一次改动之前那份数据放回来。"""
    return data_service.undo_clean()


@app.get("/api/data/clean/state")
async def clean_state():
    return data_service.clean_state()


# ── Stats ──

@app.get("/api/stats")
async def get_stats():
    df = data_service.current_dataset
    return {
        # 数可用清单而不是内存缓存：缓存有上限 6 份，数字会随切换跳动
        "datasets": data_service.count_available(),
        "total_rows": len(df) if df is not None else 0,
        "commands_run": len(code_service.history),
        "exports": len(export_service.exports),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
