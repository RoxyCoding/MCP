# Local Figma MCP

Figmaファイルの取得と、開いているファイルの直接作成・編集を行う自作MCPサーバーです。
Node.js 22以上を使用します。初回は`npm run setup`を実行してください。プラグインのソースや`.env`を編集した場合は`npm run build`で`plugin/code.js`とこのPC用の`plugin/ui.local.html`を生成します。`npm run setup`・`npm start`・`npm test`でも自動生成します。

## 構成

MCPクライアント → stdio MCPサーバー → ローカルWebSocket → Figma開発プラグイン → Plugin API

直接編集には付属プラグインを使用します。REST API用トークンは直接編集には不要です。
RESTツールは保存済みファイルを取得します。編集中の状態を取得する場合はプラグイン経由のツールを使用してください。

## セットアップ

このフォルダーで実行します。

```powershell
npm install
npm run setup
```

`setup`はランダムな接続トークンを`.env`に保存し、絶対パスを使用した接続設定`mcp.local.json`を生成します。さらに、このPC用のプラグイン画面`plugin/ui.local.html`へ接続設定を組み込みます。接続トークンの手入力は不要です。
既存の`.env`は上書きしません。生成したJSONの`mcpServers`エントリーを、対応するMCPクライアントの設定に追加してください。

接続先クライアントがJSON以外の形式の場合は、`mcp.local.json`にある`command`と`args`をそのクライアントのMCP設定へ転記してください。
実行コマンドは`node`、引数は`.env`の絶対パスを指定した`--env-file=...`と`src/index.js`の絶対パスです。

MCPクライアントがサーバーを起動します。手動起動を確認する場合は`npm start`を実行してください。
標準出力はMCP通信専用なので、通常の対話画面は表示されません。終了はCtrl+Cです。
同じ接続トークン・ポートのMCPサーバーはFigma接続を共有できます。複数のCodexセッションを開いても、ポート競合によってツールの読み込みが失敗しない構成です。

## リモート接続（HTTP）

stdioの代わりにMCPのStreamable HTTPで公開し、別のPCやクラウド上のMCPクライアントから操作できます。FigmaとプラグインはこのPCで動かし、プラグインは従来どおり`localhost`のブリッジへ接続します。

```powershell
npm run setup
npm run start:remote
```

`setup`は既存の`.env`の値を変更せず、未設定の場合だけ`MCP_HTTP_TOKEN`・`MCP_HTTP_HOST`・`MCP_HTTP_PORT`を追記します。接続先URLと認証ヘッダーを含む`mcp.remote.json`も生成します。トークンを含むため共有しないでください（Git対象外）。

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `MCP_HTTP_TOKEN` | なし（必須、32文字以上） | クライアントは`Authorization: Bearer <トークン>`を送信 |
| `MCP_HTTP_HOST` | `127.0.0.1` | 待ち受けアドレス。LANから使う場合は`0.0.0.0` |
| `MCP_HTTP_PORT` | `3100` | 待ち受けポート |
| `MCP_HTTP_ALLOWED_HOSTS` | 空（制限なし） | 受け付ける`Host`ヘッダーのホスト名をカンマ区切りで指定 |

エンドポイントは`http://ホスト:ポート/mcp`です。Claude Codeの例:

```powershell
claude mcp add --transport http local-figma http://localhost:3100/mcp --header "Authorization: Bearer <MCP_HTTP_TOKEN>"
```

インターネット越しに使う場合は`MCP_HTTP_HOST`を`127.0.0.1`のまま、Cloudflare Tunnel・ngrok・TLS対応リバースプロキシなどでHTTPSを付けて公開し、`MCP_HTTP_ALLOWED_HOSTS`へ公開ホスト名を指定してください。このサーバー自体はTLSを提供しないため、平文HTTPのままLAN外へ公開しないでください。トークンを知る相手は接続中のFigmaファイルを編集でき、`figma_place_image`の`filePath`や書き出し先はサーバーPC上のパスとして読み書きされます。

