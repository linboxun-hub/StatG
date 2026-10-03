"""文献/文章正文抽取 — 支持 PDF / Word / URL / 纯文本

统一产出 blocks 结构，每个 block 带定位号（loc），后续沉淀成 MD 时
每条论断都要求能回溯到这里的 loc，否则不准写入。
"""
import io
import os
import re
from urllib.parse import urlparse

MAX_CHARS = 400_000          # 篇幅上限，超长只取前 40 万字符
MAX_URL_CHARS = 120_000

_BLOCK_SPLIT = re.compile(r"\n\s*\n+")


def _split_blocks(text: str) -> list:
    """按空行切段，过滤过短噪声段"""
    out = []
    for raw in _BLOCK_SPLIT.split(text or ""):
        s = re.sub(r"[ \t\xa0]+", " ", raw).strip()
        if len(s) >= 2:
            out.append(s)
    return out


def _result(kind: str, title: str, blocks: list, meta: dict) -> dict:
    """blocks: [{n, text}]，n 从 1 开始，作为原文定位号"""
    full = "\n\n".join(b["text"] for b in blocks)
    truncated = False
    if len(full) > MAX_CHARS:
        full = full[:MAX_CHARS]
        truncated = True
    return {
        "kind": kind,
        "title": title or "",
        "blocks": blocks,
        "full_text": full,
        "chars": len(full),
        "n_blocks": len(blocks),
        "truncated": truncated,
        "meta": meta or {},
    }


# ── PDF ──

def extract_pdf(path=None, data=None) -> dict:
    """PDF 双引擎：PyMuPDF 优先，失败退 pdfplumber。loc = 页码"""
    import fitz  # PyMuPDF

    doc = fitz.open(path, stream=data, filetype="pdf") if path else fitz.open(
        stream=data, filetype="pdf")
    meta = {
        "pages": doc.page_count,
        "author": (doc.metadata or {}).get("author", ""),
        "title_from_pdf": (doc.metadata or {}).get("title", ""),
    }
    blocks = []
    for i in range(doc.page_count):
        t = doc[i].get_text("text")
        if not t or not t.strip():
            continue
        blocks.append({"n": i + 1, "text": t.strip(), "loc": f"p.{i + 1}"})
    title = meta["title_from_pdf"] or _guess_title(blocks)
    doc.close()
    if not any(b["text"].strip() for b in blocks):
        raise ValueError("PDF 没有可抽取的文字层，可能是扫描版（需要 OCR）")
    return _result("pdf", title, blocks, meta)


def _pdf_pdfplumber(path=None, data=None) -> dict:
    import pdfplumber
    blocks = []
    with pdfplumber.open(path) if path else pdfplumber.open(io.BytesIO(data)) as pdf:
        for i, page in enumerate(pdf.pages):
            t = page.extract_text() or ""
            if t.strip():
                blocks.append({"n": i + 1, "text": t.strip(), "loc": f"p.{i + 1}"})
    return _result("pdf", _guess_title(blocks), blocks, {"pages": len(blocks)})


# ── Word ──

def extract_docx(path=None, data=None) -> dict:
    """loc = 段落序号"""
    import docx
    d = docx.Document(path) if path else docx.Document(io.BytesIO(data))
    paras = [p.text.strip() for p in d.paragraphs if p.text.strip()]
    meta = {"paragraphs": len(paras)}
    try:
        cp = d.core_properties
        meta["author"] = cp.author or ""
        meta["title_from_pdf"] = cp.title or ""
        if cp.created:
            meta["created"] = str(cp.created)[:10]
    except Exception:
        pass
    blocks = []
    for i, t in enumerate(paras, start=1):
        blocks.append({"n": i, "text": t, "loc": f"§{i}"})
    # 表格也进来，编号接着段落
    for ti, tb in enumerate(d.tables, start=1):
        rows = []
        for r in tb.rows:
            rows.append(" | ".join(c.text.strip() for c in r.cells))
        if rows:
            blocks.append({"n": len(paras) + ti, "text": "\n".join(rows),
                           "loc": f"表{ti}"})
    title = meta.get("title_from_pdf") or (paras[0][:80] if paras else "")
    return _result("word", title, blocks, meta)


# ── URL ──

_NOISE_TAGS = ["script", "style", "nav", "footer", "header", "aside", "form",
               "noscript", "iframe", "svg", "button", "select", "figure"]


def _collect_blocks(root) -> list:
    out = []
    for el in root.find_all(["p", "h1", "h2", "h3", "h4", "li", "pre", "blockquote"]):
        t = re.sub(r"\s+", " ", el.get_text(" ", strip=True))
        if len(t) >= 15 and not any(t in o for o in out):
            out.append(t)
    return out


