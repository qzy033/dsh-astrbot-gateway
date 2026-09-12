"""dsh 任务台账（Funa 的桥接记忆库）

用途：把「Funa 投出去的每条指令」和「小鲸鱼回传的每个结果」汇成一份随时可查的账本，
省得每次都要翻 inbox / outbox / notice 三处文件。

分工：
  memory/relay_events.jsonl  插件只追加的事件流水（收到小鲸鱼消息、转达结果）
  memory/ledger.jsonl        本脚本汇总出来的台账（一行一条，可读）

用法：
    python tools\\dsh_ledger.py sync                 # 合并更新（最常用，只读本地文件）
    python tools\\dsh_ledger.py list --limit 20      # 看最近 20 条
    python tools\\dsh_ledger.py show <id>            # 看某条完整字段
    python tools\\dsh_ledger.py dispatch --content "任务内容" [--id X] [--preset teyvat-hoi4]
                                                    # 投指令给 dsh 并顺手记账
    python tools\\dsh_ledger.py add --id X --summary "..."
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(r"E:\project\dsh-funa-bridge")
CACHE = ROOT / "cache"
INBOX = CACHE / "inbox"
OUTBOX = CACHE / "outbox"
MEM_DIR = Path(r"C:\Users\qzy\.astrbot\data\plugin_data\astrbot_plugin_funa_bridge")
RELAY_EVENTS = MEM_DIR / "relay_events.jsonl"
LEDGER = MEM_DIR / "ledger.jsonl"
STATUS = CACHE / "bridge_status.json"

FIELDS = [
    "id",
    "updated",
    "direction",
    "title",
    "workspace",
    "preset",
    "status",
    "result",
    "session",
    "files",
]


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _load_ledger() -> dict:
    items: dict = {}
    if LEDGER.is_file():
        for line in LEDGER.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            if isinstance(row, dict) and row.get("id"):
                items[str(row["id"])] = row
    return items


def _save_ledger(items: dict) -> None:
    MEM_DIR.mkdir(parents=True, exist_ok=True)
    rows = sorted(items.values(), key=lambda r: str(r.get("updated") or ""))
    text = "\n".join(json.dumps({k: r.get(k) for k in FIELDS}, ensure_ascii=False) for r in rows)
    LEDGER.write_text(text + "\n", encoding="utf-8")


def _brief(text: str, limit: int = 160) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[:limit] + "…"


def _dispatch_snapshot() -> dict:
    data = _read_json(STATUS) or {}
    d = data.get("dispatch") or {}
    return {
        "workspace": d.get("cwd"),
        "preset": d.get("preset"),
        "autoDispatch": d.get("autoDispatch"),
    }


def cmd_sync(args) -> int:
    now = datetime.now().isoformat(timespec="seconds")
    snap = _dispatch_snapshot()
    items = _load_ledger()
    touched = 0

    # 1) 指令侧：inbox/<id>.json
    if INBOX.is_dir():
        for path in sorted(INBOX.glob("*.json")):
            data = _read_json(path)
            if not isinstance(data, dict):
                continue
            tid = str(data.get("id") or path.stem)
            row = items.get(tid) or {"id": tid}
            row["direction"] = "funa → dsh"
            row["title"] = _brief(data.get("content"))
            row["status"] = data.get("status") or row.get("status") or "pending"
            row["preset"] = data.get("preset") or data.get("agentPreset") or row.get("preset") or snap.get("preset")
            row["workspace"] = row.get("workspace") or snap.get("workspace")
            files = row.get("files") or {}
            files["inbox"] = str(path)
            row["files"] = files
            row["updated"] = now
            items[tid] = row
            touched += 1

    # 2) 回报侧：outbox/<id>.json
    if OUTBOX.is_dir():
        for path in sorted(OUTBOX.glob("*.json")):
            if path.name.endswith(".notice.json"):
                continue
            data = _read_json(path)
            if not isinstance(data, dict):
                continue
            tid = str(data.get("ref") or data.get("id") or path.stem)
            row = items.get(tid) or {"id": tid, "direction": "funa → dsh"}
            row["result"] = _brief(data.get("content") or data.get("result") or data.get("summary"))
            row["status"] = str(data.get("status") or row.get("status") or "done")
            row["session"] = data.get("sessionId") or row.get("session")
            files = row.get("files") or {}
            files["outbox"] = str(path)
            row["files"] = files
            row["updated"] = now
            items[tid] = row
            touched += 1

    # 3) 通知侧：outbox/<id>.notice.json（能看到这次用的模式）
    if OUTBOX.is_dir():
        for path in sorted(OUTBOX.glob("*.notice.json")):
            data = _read_json(path)
            if not isinstance(data, dict):
                continue
            tid = str(data.get("ref") or data.get("id") or path.stem.replace(".notice", ""))
            row = items.get(tid) or {"id": tid, "direction": "funa → dsh"}
            note = str(data.get("content") or data.get("message") or "")
            if note:
                row["session"] = row.get("session") or _brief(note, 60)
                if "模式" in note and not row.get("preset"):
                    tail = note.split("模式", 1)[1]
                    row["preset"] = tail.strip(" ：:）。\n")[:24] or row.get("preset")
            files = row.get("files") or {}
            files["notice"] = str(path)
            row["files"] = files
            row["updated"] = now
            items[tid] = row
            touched += 1

    # 4) 插件事件流水：memory/relay_events.jsonl（小鲸鱼发来的消息 + 转达结果）
    if RELAY_EVENTS.is_file():
        for line in RELAY_EVENTS.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            tid = str(ev.get("id") or "")
            if not tid:
                continue
            row = items.get(tid) or {"id": tid}
            row["direction"] = "dsh → funa"
            row["title"] = _brief(ev.get("text"))
            row["result"] = _brief(ev.get("summary"))
            row["status"] = "已转达 qzy" if ev.get("delivered") else "转达失败（待补发）"
            row["preset"] = row.get("preset") or snap.get("preset")
            row["workspace"] = row.get("workspace") or snap.get("workspace")
            row["updated"] = str(ev.get("time") or now)
            items[tid] = row
            touched += 1

    # 5) 记录本次默认值快照，方便回看「那时候默认是什么」
    if snap.get("workspace") or snap.get("preset"):
        sid = f"snapshot-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        items[sid] = {
            "id": sid,
            "updated": now,
            "direction": "snapshot",
            "title": f"默认工作区 {snap.get('workspace')} / 默认模式 {snap.get('preset')}",
            "workspace": snap.get("workspace"),
            "preset": snap.get("preset"),
            "status": "info",
        }

    _save_ledger(items)
    print(f"台账已更新：{len(items)} 条记录（本次触及 {touched} 条）")
    print(f"位置：{LEDGER}")
    print(f"当前默认工作区：{snap.get('workspace')}    默认模式：{snap.get('preset')}")
    return 0


def cmd_list(args) -> int:
    items = _load_ledger()
    rows = sorted(items.values(), key=lambda r: str(r.get("updated") or ""), reverse=True)
    rows = [r for r in rows if r.get("direction") != "snapshot"][: args.limit]
    if not rows:
        print("台账还是空的，先跑一次 sync 吧。")
        return 0
    for r in rows:
        print("=" * 60)
        print(f"id      : {r.get('id')}")
        print(f"更新    : {r.get('updated')}")
        print(f"方向    : {r.get('direction')}")
        print(f"工作区  : {r.get('workspace')}")
        print(f"模式    : {r.get('preset')}")
        print(f"状态    : {r.get('status')}")
        print(f"任务    : {r.get('title')}")
        if r.get("result"):
            print(f"结果    : {r.get('result')}")
    return 0


def cmd_show(args) -> int:
    items = _load_ledger()
    row = items.get(args.id)
    if not row:
        print(f"没找到 id = {args.id}")
        return 1
    print(json.dumps({k: row.get(k) for k in FIELDS}, ensure_ascii=False, indent=2))
    return 0


def cmd_dispatch(args) -> int:
    """投一条指令给 dsh，并顺手记进台账。"""
    INBOX.mkdir(parents=True, exist_ok=True)
    snap = _dispatch_snapshot()
    now = datetime.now()
    tid = args.id or f"funa-{now.strftime('%Y%m%d-%H%M%S')}"

    item = {
        "id": tid,
        "from": "funa",
        "to": "dsh",
        "time": now.isoformat(timespec="seconds"),
        "type": "task",
        "content": args.content,
        "status": "pending",
    }
    preset = (args.preset or "").strip()
    if preset and preset != "standard":
        item["preset"] = preset

    path = INBOX / f"{tid}.json"
    path.write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8")

    items = _load_ledger()
    row = items.get(tid) or {"id": tid}
    row.update(
        {
            "updated": now.isoformat(timespec="seconds"),
            "direction": "funa → dsh",
            "title": _brief(args.content),
            "workspace": args.workspace or snap.get("workspace"),
            "preset": preset or snap.get("preset"),
            "status": "pending",
            "files": {"inbox": str(path)},
        }
    )
    items[tid] = row
    _save_ledger(items)

    print(f"已投指令并记账：{tid}")
    print(f"  工作区 {row.get('workspace')} / 模式 {row.get('preset')}")
    print(f"  inbox  {path}")
    return 0


def cmd_add(args) -> int:
    items = _load_ledger()
    snap = _dispatch_snapshot()
    row = items.get(args.id) or {"id": args.id}
    row.update(
        {
            "updated": datetime.now().isoformat(timespec="seconds"),
            "direction": args.direction,
            "title": args.summary,
            "workspace": args.workspace or row.get("workspace") or snap.get("workspace"),
            "preset": args.preset or row.get("preset") or snap.get("preset"),
            "status": args.status,
        }
    )
    if args.result:
        row["result"] = args.result
    items[args.id] = row
    _save_ledger(items)
    print(f"已记账：{args.id}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="dsh 任务台账")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_sync = sub.add_parser("sync", help="从桥接目录自动合并更新")
    p_sync.set_defaults(func=cmd_sync)

    p_list = sub.add_parser("list", help="列出最近记录")
    p_list.add_argument("--limit", type=int, default=10)
    p_list.set_defaults(func=cmd_list)

    p_show = sub.add_parser("show", help="查看某条记录")
    p_show.add_argument("id")
    p_show.set_defaults(func=cmd_show)

    p_dispatch = sub.add_parser("dispatch", help="投指令给 dsh 并记账")
    p_dispatch.add_argument("--content", required=True)
    p_dispatch.add_argument("--id", default="")
    p_dispatch.add_argument("--preset", default="")
    p_dispatch.add_argument("--workspace", default="")
    p_dispatch.set_defaults(func=cmd_dispatch)

    p_add = sub.add_parser("add", help="手工记一条")
    p_add.add_argument("--id", required=True)
    p_add.add_argument("--summary", default="")
    p_add.add_argument("--workspace", default="")
    p_add.add_argument("--preset", default="")
    p_add.add_argument("--status", default="pending")
    p_add.add_argument("--direction", default="funa → dsh")
    p_add.add_argument("--result", default="")
    p_add.set_defaults(func=cmd_add)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