リモート用サーバーはステートレスで、リクエストごとにMCPサーバーを生成します。Figmaブリッジはstdioのサーバーと共有するため、`npm start`・各クライアントのstdio接続と同時に起動できます。認証はBearerトークンのみで、OAuthには対応していません。OAuth必須のクライアントからは直接接続できません。

## Figmaプラグインの接続

1. Figmaデスクトップで編集対象のデザインファイルを開きます。
2. Plugins → Development → Import plugin from manifestから`plugin/manifest.json`を選択します。
3. Developmentから「Local Figma MCP」を実行します。
4. MCPサーバーが起動していれば、トークンを自動設定して接続します。
5. MCPクライアントから`figma_status`を呼び、`connected: true`を確認します。

初回から自動接続します。セットアップ時のポートと3055・3056・3057を自動で探し、起動中のサーバーすべてに接続します。接続先ポートの手入力やCodex／Claude間の切り替えは不要です。トークンはセットアップ時の値を使用します。未接続のポートは3秒間隔で再接続し、ほかのポートの接続は維持します。「切断」を押すと、全接続とその実行中の自動再接続を停止します。

保存設定はこのPCのプラグイン用ローカル領域に保持し、Figmaファイルへ書き込んだり他のユーザーと同期したりしません。これは暗号化された資格情報保管庫ではありません。`plugin/ui.local.html`にも接続トークンを含むため、`.env`と同様に共有しないでください。両ファイルはGitの対象から除外しています。トークンを変更したら`npm run build`後にプラグインを再起動してください。

接続後に「接続を維持して非表示」を押すと、接続を保ったままプラグインの画面だけ隠せます。非表示中に接続が切れた場合は画面を再表示します。右上の×やFigmaのプラグイン停止操作はプラグインを終了するため、接続も切れます。
非表示にできるのはプラグインの設定画面です。Figma本体の「Local Figma MCPを実行しています」という表示は、プラグインの実行中は残ります。付属プラグインでの常時接続では、この実行中表示も残る制約があります。
接続はサーバー1個につきプラグイン1個です。別のファイルを操作する場合は元のプラグインを停止し、そのファイルでプラグインを実行します。接続済みのサーバーを別のプラグインが奪うことはありません。
同じポートの複数MCPセッションは、最初のプロセスが開いた接続を共有します。そのプロセスが終了するとプラグインは切断されます。残ったセッションで`figma_status`を呼ぶと接続ポートを再確保できるので、プラグインを再接続してください。
`FIGMA_BRIDGE_PORT`を変更した場合はプラグインの接続ポートと`manifest.json`の`devAllowedDomains`も合わせて変更してください。
`devAllowedDomains`には`http://localhost:ポート番号`と、実際の通信に使う`ws://localhost:ポート番号`を指定します。マニフェストを変更した後はプラグインを閉じ、Figmaでマニフェストを再読み込みしてから起動してください。

この環境では以下の別々のポートで登録しています。プラグインが自動検出するため、入力は不要です。

| クライアント | 接続ポート |
| --- | --- |
| Codex | 3055 |
| Claude Code | 3056 |
| Claude Desktop | 3057 |

各クライアントは独立したサーバーを起動し、プラグインは同時に接続します。返信は要求元のサーバーにだけ返し、Figmaの編集命令は共通の待ち行列で順番に実行します。同じノードの同じ設定を両クライアントが変更すると、後から実行した変更が反映されます。操作内容の競合を自動で解決する機能ではありません。

## ツール

