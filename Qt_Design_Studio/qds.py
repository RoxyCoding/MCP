"""Qt Design Studioのプロジェクトファイル操作。GUIの未保存状態は扱わない。"""

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

BASE = Path(__file__).resolve().parent
MAX_BYTES = 1024 * 1024
MAX_SCAN = 10000
TEXT_SUFFIXES = {".qml", ".qmlproject", ".js", ".mjs", ".json", ".conf", ".txt", ".md", ".svg", ".qrc"}
EXCLUDED = {".git", ".venv", "node_modules", "build", ".qds-mcp-backups", "__pycache__"}
WRITE_LOCK = threading.RLock()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def workspace() -> Path:
    raw = Path(os.environ.get("QDS_WORKSPACE") or "projects")
    root = (BASE / raw).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def safe_path(relative: str, *, text: bool = False) -> Path:
    """解決後のパスも検証し、外部へのリンクとWindowsの特殊パスを拒否する。"""
    raw = Path(relative)
    if raw.is_absolute() or raw.drive or ":" in relative or "\x00" in relative:
        raise ValueError("ワークスペース内の相対パスを指定してください。")
    reserved = r"(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?"
    if any(part not in {".", ".."} and (part.endswith((".", " ")) or re.fullmatch(reserved, part, re.IGNORECASE))
           for part in raw.parts):
        raise ValueError("Windowsの予約名や末尾の空白・ピリオドは使用できません。")
    if any(part.startswith(".") and part not in {".", ".."} for part in raw.parts):
        raise ValueError("隠しファイル・隠しフォルダーは操作できません。")
    if any(part in EXCLUDED for part in raw.parts):
        raise ValueError("管理用フォルダーは操作できません。")
    root = workspace()
    path = (root / raw).resolve()
    if not path.is_relative_to(root):
        raise ValueError("ワークスペース外のパスは操作できません。")
    if text and path.suffix.lower() not in TEXT_SUFFIXES and path.name != "qmldir":
        raise ValueError("対応するQML・設定・テキストファイルを指定してください。")
    return path


