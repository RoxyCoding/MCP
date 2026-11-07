# Qt Design Studio MCP

Qt Design Studioの保存済みQMLプロジェクトを扱うローカルMCPサーバーです。Python 3.12以上と公式MCP Python SDK v2を使用し、stdioで接続します。APIキーや有料サービスは不要です。

## セットアップ

PowerShellで実行します。[uv](https://docs.astral.sh/uv/)が必要です。

```powershell
cd I:\Programming\PF\MCP\Qt_Design_Studio
.\setup.ps1
```

セットアップは依存関係をロックファイルどおりにインストールし、`.env`とこのPC用の接続設定を生成します。既存の`.env`は保持します。Qt Design Studioは別途インストールしてください。

## MCPクライアントへの登録

`mcp-config.local.json`の`qt_design_studio`エントリーを、利用中のクライアントの`mcpServers`へ追加してください。Codex形式の設定断片は`codex-config.local.toml`です。既存の設定ファイル全体を上書きしないでください。

設定の内容は、このフォルダーの`.venv\Scripts\python.exe`で`server.py`を起動する指定です。サーバーは起動時に自身のフォルダーの`.env`を読むため、クライアントの作業ディレクトリーに依存しません。設定を追加したらクライアントのMCP接続を再起動してください。

手動起動は`.\start.ps1`です。stdioサーバーなので、起動後はMCPクライアントの入力を待ちます。通常はクライアントが自動起動するため、手動で常駐させる必要はありません。

## 編集対象の設定

`.env`を編集します。環境変数に同名の値がある場合は環境変数が優先されます。変更後はMCP接続を再起動してください。

```dotenv
QDS_WORKSPACE=I:/Your/QtProjects
QDS_EXECUTABLE=C:/Qt2/Tools/QtDesignStudio/bin/qtdesignstudio.exe
QDS_QMLLINT=C:/Qt2/Tools/QtDesignStudio/qt6_design_studio_reduced_version/bin/qmllint.exe
```

`QDS_WORKSPACE`の初期値はこのフォルダー内の`projects`です。実際に編集したいプロジェクトの親フォルダーを指定してください。Studioとqmllintは空欄なら自動検索します。複数バージョンが入っている場合は明示指定を推奨します。

## ツール

| ツール | 用途 |
|---|---|
| `qds_status` | ワークスペース・実行ファイルの検出結果 |
| `qds_list_files` | 再帰一覧、offset/limitによるページ分割 |
| `qds_read_file` | UTF-8ファイルの内容・sha256の取得 |
| `qds_write_file` | 新規作成・競合チェック付きの更新 |
| `qds_search` | 文字列検索、ファイル名・行番号の取得 |
| `qds_create_project` | Qt 6の最小プロジェクトの作成 |
| `qds_lint_qml` | qmllintによるQML検証 |
| `qds_open_project` | Qt Design Studioでプロジェクトを開く起動要求 |

リソース`qds://guide`とレビュー用プロンプト`qds_review_ui`も利用できます。

## 利用例

接続後、AIに次のように依頼できます。

> Qt Design Studio MCPの状態を確認し、Demoという名前で1280×720のプロジェクトを作成してください。画面の背景を薄い青に変更し、QMLを検証してください。

既存ファイルの更新例:

1. `qds_read_file`に`{"path":"Demo/DemoContent/Screen01.ui.qml"}`を渡します。
2. 取得した内容を編集し、`qds_write_file`に`path`、`content`、取得した`sha256`を`expected_sha256`として渡します。
3. `qds_lint_qml`で検証します。プロジェクト固有のモジュールがある場合は`import_paths`にワークスペースからの相対ディレクトリを渡してください。`.qmlproject`の追加importPathsは自動解釈しません。
4. 必要に応じて`qds_open_project`で`Demo/Demo.qmlproject`を開きます。

## 保存と制限

- 既存ファイルの上書きはハッシュ一致が必要です。更新前の内容はワークスペースの`.qds-mcp-backups/<sha256>.bak`へ保存します。復元はStudioで保存状態を確認したうえで、手動コピーしてください。
- Studioで未保存の編集がある場合は先に保存してください。保存中の同時編集は避けてください。ハッシュ照合と保存の間の外部変更を完全にはロックできません。
- テキストはUTF-8、1ファイル1 MiBまでです。QML・JS・JSON・conf・txt・md・SVG・qrc・qmldirに対応します。バイナリー画像の追加は手動で行ってください。
- 外部パス、外部へのシンボリックリンクやjunction、隠しファイル、管理フォルダーは操作対象外です。走査は10000ファイルまで。大規模プロジェクトでは`directory`を絞ってください。
- 最小プロジェクトは`.qmlproject`・実行用`.qml`・画面用`.ui.qml`の3ファイルです。CMakeやC++の配布用構成は生成しません。
- 連携対象は保存済みファイルです。GUIの選択状態、未保存バッファー、画面キャプチャー、デザイナーの直接操作には対応しません。ファイル変更後、Studioの再読み込み確認が出た場合は再読み込みしてください。
- `qds_open_project`の成功は起動要求の送信を示します。読み込み完了や既存ウィンドウの再利用を保証するものではありません。

## 検証

```powershell
.\.venv\Scripts\python.exe -m unittest -v
```

一時ディレクトリーでファイル境界、バックアップ、競合防止、junction、ページ分割、実際のstdio MCP接続を検証します。qmllintが見つかる環境では正常・不正QMLも検証します。テストからQt Design StudioのGUIは開きません。

`examples/Demo`は読取専用評価用のサンプルです。`.env`の`QDS_WORKSPACE=examples`で`evaluations.xml`の10問を評価できます。評価中はサンプルを変更しないでください。

## 参考

- [MCP Python SDK v2](https://py.sdk.modelcontextprotocol.io/)
- [Qt Design Studioのプロジェクト構成](https://doc.qt.io/qtdesignstudio/studio-projects.html)
- [QMLプロジェクト形式](https://wiki.qt.io/QtDesignStudio/QMLProjectFileFormat)
- [qmllint](https://doc.qt.io/qt-6/qtqml-tooling-qmllint.html)