| ツール | 用途 |
| --- | --- |
| `figma_status` | プラグインの接続確認 |
| `figma_get_document` | ページ一覧・現在のページの構造 |
| `figma_get_selection` | 選択中のノードの取得 |
| `figma_get_node` | 指定ノードのプロパティ・子ノード取得 |
| `figma_find_nodes` | 名前・種類でページや部分ツリーを検索 |
| `figma_get_fonts` | 使用できるフォントの検索・一覧取得 |
| `figma_get_local_styles` | ローカルの色・文字・効果・グリッドスタイル一覧 |
| `figma_create_page` | ページ作成 |
| `figma_set_current_page` | ページ切り替え |
| `figma_duplicate_node` | 子ノードも含めた複製 |
| `figma_move_node` | 親ノード・ページ間で移動 |
| `figma_import_svg` | SVG文字列を編集可能なノードとして取り込み |
| `figma_group_nodes` | 同じ親のノードをグループ化 |
| `figma_ungroup_node` | グループ解除 |
| `figma_align_nodes` | 左・中央・右・上・上下中央・下へ整列 |
| `figma_create_component` | 既存ノードをコンポーネント化 |
| `figma_create_instance` | ローカルコンポーネントのインスタンス配置 |
| `figma_place_image` | ローカルPNG・JPEGの配置／画像差し替え |
| `figma_set_text_style` | 文字揃え・下線・取り消し線・行間・字間 |
| `figma_set_appearance` | 枠線・影・ぼかしの設定／解除 |
| `figma_distribute_nodes` | 横・縦方向の等間隔配置 |
| `figma_set_gradient` | 線形・円形・角度・菱形グラデーション |
| `figma_reorder_node` | 重なり順の変更 |
| `figma_create_paint_style` | 共通の色スタイル作成 |
| `figma_create_text_style` | 共通の文字スタイル作成 |
| `figma_apply_styles` | 色・文字・効果スタイルを適用 |
| `figma_get_variables` | ローカル変数とモードを取得 |
| `figma_create_variable_collection` | 変数コレクションとモード作成 |
| `figma_create_variable` | 色・数値・文字・真偽値の変数作成 |
| `figma_set_variable` | 変数のモード別値を更新 |
| `figma_bind_variable` | 色・余白・サイズなどへ変数を紐づけ |
| `figma_set_variable_mode` | ノードのライト／ダーク等のモード変更 |
| `figma_set_responsive` | FILL／HUG・制約・最小最大サイズ・配置設定 |
| `figma_combine_variants` | コンポーネントを状態別バリアントへ統合 |
| `figma_get_component_properties` | コンポーネントのプロパティ取得 |
| `figma_set_instance_properties` | インスタンスの文字・表示・状態などを変更 |
| `figma_batch_update` | 複数ノードへ同じプロパティを一括適用 |
| `figma_audit_design` | 余白・文字のクリップ・コントラストを検査 |
| `figma_create_game_screen` | 基準解像度とセーフエリア付き画面を作成 |
| `figma_set_game_anchor` | HUDの四隅・中央・伸縮配置 |
| `figma_build_game_focus` | コントローラー用の上下左右フォーカス経路 |
| `figma_create_game_button` | 通常・選択・押下・無効のボタン状態を作成 |
| `figma_create_hud_bar` | HP・MP・進捗バーを作成 |
| `figma_set_hud_value` | バーの値と塗りの大きさを更新 |
| `figma_set_nine_slice` | 9スライスの境界を設定 |
| `figma_export_game_assets` | 倍率別PNGとゲームUI用JSONをローカル出力 |
| `figma_set_localization_key` | テキストへ翻訳キーを設定 |
| `figma_apply_localization` | 指定翻訳を適用し、固定文字枠の長文はみ出しを測定 |
| `figma_preview_localization` | 元画面を保持して言語別の比較画面を作成 |
| `figma_export_localization` | 翻訳キー・元文字列・競合をJSONへ書き出し |
| `figma_preview_resolutions` | 解像度・アスペクト比別の比較画面を作成 |
| `figma_create_state_sheet` | バリアント状態の比較シートを作成 |
| `figma_create_input_prompt` | キーボード・Xbox・PlayStationの操作案内を作成 |
| `figma_set_input_device` | 操作案内の入力記号を切り替え |
| `figma_create_inventory` | アイテム枠・選択表示・移動経路付きの一覧を作成 |
| `figma_set_inventory_item` | アイテム名と数量を設定／解除 |
| `figma_select_inventory_slot` | 選択枠と初期フォーカスを移動 |
| `figma_create_cooldown` | 円形クールダウンと残秒表示を作成 |
| `figma_set_cooldown` | 円形ゲージと残秒表示を変更 |
| `figma_create_tooltip` | 画面端を考慮した説明パネルを作成 |
| `figma_position_tooltip` | 説明パネルを対象の近くへ再配置 |
| `figma_export_game_atlas` | 素材を1枚のPNGと座標JSONへまとめて書き出し |
| `figma_audit_game_focus` | フォーカス経路の破損・到達不可・無効対象を検査 |
| `figma_export_ui_spec` | UI階層・配置・状態・メタデータをJSONへ書き出し |
| `figma_create_node` | フレーム・長方形・楕円・テキストの作成 |
| `figma_update_node` | 名前・位置・サイズ・色・テキスト・レイアウト更新 |
| `figma_delete_node` | ノード削除。`confirm: true`が必須 |
| `figma_select_nodes` | 同じページのノードを選択・画面に表示 |
| `figma_export_node` | PNGをMCP画像として返す、またはSVG文字列を返す |
| `figma_get_file` | RESTで保存済みファイルを取得 |
| `figma_get_file_nodes` | RESTで指定ノードを取得 |
| `figma_get_image_urls` | RESTで画像の一時ダウンロードURLを取得 |

