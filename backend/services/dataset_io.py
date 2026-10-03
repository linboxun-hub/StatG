# -*- coding: utf-8 -*-
"""数据文件的目录扫描与按需读取。

项目文件夹动辄几十个 .dta、几百 MB。原来的 import_folder 有两个问题：
一是只用 os.listdir + isfile，只看顶层，子文件夹里的文件整个不见了；
二是把每个文件 read 完塞进内存——实测这个目录 39 个文件要 507 MB、5 秒，
而且切项目时 save_to_data_service 会把这堆 DataFrame 再复制一遍。

这里把「扫目录」和「读数据」拆开：扫目录拿清单和形状（dta 走
metadataonly，39 个文件 0.46 秒），真正要用某个文件时才读它。
"""
import os

DATA_EXTS = ("dta", "csv", "xlsx", "xls", "sav")
CODE_EXTS = ("do", "sps", "r", "py", "ipynb")

SKIP_DIRS = {
    "__pycache__", ".git", ".ipynb_checkpoints", ".pytest_cache", ".mypy_cache",
    "$RECYCLE.BIN", "node_modules", ".venv", "venv", "env", ".idea", ".vscode",
    ".claude", ".vite", "dist", "build",
}


def scan_tree(root: str) -> list:
    """递归扫出 root 下的数据文件与代码文件。

    返回 [(rel, folder, basename, abs_path, ext)]，rel 用 "/" 分隔、相对 root。
    拿 rel 当数据集名是天然唯一的：这个目录里 FS_Comins.dta 出现了三次
    （55512 / 61195 / 63728 行，是三份不同数据），FS_Combas.dta 两次，
    按裸文件名当字典键会静默覆盖掉其中两份。
    """
    out = []
    if not os.path.isdir(root):
        return out
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames
                       if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in sorted(filenames):
            if fn.startswith("~$"):          # Excel 的临时文件
                continue
            ext = os.path.splitext(fn)[1].lower().lstrip(".")
            if not ext or ext not in DATA_EXTS + CODE_EXTS:
                continue
            ap = os.path.join(dirpath, fn)
            rel = os.path.relpath(ap, root).replace(os.sep, "/")
            out.append((rel, os.path.dirname(rel), fn, ap, ext))
    out.sort(key=lambda r: (r[1] != "", r[1], r[2].lower()))
    return out


def light_info(path: str, ext: str = "") -> dict:
    """只拿形状，不读数据：行数、变量名。读不出来也不抛异常，ok=False。"""
    ext = (ext or os.path.splitext(path)[1]).lower().lstrip(".")
    blank = {"rows": None, "cols": None, "columns": [], "ok": False, "error": ""}
    try:
        if ext in ("dta", "sav"):
            import pyreadstat
            reader = pyreadstat.read_dta if ext == "dta" else pyreadstat.read_sav
            _, meta = reader(path, metadataonly=True)
            return {"rows": int(meta.number_rows), "cols": len(meta.column_names),
                    "columns": list(meta.column_names), "ok": True, "error": ""}
        if ext == "csv":
            import pandas as pd
            head = pd.read_csv(path, nrows=0)
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                rows = sum(1 for _ in f)
            return {"rows": max(rows - 1, 0), "cols": len(head.columns),
                    "columns": list(head.columns), "ok": True, "error": ""}
        if ext in ("xlsx", "xls"):
            import pandas as pd
            head = pd.read_excel(path, nrows=0)
            return {"rows": None, "cols": len(head.columns),
                    "columns": list(head.columns), "ok": True, "error": ""}
    except Exception as e:
        blank["error"] = "%s: %s" % (type(e).__name__, str(e)[:200])
        return blank
    blank["error"] = "不支持的格式 .%s" % ext
    return blank


def read_frame(path: str, ext: str = ""):
    """真正把文件读成 DataFrame。读取失败照原样抛异常，交给调用方记录。"""
    ext = (ext or os.path.splitext(path)[1]).lower().lstrip(".")
    if ext == "dta":
        import pyreadstat
        df, _ = pyreadstat.read_dta(path)
        return df
    if ext == "sav":
        import pyreadstat
        df, _ = pyreadstat.read_sav(path)
        return df
    import pandas as pd
    if ext == "csv":
        return pd.read_csv(path)
    return pd.read_excel(path)


def display_parts(name: str):
    """数据集名 -> (短名, 所在子目录)。

    name 现在是相对路径（"机制检验/利润表/FS_Comins.dta"），
    界面上短名当标题、目录当副标题，否则三个同名文件看不出区别。
    """
    n = str(name).replace("\\", "/")
    folder, base = n.rsplit("/", 1) if "/" in n else ("", n)
    return base, folder


def safe_filename(name: str) -> str:
    """下载文件名：rel 名里的 "/" 一律换成下划线。"""
    base = os.path.basename(str(name).replace("\\", "/").rstrip("/"))
    out = base.replace("/", "_").replace("\\", "_").strip().strip(".")
    return out or "data"
