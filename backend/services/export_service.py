"""导出服务 — 导出记录 + 真实文件生成

早期版本「导出 Word」只是把 JSON 字符串塞进一个 .docx 文件名，打不开；
export_word / export_latex 也只是返回 Markdown 文本，没有任何地方调用。
现在 Word / Excel / LaTeX / Markdown 都产出真文件，登记到导出记录里，
结果输出页可以下载。
"""
import io
import os
import re
import json
import zipfile
from datetime import datetime
from urllib.parse import quote as _quote

EXPORT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "exports")
os.makedirs(EXPORT_DIR, exist_ok=True)


def _url(filename: str) -> str:
    """下载地址。文件名常带中文（“特高压_回归结果.docx”），
    URL 里必须百分号编码，否则浏览器报 ascii codec error。"""
    return "/api/exports/download/" + _quote(filename)


def _fname(name: str, ext: str) -> str:
    stem = re.sub(r"[\\/:*?\"<>|]+", "_", name or "export").strip("_") or "export"
    if stem.lower().endswith("." + ext):
        stem = stem[: -(len(ext) + 1)]
    p = os.path.join(EXPORT_DIR, f"{stem}.{ext}")
    n = 2
    while os.path.exists(p):
        p = os.path.join(EXPORT_DIR, f"{stem}-{n}.{ext}")
        n += 1
    return os.path.basename(p)