ノードIDは`12:34`形式です。URLの`node-id=12-34`を使用する場合は`12:34`に置き換えます。
ファイルキーは`https://www.figma.com/design/FILE_KEY/...`の`FILE_KEY`部分です。

### 作成例

```json
{
  "type": "FRAME",
  "properties": {
    "name": "カード",
    "width": 320,
    "height": 180,
    "fill": "#FFFFFF",
    "cornerRadius": 12,
    "layoutMode": "VERTICAL",
    "itemSpacing": 16,
    "paddingTop": 24,
    "paddingLeft": 24
  }
}
```

返却されたIDを`parentId`に指定し、`type: "TEXT"`、`properties: {"characters": "こんにちは", "fontSize": 24, "fill": "#222222"}`でテキストを追加できます。
文字の編集前にフォントを読み込みます。必要に応じて`fontFamily`・`fontStyle`を指定してください。
座標は親ノードを基準とします。オートレイアウト内ではFigmaが子の配置を決定します。
各ノードが対応していないプロパティはエラーを返します。

### 追加ツールの使い方

`figma_find_nodes`に`{"query":"ボタン","types":["FRAME"],"limit":50}`を渡すと、現在のページ内を検索します。`rootId`で別のページや部分ツリーを指定できます。最大20,000ノードまで探索し、取得上限を超えた場合は`truncated: true`を返します。

`figma_get_fonts`は`query`・`offset`・`limit`に対応します。`figma_get_local_styles`は各種類につき先頭200件のIDと名前、および総数を返します。チームライブラリは含みません。

複製・SVG取り込み・インスタンス配置は`parentId`・`name`・`x`・`y`を指定できます。`figma_create_page`はページを作成するだけなので、表示を切り替える場合は返却IDで`figma_set_current_page`を呼んでください。

グループ化と整列は同じ親を持つノードを`nodeIds`で指定します。整列の`alignment`は`LEFT`・`CENTER`・`RIGHT`・`TOP`・`MIDDLE`・`BOTTOM`です。回転ノード、オートレイアウト内、自動サイズ変更されるグループ内での整列はエラーを返します。

`figma_place_image`に画像の絶対パスを`filePath`で指定します。新規配置では画像の自然サイズの長方形を作り、`parentId`・`name`・`x`・`y`・`width`・`height`で配置を調整できます。`nodeId`を指定すると既存ノードの塗りを画像へ置き換えます。`scaleMode`は`FILL`または`FIT`です。最大8 MiBのPNG・JPEGに対応し、画像のデコードと画素数制限はFigmaが検証します。

`figma_set_text_style`の`properties`は、例えば`{"textAlignHorizontal":"CENTER","textDecoration":"UNDERLINE","lineHeight":{"unit":"PERCENT","value":150},"letterSpacing":{"unit":"PIXELS","value":2}}`です。`lineHeight`は`AUTO`・`PIXELS`・`PERCENT`、字間は`PIXELS`・`PERCENT`で指定できます。文字装飾を更新する前にフォントを読み込みます。

