"""知识沉淀 — 导入文献 → 读取 → 智能推荐去向 → 生成草稿 → 确认落库

设计原则：**去向推荐是确定性规则，不交给 AI 判断**。
规则跑得快、可复现、不会漂；AI 只负责两件它真正擅长的事——
写笔记正文，以及给出门类判断的一句人话解释。

一条文献可以同时落进多个去处（一篇 CSD 方法论文通常同时产出
文献笔记 + 方法卡片），所以推荐结果是一张可勾选的清单，
而不是单选题。
"""
import os
import re
import json
import uuid
import hashlib
from datetime import datetime

from . import doc_extract, kb_service
from .kb_service import DOC_TYPES, VALID_TYPES, DEFAULT_KB

# 系统内回归方法 → 常见叫法（用于判断文献是否对应库内某个方法）
METHOD_ALIASES = {
    "csdid": ["csdid", "callaway", "sant'anna", "santanna", "group-time att", "att(g,t)"],
    "sunab": ["sun", "abraham", "交互加权", "event study coefficients", "did_imputation"],
    "did2s": ["gardner", "两阶段 did", "two-stage did", "did2s", "residualized"],
    "bacon": ["goodman-bacon", "bacon decomposition", "2×2 decomposition", "forbidden comparison"],
    "did": ["did", "difference-in-differences", "双重差分", "倍分法"],
    "event_study": ["event study", "事件研究法", "动态效应", "平行趋势"],
    "iv2sls": ["iv", "2sls", "工具变量", "instrumental variable", "内生性"],
    "rd": ["rdd", "regression discontinuity", "断点回归", "rdrobust", "sharp rd"],
    "rd_fuzzy": ["模糊断点", "fuzzy rd", "fuzzy rdd"],
    "psm": ["psm", "倾向得分匹配", "propensity score", "psmatch"],
    "scm": ["scm", "合成控制法", "synthetic control", "synth"],
    "gmm": ["gmm", "广义矩", "差分 gmm", "系统 gmm", "动态面板"],
    "fe": ["固定效应", "fixed effect", "个体固定效应"],
    "twoway_fe": ["双向固定效应", "two-way fixed", "高维固定效应", "reghdfe"],
    "re": ["随机效应", "random effect", "hausman"],
    "heckman": ["heckman", "样本选择", "selection bias"],
    "quantile": ["分位数回归", "quantile regression"],
    "threshold": ["门槛回归", "threshold regression", "hansen", "面板门槛"],
    "tobit": ["tobit", "截断回归", "归并"],
    "poisson": ["泊松回归", "poisson"],
    "logit": ["logit", "逻辑回归"],
    "probit": ["probit"],
}