def _best_root(soup):
    """按「候选容器内正文总长度」挑最可能承载正文的那个容器。

    只认 article/main 会漏掉大量中文站点（连享会的推文页就没有这些标签），
    所以把所有 div/section/article/main 都当候选，按文本量打分取最高。
    """
    cands = soup.find_all(["article", "main", "section", "div", "body"])
    best, best_len = None, 0
    for el in cands[:800]:
        txt = el.get_text(" ", strip=True)
        if len(txt) < 400:
            continue
        # 嵌套容器会让外层也得分高，用「自身直接文本」占比做衰减
        own = sum(len(p.get_text(" ", strip=True)) for p in el.find_all(["p", "li"], recursive=False))
        score = len(txt) + own * 2
        if score > best_len:
            best, best_len = el, score
    return best or soup.body or soup


def extract_url(url: str) -> dict:
    import requests
    from bs4 import BeautifulSoup

    if not re.match(r"^https?://", url):
        url = "http://" + url
    r = requests.get(url, timeout=25, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    })
    r.raise_for_status()
    r.encoding = r.apparent_encoding or r.encoding or "utf-8"

    soup = BeautifulSoup(r.text, "html.parser")
    title = (soup.title.get_text(strip=True) if soup.title else "")[:200]
    if not title:
        h1 = soup.find("h1")
        title = h1.get_text(strip=True)[:200] if h1 else ""

    for tag in soup(_NOISE_TAGS):
        tag.decompose()

    root = _best_root(soup)

    # 链接密度：索引/列表页的正文几乎全是一串链接文字。这个信号用来把
    # 「一页文章标题列表」和「一篇正文」区分开，否则分类会把列表页当成文献。
    link_text = " ".join(a.get_text(" ", strip=True) for a in root.find_all("a"))
    all_text = root.get_text(" ", strip=True)
    link_density = round(len(link_text) / max(len(all_text), 1), 3)

    blocks = _collect_blocks(root)[:600]

    # 一个段落都没捞到时，退回全文按句粗切，至少让用户看到抓到了什么
    if sum(len(b) for b in blocks) < 400:
        raw = re.sub(r"\s+", " ", root.get_text(" ", strip=True))
        blocks = [s.strip() for s in re.split(r"(?<=[。！？；])", raw)
                  if len(s.strip()) >= 20][:400]

    if sum(len(b) for b in blocks) < 300:
        raise ValueError(
            "这个页面没抓到有效正文（可能需要登录、是动态渲染页，或地址无效）。"
            "可以改为上传 PDF/Word，或直接把正文粘过来。")

    blks = [{"n": i + 1, "text": t, "loc": f"段{i + 1}"} for i, t in enumerate(blocks)]
    meta = {"url": url, "host": urlparse(url).netloc, "status": r.status_code,
            "link_density": link_density}
    res = _result("url", title, blks, meta)
    if res["chars"] > MAX_URL_CHARS:
        res["full_text"] = res["full_text"][:MAX_URL_CHARS]
        res["truncated"] = True
    return res


# ── 纯文本 ──

def extract_text(text: str) -> dict:
    blocks = [{"n": i + 1, "text": t, "loc": f"行{i + 1}"}
              for i, t in enumerate(_split_blocks(text))]
    return _result("text", _guess_title(blocks), blocks, {"source": "手输文本"})


# ── 调度 ──

def _guess_title(blocks: list) -> str:
    """从正文猜一个标题。粘进来的文本常常没有标题行，
    这时退回「第一段前 40 字」，总比库里的条目叫「未命名」好。"""
    for b in blocks[:6]:
        t = b["text"].split("\n")[0].strip()
        if 6 <= len(t) <= 120:
            return t
    for b in blocks[:3]:
        s = re.sub(r"\s+", " ", b["text"]).strip()
        if len(s) >= 8:
            cut = s[:40]
            for sep in ("。", "；", "，", ".", ";"):
                if sep in cut:
                    cut = cut.split(sep)[0]
                    break
            return cut.strip(" ，,。.")
    return ""


def extract(path: str = None, data: bytes = None, filename: str = "",
            url: str = None, text: str = None) -> dict:
    """统一入口：按情况四选一"""
    if text:
        return extract_text(text)
    if url:
        return extract_url(url)
    ext = ""
    if filename:
        ext = filename.rsplit(".", 1)[-1].lower()
    elif path:
        ext = os.path.splitext(path)[1].lower().lstrip(".")

    if ext == "pdf":
        try:
            return extract_pdf(path=path, data=data)
        except Exception as e:
            if path or data:
                try:
                    return _pdf_pdfplumber(path=path, data=data)
                except Exception:
                    pass
            raise
    if ext in ("docx", "doc"):
        return extract_docx(path=path, data=data)
    if ext in ("txt", "md"):
        if path:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                return extract_text(f.read())
        return extract_text((data or b"").decode("utf-8", errors="ignore"))
    raise ValueError(f"不支持的文件格式: .{ext}（支持 pdf / docx / txt / md / URL）")
