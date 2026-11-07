"""このPC用の接続設定を生成する。既存のクライアント設定は変更しない。"""

import json
import sys

from qds import BASE


def main() -> None:
    command, script = str(BASE / ".venv/Scripts/python.exe"), str(BASE / "server.py")
    generic = {"mcpServers": {"qt_design_studio": {"command": command, "args": [script]}}}
    (BASE / "mcp-config.local.json").write_text(json.dumps(generic, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    toml = f'[mcp_servers.qt_design_studio]\ncommand = {json.dumps(command)}\nargs = [{json.dumps(script)}]\n'
    (BASE / "codex-config.local.toml").write_text(toml, encoding="utf-8")
    print("接続設定を生成しました: mcp-config.local.json / codex-config.local.toml", file=sys.stderr)


if __name__ == "__main__":
    main()