# 四类产物的判据。
#
# 不用纯计分：同一句话重复 8 遍就能把分数刷上去，而论文里「首先…然后」这种
# 所以每条信号归入一个「组」，判定要求「命中的不同组数」达到阈值；
# 计分只用来排序和展示。这样每条规则都能在界面上打勾/打叉给用户看。
_RULES = {
    "paper": {
        "signals": [
            (r"摘\s*要|abstract", 3, "abstract", "有摘要"),
            (r"关键词|keywords|jel", 2, "meta", "有关键词/JEL"),
            (r"本文|本\s*文|we\s+(?:find|show|use|estimate|propose)", 2, "voice", "第一人称论述"),
            (r"识别策略|内生性|因果|工具变量|外生冲击", 3, "ident", "有识别策略讨论"),
            (r"样本|数据来源|微观数据|面板数据|我们使用.{0,12}数据", 2, "data", "有数据与样本说明"),
            (r"参考文献|references", 1, "refs", "有参考文献"),
            (r"稳健性检验|安慰剂|placebo|robustness", 3, "robust", "有稳健性设计"),
            (r"政策评估|准自然实验|自然实验", 1, "policy", "属政策评估"),
        ],
        "need_min": 6,
        "need_groups": 4,
        "group_labels": {"abstract": "摘要", "meta": "关键词/JEL", "voice": "第一人称论述",
                         "ident": "识别策略", "data": "数据与样本", "refs": "参考文献",
                         "robust": "稳健性设计", "policy": "政策评估"},
    },
    "method": {
        "signals": [
            (r"适用条件|适用范围|前提假设|when\s+to\s+use", 4, "when", "讲适用条件"),
            (r"带宽|bandwidth|窗?宽|带宽选择", 2, "param", "讲带宽/窗口"),
            (r"参数选择|超参数|核函?数|kernel", 2, "param", "讲参数选择"),
            (r"估计量|渐近性质|一致性|有效性", 3, "theory", "讲估计量性质"),
            (r"假设检验|蒙特卡洛|模拟结果|simulation", 2, "sim", "有模拟/检验"),
            (r"命令|ado|stata|r\s+package|python", 2, "impl", "有软件实现"),
            (r"对?比|比较|versus|vs\.?", 1, "cmp", "有方法间比较"),
        ],
        "need_min": 6,
        "need_groups": 2,
        "group_labels": {"when": "适用条件", "param": "参数/带宽", "theory": "估计量性质",
                         "sim": "模拟/检验", "impl": "软件实现", "cmp": "方法间比较"},
    },
    "concept": {
        "signals": [
            (r"是指|指的是|定义为|即所称|defined\s+as|refers\s+to", 4, "def", "定义式表述"),
            (r"区别于|不同于|容易混淆|与.{0,10}不同", 3, "dist", "有概念辨析"),
        ],
        "need_min": 5,
        "need_groups": 1,
        "group_labels": {"def": "定义", "dist": "与相邻概念的区别"},
    },
}

_DISCARD_SIGNALS = [
    (r"仅供?参考|免责声明|版权归|转载", 1),
    (r"登录后|注册后|会员", 1),
]


def _norm(text: str) -> str:
    return text.lower()