def read_bytes(path: Path) -> bytes:
    with path.open("rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("1 MiBを超えるファイルは扱えません。")
    return data


def read_file(relative: str) -> dict:
    data = read_bytes(safe_path(relative, text=True))
    return {"path": relative, "content": data.decode("utf-8"), "sha256": digest(data), "bytes": len(data)}


def write_file(relative: str, content: str, expected_sha256: str | None = None) -> dict:
    """既存ファイルはハッシュ照合・バックアップ後に置換する。"""
    data = content.encode("utf-8")
    if len(data) > MAX_BYTES:
        raise ValueError("内容はUTF-8で1 MiB以内にしてください。")
    with WRITE_LOCK:
        path = safe_path(relative, text=True)
        existed = path.exists()
        backup = None
        if existed:
            old = read_bytes(path)
            if expected_sha256 != digest(old):
                raise ValueError("更新競合です。qds_read_fileで再読込し、取得したsha256をexpected_sha256に指定してください。")
            # 元データを内容ハッシュ別に保管する。バックアップの外部リンクも拒否する。
            folder = workspace() / ".qds-mcp-backups"
            folder.mkdir(exist_ok=True)
            if folder.is_symlink() or folder.resolve() != folder:
                raise ValueError("バックアップフォルダーにリンクは使用できません。")
            backup = folder / f"{digest(old)}.bak"
            try:
                with backup.open("xb") as stream:
                    stream.write(old)
            except FileExistsError:
                if backup.is_symlink() or backup.read_bytes() != old:
                    raise ValueError("バックアップが不正です。管理者が確認してください。")
        elif expected_sha256 is not None:
            raise ValueError("対象ファイルがありません。新規作成ではexpected_sha256を省略してください。")
        path.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix=".qds-write-", dir=path.parent)
        try:
            with os.fdopen(handle, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if existed:
                # 別アプリの保存をできるだけ直前にも検出する。
                if digest(read_bytes(path)) != expected_sha256:
                    raise ValueError("保存直前にファイルが変更されました。再読込してください。")
                shutil.copymode(path, temporary)
                os.replace(temporary, path)
            else:
                # 新規作成中に現れたファイルを上書きしない。
                os.link(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    return {"path": relative, "sha256": digest(data), "bytes": len(data),
            "backup": str(backup.relative_to(workspace())) if backup else None}


def iter_files(directory: str):
    start = safe_path(directory)
    if not start.is_dir():
        raise ValueError("存在するフォルダーを指定してください。")
    root = workspace()
    # followlinks=Falseに加え、Windowsのjunctionも解決して除外する。
    count = 0
    for folder, dirs, files in os.walk(start, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDED and not d.startswith(".")
                         and (Path(folder) / d).resolve() == Path(folder) / d)
        for name in sorted(files):
            count += 1
            if count > MAX_SCAN:
                raise ValueError("走査上限10000ファイルを超えました。directoryを狭めてください。")
            path = Path(folder) / name
            if not name.startswith(".") and not path.is_symlink() and path.resolve().is_relative_to(root):
                yield path


def list_files(directory: str = ".", offset: int = 0, limit: int = 100) -> dict:
    if offset < 0 or not 1 <= limit <= 500:
        raise ValueError("offsetは0以上、limitは1〜500を指定してください。")
    paths = list(iter_files(directory))
    page = paths[offset:offset + limit]
    end = offset + len(page)
    return {"files": [{"path": p.relative_to(workspace()).as_posix(), "bytes": p.stat().st_size} for p in page],
            "total_count": len(paths), "has_more": end < len(paths),
            "next_offset": end if end < len(paths) else None}


def search(query: str, directory: str = ".", limit: int = 50) -> dict:
    if not query or len(query) > 500 or not 1 <= limit <= 200:
        raise ValueError("検索語は1〜500文字、limitは1〜200を指定してください。")
    matches = []
    skipped = []
    for path in iter_files(directory):
        if path.suffix.lower() not in TEXT_SUFFIXES and path.name != "qmldir":
            continue
        try:
            content = read_bytes(path).decode("utf-8")
        except (UnicodeError, ValueError, OSError):
            skipped.append(path.relative_to(workspace()).as_posix())
            continue
        for number, line in enumerate(content.splitlines(), 1):
            if query.casefold() in line.casefold():
                if len(matches) == limit:
                    return {"matches": matches, "truncated": True, "skipped": skipped}
                matches.append({"path": path.relative_to(workspace()).as_posix(),
                                "line": number, "text": line[:1000]})
    return {"matches": matches, "truncated": False, "skipped": skipped}


def find_studio() -> Path | None:
    configured = os.environ.get("QDS_EXECUTABLE")
    if configured:
        path = Path(configured)
        return path.resolve() if path.is_file() else None
    executable = shutil.which("qtdesignstudio")
    if executable:
        return Path(executable)
    for drive in ("C:/", "D:/", "I:/"):
        for path in sorted(Path(drive).glob("Qt*/Tools/QtDesignStudio*/bin/qtdesignstudio.exe")):
            return path.resolve()
    return None


def find_qmllint() -> Path | None:
    configured = os.environ.get("QDS_QMLLINT")
    if configured:
        path = Path(configured)
        return path.resolve() if path.is_file() else None
    studio = find_studio()
    if studio:
        path = studio.parent.parent / "qt6_design_studio_reduced_version/bin/qmllint.exe"
        if path.is_file():
            return path
    executable = shutil.which("qmllint")
    return Path(executable) if executable else None


def lint(relative: str, import_paths: list[str] | None = None) -> dict:
    path = safe_path(relative, text=True)
    if path.suffix.lower() != ".qml" or not path.is_file():
        raise ValueError("存在する.qmlまたは.ui.qmlファイルを指定してください。")
    executable = find_qmllint()
    if not executable:
        raise ValueError("qmllintが見つかりません。.envのQDS_QMLLINTに実行ファイルを指定してください。")
    if len(import_paths or []) > 20:
        raise ValueError("import_pathsは20個以内にしてください。")
    args = [str(executable), "--ignore-settings", "-I", str(workspace())]
    for relative_import in import_paths or []:
        directory = safe_path(relative_import)
        if not directory.is_dir():
            raise ValueError("import_pathsには存在するフォルダーを指定してください。")
        args.extend(["-I", str(directory)])
    args.append(str(path))
    # 大量の診断出力をメモリに保持しない。
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(args, cwd=workspace(), stdout=output, stderr=subprocess.STDOUT,
                                timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        output.seek(0)
        data = output.read(32769)
    return {"path": relative, "exit_code": result.returncode, "ok": result.returncode == 0,
            "diagnostics": data[:32768].decode("utf-8", errors="replace"), "truncated": len(data) > 32768}


def create_project(name: str, width: int = 1280, height: int = 720) -> dict:
    if not re.fullmatch(r"[A-Z][A-Za-z0-9_]{0,63}", name):
        raise ValueError("nameは英大文字で始まる英数字・_の1〜64文字にしてください。")
    if not 1 <= width <= 16384 or not 1 <= height <= 16384:
        raise ValueError("widthとheightは1〜16384を指定してください。")
    with WRITE_LOCK:
        destination = safe_path(name)
        if destination.exists():
            raise ValueError("同名のフォルダーが存在します。別のnameを指定してください。")
        # 全ファイルを一時フォルダーで揃えてから公開する。
        with tempfile.TemporaryDirectory(prefix=".qds-project-", dir=workspace()) as temporary:
            stage = Path(temporary) / name
            content = stage / f"{name}Content"
            content.mkdir(parents=True)
            (stage / f"{name}.qmlproject").write_text(
                'import QmlProject\n\nProject {\n'
                f'    mainFile: "{name}Content/App.qml"\n'
                f'    mainUiFile: "{name}Content/Screen01.ui.qml"\n'
                '    QmlFiles { directory: "." }\n'
                '    JavaScriptFiles { directory: "." }\n'
                '    ImageFiles { directory: "." }\n'
                '    Files { filter: "qmldir"; directory: "." }\n'
                '    importPaths: [ "." ]\n    qt6Project: true\n}\n', encoding="utf-8")
            (content / "App.qml").write_text(
                'import QtQuick\nimport QtQuick.Window\n\nWindow {\n'
                f'    width: {width}\n    height: {height}\n    visible: true\n'
                f'    title: "{name}"\n    Screen01 {{ anchors.fill: parent }}\n}}\n', encoding="utf-8")
            (content / "Screen01.ui.qml").write_text(
                'import QtQuick\n\nRectangle {\n    id: screen\n'
                f'    width: {width}\n    height: {height}\n'
                '    color: "#f5f5f5"\n\n    Text {\n        anchors.centerIn: parent\n'
                f'        text: "{name}"\n'
                '        color: "#202124"\n        font.pixelSize: 32\n    }\n}\n', encoding="utf-8")
            stage.rename(destination)
    return {"project": f"{name}/{name}.qmlproject", "main_file": f"{name}/{name}Content/App.qml",
            "ui_file": f"{name}/{name}Content/Screen01.ui.qml"}


def open_project(relative: str) -> dict:
    path = safe_path(relative)
    if path.suffix != ".qmlproject" or not path.is_file():
        raise ValueError("存在する.qmlprojectファイルを指定してください。")
    executable = find_studio()
    if not executable:
        raise ValueError("Qt Design Studioが見つかりません。.envのQDS_EXECUTABLEに実行ファイルを指定してください。")
    process = subprocess.Popen([str(executable), str(path)], cwd=path.parent,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"project": relative, "pid": process.pid, "status": "起動要求を送信しました。GUIで読み込み結果を確認してください。"}
