"""知识库服务 — 多个知识库 × 三类产物的结构化笔记库

不用向量化。每条笔记是带头信息（front-matter）的 Markdown 文件，
人可读可改，检索走「元数据过滤 + 关键词打分」，召回几十条后由 AI 读全文。

目录结构（顶层是知识库，一个知识库就是一个文件夹）：
  <root>/<知识库>/papers/      文献笔记
  <root>/<知识库>/methods/     方法卡片
  <root>/<知识库>/glossary/    概念
  <root>/<知识库>/_about.md    这个库是干什么的（可选）
  <root>/_source/              导入时的原文快照，根层共享

一条笔记的 front-matter 里有 kb 字段，和它所在的顶层目录一致。
真目录而不是只加一个字段，是为了你能在文件管理器里直接看、拷、备份。
"""
import os
import re
import json
import time
import shutil
import random
import string
from datetime import datetime

# 产物类型
DOC_TYPES = {
    "paper": ("papers", "文献笔记"),
    "method": ("methods", "方法卡片"),
    "concept": ("glossary", "概念"),
}
VALID_TYPES = list(DOC_TYPES.keys())

DEFAULT_KB = "未归档"
ABOUT_FILE = "_kb.json"


def _root() -> str:
    r = os.environ.get("STATA_KB_ROOT")
    if r:
        return r
    return os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))), "knowledge")


def _slug(s: str, n: int = 48) -> str:
    """目录/文件名安全的名字。中文保留，只替换 Windows 非法字符。"""
    s = re.sub(r'[\\/:*?"<>|\s]+', "-", (s or "").strip())
    s = re.sub(r"[\x00-\x1f]", "", s)
    s = s.strip("-. ")
    return (s[:n] or "untitled")


def _new_id() -> str:
    return "kb_%s_%s" % (datetime.now().strftime("%Y%m%d%H%M%S"),
                         "".join(random.choices(string.ascii_lowercase + string.digits, k=4)))


# ── front-matter（自描述的最小 YAML 子集，不引依赖） ──

_FM_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?(.*)\Z", re.S)


def _dump_scalar(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return '""'
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v)
    if s == "" or re.search(r'[:#\[\]{}]|^\s|\s$', s) or "\n" in s:
        return '"' + s.replace('\\', "\\\\").replace('"', '\\"') + '"'
    return s


def _dump_list(v):
    if not v:
        return "[]"
    return "[" + ", ".join(_dump_scalar(x) for x in v) + "]"


def parse_doc(raw: str) -> dict:
    """拆成 (meta, body)"""
    m = _FM_RE.match(raw or "")
    if not m:
        return {}, raw or ""
    meta = {}
    for line in m.group(1).split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        k, v = k.strip(), v.strip()
        if v in ("[]", '""', ""):
            meta[k] = []
            continue
        if v.startswith("[") and v.endswith("]"):
            inner = v[1:-1].strip()
            items = []
            if inner:
                for part in re.findall(r'"((?:[^"\\]|\\.)*)"|([^,]+)', inner):
                    items.append((part[0] or part[1]).replace('\\"', '"').strip())
            meta[k] = items
        elif v in ("true", "false"):
            meta[k] = (v == "true")
        elif re.fullmatch(r"-?\d+", v):
            meta[k] = int(v)
        else:
            meta[k] = v.strip('"')
    return meta, m.group(2)


def dump_doc(meta: dict, body: str) -> str:
    lines = ["---"]
    order = ["id", "kb", "type", "title", "source_kind", "source_ref",
             "authors", "year", "venue", "tags", "methods", "dois",
             "verified", "citations", "created", "updated"]
    keys = [k for k in order if k in meta] + [k for k in meta if k not in order]
    for k in keys:
        v = meta[k]
        if isinstance(v, (list, tuple)):
            lines.append(f"{k}: {_dump_list(v)}")
        else:
            lines.append(f"{k}: {_dump_scalar(v)}")
    lines.append("---")
    return "\n".join(lines) + "\n" + (body or "").lstrip("\n")