def classify(ex) -> dict:
    """确定性推荐。返回每个去处的得分、命中的判据、以及对方法的关联猜测。"""
    body = _norm(ex["full_text"])
    title = _norm(ex.get("title") or "")
    hay = body + "\n" + title

    # ── 索引/列表页检测 ──
    # 一页文章标题列表会被误判成文献（每条标题都带「数据」「方法」「实现」这类词），
    # 必须先把这类页面摘出去。链接密度是最直接的信号。
    ld = float((ex.get("meta") or {}).get("link_density") or 0)
    short_blocks = sum(1 for b in ex["blocks"] if len(b["text"]) < 32)
    short_ratio = short_blocks / max(len(ex["blocks"]), 1)
    is_index = (ld >= 0.45 and ex["kind"] == "url") or (short_ratio >= 0.6 and ex["chars"] < 8000)
    index_note = None
    if is_index:
        index_note = (f"这更像一个索引/列表页而不是一篇正文"
                      f"（链接密度 {ld:.0%}，短条目占比 {short_ratio:.0%}）。"
                      f"列表页不进库——请打开其中具体的一篇再导入。")

    # 关联到系统内的方法
    methods = []
    for k, aliases in METHOD_ALIASES.items():
        c = sum(len(re.findall(re.escape(a), hay)) for a in aliases)
        if c >= 2:
            methods.append((k, c))
    methods.sort(key=lambda x: -x[1])
    methods = [k for k, _ in methods[:6]]

    scores, reasons, groups = {}, {}, {}
    for dtype, spec in _RULES.items():
        pts, why = 0, []
        hit_groups = {}
        for pat, w, grp, label in spec["signals"]:
            n = len(re.findall(pat, hay))
            if n:
                pts += w * min(n, 3)
                why.append(f"{label}（命中 {n} 处）")
                hit_groups[grp] = hit_groups.get(grp, 0) + n
        scores[dtype] = pts
        reasons[dtype] = why
        groups[dtype] = hit_groups

    # 篇幅门槛按类设：论文和方法卡都要求正文到一定长度；
    # 而一段操作流、一个概念本来就短，不能因为字数不够把它们毙掉。
    for dtype, mc in (("paper", 1200), ("method", 1200)):
        if ex["chars"] < mc:
            scores[dtype] = 0
            reasons[dtype] = [f"正文只有 {ex['chars']} 字符，够不上{DOC_TYPES[dtype][1]}"]
            groups[dtype] = {}

    def passes(dtype):
        """结构判定：凑够「不同组数」且分数过线，才算这一类。"""
        spec = _RULES[dtype]
        g = groups[dtype]
        if scores[dtype] < spec["need_min"]:
            return False
        return len(g) >= spec["need_groups"]

    # 每类的结构核对表，界面上直接打勾打叉给用户看
    structure = {}
    for dtype, spec in _RULES.items():
        gl = spec.get("group_labels", {})
        strong = set(spec.get("strong_groups", []))
        structure[dtype] = [{
            "group": k, "label": gl.get(k, k), "hit": groups[dtype].get(k, 0),
            "strong": (not strong) or (k in strong),
        } for k in gl]
        spec2 = spec
        need = spec2["need_groups"]
        got = sum(1 for s in structure[dtype] if s["hit"] > 0)
        structure[dtype] = {"items": structure[dtype],
                            "got": got, "need": need,
                            "ok_groups": got >= need,
                            "ok_points": scores[dtype] >= spec["need_min"],
                            "points": scores[dtype], "need_points": spec["need_min"]}

    recs = []
    for dtype in VALID_TYPES:
        if passes(dtype):
            recs.append({
                "type": dtype,
                "label": DOC_TYPES[dtype][1],
                "score": scores[dtype],
                "reasons": reasons[dtype],
                "structure": structure[dtype],
                "recommended": True,
            })

    # 索引页一律不给推荐，理由单独说清
    discard = None
    if is_index:
        recs = []
        discard = {"verdict": "不建议入库", "why": [index_note]}
    elif not recs:
        discard = {
            "verdict": "不建议入库",
            "why": ["未识别出研究问题、识别策略、结论等文献要（识别策略）"
                    "，也没有足够的方法说明（适用条件、参数选择、输出解读）",
                    f"全文 {ex['chars']} 字符 / {ex['n_blocks']} 段"],
        }

    return {
        "recs": recs,
        "scores": scores,
        "structure": structure,
        "methods": methods,
        "discard": discard,
        "hint": None,
        "chars": ex["chars"],
        "title": ex.get("title") or "",
        "is_index": is_index,
        "link_density": ld,
    }


# ── 草稿：让 AI 按已定下的去处写正文 ──

_BODY_SYSTEM = """你是实证研究方法论文献的整理助手。给你一篇文献的正文和它应当落入的类别，
你要为它写一份结构化笔记正文（Markdown，不要一级标题，不要 front-matter）。

硬规则，违反任何一条都算失败：
1. 每个实质性论断后面必须跟上原文定位标记，格式为 （{loc}）。定位号由用户提供，
   你必须原样使用提供的 loc，不得自己编造页码或段落号。
2. 只用原文里有的信息。原文没说的，写「原文未提及」，不要补全、不要推测。
3. 不得把「作者认为」写成「事实」。作者的主张要标明是主张。
4. 数字、符号、显著性必须与原文一致；拿不准就写「原文未明确」。
5. 中文写作，专业、紧凑，不写空洞总结。
"""

_TPL = {
    "paper": """按以下小节写：
- 研究问题
- 理论/机制
- 数据与样本
- 识别策略（重点：处理是什么、对照组是谁、为什么可信）
- 主要结论（逐条，带数字）
- 与现有方法的差异
- 局限与适用边界
- 对我有用的点（操作方法/可复现性/可引用的论断）""",
    "method": """按以下小节写：
- 这个方法解决什么问题
- 适用条件（什么数据形态、什么假设，缺一个会怎样）
- 关键参数怎么选（带宽/窗口/阶数/核，各自的后果）
- 输出怎么读（哪个数是有信息的，哪些只是副产品）
- 与其他方法的分界（什么时候不该用它）
- 常见坑
- 软件实现（命令/包名/关键选项）""",
    "concept": """按以下写：
- 一句话定义
- 与相邻概念的区别（容易混的是什么，差在哪）
- 用错会导致什么问题""",
}


