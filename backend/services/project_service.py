# -*- coding: utf-8 -*-
"""项目管理服务

数据集以「目录清单」而不是 DataFrame 存在项目里：每个文件记下路径、行数、
变量名，用到哪个才读哪个。原来是把整个文件夹的 DataFrame 一次全塞进内存
（实测这个目录 507 MB）、切项目再复制一遍。

数据集名 = 相对项目根目录的路径，用 "/" 分隔。
"机制检验/利润表/FS_Comins.dta" 和 "机制检验/利润表2/FS_Comins.dta"
是三份不同数据（55512 / 61195 / 63728 行），用裸文件名会互相覆盖。
"""
import os
import uuid
from datetime import datetime

from .dataset_io import scan_tree, light_info, read_frame, display_parts

CODE_SUFFIXES = ("do", "sps", "r", "py", "ipynb")


class ProjectService:
    def __init__(self):
        self.projects = {}
        self.current_project_id = None

    def create(self, name: str, description: str = "") -> dict:
        pid = str(uuid.uuid4())[:8]
        project = {
            "id": pid,
            "name": name,
            "description": description,
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "source_path": None,
            "datasets": {},
            "current_dataset": None,
            "analysis_results": [],
            "code_history": [],
        }
        self.projects[pid] = project
        return project

    def get(self, pid: str) -> dict:
        return self.projects.get(pid)

    def list_all(self) -> list:
        out = []
        for p in self.projects.values():
            d = {k: v for k, v in p.items()
                 if k not in ("datasets", "analysis_results", "code_history")}
            ds = p.get("datasets") or {}
            # 卡片上要能看出这个项目到底扫到了几个文件、几个读不出来。
            # 之前只报 datasets_loaded，用户看到 6 个完全不知道漏了 33 个。
            d["n_datasets"] = len(ds)
            d["n_subdir_files"] = sum(1 for e in ds.values() if e.get("folder"))
            d["n_broken"] = sum(1 for e in ds.values() if not e.get("ok"))
            out.append(d)
        return out

    def delete(self, pid: str) -> bool:
        if pid in self.projects:
            if self.current_project_id == pid:
                self.current_project_id = None
            del self.projects[pid]
            return True
        return False

    def select(self, pid: str) -> dict:
        if pid in self.projects:
            self.current_project_id = pid
            return self.projects[pid]
        return None

    def get_current(self):
        if self.current_project_id and self.current_project_id in self.projects:
            return self.projects[self.current_project_id]
        return None

    # ── 文件夹导入 ──

    def import_folder(self, folder_path: str, name: str = "") -> dict:
        """导入本地文件夹作为项目（递归，含子文件夹）"""
        if not folder_path or not os.path.isdir(folder_path):
            return {"error": f"文件夹不存在: {folder_path}"}

        project_name = name or os.path.basename(folder_path.rstrip("\\/")) or folder_path
        project = self.create(project_name, f"从 {folder_path} 导入")
        project["source_path"] = folder_path

        result = self._scan_into(project, folder_path)
        self.current_project_id = project["id"]

        result["project"] = {k: v for k, v in project.items()
                             if k not in ("analysis_results", "datasets", "code_history")}
        result["datasets_loaded"] = result["ok"]
        return result

    def rescan(self, pid: str) -> dict:
        """重新扫一遍项目文件夹：补上新增的、报出消失的和读不出的。"""
        p = self.projects.get(pid)
        if not p:
            return {"error": "项目不存在"}
        root = p.get("source_path")
        if not root or not os.path.isdir(root):
            return {"error": "这个项目不是从文件夹导入的，没有可重扫的目录"}

        before = set(p["datasets"].keys())
        r = self._scan_into(p, root, fresh=False)
        # gone 必须拿「磁盘上实际扫到的」来比。
        # _scan_into 不会从清单里删条目，所以 before - p["datasets"].keys()
        # 恒为空——那样磁盘上被移走的文件永远检测不到，
        # 状态列还会写着「切换时读取」。
        gone = sorted(before - set(r["found"]))
        if gone:
            # 文件被移走/改名了：如果它正是当前数据集，当前数据要落空
            for n in gone:
                p["datasets"].pop(n, None)
            if p.get("current_dataset") in gone:
                p["current_dataset"] = sorted(set(r["found"]) & before or r["found"])[0] if r["found"] else None
        r["removed"] = gone
        r["project"] = {k: v for k, v in p.items()
                        if k not in ("analysis_results", "datasets", "code_history")}
        return r

    def _scan_into(self, project: dict, root: str, fresh: bool = True) -> dict:
        """把 root 扫出来的文件登记进 project["datasets"]。

        fresh=True（首次导入）时只登记新增的，避免把已有条目的
        "frame" 字段（已读进内存的）冲掉。
        """
        if fresh:
            project["datasets"] = {}

        data_files = []
        code_files = []
        added = []
        failed = []
        in_subdirs = 0
        already = 0

        for rel, folder, fn, ap, ext in scan_tree(root):
            if ext in CODE_SUFFIXES:
                code_files.append((fn, ap))
                continue
            data_files.append((rel, folder, fn, ap, ext))

        for rel, folder, fn, ap, ext in data_files:
            if not fresh:
                old = project["datasets"].get(rel)
                if old is not None and not old.get("error"):
                    already += 1
                    continue
            try:
                size_kb = round(os.path.getsize(ap) / 1024, 1)
            except OSError:
                size_kb = None
            info = light_info(ap, ext)
            project["datasets"][rel] = {
                "path": ap, "rel": rel, "folder": folder, "ext": ext,
                "size_kb": size_kb,
                "rows": info["rows"], "cols": info["cols"],
                "columns": info["columns"],
                "ok": info["ok"], "error": info["error"],
                "frame": None,
            }
            if not info["ok"]:
                failed.append({"name": rel, "error": info["error"] or "无法读取"})
            else:
                added.append(rel)
                if folder:
                    in_subdirs += 1

        # 当前数据集：优先沿用，否则取第一个读得出来的
        if not project.get("current_dataset") or project["current_dataset"] not in project["datasets"]:
            project["current_dataset"] = None
            for n, e in project["datasets"].items():
                if e.get("ok"):
                    project["current_dataset"] = n
                    break

        # 代码文件照原样收着
        if fresh:
            project["code_history"] = []
        for fn, ap in code_files:
            try:
                with open(ap, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
                project["code_history"].append({
                    "filename": fn, "content": content, "path": ap,
                })
            except Exception as e:
                print(f"读取代码文件失败 {fn}: {e}")

        subdirs = sorted({folder for rel, folder, fn, ap, ext in data_files if folder})
        return {
            "data_files": len(data_files),
            "code_files": len(code_files),
            "ok": len(added),
            "added": added,
            "failed": failed,
            "found": [rel for rel, folder, fn, ap, ext in data_files],
            "subdirs": subdirs,
            "in_subdirs": in_subdirs,
            "skipped": already,
        }

    # ── 取数据 ──

    def _entry(self, pid: str, name: str):
        p = self.projects.get(pid)
        if not p:
            return None, None, {"error": "项目不存在"}
        e = p["datasets"].get(name)
        if e is None:
            # 兼容：允许只传短名，只要唯一
            base, folder = display_parts(name)
            hits = [(n, x) for n, x in p["datasets"].items()
                    if os.path.basename(n) == name]
            if len(hits) == 1:
                e = hits[0][1]
            elif len(hits) > 1:
                return p, None, {"error": f"“{name}”在项目里有 {len(hits)} 个，请带上子目录区分"}
        if e is None:
            return p, None, {"error": f"数据集 {name} 不存在"}
        return p, e, None

    def frame(self, pid: str, name: str):
        """拿到数据集对应的 DataFrame，按需从磁盘读并缓存。"""
        p, e, err = self._entry(pid, name)
        if err:
            return err
        if e.get("frame") is not None:
            return e["frame"]
        path = e.get("path")
        if not path or not os.path.isfile(path):
            return {"error": f"文件已不存在：{e.get('rel')}（原路径 {path}）"}
        try:
            df = read_frame(path, e.get("ext", ""))
        except Exception as ex:
            # 读失败就把原因写回清单，页面上一眼能看到是哪个文件坏了
            e["error"] = "%s: %s" % (type(ex).__name__, str(ex)[:300])
            e["ok"] = False
            return {"error": f"读取 {e.get('rel')} 失败：{e['error']}"}
        e["frame"] = df
        return df

    def load_dataset(self, pid: str, dataset_name: str) -> dict:
        p, e, err = self._entry(pid, dataset_name)
        if err:
            return err
        df = self.frame(pid, dataset_name)
        if isinstance(df, dict):
            return df
        return {
            "name": dataset_name,
            "folder": e.get("folder", ""),
            "rows": len(df),
            "cols": len(df.columns),
            "columns": list(df.columns),
            "missing": int(df.isnull().sum().sum()),
            "missing_pct": round(df.isnull().sum().sum() / (len(df) * len(df.columns)) * 100, 2),
        }

    def catalog(self, pid: str) -> list:
        """项目的数据集清单（不触发读取），供前端列出可切换的文件。"""
        p = self.projects.get(pid)
        if not p:
            return []
        out = []
        for name, e in p["datasets"].items():
            base, folder = display_parts(name)
            out.append({
                "name": name,
                "file": base,
                "folder": folder,
                "ext": e.get("ext", ""),
                "rows": e.get("rows"),
                "cols": e.get("cols"),
                "size_kb": e.get("size_kb"),
                "ok": bool(e.get("ok")),
                "error": e.get("error") or "",
                "current": name == p.get("current_dataset"),
                "loaded": e.get("frame") is not None,
            })
        return out

    def unload(self, pid: str, name: str):
        """把某个数据集的内存副本丢掉（文件还在磁盘上，随时能再读）。"""
        p, e, err = self._entry(pid, name)
        if e is not None:
            e["frame"] = None

    # ── 与 data_service 同步 ──

    def save_to_data_service(self, pid: str, data_service) -> dict:
        """把项目的数据集清单同步给 data_service。

        只把当前数据集读进内存，其余只在 data_service.catalog 里登记——
        这样切项目不会把几百兆 DataFrame 整个搬一遍，分析页要用到哪个
        文件时才会触发读取。

        注意「当前数据集」的方向：如果 data_service 此刻正用着这个项目里
        的某个数据集，就以它为准、写回项目；否则才用项目里的值恢复。
        原来无条件用项目的值覆盖，用户在界面上挑的文件会被打回导入时
        排序第一的那个。
        """
        p = self.get(pid)
        if not p:
            return {"error": "项目不存在"}

        old = getattr(data_service, "catalog", None) or {}
        for name in old:
            if name not in p["datasets"]:
                data_service.datasets.pop(name, None)

        data_service.catalog = {}
        for name, e in p["datasets"].items():
            data_service.catalog[name] = {
                "path": e.get("path"), "rel": name,
                "folder": e.get("folder", ""), "ext": e.get("ext", ""),
                "rows": e.get("rows"), "cols": e.get("cols"),
                "columns": e.get("columns") or [],
                "ok": bool(e.get("ok")), "error": e.get("error") or "",
                "size_kb": e.get("size_kb"),
                "project": pid,
            }

        cur = data_service.current_name
        if not (cur and cur in p["datasets"]):
            cur = p.get("current_dataset")
        if not (cur and cur in p["datasets"]):
            cur = None
            for n, e in p["datasets"].items():
                if e.get("ok"):
                    cur = n
                    break

        if cur:
            e = p["datasets"][cur]
            if e.get("frame") is None:
                df = self.frame(pid, cur)
                if isinstance(df, dict):
                    return df
            data_service.datasets[cur] = e["frame"]
            data_service.current_dataset = e["frame"]
            data_service.current_name = cur
            data_service.panel_config = None
        else:
            # 这个项目没有可用的数据集（全读失败或空目录）。当前数据必须落空，
            # 否则分析页还在拿上一个项目的数据出结果，而清单已经变了。
            data_service.current_dataset = None
            data_service.current_name = None
            data_service.panel_config = None

        p["current_dataset"] = cur
        return {"ok": True, "datasets": list(p["datasets"].keys()),
                "current": cur,
                "loaded": [k for k, v in p["datasets"].items() if v.get("frame") is not None]}


project_service = ProjectService()