class ExportService:
    def __init__(self):
        self.exports = []
        self._counter = 0

    # ── 记录 ──

    def _register(self, name, fmt, size, source, file=None, url=None, content=None):
        self._counter += 1
        rec = {
            "id": self._counter,
            "name": name,
            "format": fmt,
            "source": source or "",
            "size": f"{max(1, size // 1024)} KB",
            "time": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "status": "success",
            "content": content,
            "file": file,
            "url": url,
        }
        self.exports.append(rec)
        return {k: v for k, v in rec.items() if k != "content"}

    def create(self, name: str, format: str, content: str, source: str) -> dict:
        """纯文本/JSON 内容登记，写成一个真文件"""
        fmt = (format or "txt").lower()
        ext = {"latex": "tex", "tex": "tex", "word": "md", "markdown": "md"}.get(fmt, fmt)
        fn = _fname(name, ext)
        data = (content or "").encode("utf-8")
        with open(os.path.join(EXPORT_DIR, fn), "wb") as f:
            f.write(data)
        return self._register(name, fmt, len(data), source, file=fn,
                              url=_url(fn), content=content)

    def list_all(self) -> list:
        out = []
        for e in self.exports:
            r = {k: v for k, v in e.items() if k != "content"}
            r["has_file"] = bool(e.get("file"))
            out.append(r)
        return out

    def get_content(self, export_id: int) -> str:
        for e in self.exports:
            if e["id"] == export_id:
                return e["content"]
        return None

    def file_path(self, filename: str):
        p = os.path.join(EXPORT_DIR, os.path.basename(filename or ""))
        return p if os.path.isfile(p) else None

    def delete(self, export_id: int) -> bool:
        for i, e in enumerate(self.exports):
            if e["id"] == export_id:
                fn = e.get("file")
                self.exports.pop(i)
                if fn:
                    try:
                        os.remove(os.path.join(EXPORT_DIR, fn))
                    except Exception:
                        pass
                return True
        return False

    # ── 分析结果 → 结构化小节 ──

    @staticmethod
    def to_sections(r: dict) -> list:
        """把一份分析结果转成带标题层级的小节，供 Word / LaTeX / Markdown 共用"""
        secs = []
        meta = []
        if r.get("dep_var"):
            meta.append(f"因变量：{r['dep_var']}")
        if r.get("nobs"):
            meta.append(f"观测数：{r['nobs']}")
        if r.get("n_entities"):
            meta.append(f"个体数：{r['n_entities']}")
        if r.get("n_periods"):
            meta.append(f"期数：{r['n_periods']}")
        if r.get("se_type"):
            meta.append(f"标准误：{r['se_type']}")
        if r.get("r_squared") is not None:
            meta.append(f"R² = {r['r_squared']}")
        if r.get("adj_r_squared") is not None:
            meta.append(f"调整 R² = {r['adj_r_squared']}")
        if r.get("f_stat") is not None:
            meta.append(f"F/χ² = {r['f_stat']}")
        if r.get("p_value") is not None:
            meta.append(f"p = {r['p_value']}")
        if r.get("df") is not None:
            meta.append(f"自由度 = {r['df']}")
        if meta:
            secs.append({"heading": "一、分析设定", "body": "\n".join("· " + m for m in meta)})

        if r.get("coefficients"):
            rows = ["| 变量 | 系数 | 标准误 | t | p | 显著性 |", "|---|---|---|---|---|---|"]
            for c in r["coefficients"]:
                rows.append("| {} | {} | {} | {} | {} | {} |".format(
                    c.get("variable", ""), _n(c.get("coef")), _n(c.get("std_err")),
                    _n(c.get("t")), _n(c.get("p")), c.get("stars", "")))
            secs.append({"heading": "二、估计结果", "body": "\n".join(rows)})

        if r.get("comparison"):
            rows = ["| 变量 | 固定效应系数 | 随机效应系数 | 差异 |", "|---|---|---|---|"]
            for c in r["comparison"]:
                rows.append("| {} | {} | {} | {} |".format(
                    c.get("variable"), c.get("fe_coef"), c.get("re_coef"), c.get("diff")))
            secs.append({"heading": "三、FE 与 RE 系数对比", "body": "\n".join(rows)})

        if r.get("table") and isinstance(r["table"], dict):
            keys = list(r["table"].keys())
            if keys and isinstance(r["table"][keys[0]], dict):
                cols = list(r["table"][keys[0]].keys())
                rows = ["| 变量 | " + " | ".join(str(c) for c in cols) + " |",
                        "|" + "---|" * (len(cols) + 1)]
                for k, v in r["table"].items():
                    rows.append("| {} | {} |".format(k, " | ".join(str(v.get(c, "")) for c in cols)))
                secs.append({"heading": "二、描述性统计", "body": "\n".join(rows)})

        if r.get("matrix") and r.get("variables"):
            vs = r["variables"]
            rows = ["| | " + " | ".join(str(v) for v in vs) + " |", "|" + "---|" * (len(vs) + 1)]
            for a in vs:
                rows.append("| {} | {} |".format(a, " | ".join(
                    str(r["matrix"].get(a, {}).get(b, "")) for b in vs)))
            secs.append({"heading": "二、相关系数矩阵", "body": "\n".join(rows)})

        if r.get("groups"):
            rows = ["| 组 | N | 均值 |", "|---|---|---|"]
            for g in r["groups"]:
                rows.append("| {} | {} | {} |".format(g.get("name"), g.get("n"), g.get("mean")))
            secs.append({"heading": "三、分组描述", "body": "\n".join(rows)})

        if r.get("conclusion"):
            secs.append({"heading": "四、结论", "body": r["conclusion"]})

        if r.get("notes"):
            secs.append({"heading": "五、说明",
                         "body": "\n".join(f"- {n}" for n in r["notes"])})

        if r.get("stata_code"):
            secs.append({"heading": "六、Stata 命令",
                         "body": "```stata\n" + r["stata_code"] + "\n```"})
        return secs

    # ── 真实文件 ──

    def create_docx(self, name: str, result: dict, title: str = None,
                    source: str = "") -> dict:
        import docx
        from docx.shared import Pt, RGBColor

        secs = self.to_sections(result)
        d = docx.Document()
        d.styles["Normal"].font.name = "Microsoft YaHei"
        d.styles["Normal"].font.size = Pt(10.5)

        h = d.add_heading(title or result.get("method") or "分析报告", level=0)
        for r in h.runs:
            r.font.color.rgb = RGBColor(0x1E, 0x29, 0x3B)
        sub = d.add_paragraph()
        sr = sub.add_run("由 Stata 助手生成 · "
                         + datetime.now().strftime("%Y-%m-%d %H:%M"))
        sr.font.size = Pt(8)
        sr.font.color.rgb = RGBColor(0x94, 0xA3, 0xB8)

        for sec in secs:
            d.add_heading(sec.get("heading", ""), level=1)
            for line in str(sec.get("body") or "").split("\n"):
                t = line.strip()
                if not t:
                    continue
                if t.startswith("|") and t.endswith("|"):
                    cells = [c.strip() for c in t.strip("|").split("|")]
                    if not cells or all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
                        continue
                    row = d.add_table(rows=1, cols=len(cells)).rows[0]
                    for i, c in enumerate(cells):
                        row.cells[i].text = c
                    continue
                if t.startswith("```stata"):
                    d.add_paragraph(t.replace("```stata", ""), style="Intense Quote")
                elif t.startswith("- "):
                    d.add_paragraph(t[2:], style="List Bullet")
                elif t.startswith("· "):
                    d.add_paragraph(t[2:], style="List Bullet")
                else:
                    d.add_paragraph(t)

        fn = _fname(name, "docx")
        p = os.path.join(EXPORT_DIR, fn)
        d.save(p)
        return self._register(name, "docx", os.path.getsize(p), source,
                              file=fn, url=_url(fn))

    def create_latex(self, name: str, result: dict, source: str = "") -> dict:
        L = []
        L.append(r"\documentclass[11pt]{article}")
        L.append(r"\usepackage[UTF8]{ctex}")
        L.append(r"\usepackage{booktabs}")
        L.append(r"\usepackage{geometry}")
        L.append(r"\geometry{margin=2.5cm}")
        L.append(r"\title{%s}" % _tex(result.get("method") or "分析报告"))
        L.append(r"\date{}")
        L.append(r"\begin{document}\maketitle")
        meta = []
        if result.get("dep_var"):
            meta.append("因变量 \\textit{%s}" % _tex(result["dep_var"]))
        if result.get("nobs"):
            meta.append("观测数 %s" % result["nobs"])
        if result.get("se_type"):
            meta.append("标准误 %s" % _tex(str(result["se_type"])))
        if result.get("r_squared") is not None:
            meta.append("$R^2$ = %s" % result["r_squared"])
        if result.get("adj_r_squared") is not None:
            meta.append("调整 $R^2$ = %s" % result["adj_r_squared"])
        if meta:
            L.append("\\noindent " + "\\quad ".join(meta))
        if result.get("coefficients"):
            L += [r"\begin{table}[htbp]", r"\centering",
                  r"\caption{%s}" % _tex(result.get("method") or "估计结果"),
                  r"\begin{tabular}{lccccc}", r"\toprule",
                  "变量 & 系数 & 标准误 & t 值 & p 值 & \\\\", r"\midrule"]
            for c in result["coefficients"]:
                sig = "^{***}" if (c.get("p") is not None and c["p"] < 0.01) else (
                    "^{**}" if (c.get("p") is not None and c["p"] < 0.05) else (
                        "^{*}" if (c.get("p") is not None and c["p"] < 0.1) else ""))
                L.append("%s & %s%s & (%s) & %s & %s \\\\" % (
                    _tex(str(c.get("variable", ""))), _n(c.get("coef")), sig,
                    _n(c.get("std_err")), _n(c.get("t")), _n(c.get("p"))))
            L += [r"\bottomrule", r"\end{tabular}", r"\end{table}"]
        if result.get("comparison"):
            L += [r"\begin{table}[htbp]", r"\centering", r"\caption{FE 与 RE 系数对比}",
                  r"\begin{tabular}{lccc}", r"\toprule",
                  "变量 & 固定效应 & 随机效应 & 差异 \\\\", r"\midrule"]
            for c in result["comparison"]:
                L.append("%s & %s & %s & %s \\\\" % (
                    _tex(str(c.get("variable"))), c.get("fe_coef"),
                    c.get("re_coef"), c.get("diff")))
            L += [r"\bottomrule", r"\end{tabular}", r"\end{table}"]
        if result.get("table") and isinstance(result["table"], dict):
            keys = list(result["table"].keys())
            if keys and isinstance(result["table"][keys[0]], dict):
                cols = [str(c) for c in result["table"][keys[0]].keys()]
                L += [r"\begin{table}[htbp]", r"\centering", r"\caption{描述性统计}",
                      r"\begin{tabular}{l" + "c" * len(cols) + "}", r"\toprule",
                      "变量 & " + " & ".join(cols) + " \\\\", r"\midrule"]
                for k, v in result["table"].items():
                    L.append("%s & %s \\\\" % (_tex(str(k)),
                                               " & ".join(str(v.get(c, "")) for c in cols)))
                L += [r"\bottomrule", r"\end{tabular}", r"\end{table}"]
        if result.get("groups"):
            L += [r"\begin{table}[htbp]", r"\centering", r"\caption{分组描述}",
                  r"\begin{tabular}{lcc}", r"\toprule", "组 & N & 均值 \\\\", r"\midrule"]
            for g in result["groups"]:
                L.append("%s & %s & %s \\\\" % (_tex(str(g.get("name"))),
                                                g.get("n"), g.get("mean")))
            L += [r"\bottomrule", r"\end{tabular}", r"\end{table}"]
        if result.get("conclusion"):
            L.append(r"\subsection*{结论}")
            L.append(_tex(str(result["conclusion"])))
        if result.get("notes"):
            L.append(r"\subsection*{说明}")
            L.append(r"\begin{itemize}")
            for n in result["notes"]:
                L.append(r"\item " + _tex(str(n)))
            L.append(r"\end{itemize}")
        if result.get("stata_code"):
            L.append(r"\subsection*{Stata 命令}")
            L.append(r"\begin{verbatim}")
            L.append(str(result["stata_code"]))
            L.append(r"\end{verbatim}")
        L.append(r"\end{document}")

        text = "\n".join(L)
        data = text.encode("utf-8")
        fn = _fname(name, "tex")
        with open(os.path.join(EXPORT_DIR, fn), "wb") as f:
            f.write(data)
        return self._register(name, "latex", len(data), source, file=fn,
                              url=_url(fn), content=text)

    def create_esttab(self, name: str, matrix: dict, row_mode: str = "core",
                      fmt: str = "esttab_tex") -> dict:
        """多模型对照表 → 真文件。fmt：esttab_tex（默认）/ esttab_docx / esttab_xlsx。

        矩阵由 /api/regression/esttab 生成（kind == "esttab"），此处只负责渲染，
        不再跑回归——否则导一次就是把五列回归重跑一遍。
        """
        if not isinstance(matrix, dict) or matrix.get("kind") != "esttab":
            return {"error": "不是多模型对照表矩阵"}
        cols = matrix.get("columns") or []
        if not cols:
            return {"error": "对照表没有任何列"}
        from services._esttab import filter_rows
        rows = filter_rows(matrix.get("rows") or [], row_mode)
        spec_rows = matrix.get("spec_rows") or []
        stat_rows = matrix.get("stat_rows") or []
        notes = matrix.get("notes") or []

        stem = re.sub(r"[\\/:*?\"<>|]+", "_", name or "对照表").strip("_") or "对照表"
        source = "多模型对照表（{} 列）".format(len(cols))
        fmt = (fmt or "esttab_tex").lower()

        # 一次导出只出一个文件、一条记录——不然写进磁盘的 docx/xlsx
        # 没有登记，「结果输出」页里看不到也下载不了。
        if fmt == "esttab_docx":
            fn = self._esttab_docx(stem, cols, rows, spec_rows, stat_rows, notes)
            return self._register(stem, "esttab", os.path.getsize(
                os.path.join(EXPORT_DIR, fn)), source, file=fn, url=_url(fn))
        if fmt == "esttab_xlsx":
            fn = self._esttab_xlsx(stem, cols, rows, spec_rows, stat_rows, notes)
            return self._register(stem, "esttab", os.path.getsize(
                os.path.join(EXPORT_DIR, fn)), source, file=fn, url=_url(fn))

        lines = self._esttab_tex(stem, cols, rows, spec_rows, stat_rows, notes)
        fn = _fname(stem, "tex")
        with open(os.path.join(EXPORT_DIR, fn), "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        return self._register(stem, "esttab", os.path.getsize(
            os.path.join(EXPORT_DIR, fn)), source, file=fn, url=_url(fn))

    @staticmethod
    def _esttab_tex(stem, cols, rows, spec_rows, stat_rows, notes):
        title = stem
        L = [r"\documentclass[11pt]{article}", r"\usepackage[UTF8]{ctex}",
             r"\usepackage{booktabs}", r"\usepackage{geometry}",
             r"\geometry{margin=2.5cm}", r"\title{%s}" % _tex(title), r"\date{}",
             r"\begin{document}\maketitle"]
        ncol = len(cols) + 1
        L += [r"\begin{table}[htbp]", r"\centering",
              r"\caption{%s}" % _tex(title),
              r"\begin{tabular}{l" + "c" * len(cols) + "}", r"\toprule"]
        # 表头两行：列号 + 被解释变量（esttab 的 depvars 就是这样）
        L.append(" & ".join([""] + [_tex(str(c["label"])) for c in cols]) + r" \\")
        L.append(" & ".join([""] + [r"\textit{%s}" % _tex(str(c.get("dep_var") or ""))
                                    for c in cols]) + r" \\")
        L.append(r"\midrule")
        for row in rows:
            first = [_tex(str(row["name"]))]
            for cell in row.get("cells") or []:
                first.append("" if cell is None else
                             _est_coef_tex(cell.get("coef"), cell.get("stars")))
            L.append(" & ".join(first) + r" \\")
            # 标准误另起一行，括号包裹——论文表格的通行排法
            ses = ["" if (c is None or c.get("se") is None) else "({})".format(_n(c.get("se")))
                   for c in (row.get("cells") or [])]
            L.append(" & ".join([""] + ses) + r" \\")
        L.append(r"\midrule")
        for group in (spec_rows, stat_rows):
            for row in group:
                cells = [c.get("value", "") if c else "" for c in (row.get("cells") or [])]
                L.append(" & ".join([_tex(str(row["name"]))] + cells) + r" \\")
        for note in notes:
            L.append(r"\multicolumn{%d}{p{13cm}}{\footnotesize 注：%s} \\" % (ncol, _tex(note)))
        L += [r"\bottomrule", r"\end{tabular}", r"\end{table}", r"\end{document}"]
        return L

    @staticmethod
    def _esttab_docx(stem, cols, rows, spec_rows, stat_rows, notes):
        import docx
        from docx.shared import Pt as _Pt, RGBColor as _RGB
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        d = docx.Document()
        d.styles["Normal"].font.name = "Microsoft YaHei"
        d.styles["Normal"].font.size = _Pt(10.5)
        h = d.add_heading(stem, level=0)
        for r in h.runs:
            r.font.color.rgb = _RGB(0x1E, 0x29, 0x3B)
        t = d.add_table(rows=1, cols=len(cols) + 1)
        t.style = "Table Grid"

        def put(cell, text, bold=False, right=False, size=8.5):
            cell.text = ""
            p = cell.paragraphs[0]
            if right:
                p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
            run = p.add_run(str(text))
            run.bold = bold
            run.font.size = _Pt(size)

        hdr = t.rows[0].cells
        put(hdr[0], "", True)
        for j, c in enumerate(cols):
            put(hdr[j + 1], "{}\n{}".format(c["label"], c.get("dep_var") or ""),
                True, right=True)
        for row in list(rows) + list(spec_rows) + list(stat_rows):
            cells = t.add_row().cells
            put(cells[0], row["name"], row.get("kind") == "core")
            for j, cell in enumerate(row.get("cells") or []):
                if cell is None:
                    put(cells[j + 1], "")
                elif "value" in cell:
                    put(cells[j + 1], cell["value"], right=True)
                else:
                    txt = _est_coef(cell.get("coef"), cell.get("stars"))
                    if cell.get("se") is not None:
                        txt += "\n({})".format(_n(cell.get("se")))
                    put(cells[j + 1], txt, right=True)
        for note in notes:
            p = d.add_paragraph()
            r = p.add_run("注：" + note)
            r.font.size = _Pt(8)
            r.font.color.rgb = _RGB(0x64, 0x74, 0x8B)
        fn = _fname(stem, "docx")
        d.save(os.path.join(EXPORT_DIR, fn))
        return fn

    @staticmethod
    def _esttab_xlsx(stem, cols, rows, spec_rows, stat_rows, notes):
        from openpyxl import Workbook
        from openpyxl.styles import Font, Alignment
        wb = Workbook()
        ws = wb.active
        ws.title = "多模型对照表"
        bold = Font(bold=True)
        ws.cell(row=1, column=1, value=stem).font = Font(bold=True, size=13)
        r0 = 3
        for j, c in enumerate(cols):
            a = ws.cell(row=r0, column=j + 2, value=str(c["label"]))
            a.font = bold
            a.alignment = Alignment(horizontal="center")
            ws.cell(row=r0 + 1, column=j + 2,
                    value=str(c.get("dep_var") or "")).alignment = \
                Alignment(horizontal="center")
        ri = [r0 + 2]

        def emit(row, is_var):
            i = ri[0]
            nm = ws.cell(row=i, column=1, value=str(row["name"]))
            nm.font = bold if row.get("kind") == "core" else Font()
            for j, cell in enumerate(row.get("cells") or []):
                col = j + 2
                if cell is None:
                    continue
                if "value" in cell:
                    ws.cell(row=i, column=col, value=cell["value"])
                else:
                    ws.cell(row=i, column=col,
                            value=_est_coef(cell.get("coef"), cell.get("stars")))
                    if cell.get("se") is not None:
                        ws.cell(row=i + 1, column=col,
                                value="({})".format(_n(cell.get("se"))))
            ri[0] = i + (2 if is_var else 1)

        for row in rows:
            emit(row, True)
        for row in list(spec_rows) + list(stat_rows):
            emit(row, False)
        ri[0] += 1
        for note in notes:
            ws.cell(row=ri[0], column=1, value="注：" + note).font = Font(size=9)
            ri[0] += 1
        fn = _fname(stem, "xlsx")
        wb.save(os.path.join(EXPORT_DIR, fn))
        return fn

    def create_zip(self, name: str, result: dict, source: str = "") -> dict:
        """把 docx + tex + md 打一个包，一次下载全都有"""
        tmp_doc = self.create_docx(name, result, source=source)
        tmp_tex = self.create_latex(name, result, source=source)
        fn = _fname(name, "zip")
        p = os.path.join(EXPORT_DIR, fn)
        with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
            for rec, ext in ((tmp_doc, "docx"), (tmp_tex, "tex")):
                fp = self.file_path(rec["file"])
                if fp:
                    z.write(fp, os.path.basename(fp))
        self.delete(tmp_doc["id"])
        self.delete(tmp_tex["id"])
        return self._register(name, "zip", os.path.getsize(p), source, file=fn,
                              url=_url(fn))


def _n(v):
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:.4f}"
    return str(v)


def _est_coef(coef, stars=""):
    """合并表单元格里的系数：四位小数 + 显著性星号。"""
    if coef is None:
        return ""
    txt = _n(coef) if isinstance(coef, float) else str(coef)
    return txt + (stars or "")


def _est_coef_tex(coef, stars=""):
    """LaTeX 版：星号要进数学环境，否则是文本模式的三个星号。"""
    base = _est_coef(coef, "")
    if not base:
        return ""
    return base + (("$^{" + stars + "}$") if stars else "")


def _tex(s: str) -> str:
    return (str(s).replace("\\", r"\textbackslash{}")
            .replace("&", r"\&").replace("%", r"\%").replace("$", r"\$")
            .replace("#", r"\#").replace("_", r"\_").replace("^", r"\textasciicircum{}")
            .replace("{", r"\{").replace("}", r"\}"))


export_service = ExportService()