`figma_set_appearance`に`stroke: {"color":"#336699","width":2}`で枠線、`effects: [{"type":"DROP_SHADOW","color":"#000000","opacity":0.2,"x":0,"y":4,"radius":8}]`で影を指定します。`INNER_SHADOW`・`LAYER_BLUR`・`BACKGROUND_BLUR`も対応します。`effects`は既存の効果全体を置き換え、空配列で解除します。`stroke: null`で枠線を解除します。

`figma_distribute_nodes`は3個以上の同じ親のノードを指定し、`axis: "HORIZONTAL"`または`"VERTICAL"`、任意の`gap`で等間隔に配置します。`gap`省略時は全体の端を維持して間隔を計算します。オートレイアウトやグループ内・回転ノードは非対応です。

ツール追加後はMCPクライアントとFigmaプラグインを起動し直してください。全72ツールです。同じポートを共有する古いサーバープロセスも終了させてから新しい構成を起動してください。

### 仕上げと一貫性を整えるツール

`figma_set_gradient`に`stops: [{"position":0,"color":"#3758F9"},{"position":1,"color":"#8C54FF"}]`と`angle`を指定します。塗り全体を置き換えます。重なり順は`figma_reorder_node`の`FRONT`・`BACK`・`FORWARD`・`BACKWARD`で変更します。

共通色は`figma_create_paint_style`、共通文字は`figma_create_text_style`で作成します。返却されたIDを`figma_apply_styles`の`fillStyleId`・`textStyleId`へ指定してください。既存の効果スタイルも`effectStyleId`で適用できます。

変数は、まず`figma_create_variable_collection`に`{"name":"Theme","modes":["Light","Dark"]}`を渡し、返却されたコレクションIDとモードIDを使って`figma_create_variable`を呼びます。COLORの値は`{"r":0.2,"g":0.3,"b":0.9,"a":1}`、FLOATは数値、STRINGは文字列、BOOLEANは真偽値です。`values`には`{"modeId":"...","value":...}`を並べます。変数の型とモード所属を検証し、作成失敗時は新規変数・コレクションを削除します。使用できるモード数はFigmaプランに依存します。

`figma_bind_variable`は`field: "fill"`で単一のベタ塗りにCOLOR変数を紐づけます。数値変数は`opacity`・`cornerRadius`・`itemSpacing`・各`padding`・`width`・`height`へ設定できます。`figma_set_variable_mode`は指定ノードのモードを切り替えます。

`figma_set_responsive`の`properties`に`{"layoutSizingHorizontal":"FILL","minWidth":240,"maxWidth":800}`などを指定できます。FILLにはオートレイアウトの親、HUGにはテキストまたはオートレイアウトのフレームが必要です。`constraints`・軸の配置・`clipsContent`にも対応します。

バリアントはコンポーネントを`State=Default`・`State=Hover`などの名前で用意し、`figma_combine_variants`で統合します。既存インスタンスの編集では`figma_get_component_properties`で正確なキーを取得してから`figma_set_instance_properties`へ渡してください。新しいプロパティ定義やプロトタイプのホバー遷移を自動作成する機能ではありません。

`figma_batch_update`は`nodeIds`と既存の`update_node`と同じ`properties`を受け取ります。全ノードの対応プロパティを先に確認します。実行途中のフォント読み込みなどが失敗した場合は`updated`・`failed`・`partial`を返します。トランザクションではないため、成功した変更や失敗ノードの一部変更は残り、FigmaのUndoで戻せます。

`figma_audit_design`は読み取り専用です。`rootId`で範囲、`maxNodes`で上限、`spacingStep`で余白の基準単位を指定できます。問題は`issues`、未判定コントラスト件数は`skippedContrast`、途中打ち切りは`truncated`で確認します。

コントラストは不透明な単色の文字・祖先背景のみを計算し、通常文字4.5、大きい文字3の比率を目安にします。画像・グラデーション・透過・効果・混在フォントは除外し、重なった別ノードは計算しません。文字のクリップは親からのノード境界のはみ出しを検査し、文字枠内部の実際のグリフはみ出しは測りません。小さい文字や余白グリッドの指摘は設計判断が必要なヒューリスティックです。完全なアクセシビリティ認証やプロ品質の保証ではありません。

