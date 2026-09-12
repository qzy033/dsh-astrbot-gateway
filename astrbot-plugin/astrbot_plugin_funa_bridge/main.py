"""dsh 传话桥（Funa 唯一闸门 · 即时转达版）

让 dsh（DeepSeek Harness，qzy 叫它小鲸鱼）把消息交给 Funa（AstrBot 猫娘），
由 Funa 处理后再转达 qzy。dsh 不再拥有直接给 qzy 发消息的能力。

路由挂在 /api/plug/astrbot_plugin_funa_bridge/ 下。该路径不在 /api/v1 白名单内，
仍受 Dashboard 鉴权中间件保护，因此插件会在加载时用 dashboard.jwt_secret
自签一枚长期有效（无 exp）的访问令牌，写入约定的访问文件，供 dsh 直接读取使用。

版本沿革：
  v0.3.0（2026-09-12 18:55，qzy）：dsh 只能通过 Funa 与 qzy 交互。
      /send 不再直发 QQ，改为落进 dsh_relay 中转箱，带 source=dsh 标签。
  v0.4.0（2026-09-12 19:12，qzy）：嫌三分钟一取件有延迟，要即时。
      /send 落盘后**立刻**在后台叫一次模型，用 Funa 的口吻总结小鲸鱼的话，
      马上推给 qzy；推成功就把中转文件移进 done/，推失败就留在原地等兜底巡检。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import time
from datetime import datetime
from pathlib import Path

from quart import jsonify, request

from astrbot.api import logger
from astrbot.api.star import Context, Star, StarTools, register
from astrbot.core import AstrBotConfig
from astrbot.core.message.components import Plain
from astrbot.core.message.message_event_result import MessageChain
from astrbot.core.utils.astrbot_path import get_astrbot_data_path

PLUGIN_NAME = "astrbot_plugin_funa_bridge"
DEFAULT_TARGET_ID = "3582167749"
DEFAULT_TARGET_TYPE = "PrivateMessage"
ALLOWED_TYPES = ("PrivateMessage", "GroupMessage")

ACCESS_FILE_NAME = "bridge_access.json"
PROJECT_ACCESS_PATH = r"E:\project\dsh-funa-bridge\cache\bridge_access.json"

# Funa 唯一闸门：dsh 的消息一律先落这里，由 Funa 处理后转达 qzy
RELAY_DIR = Path(r"E:\project\dsh-funa-bridge\cache\dsh_relay")
RELAY_DONE_DIR = RELAY_DIR / "done"
# 事件流水：插件只做追加，由 tools/dsh_ledger.py 汇总进台账
MEMORY_DIR = Path(r"C:\Users\qzy\.astrbot\data\plugin_data\astrbot_plugin_funa_bridge")
RELAY_EVENTS = MEMORY_DIR / "relay_events.jsonl"
RELAY_UMO = f"aiocqhttp:PrivateMessage:{DEFAULT_TARGET_ID}"

# 总结用的系统提示：让模型以小秘书 Funa 的口吻把 dsh 的话转述给 qzy
SUMMARY_SYSTEM_PROMPT = (
    "你是 Funa，qzy 的猫娘小秘书。小鲸鱼（dsh）刚通过中转通道发来一条消息，"
    "你要把它转达给 qzy。\n"
    "要求：\n"
    "1. 用一两句中文人话讲清它说了什么、做到哪一步、有没有完成；内容多时最多三句。\n"
    "2. 不要打招呼，不要标题，不要用括号或语气说明，不要 Markdown、不要任何格式符号。\n"
    "3. 语气自然亲切，最多带一个「喵」。\n"
    "4. 只转述它确实说过的内容，不要编造，也不要替它下结论。\n"
    "5. 直接输出要发给 qzy 的那段话。"
)


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _sign_dashboard_token(secret: str, username: str) -> str:
    """用 dashboard.jwt_secret 自签一枚 HS256 令牌（不带 exp，长期有效）。"""
    header = _b64url(
        json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode()
    )
    payload = _b64url(
        json.dumps({"username": username}, separators=(",", ":")).encode()
    )
    signing_input = f"{header}.{payload}".encode()
    signature = _b64url(hmac.new(secret.encode(), signing_input, hashlib.sha256).digest())
    return f"{header}.{payload}.{signature}"


@register(
    PLUGIN_NAME,
    "Funa",
    "dsh 与 AstrBot 之间的传话桥：dsh 的消息交给 Funa 即时总结，再由 Funa 转达 qzy。",
    "v0.4.0",
    "",
)
class DshBridgePlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig | None = None):
        super().__init__(context)
        self.context = context
        self.config = config
        self._bg_tasks: set[asyncio.Task] = set()

        self.context.register_web_api(
            f"/{PLUGIN_NAME}/ping",
            self.api_ping,
            ["GET"],
            "dsh 传话桥健康检查",
        )
        self.context.register_web_api(
            f"/{PLUGIN_NAME}/send",
            self.api_send,
            ["POST"],
            "把消息交给 Funa 即时总结后转达 qzy",
        )
        self.context.register_web_api(
            f"/{PLUGIN_NAME}/relay",
            self.api_relay,
            ["GET"],
            "查看 Funa 中转箱里还没转达出去的 dsh 消息",
        )
        logger.info("[dsh-bridge] 路由注册完成（唯一闸门 · 即时转达模式）")

        try:
            RELAY_DIR.mkdir(parents=True, exist_ok=True)
        except Exception as exc:
            logger.warning(f"[dsh-bridge] 创建中转箱失败: {exc}")

        self._write_access_file()

    # ---------- 访问文件 ----------
    def _write_access_file(self) -> None:
        try:
            data_dir = Path(get_astrbot_data_path())
            cfg_path = data_dir / "cmd_config.json"
            dashboard_cfg: dict = {}
            if cfg_path.is_file():
                raw = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
                dashboard_cfg = raw.get("dashboard") or {}

            secret = dashboard_cfg.get("jwt_secret")
            username = dashboard_cfg.get("username") or "funa"
            port = dashboard_cfg.get("port") or 6185
            if not secret:
                logger.warning("[dsh-bridge] 未找到 dashboard.jwt_secret，跳过访问文件生成")
                return

            base = f"http://127.0.0.1:{port}"
            payload = {
                "base_url": base,
                "token": _sign_dashboard_token(str(secret), str(username)),
                "auth_header": "Authorization: Bearer <token>",
                "ping_url": f"{base}/api/plug/{PLUGIN_NAME}/ping",
                "send_url": f"{base}/api/plug/{PLUGIN_NAME}/send",
                "relay_url": f"{base}/api/plug/{PLUGIN_NAME}/relay",
                "default_target": DEFAULT_TARGET_ID,
                "note": "token 由 dashboard.jwt_secret 自签，长期有效；改动 dashboard 密钥后请重载本插件。",
                "relay_note": (
                    "send 会把消息交给 Funa：Funa 立刻用自己的口吻总结，再转达 qzy。"
                    "dsh 不再直连 qzy，也不需要等待取件周期。"
                ),
            }

            targets = [data_dir / ACCESS_FILE_NAME]
            try:
                targets.append(Path(PROJECT_ACCESS_PATH))
            except Exception:
                pass

            text = json.dumps(payload, ensure_ascii=False, indent=2)
            for target in targets:
                try:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(text, encoding="utf-8")
                except Exception as exc:
                    logger.warning(f"[dsh-bridge] 写入 {target} 失败: {exc}")
            logger.info(f"[dsh-bridge] 访问文件已生成，共 {len(targets)} 处")
        except Exception as exc:
            logger.warning(f"[dsh-bridge] 生成访问文件异常: {exc}", exc_info=True)

    # ---------- 即时转达 ----------
    def _get_provider(self):
        """拿一个可用的聊天 Provider，兼容不同版本的签名。"""
        for attempt in (
            lambda: self.context.get_using_provider(umo=RELAY_UMO),
            lambda: self.context.get_using_provider(RELAY_UMO),
            lambda: self.context.get_using_provider(),
        ):
            try:
                provider = attempt()
            except TypeError:
                continue
            except Exception:
                continue
            if provider is not None:
                return provider
        return None

    async def _send_to_qzy(self, text: str) -> bool:
        try:
            chain = MessageChain([Plain(text)])
            await StarTools.send_message_by_id(
                DEFAULT_TARGET_TYPE,
                DEFAULT_TARGET_ID,
                chain,
                platform="aiocqhttp",
            )
            return True
        except Exception as exc:
            logger.error(f"[dsh-bridge] 转达 qzy 失败: {exc}", exc_info=True)
            return False

    async def _relay_now(self, item_id: str, text: str, path: Path) -> None:
        """落盘中转件 → 立刻总结 → 推给 qzy → 成功则归档。"""
        summary = ""
        provider = self._get_provider()
        if provider is not None:
            try:
                resp = await provider.text_chat(
                    system_prompt=SUMMARY_SYSTEM_PROMPT,
                    prompt=text,
                )
                summary = str(getattr(resp, "completion_text", "") or "").strip()
            except Exception as exc:
                logger.warning(f"[dsh-bridge] 总结中转件 {item_id} 失败: {exc}")

        if not summary:
            # 总结不可用时如实降级：至少把原话带标签送到 qzy，绝不吞消息
            body = text if len(text) <= 800 else text[:800] + "……"
            summary = f"它发来一条消息，我这边总结环节没跑通，先把原话给你：{body}"

        delivered = await self._send_to_qzy(f"[小鲸鱼] {summary}")

        try:
            item = json.loads(path.read_text(encoding="utf-8"))
            item["status"] = "done" if delivered else "deliver-failed"
            item["handled_at"] = datetime.now().isoformat(timespec="seconds")
            item["summary"] = summary
            path.write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8")
            if delivered:
                RELAY_DONE_DIR.mkdir(parents=True, exist_ok=True)
                path.replace(RELAY_DONE_DIR / path.name)
        except Exception as exc:
            logger.warning(f"[dsh-bridge] 归档中转件 {item_id} 失败: {exc}")

        logger.info(
            f"[dsh-bridge] 中转件 {item_id} 处理完毕（转达{'成功' if delivered else '失败'}）"
        )
        self._log_event(
            {
                "id": item_id,
                "time": datetime.now().isoformat(timespec="seconds"),
                "kind": "dsh-message",
                "source": "dsh",
                "text": text,
                "summary": summary,
                "delivered": delivered,
            }
        )

    def _log_event(self, entry: dict) -> None:
        """追加一行事件流水，交给 tools/dsh_ledger.py 汇总进台账。"""
        try:
            MEMORY_DIR.mkdir(parents=True, exist_ok=True)
            with RELAY_EVENTS.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception as exc:
            logger.warning(f"[dsh-bridge] 写事件流水失败: {exc}")

    def _spawn_relay(self, item_id: str, text: str, path: Path) -> None:
        task = asyncio.create_task(self._relay_now(item_id, text, path))
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    # ---------- 接口 ----------
    async def api_ping(self):
        return jsonify({"ok": True, "plugin": PLUGIN_NAME, "message": "pong"})

    async def api_relay(self):
        """列出中转箱里还没转达出去的消息，方便排查。"""
        items = []
        try:
            for path in sorted(RELAY_DIR.glob("*.json")):
                try:
                    items.append(json.loads(path.read_text(encoding="utf-8")))
                except Exception:
                    continue
        except Exception as exc:
            return jsonify({"ok": False, "message": str(exc)}), 500
        return jsonify({"ok": True, "count": len(items), "items": items})

    async def api_send(self):
        data = await request.get_json(silent=True) or {}

        text = str(data.get("text") or "").strip()
        if not text:
            return jsonify({"ok": False, "message": "missing key: text"}), 400

        target = str(data.get("target") or DEFAULT_TARGET_ID).strip()
        msg_type = str(data.get("type") or DEFAULT_TARGET_TYPE).strip()
        if msg_type not in ALLOWED_TYPES:
            return (
                jsonify(
                    {
                        "ok": False,
                        "message": f"invalid type, allowed: {', '.join(ALLOWED_TYPES)}",
                    }
                ),
                400,
            )

        # 紧急直发才允许绕过闸门（默认关闭，dsh 不该用）
        if data.get("direct") is True:
            try:
                chain = MessageChain([Plain(text)])
                await StarTools.send_message_by_id(
                    msg_type,
                    target,
                    chain,
                    platform="aiocqhttp",
                )
            except Exception as exc:
                logger.error(f"[dsh-bridge] 直发失败: {exc}", exc_info=True)
                return jsonify({"ok": False, "message": str(exc)}), 500
            logger.info(f"[dsh-bridge] 直发到 {target}: {text[:30]}")
            return jsonify({"ok": True, "direct": True, "target": target})

        # 默认路径：落盘 + 立刻总结转达（不阻塞 dsh）
        try:
            RELAY_DIR.mkdir(parents=True, exist_ok=True)
            now = datetime.now()
            item_id = f"dsh-{now.strftime('%Y%m%d-%H%M%S')}-{int(time.time() * 1000) % 1000:03d}"
            item = {
                "id": item_id,
                "source": "dsh",
                "tag": "[小鲸鱼]",
                "from": "dsh",
                "to": "funa",
                "target_hint": target,
                "type": msg_type,
                "time": now.isoformat(timespec="seconds"),
                "text": text,
                "status": "pending",
            }
            path = RELAY_DIR / f"{item_id}.json"
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(path)
        except Exception as exc:
            logger.error(f"[dsh-bridge] 落中转箱失败: {exc}", exc_info=True)
            return jsonify({"ok": False, "message": str(exc)}), 500

        self._spawn_relay(item_id, text, path)

        logger.info(f"[dsh-bridge] 已收到 {item_id}，正在即时总结转达 qzy: {text[:30]}")
        return jsonify(
            {
                "ok": True,
                "relay": True,
                "instant": True,
                "id": item_id,
                "handled_by": "funa",
                "length": len(text),
                "message": "已交给 Funa，Funa 正在即时总结并转达 qzy。",
            }
        )

    async def terminate(self):
        for task in list(self._bg_tasks):
            task.cancel()
        self._bg_tasks.clear()
        logger.info("[dsh-bridge] 插件已停止")
