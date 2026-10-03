"""数据管理服务 — 基于 StatsPAI 内置数据集 + 用户上传"""
import io
import os
from typing import Optional
import pandas as pd

DEMO_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "demo_data")


class DataService:
    # 内存里最多留几份 DataFrame。切换过的数据集会缓存下来，不然来回切
    # 同一个文件要反复读盘；但缓存不设上限的话，把这个目录 39 个文件全点
    # 一遍照样吃掉 500 MB，跟原来导入时一次读全没有区别。
    MAX_CACHED_FRAMES = 6

    def __init__(self):
        self.datasets = {}
        # 已知但还没读进内存的数据集（项目文件夹扫出来的清单）。
        # datasets 是真正加载了的；catalog 只是知道有这么个文件、多大多长。
        # 两者分开才敢往项目里塞几十个文件——否则导入一次就是几百 MB。
        self.catalog = {}
        self._load_order = []
        self.current_dataset = None
        self.current_name = None
        self.panel_config = None
        # 清洗用的：第一次改动前留下原始数据，撤销全部就是把它放回来
        self._clean_snapshot = None
        self._clean_steps = 0

    def _forget_clean_state(self):
        self._clean_snapshot = None
        self._clean_steps = 0

    def snapshot_current(self):
        """记下清洗前的原始数据。只在还没有快照时记，之后的多步清洗都算在
        同一个「撤销全部」上——用户撤销的是「这一批」，不是最后一步。"""
        if self.current_dataset is not None and self._clean_snapshot is None:
            self._clean_snapshot = self.current_dataset.copy(deep=True)
        return self._clean_snapshot

    def clean_state(self) -> dict:
        return {"steps": self._clean_steps, "can_undo": self._clean_snapshot is not None}

    def undo_clean(self) -> dict:
        if self._clean_snapshot is None:
            return {"ok": False, "error": "还没有执行过清洗，没有可撤销的"}
        rep = self.replace_current(self._clean_snapshot.copy(deep=True))
        n = self._clean_steps
        self._forget_clean_state()
        if "error" in rep:
            return rep
        return {"ok": True, "restored": True, "steps": n,
                "detail": f"已撤销 {n} 步清洗，数据回到 {rep['rows']} 行"}

    def replace_current(self, df) -> dict:
        """清洗原地替换当前数据集。

        三处都要更新：data_service、data_service.catalog、以及
        project_service 里缓存的那份 frame。漏掉任何一处，表现都是
        「分析页还在用旧数据」或者「切走再切回来清洗就白做了」。
        """
        if self.current_name is None:
            return {"error": "没有正在使用的数据集，请先导入或切换"}
        if len(df) == 0:
            return {"error": "清洗之后一行都不剩了，这一步会造成数据全空，已取消"}
        self.current_dataset = df
        self.datasets[self.current_name] = df
        c = self.catalog.get(self.current_name)
        if c is not None:
            c["rows"] = len(df)
            c["cols"] = len(df.columns)
            c["columns"] = list(df.columns)
        try:
            from . import project_service as _ps
            cur = _ps.project_service.get_current()
            ent = (cur or {}).get("datasets", {}).get(self.current_name)
            if ent is not None:
                ent["frame"] = df
                ent["rows"] = len(df)
                ent["cols"] = len(df.columns)
                ent["columns"] = list(df.columns)
        except Exception:
            pass
        return {"ok": True, "name": self.current_name, "rows": len(df),
                "cols": len(df.columns),
                "missing": int(df.isnull().sum().sum())}

    # ── 加载 StatsPAI 内置数据集 ──

    def load_statspai_datasets(self):
        """加载 StatsPAI 内置数据集到可选列表"""
        import statspai as sp
        try:
            ds_df = sp.datasets.list_datasets()
            self._statspai_list = ds_df
        except Exception:
            self._statspai_list = None

    def load_statspai_dataset(self, name: str) -> dict:
        """加载指定 StatsPAI 数据集"""
        import statspai as sp
        try:
            loader = getattr(sp.datasets, name, None)
            if loader and callable(loader):
                df = loader()
            else:
                return {"error": f"数据集 {name} 不存在"}

            self.datasets[name] = df
            self.current_dataset = df
            self.current_name = name
            self.panel_config = None
            self._forget_clean_state()
            self._remember(name)
            return self._dataset_info(name, df)
        except Exception as e:
            return {"error": str(e)}

    # ── 加载 CSV / Excel / DTA ──

    def load_from_bytes(self, content: bytes, filename: str) -> dict:
        ext = filename.rsplit(".", 1)[-1].lower()
        if ext == "csv":
            df = pd.read_csv(io.BytesIO(content))
        elif ext in ("xlsx", "xls"):
            df = pd.read_excel(io.BytesIO(content))
        elif ext == "dta":
            import pyreadstat
            df, _ = pyreadstat.read_dta(io.BytesIO(content))
        else:
            return {"error": f"不支持的文件格式: .{ext}"}

        self.datasets[filename] = df
        self.current_dataset = df
        self.current_name = filename
        self.panel_config = None
        self._forget_clean_state()
        self._remember(filename)
        return self._dataset_info(filename, df)

    def load_from_demo(self, filename: str) -> dict:
        path = os.path.join(DEMO_DIR, filename)
        df = pd.read_csv(path)
        self.datasets[filename] = df
        self.current_dataset = df
        self.current_name = filename
        return self._dataset_info(filename, df)

    # ── 查询 ──

    def _remember(self, name: str):
        """记下加载顺序，供 _evict 决定丢谁。重复切换不算新的一次。"""
        if name in self._load_order:
            self._load_order.remove(name)
        self._load_order.append(name)

    def known(self, name: str) -> bool:
        """数据集是否可用：加载过的，或清单里有、源文件还在。"""
        if name in self.datasets:
            return True
        c = self.catalog.get(name)
        if c and c.get("path") and os.path.isfile(c["path"]):
            return True
        return False

    def load_known(self, name: str) -> dict:
        """把清单里的数据集读进内存并设为当前。已加载过就直接用。"""
        from .dataset_io import read_frame
        if name in self.datasets:
            self.current_dataset = self.datasets[name]
            self.current_name = name
            self.panel_config = None
            self._forget_clean_state()
            return self._dataset_info(name, self.current_dataset)
        c = self.catalog.get(name)
        if not c:
            return {"error": f"数据集 {name} 不存在。可能已被移除，或项目已切换，请刷新列表"}
        if not c.get("path"):
            return {"error": f"{name} 不在项目目录里，无法重新加载"}
        if not os.path.isfile(c["path"]):
            c["ok"] = False
            c["error"] = "源文件已不存在"
            return {"error": f"找不到源文件：{c['path']}"}
        try:
            df = read_frame(c["path"], c.get("ext", ""))
        except Exception as e:
            c["ok"] = False
            c["error"] = "%s: %s" % (type(e).__name__, str(e)[:200])
            return {"error": f"读取 {name} 失败：{c['error']}"}
        self.datasets[name] = df
        self.current_dataset = df
        self.current_name = name
        self.panel_config = None
        self._forget_clean_state()
        self._remember(name)
        self._evict(keep=name)
        return self._dataset_info(name, df)

    def _evict(self, keep: str):
        """超量时丢掉最早加载的那份（当前这份永远不动）。

        文件还在磁盘上，重新切换只是再读一次；项目清单里的 rows/cols
        早就有了，界面照常显示。
        """
        self._load_order = [n for n in self._load_order if n in self.datasets]
        while (keep in self.datasets and len(self.datasets) > self.MAX_CACHED_FRAMES
               and len(self.datasets) > 1):
            victim = next((n for n in self._load_order
                           if n in self.datasets and n != keep), None)
            if victim is None:
                break
            self._load_order.remove(victim)
            self.datasets.pop(victim, None)
            # 项目里也持着同一份 DataFrame，只这边丢了内存并不会真释放
            c = self.catalog.get(victim) or {}
            pid = c.get("project")
            if pid:
                try:
                    from . import project_service as _ps
                    _ps.project_service.unload(pid, victim)
                except Exception:
                    pass

    def forget(self, name: str) -> dict:
        """把数据集从内存和清单里都去掉（磁盘上的原文件不动）。"""
        if name == self.current_name:
            return {"error": "不能删除当前正在使用的数据集，请先切换"}
        loaded, listed = name in self.datasets, name in self.catalog
        if not loaded and not listed:
            return {"error": "数据集不存在"}
        self.datasets.pop(name, None)
        self.catalog.pop(name, None)
        return {"ok": True}

    def _dataset_info(self, name, df):
        # size_kb 报的是磁盘上那个文件的大小，不是 DataFrame 在内存里的占用。
        # 懒加载之后数据集的「大小」在清单里一直是磁盘大小，这里再报内存值
        # 就自相矛盾了（实测 25 MB 的文件 DataFrame 要 38 MB）。
        size_kb = None
        c = self.catalog.get(name) or {}
        if c.get("path"):
            try:
                size_kb = round(os.path.getsize(c["path"]) / 1024, 1)
            except OSError:
                size_kb = None
        if size_kb is None:
            size_kb = round(df.memory_usage(deep=True).sum() / 1024, 1)
        return {
            "name": name,
            "rows": len(df),
            "cols": len(df.columns),
            "missing": int(df.isnull().sum().sum()),
            "size_kb": size_kb,
            "ram_kb": round(df.memory_usage(deep=True).sum() / 1024, 1),
            "columns": list(df.columns),
        }

    def count_available(self) -> int:
        """可用数据集个数：已读进内存的 + 项目清单里还没读的。

        懒加载之前 datasets 里就是全部文件，len() 直接可用；现在它只是内存
        缓存（上限 6 份），数字会在 1~7 之间跳。工作台那个统计卡片问的是
        「我有多少数据集」，要数清单而不是数缓存。
        """
        n = len(self.datasets)
        n += sum(1 for k in self.catalog if k not in self.datasets)
        return n

    def get_current(self) -> Optional[pd.DataFrame]:
        return self.current_dataset

    def set_panel(self, id_var: str, time_var: str):
        self.panel_config = {"id": id_var, "time": time_var}

    def get_page(self, page: int = 1, page_size: int = 20, search: str = "") -> dict:
        df = self.current_dataset
        if df is None:
            return {"data": [], "total": 0, "page": page, "page_size": page_size}

        if search:
            mask = df.astype(str).apply(
                lambda col: col.str.contains(search, case=False, na=False)
            ).any(axis=1)
            df = df[mask]

        total = len(df)
        start = (page - 1) * page_size
        page_df = df.iloc[start : start + page_size]

        return {
            "data": page_df.fillna("").to_dict(orient="records"),
            "total": total,
            "page": page,
            "page_size": page_size,
            "columns": list(df.columns),
        }

    def get_variables(self) -> list:
        df = self.current_dataset
        if df is None:
            return []
        return [
            {
                "name": col,
                "type": "数值型" if pd.api.types.is_numeric_dtype(df[col]) else "字符型",
                "label": col,
                "missing": int(df[col].isnull().sum()),
                "unique": int(df[col].nunique()),
            }
            for col in df.columns
        ]

    def get_summary(self, columns: list = None) -> dict:
        import math
        df = self.current_dataset
        if df is None:
            return {}
        if columns:
            df = df[columns]
        numeric = df.select_dtypes(include="number")
        result = {}
        for col in numeric.columns:
            s = numeric[col].dropna()
            if len(s) == 0:
                result[col] = {"obs": 0, "mean": 0, "std": 0, "min": 0, "p25": 0, "p50": 0, "p75": 0, "max": 0}
                continue
            def safe_round(val):
                v = float(val)
                return round(v, 4) if not math.isnan(v) else 0
            result[col] = {
                "obs": int(len(s)),
                "mean": safe_round(s.mean()),
                "std": safe_round(s.std()),
                "min": safe_round(s.min()),
                "p25": safe_round(s.quantile(0.25)),
                "p50": safe_round(s.quantile(0.50)),
                "p75": safe_round(s.quantile(0.75)),
                "max": safe_round(s.max()),
            }
        return result

    def export_csv(self) -> bytes:
        return self.current_dataset.to_csv(index=False).encode("utf-8-sig")

    def export_excel(self) -> bytes:
        buf = io.BytesIO()
        self.current_dataset.to_excel(buf, index=False, engine="openpyxl")
        return buf.getvalue()



data_service = DataService()