実際の仕上げでは、監査結果を直した後に`figma_export_node`で画像を確認し、階層・余白・文字量を調整してください。

開発用ソースは`plugin/core.js`と`plugin/features/`配下です。`plugin/code.js`は生成物なので直接編集しないでください。

### ゲームUI向けツール

`figma_create_game_screen`に`{"name":"HUD","width":1920,"height":1080,"insets":{"left":96,"right":96,"top":54,"bottom":54}}`を渡すと、画面フレームと透明な`Safe Area`フレームを作成します。返却される`safeArea.id`をHUD要素の`parentId`に指定してください。セーフエリアは指定値であり、実機のノッチやテレビのオーバースキャンを自動検出するものではありません。

`figma_set_game_anchor`は既存の親フレーム内でノードを配置し、Figmaの制約も設定します。`anchor`は`TOP_LEFT`・`TOP_CENTER`・`TOP_RIGHT`・`CENTER_LEFT`・`CENTER`・`CENTER_RIGHT`・`BOTTOM_LEFT`・`BOTTOM_CENTER`・`BOTTOM_RIGHT`・`STRETCH`です。`marginX`・`marginY`で端からの余白を指定します。親のオートレイアウトや回転ノードは非対応で、親に収まらない配置は拒否します。

`figma_create_game_button`に`{"name":"PlayButton","label":"開始","parentId":"..."}`を渡すと、`State=Default`・`Focused`・`Pressed`・`Disabled`の4コンポーネントをまとめたセットを作成します。選択中は枠線、押下中は暗い背景、無効は透明度で区別します。画面内には既存の`figma_create_instance`でインスタンスを配置し、状態は`figma_set_instance_properties`で変更できます。

同じ親の操作対象を`figma_build_game_focus`の`nodeIds`に渡すと、各対象の上下左右にある近い対象への経路を計算します。`defaultNodeId`で初期選択を指定できます。端での折り返しはなく、相手がない方向は`null`です。非表示・透明度0・既知の無効状態・回転ノードは対象にできません。自動生成した経路は複雑な配置で意図とずれる場合があるため、返却値を確認してください。

`figma_create_hud_bar`に`{"name":"HP","width":320,"height":24,"value":0.75}`を渡すとトラックと塗り付きのバーを作成します。`direction: "VERTICAL"`は下から上に塗るバーです。`figma_set_hud_value`にバーのIDと0〜1の`value`を渡すと、現在のサイズに合わせて塗りを更新します。値0では塗りを非表示にします。これはデザインの状態変更で、ゲームのHPや時間との自動同期ではありません。

`figma_set_nine_slice`に`{"nodeId":"...","borders":{"left":16,"right":16,"top":16,"bottom":16}}`を渡すと、そのノードへ9スライス境界を保存します。単位はFigma上の論理ピクセル、原点は左上です。左右・上下の境界の合計がサイズ以上になる指定は拒否します。ノードのサイズ変更後も、書き出し時に再検証します。

`figma_export_game_assets`の例:

```json
{
  "assets": [{"nodeId":"12:34","name":"panel"}],
  "scales": [1, 2],
  "outputDirectory": "I:/Programming/PF/MCP/Figma/exports"
}
```

`outputDirectory`は任意の絶対パスです。省略時はこのプロジェクトの`exports/`を使用します。毎回新しい`game-ui-...`フォルダーへ`panel@1x.png`・`panel@2x.png`と`manifest.json`を書き、既存ファイルを上書きしません。出力先のパスをMCPの結果として返します。

書き出しはsRGB・ノードのフルサイズ・倍率指定を使用し、1回につき最大8画像／合計8 MiBです。画像名は英数字・ハイフン・アンダースコアのみ、倍率は0.25〜4、ノードは未回転に限定します。大きい素材は分けて書き出してください。

JSONには各PNGの実サイズ、論理サイズ、倍率、倍率に合わせた9スライス境界、元ノードID、セーフエリア・アンカー・フォーカス・HUD状態などのメタデータが含まれます。Unity・Unreal・Godot固有のインポーター設定、入力処理、アニメーション、画面遷移はゲーム側で実装してください。UIの配置と素材の受け渡しを助ける機能であり、エンジン内UIを自動生成する機能ではありません。

