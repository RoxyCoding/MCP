"""ファイル境界・競合防止・実機Qtツール・stdioを検証する。"""

import asyncio
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from mcp import Client
from mcp.client.stdio import StdioServerParameters

import qds


class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        environment = patch.dict(os.environ, {"QDS_WORKSPACE": str(self.root)})
        environment.start()
        self.addCleanup(environment.stop)

    def test_project_creation_and_existing_directory(self):
        result = qds.create_project("Demo", 800, 600)
        self.assertEqual(len(qds.list_files()["files"]), 3)
        self.assertIn('width: 800', qds.read_file(result["ui_file"])["content"])
        with self.assertRaises(ValueError):
            qds.create_project("Demo")
        for invalid in ["../Other", "bad-name", 'Bad"Name', "con"]:
            with self.assertRaises(ValueError):
                qds.create_project(invalid)

    def test_update_backup_and_conflict(self):
        initial = qds.write_file("test.qml", "import QtQuick\nItem {}\n")
        original = qds.read_file("test.qml")
        with self.assertRaises(ValueError):
            qds.write_file("test.qml", "Item {}")
        result = qds.write_file("test.qml", "import QtQuick\nRectangle {}\n", initial["sha256"])
        self.assertEqual((self.root / result["backup"]).read_text(), original["content"])
        with self.assertRaises(ValueError):
            qds.write_file("test.qml", "old update", initial["sha256"])
        self.assertIn("Rectangle", qds.read_file("test.qml")["content"])

    def test_path_boundaries(self):
        for invalid in ["../outside.qml", "C:/outside.qml", "a.qml:stream", ".env", "build/a.qml", ".qds-mcp-backups/a.qml", "NUL.qml", "a. /test.qml"]:
            with self.subTest(path=invalid), self.assertRaises(ValueError):
                qds.write_file(invalid, "Item {}")
        with self.assertRaises(ValueError):
            qds.write_file("binary.exe", "bad")

    def test_external_junction_is_not_followed(self):
        with tempfile.TemporaryDirectory() as outside:
            target = Path(outside)
            (target / "private.qml").write_text("private")
            link = self.root / "escape"
            if os.name == "nt":
                # cmdのmklinkはリンク作成のみに利用し、ファイル削除には利用しない。
                result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), outside], capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            else:
                link.symlink_to(target, target_is_directory=True)
            try:
                with self.assertRaises(ValueError):
                    qds.read_file("escape/private.qml")
                self.assertEqual(qds.list_files()["total_count"], 0)
            finally:
                if os.name == "nt":
                    link.rmdir()
                else:
                    link.unlink()
            self.assertTrue((target / "private.qml").exists())

    def test_search_and_pagination(self):
        qds.create_project("Demo")
        first = qds.list_files(limit=1)
        self.assertTrue(first["has_more"])
        second = qds.list_files(offset=first["next_offset"], limit=1)
        self.assertNotEqual(first["files"][0], second["files"][0])
        result = qds.search("DEMO", limit=1)
        self.assertEqual(len(result["matches"]), 1)
        self.assertTrue(result["truncated"])
        with self.assertRaises(ValueError):
            qds.list_files(limit=0)

    def test_file_size_and_encoding(self):
        with self.assertRaises(ValueError):
            qds.write_file("large.qml", "x" * (qds.MAX_BYTES + 1))
        (self.root / "bad.qml").write_bytes(b"\xff")
        self.assertEqual(qds.search("x")["skipped"], ["bad.qml"])

    def test_open_uses_arguments_and_no_shell(self):
        project = qds.create_project("Demo")["project"]
        with patch("qds.find_studio", return_value=Path("C:/Qt/qtdesignstudio.exe")), patch("qds.subprocess.Popen") as launch:
            launch.return_value.pid = 123
            self.assertEqual(qds.open_project(project)["pid"], 123)
            self.assertEqual(launch.call_args.args[0][-1], str(self.root / project))
            self.assertNotIn("shell", launch.call_args.kwargs)

    def test_real_qmllint(self):
        if not qds.find_qmllint():
            self.skipTest("qmllintが未インストールです。")
        result = qds.create_project("Demo")
        self.assertTrue(qds.lint(result["ui_file"])["ok"])
        self.assertTrue(qds.lint(result["main_file"])["ok"])
        qds.write_file("Broken.qml", "import QtQuick\nItem { !!!! }")
        self.assertFalse(qds.lint("Broken.qml")["ok"])

    def test_mcp_stdio(self):
        asyncio.run(self.check_mcp())

    async def check_mcp(self):
        parameters = StdioServerParameters(
            command=sys.executable, args=[str(qds.BASE / "server.py")],
            env={**os.environ, "QDS_WORKSPACE": str(self.root)}, cwd=self.root,
        )
        async with Client(parameters) as client:
            tools = (await client.list_tools()).tools
            self.assertEqual(len(tools), 8)
            self.assertTrue(all(tool.output_schema for tool in tools))
            status = await client.call_tool("qds_status")
            self.assertEqual(status.structured_content["workspace"], str(self.root))
            created = await client.call_tool("qds_create_project", {"name": "WireTest"})
            self.assertFalse(created.is_error, created)
            read = await client.call_tool("qds_read_file", {"path": "WireTest/WireTestContent/Screen01.ui.qml"})
            self.assertFalse(read.is_error, read)
            data = read.structured_content
            # SDKの構造化dict結果を確認する。
            self.assertIn("sha256", data)
            update = await client.call_tool("qds_write_file", {
                "path": data["path"], "content": data["content"].replace("#f5f5f5", "#eeeeee"),
                "expected_sha256": data["sha256"],
            })
            self.assertFalse(update.is_error, update)
            listing = await client.call_tool("qds_list_files")
            self.assertEqual(listing.structured_content["total_count"], 3)
            found = await client.call_tool("qds_search", {"query": "#eeeeee"})
            self.assertEqual(len(found.structured_content["matches"]), 1)
            if qds.find_qmllint():
                linted = await client.call_tool("qds_lint_qml", {"path": data["path"]})
                self.assertTrue(linted.structured_content["ok"], linted)
            rejected = await client.call_tool("qds_read_file", {"path": "../outside.qml"})
            self.assertTrue(rejected.is_error)
            self.assertIn("ワークスペース外", rejected.content[0].text)
            guide = await client.read_resource("qds://guide")
            self.assertIn("sha256", guide.contents[0].text)
            prompt = await client.get_prompt("qds_review_ui", {"path": data["path"]})
            self.assertTrue(prompt.messages)


if __name__ == "__main__":
    unittest.main()
