"""dsh 传话桥（唯一闸门 · 即时转达版）

让 dsh（DeepSeek Harness 那一侧的 agent）把消息交给闸门（AstrBot 侧），
由闸门处理后再转达用户。dsh 不再拥有直接给用户发消息的能力。

路由挂在 /api/plug/<插件目录名>/ 下，用 dashboard.jwt_secret 自签一枚长期令牌
写进访问文件，供 dsh 那侧的插件读取。

版本沿革：
  v0.3.0：dsh 只能通过闸门与用户交互，/send 不再直发 QQ，改为落进中转箱。
  v0.4.0：嫌三分钟一取件有延迟，要即时。/send 落盘后**立刻**在后台叫一次模型，
      用闸门的口吻总结 dsh 的话，马上推给用户；推成功就把中转文件移进 done/，
      推失败就留在原地等兜底巡检。
  v0.5.0：开源版。本机路径、目标账号、平台名全部改成插件配置项，
      代码里不再写死任何人的用户名和路径，见 _conf_schema.json。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
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

PLUGIN_NAME = "astrbot_plugin_dsh_gateway"
DEFAULT_TARGET_TYPE = "PrivateMessage"
ALLOWED_TYPES = ("PrivateMessage", "GroupMessage")

ACCESS_FILE_NAME = "bridge_access.json"
# 没配 project_dir 时的默认项目名（落在用户主目录下）
DEFAULT_PROJECT_DIRNAME = "dsh-astrbot-gateway"


def _expand(raw: str) -> str:
    """展开 ~ 与 %ENV% / $ENV，让配置里能写「相对家目录」的路径。"""
    return os.path.expandvars(os.path.expanduser(str(raw).strip()))


def _resolve_project_dir(cfg) -> Path:
    """桥接项目目录：缓存区（cache/）就在它下面。"""
    raw = str(cfg.get("project_dir") or "").strip()
    return Path(_expand(raw)) if raw else Path.home() / DEFAULT_PROJECT_DIRNAME


def _resolve_memory_dir(cfg, plugin_name: str) -> Path:
    """事件流水目录；留空就用 AstrBot 标准的插件数据目录。"""
    raw = str(cfg.get("memory_dir") or "").strip()
    if raw:
        return Path(_expand(raw))
    return Path(get_astrbot_data_path()) / "plugin_data" / plugin_name


# 总结用的系统提示：让模型以AI 助手闸门的口吻把 dsh 的话转述给用户
SUMMARY_SYSTEM_PROMPT = """你是这个账号的助手。本地 agent 刚通过中转通道发来一条消息，你要把它转达给用户。
要求：
1. 用一两句中文人话讲清它说了什么、做到哪一步、有没有完成；内容多时最多三句。
2. 不要打招呼，不要标题，不要用括号或语气说明，不要 Markdown、不要任何格式符号。
3. 语气自然即可，别端着，也别加戏。
4. 只转述它确实说过的内容，不要编造，也不要替它下结论。
5. 直接输出要发给用户的那段话。"""


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
    "dsh-astrbot-gateway",
    "dsh 与 AstrBot 之间的传话桥：dsh 的消息交给闸门即时总结，再由闸门转达用户。",
    "v0.4.0",
    "",
)
class DshBridgePlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig | None = None):
        super().__init__(context)
        self.context = context
        self.config = config
        self._bg_tasks: set[asyncio.Task] = set()
        # ── 配置项：开源版不写死任何人的路径与账号，全部从这里取 ──
        cfg = config or {}
        self.project_dir = _resolve_project_dir(cfg)
        # ── 目录名、文件名也都能改；不写就用默认值，也就是改造前的行为 ──
        self.access_file_name = str(cfg.get("access_file_name") or ACCESS_FILE_NAME).strip()
        self.relay_dir_name = str(cfg.get("relay_dir_name") or "dsh_relay").strip()
        self.relay_done_dir_name = str(cfg.get("relay_done_dir_name") or "done").strip()
        self.events_file_name = str(cfg.get("events_file_name") or "relay_events.jsonl").strip()
        # 中转记录里的来源标签，闸门侧一眼看出这条是谁发来的
        self.source_label = str(cfg.get("source_label") or "dsh").strip()
        self.access_path = self.project_dir / "cache" / self.access_file_name
        self.relay_dir = self.project_dir / "cache" / self.relay_dir_name
        self.relay_done_dir = self.relay_dir / self.relay_done_dir_name
        self.memory_dir = _resolve_memory_dir(cfg, PLUGIN_NAME)
        self.relay_events = self.memory_dir / self.events_file_name
        self.target_id = str(cfg.get("target_id") or "").strip()
        self.target_type = str(cfg.get("target_type") or DEFAULT_TARGET_TYPE).strip()
        self.platform = str(cfg.get("platform") or "aiocqhttp").strip()
        self.instant_summary = cfg.get("instant_summary") is not False
        self.tag = str(cfg.get("tag") or "[dsh]").strip()
        # 总结用的系统提示词：配置里填了就用自己的，没填就用内置通用版
        self.summary_prompt = str(cfg.get("summary_prompt") or "").strip() or SUMMARY_SYSTEM_PROMPT
        self.relay_umo = (
            f"{self.platform}:{self.target_type}:{self.target_id}" if self.target_id else ""
        )
        if not self.target_id:
            logger.warning(
                "[dsh-gateway] 还没配置 target_id（消息要转达给谁），转达会失败；"
                "请在插件配置里填上对方账号再重载插件。"
            )

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
            "把消息交给闸门即时总结后转达用户",
        )
        self.context.register_web_api(
            f"/{PLUGIN_NAME}/relay",
            self.api_relay,
            ["GET"],
            "查看闸门中转箱里还没转达出去的 dsh 消息",
        )
        logger.info("[dsh-gateway] 路由注册完成（唯一闸门 · 即时转达模式）")
        logger.info(
            "[dsh-gateway] 安装提示：① 在插件配置里填「转达目标账号」；"
            f"②「桥接项目目录」留空即用 {Path.home() / DEFAULT_PROJECT_DIRNAME}，dsh 侧要填同一个；"
            "③ 装好 dsh 侧插件后这条通道才算闭环。"
        )

        try:
            self.relay_dir.mkdir(parents=True, exist_ok=True)
        except Exception as exc:
            logger.warning(f"[dsh-gateway] 创建中转箱失败: {exc}")

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
            username = dashboard_cfg.get("username") or "gateway"
            port = dashboard_cfg.get("port") or 6185
            if not secret:
                logger.warning("[dsh-gateway] 未找到 dashboard.jwt_secret，跳过访问文件生成")
                return

            base = f"http://127.0.0.1:{port}"
            payload = {
                "base_url": base,
                "token": _sign_dashboard_token(str(secret), str(username)),
                "auth_header": "Authorization: Bearer <token>",
                "ping_url": f"{base}/api/plug/{PLUGIN_NAME}/ping",
                "send_url": f"{base}/api/plug/{PLUGIN_NAME}/send",
                "relay_url": f"{base}/api/plug/{PLUGIN_NAME}/relay",
                "default_target": self.target_id,
                "note": "token 由 dashboard.jwt_secret 自签，长期有效；改动 dashboard 密钥后请重载本插件。",
                "relay_note": (
                    "send 会把消息交给闸门：闸门立刻用自己的口吻总结，再转达用户。"
                    "dsh 不再直连用户，也不需要等待取件周期。"
                ),
            }

            targets = [data_dir / ACCESS_FILE_NAME]
            try:
                targets.append(Path(self.access_path))
            except Exception:
                pass

            text = json.dumps(payload, ensure_ascii=False, indent=2)
            for target in targets:
                try:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(text, encoding="utf-8")
                except Exception as exc:
                    logger.warning(f"[dsh-gateway] 写入 {target} 失败: {exc}")
            logger.info(f"[dsh-gateway] 访问文件已生成，共 {len(targets)} 处")
            logger.info(
                f"[dsh-gateway] 自检：打开 {base}/api/plug/{PLUGIN_NAME}/ping 看到 pong，"
                "就说明 dsh 随时能把消息交给这条通道。"
            )
        except Exception as exc:
            logger.warning(f"[dsh-gateway] 生成访问文件异常: {exc}", exc_info=True)

    # ---------- 即时转达 ----------
    def _get_provider(self):
        """拿一个可用的聊天 Provider，兼容不同版本的签名。"""
        for attempt in (
            lambda: self.context.get_using_provider(umo=self.relay_umo),
            lambda: self.context.get_using_provider(self.relay_umo),
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

    async def _send_to_target(self, text: str) -> bool:
        try:
            chain = MessageChain([Plain(text)])
            await StarTools.send_message_by_id(
                self.target_type,
                self.target_id,
                chain,
                platform=self.platform,
            )
            return True
        except Exception as exc:
            logger.error(f"[dsh-gateway] 转达用户失败: {exc}", exc_info=True)
            return False

    async def _relay_now(self, item_id: str, text: str, path: Path) -> None:
        """落盘中转件 → 立刻总结 → 推给用户 → 成功则归档。"""
        summary = ""
        provider = self._get_provider()
        if provider is not None:
            try:
                resp = await provider.text_chat(
                    system_prompt=self.summary_prompt,
                    prompt=text,
                )
                summary = str(getattr(resp, "completion_text", "") or "").strip()
            except Exception as exc:
                logger.warning(f"[dsh-gateway] 总结中转件 {item_id} 失败: {exc}")

        if not summary:
            # 总结不可用时如实降级：至少把原话带标签送到用户，绝不吞消息
            body = text if len(text) <= 800 else text[:800] + "……"
            summary = f"它发来一条消息，我这边总结环节没跑通，先把原话给你：{body}"

        delivered = await self._send_to_target(f"[dsh] {summary}")

        try:
            item = json.loads(path.read_text(encoding="utf-8"))
            item["status"] = "done" if delivered else "deliver-failed"
            item["handled_at"] = datetime.now().isoformat(timespec="seconds")
            item["summary"] = summary
            path.write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8")
            if delivered:
                self.relay_done_dir.mkdir(parents=True, exist_ok=True)
                path.replace(self.relay_done_dir / path.name)
        except Exception as exc:
            logger.warning(f"[dsh-gateway] 归档中转件 {item_id} 失败: {exc}")

        logger.info(
            f"[dsh-gateway] 中转件 {item_id} 处理完毕（转达{'成功' if delivered else '失败'}）"
        )
        self._log_event(
            {
                "id": item_id,
                "time": datetime.now().isoformat(timespec="seconds"),
                "kind": "dsh-message",
                "source": self.source_label,
                "text": text,
                "summary": summary,
                "delivered": delivered,
            }
        )

    def _log_event(self, entry: dict) -> None:
        """追加一行事件流水，交给 tools/dsh_ledger.py 汇总进台账。"""
        try:
            self.memory_dir.mkdir(parents=True, exist_ok=True)
            with self.relay_events.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception as exc:
            logger.warning(f"[dsh-gateway] 写事件流水失败: {exc}")

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
            for path in sorted(self.relay_dir.glob("*.json")):
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

        target = str(data.get("target") or self.target_id).strip()
        msg_type = str(data.get("type") or self.target_type).strip()
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
                    platform=self.platform,
                )
            except Exception as exc:
                logger.error(f"[dsh-gateway] 直发失败: {exc}", exc_info=True)
                return jsonify({"ok": False, "message": str(exc)}), 500
            logger.info(f"[dsh-gateway] 直发到 {target}: {text[:30]}")
            return jsonify({"ok": True, "direct": True, "target": target})

        # 默认路径：落盘 + 立刻总结转达（不阻塞 dsh）
        try:
            self.relay_dir.mkdir(parents=True, exist_ok=True)
            now = datetime.now()
            item_id = f"dsh-{now.strftime('%Y%m%d-%H%M%S')}-{int(time.time() * 1000) % 1000:03d}"
            item = {
                "id": item_id,
                "source": self.source_label,
                "tag": self.tag,
                "from": "dsh",
                "to": "gateway",
                "target_hint": target,
                "type": msg_type,
                "time": now.isoformat(timespec="seconds"),
                "text": text,
                "status": "pending",
            }
            path = self.relay_dir / f"{item_id}.json"
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(path)
        except Exception as exc:
            logger.error(f"[dsh-gateway] 落中转箱失败: {exc}", exc_info=True)
            return jsonify({"ok": False, "message": str(exc)}), 500

        if self.instant_summary:
            self._spawn_relay(item_id, text, path)
            logger.info(f"[dsh-gateway] 已收到 {item_id}，正在即时总结转达: {text[:30]}")
        else:
            logger.info(f"[dsh-gateway] 已收到 {item_id}，即时总结已关闭，等兜底取件: {text[:30]}")
        return jsonify(
            {
                "ok": True,
                "relay": True,
                "instant": True,
                "id": item_id,
                "handled_by": "gateway",
                "length": len(text),
                "message": "已交给闸门，闸门正在即时总结并转达用户。",
            }
        )

    async def terminate(self):
        for task in list(self._bg_tasks):
            task.cancel()
        self._bg_tasks.clear()
        logger.info("[dsh-gateway] 插件已停止")