class KBService:
    def __init__(self):
        self.root = _root()
        self._drafts = {}
        self._ensure_dirs()

    # ── 目录 ──

    def _kb_dir(self, kb: str) -> str:
        """显示名 → 目录。优先按 _kb.json 里的 name 匹配，
        匹配不到就退回「名字本身就是目录名」（兼容早期数据）。"""
        if kb and os.path.isdir(os.path.join(self.root, kb)):
            meta = self._read_kb_meta(kb)
            if not meta.get("name") or meta.get("name") == kb:
                return os.path.join(self.root, kb)
        want = _slug(kb)
        if os.path.isdir(os.path.join(self.root, want)):
            return os.path.join(self.root, want)
        for name in self._dir_names():
            m = self._read_kb_meta(name)
            if m.get("name") == kb or _slug(m.get("name") or "") == want:
                return os.path.join(self.root, name)
        return os.path.join(self.root, want)

    def _dir_names(self) -> list:
        if not os.path.isdir(self.root):
            return []
        legacy = set(sub for sub, _ in DOC_TYPES.values()) | {"_source"}
        return [n for n in os.listdir(self.root)
                if os.path.isdir(os.path.join(self.root, n)) and n not in legacy]

    def _read_kb_meta(self, dirname: str) -> dict:
        p = os.path.join(self.root, dirname, ABOUT_FILE)
        if not os.path.isfile(p):
            return {}
        try:
            import json as _json
            with open(p, "r", encoding="utf-8") as f:
                return _json.load(f) or {}
        except Exception:
            return {}

    def _write_kb_meta(self, dirname: str, name: str, about: str) -> None:
        import json as _json
        p = os.path.join(self.root, dirname, ABOUT_FILE)
        with open(p, "w", encoding="utf-8") as f:
            _json.dump({"name": name, "about": about or "",
                        "dir": dirname,
                        "updated": datetime.now().strftime("%Y-%m-%d %H:%M")},
                       f, ensure_ascii=False, indent=2)

    def _ensure_dirs(self):
        os.makedirs(os.path.join(self.root, "_source"), exist_ok=True)
        d = self._kb_dir(DEFAULT_KB)
        for sub in DOC_TYPES.values():
            os.makedirs(os.path.join(d, sub[0]), exist_ok=True)

    def list_kbs(self) -> list:
        """列出所有知识库。目录名就是库名。"""
        out = []
        if not os.path.isdir(self.root):
            return out
        legacy = set(sub for sub, _ in DOC_TYPES.values()) | {"_source"}
        for name in sorted(os.listdir(self.root)):
            d = os.path.join(self.root, name)
            if not os.path.isdir(d) or name in legacy:
                continue
            docs = self.list_docs(kb=name)
            by_type = {}
            for t in VALID_TYPES:
                n = sum(1 for x in docs if x["type"] == t)
                if n:
                    by_type[t] = n
            meta = self._read_kb_meta(name)
            display = meta.get("name") or name
            about = meta.get("about") or ""
            methods = sorted({m for x in docs for m in x["methods"]})
            out.append({
                "name": display,
                "dir": name,
                "about": about,
                "docs": len(docs),
                "by_type": by_type,
                "chars": sum(x["chars"] for x in docs),
                "citations": sum(x["citations"] for x in docs),
                "unverified": sum(1 for x in docs if not x["verified"]),
                "methods": methods,
                "n_methods": len(methods),
                "updated": max([x["updated"] for x in docs], default=""),
                "is_default": display == DEFAULT_KB or name == DEFAULT_KB,
            })
        out.sort(key=lambda x: (x["is_default"], -x["docs"], x["name"]))
        return out

    def get_kb(self, name: str):
        for k in self.list_kbs():
            if k["name"] == name:
                return k
        return None

    def create_kb(self, name: str, about: str = "") -> dict:
        nm = (name or "").strip()
        if not nm:
            return {"error": "知识库名字不能空"}
        for k in self.list_kbs():
            if k["name"] == nm:
                return {"error": f"知识库「{nm}」已存在"}
        # 目录名用 slug；显示名可以带空格和标点，不会撞文件系统
        base = _slug(nm)
        d = os.path.join(self.root, base)
        n = 2
        while os.path.isdir(d) and os.listdir(d):
            d = os.path.join(self.root, f"{base}-{n}")
            n += 1
        dirname = os.path.basename(d)
        for sub in DOC_TYPES.values():
            os.makedirs(os.path.join(d, sub[0]), exist_ok=True)
        self._write_kb_meta(dirname, nm, about)
        return {"ok": True, "name": nm, "dir": dirname}

    def rename_kb(self, name: str, new_name: str, about: str = None) -> dict:
        """改显示名 + 说明。只写 _kb.json，不改目录名——
        Windows 上重命名目录会撞 WinError 5，而且目录名是外部引用的锚点。"""
        d = self._kb_dir(name)
        if not os.path.isdir(d):
            return {"error": "知识库不存在"}
        dirname = os.path.basename(d)
        meta = self._read_kb_meta(dirname)
        old_display = meta.get("name") or dirname
        display = (new_name or "").strip() or old_display
        if display != old_display:
            for k in self.list_kbs():
                if k["name"] == display and k["dir"] != dirname:
                    return {"error": f"已存在同名知识库「{display}」"}
        new_about = about if about is not None else (meta.get("about") or "")
        self._write_kb_meta(dirname, display, new_about)
        n = 0
        for k, t2, fp in self._files():
            if k != dirname:
                continue
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    m, body = parse_doc(f.read())
            except Exception:
                continue
            if m.get("kb") != display:
                m["kb"] = display
                with open(fp, "w", encoding="utf-8") as f:
                    f.write(dump_doc(m, body))
                n += 1
        return {"ok": True, "name": display, "dir": dirname, "docs_updated": n}

    def set_about(self, name: str, about: str) -> dict:
        d = self._kb_dir(name)
        if not os.path.isdir(d):
            return {"error": "知识库不存在"}
        dirname = os.path.basename(d)
        meta = self._read_kb_meta(dirname)
        self._write_kb_meta(dirname, meta.get("name") or dirname, about)
        return {"ok": True}

    def delete_kb(self, name: str) -> dict:
        d = self._kb_dir(name)
        if not os.path.isdir(d):
            return {"error": "知识库不存在"}
        dirname = os.path.basename(d)
        n_docs = len(self.list_docs(kb=dirname))
        shutil.rmtree(d)
        return {"ok": True, "removed_docs": n_docs}

    # ── 扫描 ──

    def _kbs(self, kb=None):
        """返回目录名列表。"""
        names = self._dir_names()
        if not kb:
            return names
        d = self._kb_dir(kb)
        return [os.path.basename(d)]

    def _files(self, types=None, kb=None):
        """返回 [(kb, type, path)]"""
        out = []
        subs = types or list(DOC_TYPES.keys())
        for k in self._kbs(kb):
            for t in subs:
                if t not in DOC_TYPES:
                    continue
                d = os.path.join(self.root, k, DOC_TYPES[t][0])
                if not os.path.isdir(d):
                    continue
                for fn in sorted(os.listdir(d), reverse=True):
                    if fn.endswith(".md"):
                        out.append((k, t, os.path.join(d, fn)))
        return out

    def list_docs(self, dtype=None, tag=None, keyword=None, verified=None, kb=None) -> list:
        res = []
        for k, t, fp in self._files([dtype] if dtype else None, kb):
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    meta, body = parse_doc(f.read())
            except Exception:
                continue
            if not meta.get("id"):
                continue
            if tag and tag not in (meta.get("tags") or []):
                continue
            if verified is not None and bool(meta.get("verified")) != bool(verified):
                continue
            if keyword:
                kw = keyword.lower()
                hay = " ".join([
                    str(meta.get("title", "")), " ".join(meta.get("tags") or []),
                    " ".join(meta.get("methods") or []), body,
                ]).lower()
                if kw not in hay:
                    continue
            display = meta.get("kb") or self._read_kb_meta(k).get("name") or k
            res.append({
                "id": meta["id"], "kb": display, "dir": k,
                "type": t, "type_label": DOC_TYPES[t][1],
                "title": meta.get("title") or "(无标题)",
                "tags": meta.get("tags") or [], "methods": meta.get("methods") or [],
                "source_kind": meta.get("source_kind"), "source_ref": meta.get("source_ref"),
                "snapshot": meta.get("snapshot"),
                "authors": meta.get("authors") or [], "year": meta.get("year"),
                "verified": bool(meta.get("verified")),
                "citations": int(meta.get("citations") or 0),
                "chars": len(body), "file": os.path.basename(fp),
                "updated": meta.get("updated") or meta.get("created") or "",
            })
        return res

    def get_doc(self, doc_id: str) -> dict:
        for k, t, fp in self._files():
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    meta, body = parse_doc(f.read())
            except Exception:
                continue
            if meta.get("id") == doc_id:
                return {"meta": meta, "body": body, "type": t, "kb": k,
                        "type_label": DOC_TYPES[t][1], "file": fp}
        return {"error": "文档不存在"}

    # ── 写入 ──

    def _path(self, dtype: str, kb: str, meta: dict) -> str:
        sub = DOC_TYPES[dtype][0]
        d = os.path.join(self.root, _slug(kb), sub)
        os.makedirs(d, exist_ok=True)
        stem = f"{datetime.now().strftime('%Y%m%d-%H%M%S')}_{_slug(meta.get('title'))}"
        p = os.path.join(d, stem + ".md")
        n = 2
        while os.path.exists(p):
            p = os.path.join(d, f"{stem}-{n}.md")
            n += 1
        return p

    def save_doc(self, dtype: str, meta: dict, body: str, kb: str = None) -> dict:
        if dtype not in DOC_TYPES:
            return {"error": f"未知类型 {dtype}"}
        kb = _slug(kb or DEFAULT_KB)
        if not os.path.isdir(self._kb_dir(kb)):
            self.create_kb(kb)
        meta = dict(meta or {})
        meta.setdefault("id", _new_id())
        meta["kb"] = kb
        meta["type"] = dtype
        now = datetime.now().strftime("%Y-%m-%d %H:%M")
        meta.setdefault("created", now)
        meta["updated"] = now
        meta.setdefault("verified", False)
        meta.setdefault("citations", 0)
        meta.setdefault("tags", [])
        meta.setdefault("methods", [])
        meta.setdefault("authors", [])
        fp = self._path(dtype, kb, meta)
        with open(fp, "w", encoding="utf-8") as f:
            f.write(dump_doc(meta, body))
        return {"ok": True, "id": meta["id"], "kb": kb, "file": fp,
                "title": meta.get("title"), "type": dtype}

    def update_doc(self, doc_id: str, meta: dict = None, body: str = None) -> dict:
        cur = self.get_doc(doc_id)
        if "error" in cur:
            return cur
        m = dict(cur["meta"])
        if meta:
            m.update({k: v for k, v in meta.items() if v is not None})
        if body is not None:
            b = body
        else:
            b = cur["body"]
        m["updated"] = datetime.now().strftime("%Y-%m-%d %H:%M")
        old = cur["file"]
        new = old
        new_kb = _slug(m.get("kb") or cur["kb"])
        if new_kb != cur["kb"]:
            new = self._path(cur["type"], new_kb, m)
        elif (meta or {}).get("title") and meta["title"] != cur["meta"].get("title"):
            new = self._path(cur["type"], cur["kb"], m)
        with open(new, "w", encoding="utf-8") as f:
            f.write(dump_doc(m, b))
        if new != old and os.path.exists(old):
            os.remove(old)
        return {"ok": True, "id": doc_id, "file": new}

    def delete_doc(self, doc_id: str) -> dict:
        cur = self.get_doc(doc_id)
        if "error" in cur:
            return cur
        os.remove(cur["file"])
        return {"ok": True}

    def verify_doc(self, doc_id: str, verified: bool = True) -> dict:
        return self.update_doc(doc_id, meta={"verified": bool(verified)})

    def bump_citation(self, doc_ids) -> dict:
        n = 0
        for did in (doc_ids or []):
            cur = self.get_doc(did)
            if "error" in cur:
                continue
            try:
                self.update_doc(did, meta={"citations": int(cur["meta"].get("citations") or 0) + 1})
                n += 1
            except Exception:
                pass
        return {"bumped": n}

    # ── 检索：元数据过滤 + 关键词打分（无向量） ──

    _STOP = set("的了是在和与对为把被从将会对一个我们你他她它这那些什么怎么如果因为所以但是或者以及可以"
                "the a an of to in for on with is are be as at by it this that".split())

    @staticmethod
    def _tokens(query: str) -> list:
        """没有分词器，所以中英混排时：英文/数字按词取，中文长串切 2~3 元组。"""
        raw = re.findall(r"[A-Za-z0-9_\-\.]{2,}|[一-鿿]{2,}", (query or "").lower())
        out = []
        for t in raw:
            if re.fullmatch(r"[a-z0-9_\-\.]+", t):
                if t not in KBService._STOP:
                    out.append(t)
                continue
            if t in KBService._STOP:
                continue
            if len(t) <= 3:
                out.append(t)
                continue
            n = 3
            out.extend(t[i:i + n] for i in range(len(t) - n + 1))
            out.append(t)
        return [t for t in dict.fromkeys(out) if len(t) >= 2]

    def search(self, query: str, k: int = 8, dtype=None, kb=None) -> dict:
        toks = self._tokens(query)
        hits = []
        for d in self.list_docs(dtype=dtype, kb=kb):
            doc = self.get_doc(d["id"])
            if "error" in doc:
                continue
            hay = " ".join([d["title"], " ".join(d["tags"]), " ".join(d["methods"]),
                            doc["body"]]).lower()
            score = 0
            if d["title"].lower() in (query or "").lower() and d["title"]:
                score += 12
            for t in toks:
                c = hay.count(t)
                score += min(c, 8) * (2 if len(t) >= 4 else 1)
            if score <= 0:
                continue
            bl = re.split(r"\n\s*\n", doc["body"])
            scored = sorted(
                ((sum(min(b.lower().count(t), 4) for t in toks), i, b) for i, b in enumerate(bl)),
                key=lambda x: -x[0])[:3]
            excerpt = "\n\n".join(b for s, _, b in scored if s > 0)[:1200]
            hits.append({**d, "score": score, "excerpt": excerpt})
        hits.sort(key=lambda h: -h["score"])
        top = hits[:k]
        self.bump_citation([h["id"] for h in top])
        # bump_citation 写盘了，重读一次让返回值反映新计数
        for h in top:
            d2 = self.get_doc(h["id"])
            if "error" not in d2:
                h["citations"] = int(d2["meta"].get("citations") or 0)
                h["verified"] = bool(d2["meta"].get("verified"))
        return {"query": query, "tokens": toks, "total": len(hits),
                "hits": top, "kbs": sorted({h["kb"] for h in top})}

    def context_for(self, query: str, k: int = 5, budget: int = 6000, kb=None) -> dict:
        """给 AI 用的上下文块：命中库内条目则拼装，未命中则明确告知库里没有。
        每条标注来自哪个知识库，用户才知道依据是什么。"""
        r = self.search(query, k=k, kb=kb)
        if not r["hits"]:
            return {"found": False, "text": "", "ids": [], "total": 0, "kbs": []}
        parts, ids, kbs = [], [], []
        used = 0
        for h in r["hits"]:
            doc = self.get_doc(h["id"])
            if "error" in doc:
                continue
            blk = (f"### [{h['type_label']}] {h['title']}\n"
                   f"知识库：{h['kb']}\n"
                   f"来源：{h.get('source_kind') or '未标注'} {h.get('source_ref') or ''}  "
                   f"已核对：{'是' if h['verified'] else '否'}\n"
                   + (h.get("excerpt") or doc["body"][:800]) + "\n")
            if used + len(blk) > budget:
                break
            parts.append(blk)
            ids.append(h["id"])
            if h["kb"] not in kbs:
                kbs.append(h["kb"])
            used += len(blk)
        return {"found": True, "text": "\n".join(parts), "ids": ids,
                "total": r["total"], "kbs": kbs}

    # ── 去重 ──

    @staticmethod
    def _sig(s: str) -> str:
        """归一化标题，用来判定「已经导过这篇」。

        同一篇文献可能先从 URL 导、再从 PDF 导，source_ref 不一样但标题一样；
        另外参考目录里常同时有方案A / 方案B / 完整版好几个文件。
        """
        s = re.sub(r"[\s\-_()（）［］]+", "", str(s or "").lower())
        s = re.sub(r"v\d+$", "", s)
        for tag in ("clean", "robust", "完整版", "方案a", "方案b"):
            s = s.replace(tag, "")
        return s[:40]

    def find_duplicates(self, title: str, source_ref: str = "",
                        kb: str = None) -> list:
        """扫全部知识库，不只看当前库。

        同库里重复是真重复；别的库已有是有用信号（说明该合并或交叉引用），
        两种都要提示，但不能一视同仁地拦。
        """
        sig = self._sig(title)
        target_dir = None
        if kb:
            target_dir = os.path.basename(self._kb_dir(kb))
        hits = []
        for k, t, fp in self._files():
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    meta, _ = parse_doc(f.read())
            except Exception:
                continue
            if not meta.get("id"):
                continue
            here = meta.get("kb") or self._read_kb_meta(k).get("name") or k
            if meta.get("title") and self._sig(meta["title"]) == sig:
                hits.append({"id": meta["id"], "title": meta.get("title"),
                             "source_ref": meta.get("source_ref"), "kb": here,
                             "type": t, "type_label": DOC_TYPES[t][1],
                             "reason": "标题相同",
                             "same_kb": (target_dir is None or here == target_dir)})
                continue
            if (source_ref and meta.get("source_ref")
                    and str(meta["source_ref"]).strip() == str(source_ref).strip()):
                hits.append({"id": meta["id"], "title": meta.get("title"),
                             "source_ref": meta.get("source_ref"), "kb": here,
                             "type": t, "type_label": DOC_TYPES[t][1],
                             "reason": "来源地址相同",
                             "same_kb": (target_dir is None or here == target_dir)})
        return hits

    # ── 内置知识条目（替代硬编码提示词） ──

    def ensure_builtins(self) -> dict:
        """把内置知识条目写进库。只补缺失的，不改已有的——
        用户在页面上手改过的笔记不会被覆盖。"""
        from . import kb_builtins as B
        self.create_kb(B.BUILTIN_KB, B.BUILTIN_ABOUT)
        existing = {d["title"] for d in self.list_docs(kb=B.BUILTIN_KB)}
        created, skipped = [], []
        for item in B.BUILTINS:
            if item["title"] in existing:
                skipped.append(item["title"])
                continue
            meta = {
                "title": item["title"],
                "tags": item.get("tags") or [],
                "methods": item.get("commands") or [],
                "builtin": True,
                "source_kind": "builtin",
                "source_ref": "系统内置知识",
                "verified": False,
            }
            r = self.save_doc("method", meta, item["body"], kb=B.BUILTIN_KB)
            if r.get("ok"):
                created.append(item["title"])
            else:
                skipped.append(item["title"] + "(失败)")
        return {"created": created, "skipped": skipped,
                "kb": B.BUILTIN_KB, "total_in_lib": len(self.list_docs(kb=B.BUILTIN_KB))}

    def builtin_context(self, query: str, page: str = "", k: int = 4,
                        budget: int = 3000) -> dict:
        """给 AI 提示词用的内置知识块。

        取代原来写死的 LIANXH_KNOWLEDGE 常量：按用户的问题和当前页面检索，
        只带相关的条目，而不是每次全量发 60 行。
        """
        from . import kb_builtins as B
        r = self.search(query, k=k, kb=B.BUILTIN_KB)
        hits = r.get("hits") or []
        parts, ids = [], []
        used = 0
        for h in hits:
            if h.get("score", 0) < 2:
                continue
            doc = self.get_doc(h["id"])
            if "error" in doc:
                continue
            cmds = h.get("methods") or []
            head = f"### {h['title']}"
            if cmds:
                head += f"（{' '.join('`' + c + '`' for c in cmds)}）"
            blk = head + "\n" + doc["body"][:1400] + "\n"
            if used + len(blk) > budget:
                break
            parts.append(blk)
            ids.append(h["id"])
            used += len(blk)
        return {"text": "\n".join(parts), "ids": ids,
                "titles": [h["title"] for h in hits[:len(ids)]],
                "found": bool(parts)}

    # ── 原文快照 ──

    def read_source(self, name: str) -> bytes:
        p = os.path.join(self.root, "_source", os.path.basename(name or ""))
        if os.path.isfile(p):
            with open(p, "rb") as f:
                return f.read()
        return None

    def stats(self, kb: str = None) -> dict:
        docs = self.list_docs(kb=kb)
        out = {"total": len(docs), "chars": sum(d["chars"] for d in docs),
               "unverified": sum(1 for d in docs if not d["verified"]),
               "citations": sum(d["citations"] for d in docs),
               "by_type": {}}
        for t in VALID_TYPES:
            sub = [d for d in docs if d["type"] == t]
            out["by_type"][t] = {"count": len(sub), "label": DOC_TYPES[t][1],
                                 "chars": sum(d["chars"] for d in sub)}
        out["n_kbs"] = 1 if kb else len(self.list_kbs())
        return out

    def save_source(self, name: str, data: bytes) -> str:
        self._ensure_dirs()
        safe = re.sub(r'[\\/:*?"<>|]+', "_", name)[:80]
        p = os.path.join(self.root, "_source", f"{time.time_ns()}_{safe}")
        with open(p, "wb") as f:
            f.write(data)
        return os.path.basename(p)


kb_service = KBService()