### 多言語・解像度・状態の比較

`figma_set_localization_key`に`{"nodeId":"...","key":"menu.play"}`を渡し、`figma_export_localization`でキーと現在の文字列をJSONへ書き出します。同じキーの文字列が一致しない場合は`conflicts`を返します。自動翻訳や翻訳サービスへの送信は行いません。

`figma_preview_localization`の例:

```json
{
  "rootId": "12:34",
  "locale": "de",
  "translations": {"menu.play":"Spiel starten"}
}
```

比較画面は元のフレームを複製し、キー付きテキストに指定した翻訳を適用します。元画面は変更しません。固定文字枠は別のテキスト複製を`HEIGHT`にして必要な高さを測り、`overflow`へ報告します。翻訳不足は`missing`、途中失敗は`failed`・`partial`で確認します。`fontFamily`・`fontStyle`で言語用フォントを指定できます。実フォントの可用性やグリフの対応はFigma実機で確認してください。

`figma_apply_localization`は同じ入力で元画面へ適用します。必要フォントを先に読み込みますが、適用途中の失敗では一部変更が残る場合があります。1回につき最大200テキスト・500翻訳キーに制限しています。

`figma_preview_resolutions`へ`rootId`と`views: [{"name":"16:9","width":1920,"height":1080},{"name":"Ultrawide","width":3440,"height":1440},{"name":"Portrait","width":1080,"height":1920}]`を渡すと、最大4種類の比較画面を並べます。複製内のセーフエリア・アンカー・フォーカス等のIDを付け替え、セーフエリアと保存アンカーを再計算します。収まらないアンカーや品質チェック結果は各`issues`へ返します。Figmaのレイアウト・制約を使う静的な比較であり、ゲームエンジン内の自動リサイズ動作を保証するものではありません。

`figma_create_state_sheet`は`nodeId`にインスタンス、`property`にVARIANTキー（標準は`State`）、`states`に比較する値を指定します。元インスタンスを変更せず、ラベル付き比較シートを作ります。

### 入力記号・インベントリ・円形ゲージ・説明パネル

`figma_create_input_prompt`へ`{"name":"ConfirmHint","action":"CONFIRM","label":"決定","device":"KEYBOARD"}`を渡します。`action`は`CONFIRM`・`CANCEL`・`INTERACT`・`MENU`、`device`は`KEYBOARD`・`XBOX`・`PLAYSTATION`です。`figma_set_input_device`で入力記号を取り替え、説明文は維持します。汎用の文字・図形であり、プラットフォーム公式のライセンス済みアートワークではありません。

`figma_create_inventory`へ`{"name":"Items","rows":4,"columns":6,"slotSize":72,"gap":8}`を渡すと、最大200枠の一覧を作成します。枠番号は0から始まります。`figma_set_inventory_item`の`itemName`・`quantity`で名前と数量を設定し、空の`itemName`で解除します。画像は既存の`figma_place_image`で対象枠へ配置できます。`figma_select_inventory_slot`で選択枠と初期フォーカスを更新します。

`figma_create_cooldown`へ`{"name":"SkillCooldown","size":64,"value":0.75,"innerRadius":0.5,"seconds":8}`を渡すと円形ゲージを作成します。値は0〜1の残量、`innerRadius`は0〜0.95で、0は扇形、0より大きい値はリングです。`figma_set_cooldown`で残量と任意の残秒を更新し、残秒は切り上げ整数で表示します。実際の時間経過との自動同期はゲーム側で実装します。

`figma_create_tooltip`は`parentId`に画面フレーム、`targetId`にその子孫、`text`に説明文を指定します。`preferred`は`ABOVE`・`BELOW`・`LEFT`・`RIGHT`です。希望位置に収まらなければ反転・代替位置を試し、最後に画面内へ制限します。対象が動いたときは`figma_position_tooltip`を呼びます。回転・特殊な変形を含む階層は対象外です。