def _ask_bodies(ex, recs, api_config) -> dict:
    """一次调用，让 AI 为每个选中的去处写正文。返回 {type: body}"""
    import asyncio
    from .ai_service import ai_service

    # 只送摘录以控成本：标题 + 前 12 段 + 命中判据相关的段
    blocks = ex["blocks"]
    keep = blocks[:14]
    want = " ".join(r["label"] for r in recs)
    for b in blocks:
        if re.search(r"步骤|流程|摘要|识别策略|结论|前提|输出|适用|参数", b["text"]):
            if b["n"] not in [x["n"] for x in keep]:
                keep.append(b)
    keep.sort(key=lambda b: b["n"])
    corpus = "\n\n".join(f"[{b['loc']}] {b['text']}" for b in keep[:40])

    ask = {
        "type": "user",
        "content": (
            f"文献标题：{ex.get('title') or '(未知)'}\n"
            f"抽取方式：{ex['kind']}，共 {ex['n_blocks']} 段 / {ex['chars']} 字符"
            + (f"（已截断）" if ex.get("truncated") else "") + "\n\n"
            f"正文摘录（方括号内是原文定位号，必须原样用于论断后的标记）：\n{corpus}\n\n"
            f"需要产出的类别：{want}\n\n"
            "对每个类别输出一段，格式严格为：\n"
            "===TYPE: paper===\n<该类别正文>\n===TYPE: method===\n<正文>\n"
            "（类别名按上面要求的给，顺序一致，没有正文也要留标记。）"
        ),
    }

    async def _go():
        return await ai_service.raw_chat(
            _BODY_SYSTEM, ask["content"], api_config,
            max_tokens=6000, temperature=0.15,
        )

    from .reg_utils import run_coro
    try:
        res = run_coro(_go())
    except Exception as e:
        return {"error": f"AI 调用失败: {type(e).__name__}: {e}"}

    if isinstance(res, dict) and res.get("error"):
        return res
    raw = res.get("content") if isinstance(res, dict) else str(res)

    out = {}
    parts = re.split(r"===TYPE:\s*(\w+)\s*===", raw or "")
    for i in range(1, len(parts) - 1, 2):
        out[parts[i].strip()] = parts[i + 1].strip()
    return {"bodies": out, "raw_len": len(raw or "")}


