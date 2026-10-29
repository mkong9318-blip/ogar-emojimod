# 表情模組

讓細胞在遊戲裡發表情的獨立模組，Canvas2D 或 WebGL 的客戶端都能用，附一個可以直接預覽、調整動畫參數的測試頁。

## 試用

用瀏覽器直接打開 `test.html` 就能玩，不需要架伺服器。

| 操作 | 按鍵 |
| --- | --- |
| 移動 | 滑鼠 |
| 分裂 | 空白鍵 |
| 表情面板 | `` ` `` |
| 快捷表情 | `1` ~ `0`（面板裡前 10 個） |
| 縮放 | 滾輪 |

面板裡左鍵發送、右鍵釘選（釘選的排最前面）。右側可以調動畫時間、彈出曲線、大小、翻轉等參數，調好後按「複製設定 JSON」。

## 檔案

- `emotes.js`：模組本體，全域只有 `window.EmoteModule`
- `test.html`：測試頁
- `emotes/`：內建表情圖（`1.png` ~ `47.png`）

## 用法

```js
const emotes = EmoteModule.create({
  baseUrl: './emotes/',
  host: {
    getMyCellIds: () => [...],      // 自己的細胞 id
    isMine: id => ...,              // 收到別人的表情時跳過自己的細胞
    isFacingLeft: () => ...,        // 滑鼠在畫面左半 → 表情翻轉
    send: bytes => ws.send(bytes),  // 送封包給伺服器
  },
});
```

畫法二選一：

- **A. 直接畫在遊戲畫布**（Canvas2D）：每畫完一顆細胞呼叫 `emotes.drawOnCell(ctx, id, x, y, r, isMine)`，回傳值是名字該用的透明度。
- **B. 疊一層透明畫布**（WebGL）：`const ov = emotes.createOverlay(gameCanvas)`，每幀呼叫 `ov.draw([{ id, x, y, r, isMine }])`，座標用畫布像素。

收到伺服器的表情封包時呼叫 `emotes.handleServerPacket(bytes)`。

## 封包格式

little-endian，字串是 UTF-8 加 0 結尾。

| 方向 | 內容 |
| --- | --- |
| 客戶端 → 伺服器 | `u8 100` │ 表情字串 |
| 伺服器 → 客戶端 | `u8 100` │ `u32 細胞id` │ 表情字串 |

伺服器收到後，對發送者的每一顆細胞各轉發一包給看得到它的玩家。

表情字串：`12` 是內建第 12 張，`imgur:圖片ID` 是 Imgur 圖片，前面加 `F:` 表示朝左（要翻轉）。別人傳來的表情只接受內建編號和 Imgur，避免被塞任意網址。
