# -*- coding: utf-8 -*-
"""AI 助手代理 — 转发用户 API 请求，内置知识改为运行时从知识库拼装

原来的做法是把一段 60 行的 Stata 命令速查写死在 LIANXH_KNOWLEDGE 常量里，
每次对话原样发一遍。问题：永远不变、和知识库无关、要改得改代码重启。

现在改成：按用户的问题和当前页面，从「Stata命令速查」库里检索相关条目拼进
system 消息。那条常量降级成兜底——只有在内置库为空（没跑过种子）时才用它，
保证不出退化。
"""
import httpx
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 只在知识库没有任何内置条目时兜底
_FALLBACK = os.path.join(HERE, "services", "_lianxh_fallback.txt")

_ROLE = """你是一个专业的计量经济学和实证研究助手，服务于做实证研究的学生和研究者。

下面「方法知识」是从用户自己的知识库里检索出来的条目，优先依据它们回答。
引用其中内容时说明出自哪一篇。库里没有的，基于通用计量知识回答，
并明确标注这是通用知识、不是来自用户的知识库。

回答原则：
1. 先理解用户的数据结构和研究问题，再给方法
2. 推荐方法必须说理由，并说明适用条件和边界
3. 涉及 Stata 命令时给完整可运行的一行，不要省略选项
4. 解释经济含义，不要只报数字
5. 主动提示稳健性检验该怎么做
6. 用户的数据如果有明显问题（样本选择、标准误层级、多重共线性），直接指出
7. 用中文，紧凑专业，不写空洞总结
"""


def _fallback_text():
    try:
        with open(_FALLBACK, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


class AIService:
    """代理用户的 AI API 调用，支持 OpenAI / DeepSeek / 兼容接口"""

    # ── 单次调用（知识沉淀等需要精确输出的场合） ──

    async def raw_chat(self, system: str, user: str, api_config: dict,
                       max_tokens: int = 4000, temperature: float = 0.2) -> dict:
        api_url = api_config.get("api_url", "").rstrip("/")
        api_key = api_config.get("api_key", "")
        model = api_config.get("model", "gpt-4o-mini")

        if not api_url or not api_key:
            return {"error": "请先在 AI 设置中配置 API 地址和密钥"}

        url = f"{api_url}/v1/chat/completions" if "/v1" not in api_url else f"{api_url}/chat/completions"
        if not url.endswith("/chat/completions"):
            url = f"{api_url}/chat/completions"

        headers = {"Authorization": f"Bearer {api_key}",
                   "Content-Type": "application/json"}
        payload = {"model": model,
                   "messages": [{"role": "system", "content": system},
                                {"role": "user", "content": user}],
                   "temperature": temperature, "max_tokens": max_tokens}
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                resp = await client.post(url, headers=headers, json=payload)
                if resp.status_code != 200:
                    return {"error": f"API 返回错误 ({resp.status_code}): {resp.text[:300]}"}
                data = resp.json()
                return {"content": data["choices"][0]["message"]["content"]}
        except httpx.ConnectError:
            return {"error": "无法连接到 API 地址，请检查配置"}
        except Exception as e:
            return {"error": f"请求失败: {str(e)}"}

    # ── 对话入口 ──

    async def chat(self, messages: list, api_config: dict, page: str = "") -> dict:
        api_url = api_config.get("api_url", "").rstrip("/")
        api_key = api_config.get("api_key", "")
        model = api_config.get("model", "gpt-4o-mini")

        if not api_url or not api_key:
            return {"error": "请先在 AI 设置中配置 API 地址和密钥"}

        url = f"{api_url}/v1/chat/completions" if "/v1" not in api_url else f"{api_url}/chat/completions"
        if not url.endswith("/chat/completions"):
            url = f"{api_url}/chat/completions"

        # 取最后一条用户消息当检索词
        query = ""
        for m in reversed(messages or []):
            if m.get("role") == "user":
                query = str(m.get("content") or "")[:400]
                break
        if not query:
            query = page or "计量经济学 Stata 回归"

        system = _ROLE
        try:
            from . import kb_service as _kb
            b = _kb.kb_service.builtin_context(query, page)
            if b["found"]:
                system += ("\n\n## 方法知识（来自用户知识库「Stata命令速查」，"
                           "优先依据）\n\n" + b["text"])
            else:
                # 库里没有内置条目时才用兜底，避免提示词能力突然掉一档
                if not _kb.kb_service.list_docs(kb="Stata命令速查"):
                    fb = _fallback_text()
                    if fb:
                        system += "\n\n## 方法知识（内置）\n\n" + fb
        except Exception:
            pass

        full_messages = [{"role": "system", "content": system}] + list(messages or [])
        payload = {"model": model, "messages": full_messages,
                   "temperature": 0.5, "max_tokens": 2000}
        headers = {"Authorization": f"Bearer {api_key}",
                   "Content-Type": "application/json"}
        try:
            async with httpx.AsyncClient(timeout=90.0) as client:
                resp = await client.post(url, headers=headers, json=payload)
                if resp.status_code != 200:
                    return {"error": f"API 返回错误 ({resp.status_code}): {resp.text[:300]}"}
                data = resp.json()
                return {"content": data["choices"][0]["message"]["content"]}
        except httpx.ConnectError:
            return {"error": "无法连接到 API 地址，请检查配置"}
        except Exception as e:
            return {"error": f"请求失败: {str(e)}"}


ai_service = AIService()
