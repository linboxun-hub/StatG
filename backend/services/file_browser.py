"""文件系统浏览服务"""
import os


class FileBrowser:
    def list_dir(self, path: str) -> dict:
        """列出目录下的子目录"""
        if not os.path.isdir(path):
            # 尝试列出上级目录
            parent = os.path.dirname(path)
            if os.path.isdir(parent):
                return self.list_dir(parent)
            return {"path": path, "exists": False, "entries": []}

        entries = []
        try:
            for name in sorted(os.listdir(path)):
                full = os.path.join(path, name)
                if os.path.isdir(full) and not name.startswith("."):
                    entries.append({"name": name, "path": full, "type": "dir"})
        except PermissionError:
            return {"path": path, "exists": True, "entries": [], "error": "权限不足"}

        return {
            "path": path,
            "exists": True,
            "parent": os.path.dirname(path),
            "entries": entries,
        }


file_browser = FileBrowser()