### アトラス・フォーカス監査・UI仕様JSON

`figma_export_game_atlas`の例:

```json
{
  "assets": [{"nodeId":"12:34","name":"panel"},{"nodeId":"12:35","name":"icon"}],
  "name": "hud-atlas",
  "scale": 2,
  "maxWidth": 1024,
  "maxHeight": 2048,
  "padding": 2,
  "powerOfTwo": true
}
```

最大32素材を高さ順の行配置でパックし、1枚のPNGと`manifest.json`の`sprite`座標情報（`sprites`配列）へ書き出します。座標と9スライス境界の原点は左上、単位は出力画像のピクセルです。`powerOfTwo`は縦横を2の累乗にします。元ノードは保持し、一時フレーム・複製は成功／失敗ともに削除します。余白は透明で、外側の影などは素材の論理境界でクリップします。エッジの色の引き伸ばし、ミップマップ、エンジンインポートは含みません。最大4096ピクセル／8 MiB／素材内合計4000ノードです。

`figma_audit_game_focus`は保存済みの経路を読み取り、初期対象、存在しない・無効な対象、不正リンク、自己リンク、到達不可、逆方向が対応しないリンクを報告します。逆方向の非対称は意図的な場合もあるため、結果を確認して判断してください。

`figma_export_ui_spec`へ`rootId`を指定すると、UIの階層・親相対座標・サイズ・文字・スタイルID・ゲームメタデータを`ui-spec.json`へ書き出します。`figma_export_localization`も同様に、ローカルの新しいフォルダーへJSONを保存して`filePath`を返します。`outputDirectory`の指定方法は他のゲーム書き出しと同じです。

取得・比較・JSON書き出しは`maxNodes`で範囲を制限します。上限を超えた場合は途中データを完成品として返さず、エラーを返します。これらの機能はデザイン・検証・素材受け渡しまでで、実行時のゲームUIやコードは生成しません。

## REST APIを使う場合

FigmaのPersonal Access Tokenを`file_content:read`スコープ付きで発行し、`.env`の`FIGMA_ACCESS_TOKEN`へ設定します。
MCPサーバーを再起動して反映してください。APIの403は権限・スコープ・有効期限、429は利用制限を確認します。
429は待機時間を返し、自動再試行はしません。

## 制限と注意点

- 開発プラグインとして利用します。Community公開・OAuth・任意JavaScript実行は含めていません。
- ファイルとページ全体の削除は非対応です。編集操作はUndo履歴へ記録します。
- 作成に失敗した新規ノードは削除します。既存ノードの更新途中でFigma APIが失敗すると、一部の変更が残る場合があります。状態を確認し、必要ならFigmaでUndoしてください。
- タイムアウトは30秒です。タイムアウト・切断後でもFigma側で操作が完了することがあります。作成・削除を再試行する前にドキュメントを確認してください。
- 取得は深さ0〜5・最大1000ノード、PNGは8 MiBまでです。大きいファイルでは取得範囲や書き出し倍率を下げてください。
- ローカル接続は`127.0.0.1`に限定し、接続トークンで認証します。リモートHTTPは`MCP_HTTP_TOKEN`で認証し、既定では`127.0.0.1`で待ち受けます。トークンを知るMCPクライアントは接続先ファイルを編集できます。
- `.env`・`mcp.local.json`・`mcp.remote.json`はGit管理対象外です。`.env`を共有しないでください。

## テスト

```powershell
npm test
```

実際のstdio接続、MCPツール入力検証、認証付きWebSocket、プラグインの作成・編集・選択・削除・書き出し、切断・タイムアウト、RESTエラー、リモートHTTP接続の認証・ホスト制限をテストします。
Figma Plugin APIはテスト用モックです。Figma実機でのプラグイン読み込み・フォント・描画・Undoは別途確認が必要です。

## 参照

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)
- [Figma Plugin API](https://developers.figma.com/docs/plugins/api/figma/)
- [Figmaプラグインのマニフェスト](https://developers.figma.com/docs/plugins/manifest/)
- [Figma RESTファイルAPI](https://developers.figma.com/docs/rest-api/file-endpoints/)