def make_draft(source_desc: str, ex: dict, api_config: dict = None,
              kb: str = None) -> dict:
    """读取 → 规则推荐 →（可选）AI 写正文 → 生成待确认草稿"""
    rec = classify(ex)
    draft_id = "dr_" + uuid.uuid4().hex[:10]
    items = [r for r in rec["recs"] if r["recommended"]]

    bodies, ai_error, ai_wrote = {}, None, set()
    if api_config and api_config.get("api_key"):
        r = _ask_bodies(ex, items, api_config)
        if r.get("error"):
            ai_error = r["error"]
        else:
            bodies = r.get("bodies", {})
            ai_wrote = {k for k, v in bodies.items() if v}

    # 没跑 AI 时给一个带 loc 的骨架，用户可手填；保证流程不中断
    for it in items:
        if not bodies.get(it["type"]):
            t = ex["blocks"][:6]
            bodies[it["type"]] = (
                f"_{_TPL[it['type']].splitlines()[0].lstrip('- ')}_\n\n"
                + "\n".join(f"- [ ] {line.strip()}" for line in _TPL[it["type"]].splitlines())
                + "\n\n## 原文要点（待人工核对）\n"
                + "\n".join(f"- （{b['loc']}）{b['text'][:120]}" for b in t)
                + "\n\n> ⚠️ 未调用 AI，以上为骨架，逐条核对后删除本提示。"
            )

    # 定位标记校验：每个断论都应该能回到原文。
    # AI 很容易写得很像那么回事但不给位置，那就无法验弎。
    loc_re = re.compile(r"[（(]\s*(p\.\d+|[§第]\s*\d+|段\d+|行\d+|表\d+)\s*[）)]",
                        re.I)
    missing_loc = []
    for it in items:
        # 只校验 AI 写的那份。没配 key 时用的骨架自带定位标记，
        # 拿它去校验等于自己验自己。
        if it["type"] in ai_wrote:
            has = bool(loc_re.search(bodies.get(it["type"]) or ""))
            it["loc_ok"] = has
            if not has:
                missing_loc.append(it["label"])
        else:
            it["loc_ok"] = None

    return {
        "draft_id": draft_id,
        "source": source_desc,
        "kind": ex["kind"],
        "title": ex.get("title") or "",
        "chars": ex["chars"],
        "truncated": ex.get("truncated"),
        "scores": rec["scores"],
        "methods": rec["methods"],
        "hint": rec["hint"],
        "discard": rec["discard"],
        "ai_error": ai_error,
        "kb": kb or DEFAULT_KB,
        "duplicates": kb_service.kb_service.find_duplicates(
            ex.get("title") or "", source_desc, kb or None),
        "missing_loc_types": missing_loc,
        "items": [{
            "type": it["type"], "label": it["label"], "score": it["score"],
            "reasons": it["reasons"], "recommended": True,
            "loc_ok": it.get("loc_ok", False),
            "selected": True, "body": bodies.get(it["type"], ""),
            "template": _TPL[it["type"]],
        } for it in items],
        # 未被推荐但允许用户手动勾上的去处
        "optional": [{
            "type": t, "label": DOC_TYPES[t][1], "score": rec["scores"][t],
            "reasons": [], "selected": False, "body": "",
            "template": _TPL[t],
        } for t in VALID_TYPES if t not in [i["type"] for i in items]],
    }


def commit_draft(draft_id: str, chosen: list, meta_extra: dict = None,
                 kb: str = None) -> dict:
    """chosen: [{type, title, body, tags?, methods?}]"""
    d = _drafts().get(draft_id)
    if not d:
        return {"error": "草稿不存在或已过期，请重新导入"}
    src = None
    if d.get("_snapshot_path"):
        src = d["_snapshot_path"]
    saved = []
    for c in chosen:
        t = (c.get("type") or "").strip()
        if t not in DOC_TYPES:
            saved.append({"error": f"未知类型 {t}"})
            continue
        meta = {
            "title": (c.get("title") or d.get("title") or "未命名").strip(),
            "source_kind": d.get("kind"),
            "source_ref": d.get("source"),
            "tags": c.get("tags") or [],
            "methods": c.get("methods") or d.get("methods") or [],
            "verified": False,
        }
        if src:
            meta["snapshot"] = src
        if meta_extra:
            meta.update({k: v for k, v in meta_extra.items() if v is not None})
        r = kb_service.kb_service.save_doc(
            t, meta, c.get("body") or "",
            c.get("kb") or kb or meta.get("kb"))
        saved.append(r)
    return {"ok": True, "saved": saved, "count": len(saved)}


def _drafts():
    return kb_service.kb_service._drafts


def store_draft(draft: dict, snapshot_path: str = None) -> dict:
    """草稿挂到 kb_service 的内存表里，等用户确认"""
    draft = dict(draft)
    draft["_snapshot_path"] = snapshot_path
    store = _drafts()
    store[draft["draft_id"]] = draft
    # 只留最近 20 份，避免内存无限涨
    if len(store) > 20:
        for k in list(store)[:len(store) - 20]:
            store.pop(k, None)
    return {"draft_id": draft["draft_id"]}


def get_draft(draft_id: str) -> dict:
    d = _drafts().get(draft_id)
    if not d:
        return {"error": "草稿不存在或已过期，请重新导入"}
    return d


def digest(text: str) -> str:
    return hashlib.sha1((text or "").encode("utf-8", "ignore")).hexdigest()[:12]
