/*!
 * emotes.js — 細胞表情模組 v1.0
 * 獨立的表情模組，不依賴任何客戶端的變數。
 * Canvas2D 或 WebGL 的客戶端都能掛。
 *
 * ── 建立 ──────────────────────────────────────────────
 *   const emotes = EmoteModule.create({
 *     baseUrl: './emotes/',          // 內建表情圖（1.png ~ 47.png）的資料夾
 *     host: {                         // 宿主客戶端要接的地方，全部可省略
 *       getMyCellIds() {},            // 自己（雙開時=操作中那隻）的細胞 id 陣列
 *       isMine(id) {},                // 收到伺服器表情時，自己的細胞跳過（本地已經先顯示）
 *       isFacingLeft() {},            // 滑鼠在畫面左半 → 表情左右翻轉
 *       send(bytes) {},               // 把 Uint8Array 送給伺服器
 *       canUseHotkeys(e) {},          // 回傳 false 就不吃熱鍵（例如選單開著）
 *     },
 *   });
 *
 * ── 畫法（二選一）──────────────────────────────────────
 *   A. 宿主自己用 Canvas2D 畫細胞：畫完細胞本體後
 *        const nameAlpha = emotes.drawOnCell(ctx, id, x, y, r, isMine);
 *      再畫名字/質量時把透明度乘上 nameAlpha（表情出現時名字淡出）。
 *   B. 宿主是 WebGL，或改不到畫細胞的程式：疊一層透明畫布
 *        const ov = emotes.createOverlay(gameCanvas);
 *        每幀：ov.draw([{ id, x, y, r, isMine }]);   // x, y, r 用遊戲畫布的像素座標
 *
 * ── 收發 ──────────────────────────────────────────────
 *   emotes.send('12')                    // 自己發表情（套用冷卻、本地顯示、送封包）
 *   emotes.handleServerPacket(bytes)     // 收到 opcode 100 的整包
 *   emotes.receive(cellId, '12')         // 或宿主自己解完封包後交給模組
 *
 * ── 封包格式（little-endian，字串 = UTF-8 + 0 結尾）────────────
 *   客戶端 → 伺服器：u8 100 │ string 表情
 *   伺服器 → 客戶端：u8 100 │ u32 細胞id │ string 表情
 *     （伺服器收到後，對發送者的每一顆細胞各轉發一包給看得到它的其他玩家）
 *   表情字串：'12' = 內建 12.png；'imgur:AbC123x' = Imgur 圖片；前面加 'F:' = 朝左（要翻轉）
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.EmoteModule = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const OPCODE = 100;
    const MAX_EMOTE_BYTES = 200;
    const FLIP_PREFIX = 'F:';

    // 動畫參數（測試頁的滑桿都對應這裡）
    const DEFAULT_ANIM = Object.freeze({
        popMs: 200,          // 彈出時間
        holdMs: 1600,        // 停留時間
        fadeMs: 200,         // 淡出時間
        curve: 'classic',    // 彈出曲線：classic(經典) / smooth / linear / none
        overshoot: 1.3,      // 彈出時最大放大倍率
        size: 1,             // 表情直徑 ÷ 細胞直徑
        fit: 'cover',        // 圖片填法：cover(填滿裁切) / contain(完整顯示) / stretch(拉伸成正方形)
        clip: true,          // 裁成圓形
        flip: true,          // 朝左時左右翻轉
        flipMineLive: true,  // 自己的細胞跟著滑鼠即時翻轉（別人的用封包帶的方向）
        fadeName: true,      // 表情出現時名字/質量淡出
        shrinkOnFade: false, // 消失時一起縮小
        stack: false,        // 連發時疊加；false = 新的取代舊的
    });

    // 經典樣式（測試頁「經典樣式」按鈕用）：拉伸填法 + 連發疊加
    const LEGACY_ANIM = Object.freeze(Object.assign({}, DEFAULT_ANIM, { fit: 'stretch', stack: true }));

    const DEFAULT_SLOTS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];

    // ─────────────────────────── 純函式：時間軸 ───────────────────────────

    function popScale(p, a) {
        const os = Math.max(1, +a.overshoot || 1);
        switch (a.curve) {
            case 'none': return 1;
            case 'linear': return p;
            case 'smooth': {
                // 前 70% 減速長到 os，後 30% 平滑回到 1
                if (os <= 1.0001) return 1 - Math.pow(1 - p, 3);
                const k = 0.7;
                if (p < k) { const q = p / k; return os * (1 - Math.pow(1 - q, 3)); }
                const q = (p - k) / (1 - k);
                return os + (1 - os) * (0.5 - 0.5 * Math.cos(Math.PI * q));
            }
            default: {
                // classic：經典公式（sin 長到接近 os，最後 25% 線性收回 1）
                let s = Math.sin(p * Math.PI / 2) * os;
                if (s > 1 && p > 0.75) s = 1 + (1 - p) / 0.25 * (os - 1);
                return s;
            }
        }
    }

    /** 經過 t 毫秒時的狀態；結束了回傳 null。name = 名字該有的透明度 */
    function sample(t, a) {
        const pop = Math.max(0, +a.popMs || 0);
        const hold = Math.max(0, +a.holdMs || 0);
        const fade = Math.max(0, +a.fadeMs || 0);
        if (t < 0) t = 0;
        if (t >= pop + hold + fade) return null;
        let scale, alpha, name;
        if (t < pop) {
            const p = t / pop;
            scale = popScale(p, a); alpha = p; name = 1 - p;
        } else if (t < pop + hold) {
            scale = 1; alpha = 1; name = 0;
        } else {
            const p = (t - pop - hold) / fade;
            scale = a.shrinkOnFade ? 1 - p * p : 1; alpha = 1 - p; name = p;
        }
        if (!a.fadeName) name = 1;
        return { scale: scale, alpha: alpha, name: name };
    }

    // ─────────────────────────── 純函式：封包 ───────────────────────────

    const te = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const td = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;

    function utf8(str) {
        if (te) return te.encode(str);
        const s = unescape(encodeURIComponent(str));
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
    }

    function readString(u8, at) {
        let end = at;
        while (end < u8.length && u8[end] !== 0) end++;
        const bytes = u8.subarray(at, end);
        let str;
        if (td) str = td.decode(bytes);
        else { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); try { str = decodeURIComponent(escape(s)); } catch (e) { str = s; } }
        return { str: str, next: end + 1, terminated: end < u8.length };
    }

    function toU8(data, offset) {
        offset = offset || 0;
        if (data instanceof Uint8Array) return offset ? data.subarray(offset) : data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data, offset);
        if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset + offset, data.byteLength - offset);
        return null;
    }

    const protocol = {
        OPCODE: OPCODE,
        /** 客戶端 → 伺服器 */
        encodeClient(emoteStr) {
            const s = utf8(String(emoteStr)).subarray(0, MAX_EMOTE_BYTES);
            const out = new Uint8Array(s.length + 2);
            out[0] = OPCODE; out.set(s, 1); out[out.length - 1] = 0;
            return out;
        },
        decodeClient(data, offset) {
            const u8 = toU8(data, offset);
            if (!u8 || u8.length < 2 || u8[0] !== OPCODE) return null;
            return { emote: readString(u8, 1).str };
        },
        /** 伺服器 → 客戶端（測試頁用來模擬伺服器轉發） */
        encodeServer(cellId, emoteStr) {
            const s = utf8(String(emoteStr)).subarray(0, MAX_EMOTE_BYTES);
            const out = new Uint8Array(s.length + 6);
            out[0] = OPCODE;
            new DataView(out.buffer).setUint32(1, cellId >>> 0, true);
            out.set(s, 5); out[out.length - 1] = 0;
            return out;
        },
        decodeServer(data, offset) {
            const u8 = toU8(data, offset);
            if (!u8 || u8.length < 6 || u8[0] !== OPCODE) return null;
            const cellId = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(1, true);
            return { cellId: cellId, emote: readString(u8, 5).str };
        },
        hex(bytes) {
            return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');
        },
    };

    // ─────────────────────────── 表情字串 ───────────────────────────

    const RE_BUILTIN = /^\d{1,4}$/;
    const RE_IMGUR_ID = /^imgur:[A-Za-z0-9]{5,12}$/;
    const RE_URL = /^https:\/\/[^\s"'<>\\]{1,300}$/i;

    function parseEmoteStr(str) {
        str = String(str == null ? '' : str);
        let flipped = false;
        if (str.startsWith(FLIP_PREFIX)) { flipped = true; str = str.slice(FLIP_PREFIX.length); }
        return { id: str, flipped: flipped };
    }

    /** 把使用者貼的東西變成表情 id；回傳 { id } 或 { error } */
    function normalizeInput(raw, allowUrls) {
        const v = String(raw || '').trim();
        if (!v) return { error: '請貼上圖片網址' };
        if (RE_IMGUR_ID.test(v)) return { id: v };
        if (/imgur\.com\/(a|gallery)\//i.test(v)) return { error: '這是相簿網址，請在圖片上按右鍵「複製圖片網址」（i.imgur.com/xxxx.png）' };
        const m = v.match(/^(?:https?:\/\/)?(?:i\.|m\.)?imgur\.com\/([A-Za-z0-9]{5,12})(?:\.[A-Za-z0-9]{2,5})?(?:[?#].*)?$/i);
        if (m) return { id: 'imgur:' + m[1] };
        if (allowUrls && RE_URL.test(v)) return { id: v };
        return { error: allowUrls ? '只支援 Imgur 或 https 圖片網址' : '只支援 Imgur 圖片網址' };
    }

    // ─────────────────────────── 樣式 ───────────────────────────

    const CSS = `
.emo-panel{--emo-bg:rgba(13,19,42,.94);--emo-glass:rgba(148,168,255,.06);--emo-glass2:rgba(148,168,255,.14);--emo-line:rgba(148,168,255,.2);--emo-text:#e8ecf8;--emo-sub:#9aa6c8;--emo-dim:#5f6b8f;--emo-title:#c7d2fe;--emo-accent:#7aa2ff;--emo-accent2:#b48cff;
position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:560px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;
background:var(--emo-bg);border:1px solid var(--emo-line);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.55);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
color:var(--emo-text);font:14px/1.45 "Noto Sans TC",Ubuntu,system-ui,sans-serif;padding:14px 16px 12px;z-index:10000;user-select:none;text-align:left}
.emo-panel[hidden]{display:none}
.emo-panel *{box-sizing:border-box}
.emo-head{display:flex;align-items:center;gap:10px;margin:0 0 4px}
.emo-title{font-weight:700;font-size:16px;color:var(--emo-title)}
.emo-hint{font-size:12px;color:var(--emo-sub)}
.emo-panel .emo-x{margin-left:auto;width:30px;height:30px;border-radius:8px;border:0;background:transparent;color:var(--emo-sub);font:16px/1 sans-serif;cursor:pointer}
.emo-panel .emo-x:hover{background:var(--emo-glass2);color:#fff}
.emo-tip{font-size:12px;color:var(--emo-sub);margin:0 0 10px}
.emo-grid{display:grid;grid-template-columns:repeat(var(--emo-cols,6),minmax(0,1fr));gap:8px}
.emo-item{position:relative;aspect-ratio:1;border-radius:10px;background:var(--emo-glass);border:1px solid var(--emo-line);cursor:pointer;display:flex;align-items:center;justify-content:center;overflow:hidden;transition:transform .15s,background .15s,border-color .15s}
.emo-item:hover{transform:scale(1.08);background:var(--emo-glass2);border-color:var(--emo-accent);z-index:1}
.emo-item.pinned{border-color:rgba(180,140,255,.65);background:rgba(180,140,255,.1)}
.emo-item.empty{visibility:hidden}
.emo-item img{width:84%;height:84%;object-fit:contain;pointer-events:none;-webkit-user-drag:none}
.emo-item.broken img{display:none}
.emo-item.broken::after{content:'✕';color:var(--emo-dim);font-size:20px}
.emo-key{position:absolute;top:2px;left:5px;font-size:11px;font-weight:700;color:#fff;text-shadow:0 1px 2px #000,0 0 4px #000;z-index:2}
.emo-pin{position:absolute;top:1px;right:4px;font-size:11px;z-index:2}
.emo-panel .emo-del{position:absolute;right:3px;bottom:3px;width:22px;height:22px;border-radius:6px;border:0;background:rgba(0,0,0,.55);color:#fca5a5;font-size:12px;line-height:22px;padding:0;cursor:pointer;display:none;z-index:3}
.emo-item:hover .emo-del{display:block}
.emo-panel .emo-del:hover{background:#b91c1c;color:#fff}
.emo-pager{display:flex;justify-content:center;align-items:center;gap:14px;margin:12px 0 2px}
.emo-page{font-weight:700;color:var(--emo-title);min-width:52px;text-align:center}
.emo-panel .emo-btn{appearance:none;border:1px solid var(--emo-line);background:var(--emo-glass);color:var(--emo-text);border-radius:8px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer;line-height:1.3}
.emo-panel .emo-btn:hover:not(:disabled){background:var(--emo-glass2);border-color:var(--emo-accent)}
.emo-panel .emo-btn:disabled{opacity:.35;cursor:default}
.emo-panel .emo-btn.primary{background:linear-gradient(90deg,#7aa2ff,#b48cff);color:#0b1026;border:0;font-weight:700}
.emo-add{display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--emo-line)}
.emo-panel .emo-input{flex:1;min-width:0;height:auto;background:rgba(0,0,0,.28);border:1px solid var(--emo-line);border-radius:8px;color:var(--emo-text);padding:7px 10px;font:inherit;font-size:13px;outline:none;box-shadow:none;margin:0}
.emo-panel .emo-input:focus{border-color:var(--emo-accent)}
.emo-panel .emo-input::placeholder{color:var(--emo-dim)}
.emo-msg{min-height:18px;font-size:12px;color:var(--emo-sub);margin-top:6px}
.emo-msg.err{color:#fca5a5}
.emo-msg.ok{color:#6ee7d8}
`;

    function injectCss() {
        if (typeof document === 'undefined' || document.getElementById('emo-style')) return;
        const st = document.createElement('style');
        st.id = 'emo-style';
        st.textContent = CSS;
        (document.head || document.documentElement).appendChild(st);
    }

    function isTypingTarget(el) {
        if (!el || el === document.body) return false;
        if (el.isContentEditable) return true;
        const tag = el.tagName;
        if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (tag === 'INPUT') return !/^(range|checkbox|radio|button|submit|reset|color|file|image)$/i.test(el.type || '');
        return false;
    }

    function keyLabel(code) {
        return String(code || '').replace(/^Digit|^Numpad|^Key/, '');
    }

    function safeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
    function safeSet(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* 私密模式等 */ } }

    // ─────────────────────────── 主體 ───────────────────────────

    function create(opts) {
        opts = opts || {};
        const host = opts.host || {};
        const cfg = {
            baseUrl: opts.baseUrl != null ? opts.baseUrl : './emotes/',
            builtinCount: opts.builtinCount != null ? opts.builtinCount : 47,
            storageKey: opts.storageKey || 'emoteLibrary',
            perPage: opts.perPage || 36,
            columns: opts.columns || 6,
            cooldownMs: opts.cooldownMs != null ? opts.cooldownMs : 500,
            bakeSize: opts.bakeSize != null ? opts.bakeSize : 256,
            allowUrls: !!opts.allowUrls,
            closeOnSend: opts.closeOnSend !== false,
            loadTimeoutMs: opts.loadTimeoutMs || 1500,
            hotkeys: Object.assign({ panel: 'Backquote', slots: DEFAULT_SLOTS, numpad: true, enabled: true }, opts.hotkeys || {}),
        };
        const anim = Object.assign({}, DEFAULT_ANIM, opts.anim || {});
        const now = typeof opts.now === 'function' ? opts.now : () => performance.now();

        // ── 事件 ──
        const listeners = {};
        function on(type, fn) { (listeners[type] = listeners[type] || []).push(fn); return () => off(type, fn); }
        function off(type, fn) { const l = listeners[type]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }
        function emit(type, data) { const l = listeners[type]; if (l) for (const fn of l.slice()) { try { fn(data); } catch (e) { console.error('[EmoteModule]', e); } } }

        // ── 表情庫（內建 + 自訂 + 釘選）──
        const builtins = Array.from({ length: cfg.builtinCount }, (_, i) => String(i + 1));
        let lib = { custom: [], pinned: [] };

        function isBuiltin(id) { return RE_BUILTIN.test(id) && +id >= 1 && +id <= cfg.builtinCount; }
        function isCustom(id) { return lib.custom.indexOf(id) >= 0; }
        /** 別人傳來的表情只接受：內建編號、Imgur（避免被塞任意網址拿來追蹤 IP） */
        function isAllowedRemote(id) {
            if (!id || id.length > MAX_EMOTE_BYTES) return false;
            if (RE_BUILTIN.test(id) || RE_IMGUR_ID.test(id)) return true;
            return cfg.allowUrls && RE_URL.test(id);
        }

        function loadLib() {
            const raw = safeGet(cfg.storageKey);
            if (raw) {
                try {
                    const o = JSON.parse(raw);
                    lib.custom = Array.isArray(o.custom) ? o.custom.filter(x => typeof x === 'string' && isAllowedRemote(x) && !isBuiltin(x)) : [];
                    lib.pinned = Array.isArray(o.pinned) ? o.pinned.filter(x => typeof x === 'string') : [];
                } catch (e) { /* 壞掉就用空的 */ }
            }
            lib.custom = Array.from(new Set(lib.custom));
            const all = new Set(builtins.concat(lib.custom));
            lib.pinned = Array.from(new Set(lib.pinned)).filter(x => all.has(x));
        }
        function saveLib() { safeSet(cfg.storageKey, JSON.stringify({ v: 1, custom: lib.custom, pinned: lib.pinned })); }

        /** 排序後的全部表情：釘選的（照釘選順序）在前，前 10 個對應數字鍵 */
        function list() {
            const pinned = lib.pinned.slice();
            const pinSet = new Set(pinned);
            return pinned.concat(builtins.filter(x => !pinSet.has(x)), lib.custom.filter(x => !pinSet.has(x)));
        }
        function togglePin(id) {
            const i = lib.pinned.indexOf(id);
            if (i >= 0) lib.pinned.splice(i, 1); else lib.pinned.push(id);
            saveLib(); emit('change', { type: 'pin', id: id, pinned: i < 0 }); renderGrid();
        }
        function removeCustom(id) {
            const i = lib.custom.indexOf(id);
            if (i < 0) return false;
            lib.custom.splice(i, 1);
            const p = lib.pinned.indexOf(id); if (p >= 0) lib.pinned.splice(p, 1);
            saveLib(); emit('change', { type: 'remove', id: id }); renderGrid();
            return true;
        }
        /** 新增自訂表情：先試載圖片，載得到才加。回傳 Promise<{ok, id, error}> */
        function addCustom(raw) {
            const n = normalizeInput(raw, cfg.allowUrls);
            if (n.error) return Promise.resolve({ ok: false, error: n.error });
            const id = n.id;
            if (isBuiltin(id) || isCustom(id)) return Promise.resolve({ ok: false, id: id, error: '已經有這個表情了' });
            return new Promise(resolve => {
                const e = getImage(id);
                const done = () => {
                    if (e.state === 'ok') {
                        lib.custom.push(id); saveLib(); emit('change', { type: 'add', id: id }); renderGrid(true);
                        resolve({ ok: true, id: id });
                    } else {
                        images.delete(id);
                        resolve({ ok: false, id: id, error: '圖片載不到（網址錯誤或圖片已被刪）' });
                    }
                };
                if (e.state !== 'loading') done(); else e.waiters.push(done);
            });
        }

        // ── 圖片快取（載入後縮成 bakeSize，畫的時候比較省）──
        const images = new Map(); // id -> { state, img, src, w, h, waiters }

        function urlOf(id) {
            if (id.startsWith('imgur:')) return 'https://i.imgur.com/' + id.slice(6) + '.png';
            if (/^https?:\/\//i.test(id) || id.startsWith('data:')) return id;
            return cfg.baseUrl + encodeURIComponent(id) + '.png';
        }
        function setImgAttrs(img, url) {
            // 只有遠端圖片要 CORS（WebGL 宿主上傳貼圖需要）；本機/同網域不加，file:// 開測試頁才載得到
            if (/^https?:\/\//i.test(url) && (typeof location === 'undefined' || !url.startsWith(location.origin + '/'))) img.crossOrigin = 'anonymous';
            img.referrerPolicy = 'no-referrer';
            img.decoding = 'async';
            img.src = url;
        }
        function bake(img) {
            const w = img.naturalWidth, h = img.naturalHeight;
            const max = Math.max(w, h);
            if (!cfg.bakeSize || max <= cfg.bakeSize || typeof document === 'undefined') return { src: img, w: w, h: h };
            const k = cfg.bakeSize / max;
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
            const g = c.getContext('2d');
            g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
            g.drawImage(img, 0, 0, c.width, c.height);
            return { src: c, w: c.width, h: c.height };
        }
        function getImage(id) {
            let e = images.get(id);
            if (e) return e;
            const img = new Image();
            e = { state: 'loading', img: img, src: null, w: 0, h: 0, waiters: [] };
            images.set(id, e);
            img.onload = () => {
                if (!img.naturalWidth) { img.onerror(); return; }
                const b = bake(img);
                e.src = b.src; e.w = b.w; e.h = b.h; e.state = 'ok';
                const w = e.waiters; e.waiters = []; w.forEach(f => f());
            };
            img.onerror = () => {
                e.state = 'error';
                const w = e.waiters; e.waiters = []; w.forEach(f => f());
            };
            setImgAttrs(img, urlOf(id));
            return e;
        }
        function reloadImages() { images.clear(); }
        function preloadBuiltins() { builtins.forEach(getImage); }

        // ── 正在播的表情 ──
        const active = new Map(); // cellId -> [{ id, flipped, created, t0, nameCap, alphaFloor }]
        let lastPrune = 0;

        function entryState(en, t) {
            if (en.t0 == null) return null;
            return sample(t - en.t0, anim);
        }

        /** 讓某顆細胞顯示表情（不送封包） */
        function show(cellId, emoteStr, meta) {
            const p = parseEmoteStr(emoteStr);
            const remote = !!(meta && meta.remote);
            if (remote ? !isAllowedRemote(p.id) : !(isAllowedRemote(p.id) || isCustom(p.id))) return false;
            const t = now();
            const img = getImage(p.id);
            const en = { id: p.id, flipped: p.flipped, created: t, t0: img.state === 'ok' ? t : null, nameCap: 1, alphaFloor: 0 };
            let arr = active.get(cellId);
            if (arr && arr.length && !anim.stack) {
                // 取代舊的：名字不要閃回來、表情不要先消失再長出來
                let cap = 1, floor = 0;
                for (const old of arr) {
                    const s = entryState(old, t);
                    if (s) { cap = Math.min(cap, s.name); floor = Math.max(floor, s.alpha); }
                }
                en.nameCap = cap; en.alphaFloor = floor;
                arr = null;
            }
            if (!arr) { arr = []; active.set(cellId, arr); }
            arr.push(en);
            emit('show', { cellId: cellId, emote: p.id, flipped: p.flipped, remote: remote });
            return true;
        }

        function clear(cellId) { if (cellId == null) active.clear(); else active.delete(cellId); }
        function has(cellId) { return active.has(cellId); }

        function prune(t) {
            const total = anim.popMs + anim.holdMs + anim.fadeMs;
            for (const [cid, arr] of active) {
                for (let i = arr.length - 1; i >= 0; i--) {
                    const en = arr[i];
                    if (en.t0 == null) {
                        const st = images.get(en.id);
                        if (st && st.state === 'ok') en.t0 = t;
                        else if ((st && st.state === 'error') || t - en.created > cfg.loadTimeoutMs) arr.splice(i, 1);
                    } else if (t - en.t0 >= total) arr.splice(i, 1);
                }
                if (!arr.length) active.delete(cid);
            }
        }
        function maybePrune(t) { if (t - lastPrune > 250 || t < lastPrune) { lastPrune = t; prune(t); } }

        /** 名字該用的透明度（沒表情 = 1） */
        function nameAlpha(cellId) {
            const arr = active.get(cellId);
            if (!arr) return 1;
            const t = now();
            let a = 1;
            for (const en of arr) {
                const s = entryState(en, t);
                if (s) a = Math.min(a, en.nameCap < 1 && t - en.t0 < anim.popMs ? Math.min(s.name, en.nameCap) : s.name);
            }
            return a;
        }

        function drawImageFit(ctx, src, w, h, R) {
            const d = R * 2;
            if (anim.fit === 'stretch') ctx.drawImage(src, -R, -R, d, d);
            else if (anim.fit === 'contain') {
                const k = d / Math.max(w, h), dw = w * k, dh = h * k;
                ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
            } else {
                const s = Math.min(w, h);
                ctx.drawImage(src, (w - s) / 2, (h - s) / 2, s, s, -R, -R, d, d);
            }
        }

        /**
         * 在 (x, y) 半徑 r 的細胞上畫表情。座標系統跟宿主畫細胞的一樣就好（世界座標或螢幕座標都行）。
         * 回傳名字該用的透明度。
         */
        function drawOnCell(ctx, cellId, x, y, r, isMine) {
            const arr = active.get(cellId);
            if (!arr) return 1;
            const t = now();
            maybePrune(t);
            let nameA = 1;
            let liveLeft = null;
            for (const en of arr) {
                if (en.t0 == null) {
                    const st = images.get(en.id);
                    if (st && st.state === 'ok') en.t0 = t; else continue;
                }
                const s = sample(t - en.t0, anim);
                if (!s) continue;
                const inPop = t - en.t0 < anim.popMs;
                nameA = Math.min(nameA, inPop && en.nameCap < 1 ? Math.min(s.name, en.nameCap) : s.name);
                const alpha = inPop ? Math.max(s.alpha, en.alphaFloor) : s.alpha;
                if (alpha <= 0.003 || s.scale <= 0.001) continue;
                const img = images.get(en.id);
                if (!img || img.state !== 'ok') continue;

                let flip = false;
                if (anim.flip) {
                    if (isMine && anim.flipMineLive && host.isFacingLeft) {
                        if (liveLeft === null) liveLeft = !!host.isFacingLeft();
                        flip = liveLeft;
                    } else flip = en.flipped;
                }
                const R = r * anim.size;
                ctx.save();
                ctx.globalAlpha *= alpha;
                ctx.translate(x, y);
                ctx.scale(flip ? -s.scale : s.scale, s.scale);
                if (anim.clip) { ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.clip(); }
                drawImageFit(ctx, img.src, img.w, img.h, R);
                ctx.restore();
            }
            return nameA;
        }

        // ── 疊加畫布（給 WebGL / 改不到畫細胞程式的宿主）──
        function createOverlay(target, o) {
            o = o || {};
            const c = document.createElement('canvas');
            c.className = 'emo-overlay';
            c.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;';
            const z = o.zIndex != null ? String(o.zIndex) : getComputedStyle(target).zIndex;
            if (z && z !== 'auto') c.style.zIndex = z;
            (o.parent || target.parentNode).insertBefore(c, o.parent ? null : target.nextSibling);
            const g = c.getContext('2d');
            let key = '', dirty = true;
            function sync() {
                const r = target.getBoundingClientRect();
                const k = r.left + ',' + r.top + ',' + r.width + ',' + r.height + ',' + target.width + ',' + target.height;
                if (k === key) return;
                key = k;
                c.style.left = r.left + 'px'; c.style.top = r.top + 'px';
                c.style.width = r.width + 'px'; c.style.height = r.height + 'px';
                c.width = target.width || 1; c.height = target.height || 1;
                dirty = true;
            }
            return {
                canvas: c,
                /** cells: [{ id, x, y, r, isMine }]，座標 = 遊戲畫布像素 */
                draw(cells) {
                    sync();
                    if (!active.size) { if (dirty) { g.clearRect(0, 0, c.width, c.height); dirty = false; } return; }
                    g.setTransform(1, 0, 0, 1, 0, 0);
                    g.clearRect(0, 0, c.width, c.height);
                    dirty = true;
                    for (const cell of cells) if (active.has(cell.id)) drawOnCell(g, cell.id, cell.x, cell.y, cell.r, cell.isMine);
                },
                clear() { g.clearRect(0, 0, c.width, c.height); dirty = false; },
                show(v) { c.style.display = v === false ? 'none' : ''; },
                destroy() { c.remove(); },
            };
        }

        // ── 發送 / 接收 ──
        let lastSend = -Infinity;

        /** 自己發表情。回傳 false = 冷卻中或表情不存在 */
        function send(emoteId) {
            const t = performance.now();
            if (t - lastSend < cfg.cooldownMs) { emit('blocked', { reason: 'cooldown', emote: emoteId, waitMs: cfg.cooldownMs - (t - lastSend) }); return false; }
            if (!(isBuiltin(emoteId) || isCustom(emoteId) || isAllowedRemote(emoteId))) { emit('blocked', { reason: 'invalid', emote: emoteId }); return false; }
            lastSend = t;
            const flipped = !!(host.isFacingLeft && host.isFacingLeft());
            const str = (flipped ? FLIP_PREFIX : '') + emoteId;
            const ids = (host.getMyCellIds && host.getMyCellIds()) || [];
            for (const id of ids) show(id, str);
            const bytes = protocol.encodeClient(str);
            if (host.send) { try { host.send(bytes); } catch (e) { console.warn('[EmoteModule] send 失敗', e); } }
            emit('send', { emote: emoteId, str: str, flipped: flipped, bytes: bytes, cellIds: ids.slice() });
            return true;
        }
        function sendSlot(i) { const l = list(); return l[i] ? send(l[i]) : false; }

        /** 宿主已經自己解好封包：交給模組顯示 */
        function receive(cellId, emoteStr) {
            if (host.isMine && host.isMine(cellId)) return false;
            return show(cellId, emoteStr, { remote: true });
        }
        /** 整包 opcode 100（ArrayBuffer / DataView / Uint8Array，可給 offset） */
        function handleServerPacket(data, offset) {
            const m = protocol.decodeServer(data, offset);
            if (!m) return null;
            m.shown = receive(m.cellId, m.emote);
            return m;
        }

        // ── 面板 UI ──
        let panel = null, grid = null, pageEl = null, prevBtn = null, nextBtn = null, input = null, msgEl = null;
        let page = 0;

        function buildPanel() {
            if (panel || typeof document === 'undefined') return;
            injectCss();
            panel = document.createElement('div');
            panel.className = 'emo-panel';
            panel.hidden = true;
            panel.innerHTML =
                '<div class="emo-head"><span class="emo-title">😎 表情</span><span class="emo-hint"></span>' +
                '<button class="emo-x" type="button" title="關閉 (Esc)">✕</button></div>' +
                '<div class="emo-tip">左鍵：發送 ・ 右鍵：釘選 / 取消（釘選的排最前面，前 10 個對應數字鍵）</div>' +
                '<div class="emo-grid"></div>' +
                '<div class="emo-pager"><button class="emo-btn" type="button" data-dir="-1">◀ 上一頁</button>' +
                '<span class="emo-page">1 / 1</span><button class="emo-btn" type="button" data-dir="1">下一頁 ▶</button></div>' +
                '<div class="emo-add"><input class="emo-input" type="text" spellcheck="false" placeholder="貼上 Imgur 圖片網址新增表情">' +
                '<button class="emo-btn primary" type="button">＋ 新增</button></div>' +
                '<div class="emo-msg"></div>';
            panel.style.setProperty('--emo-cols', cfg.columns);
            grid = panel.querySelector('.emo-grid');
            pageEl = panel.querySelector('.emo-page');
            [prevBtn, nextBtn] = panel.querySelectorAll('.emo-pager .emo-btn');
            input = panel.querySelector('.emo-input');
            msgEl = panel.querySelector('.emo-msg');
            const hk = panel.querySelector('.emo-hint');
            hk.textContent = cfg.hotkeys.panel ? '按 ' + (cfg.hotkeys.panel === 'Backquote' ? '`' : keyLabel(cfg.hotkeys.panel)) + ' 開關' : '';

            panel.querySelector('.emo-x').onclick = () => close();
            prevBtn.onclick = () => turnPage(-1);
            nextBtn.onclick = () => turnPage(1);
            panel.querySelector('.emo-add .primary').onclick = () => submitAdd();
            input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitAdd(); } });
            grid.addEventListener('wheel', e => { e.preventDefault(); turnPage(e.deltaY > 0 ? 1 : -1); }, { passive: false });
            grid.addEventListener('contextmenu', e => e.preventDefault());
            panel.addEventListener('mousedown', e => e.stopPropagation()); // 不要讓宿主以為在點畫布
            document.body.appendChild(panel);
        }

        function setMsg(text, kind) {
            if (!msgEl) return;
            msgEl.textContent = text || '';
            msgEl.className = 'emo-msg' + (kind ? ' ' + kind : '');
        }
        function submitAdd() {
            const v = input.value;
            setMsg('載入中…');
            addCustom(v).then(res => {
                if (res.ok) { input.value = ''; setMsg('已新增（在最後一頁）', 'ok'); }
                else setMsg(res.error, 'err');
            });
        }
        function maxPage() { return Math.max(0, Math.ceil(list().length / cfg.perPage) - 1); }
        function turnPage(d) { const m = maxPage(); const p = Math.max(0, Math.min(page + d, m)); if (p !== page) { page = p; renderGrid(); } }

        function renderGrid(toLast) {
            if (!panel || panel.hidden) return;
            const all = list();
            const mp = maxPage();
            if (toLast) page = mp;
            if (page > mp) page = mp;
            pageEl.textContent = (page + 1) + ' / ' + (mp + 1);
            prevBtn.disabled = page === 0; nextBtn.disabled = page === mp;
            const slots = cfg.hotkeys.enabled ? (cfg.hotkeys.slots || []) : [];
            const pinSet = new Set(lib.pinned);
            const frag = document.createDocumentFragment();
            for (let i = 0; i < cfg.perPage; i++) {
                const gi = page * cfg.perPage + i;
                const id = all[gi];
                const div = document.createElement('div');
                div.className = 'emo-item';
                if (id == null) { div.className += ' empty'; frag.appendChild(div); continue; }
                if (pinSet.has(id)) div.className += ' pinned';
                div.title = id;
                if (gi < slots.length) {
                    const k = document.createElement('span'); k.className = 'emo-key'; k.textContent = keyLabel(slots[gi]); div.appendChild(k);
                }
                if (pinSet.has(id)) { const p = document.createElement('span'); p.className = 'emo-pin'; p.textContent = '📌'; div.appendChild(p); }
                const img = document.createElement('img');
                img.alt = ''; img.loading = 'lazy'; img.draggable = false;
                img.onerror = () => div.classList.add('broken');
                setImgAttrs(img, urlOf(id));
                div.appendChild(img);
                if (isCustom(id)) {
                    const del = document.createElement('button');
                    del.className = 'emo-del'; del.type = 'button'; del.textContent = '🗑'; del.title = '刪除這個自訂表情';
                    del.onclick = e => { e.stopPropagation(); if (confirm('確定要移除這個自訂表情嗎？')) removeCustom(id); };
                    div.appendChild(del);
                }
                div.onclick = () => { send(id); if (cfg.closeOnSend) close(); };
                div.oncontextmenu = e => { e.preventDefault(); togglePin(id); };
                frag.appendChild(div);
            }
            grid.replaceChildren(frag);
        }

        function isOpen() { return !!(panel && !panel.hidden); }
        function open() { buildPanel(); if (!panel) return; panel.hidden = false; setMsg(''); renderGrid(); emit('panel', { open: true }); }
        function close() { if (!isOpen()) return; panel.hidden = true; if (document.activeElement && panel.contains(document.activeElement)) document.activeElement.blur(); emit('panel', { open: false }); }
        function toggle() { isOpen() ? close() : open(); }

        // ── 熱鍵 ──
        function onKey(e) {
            if (!cfg.hotkeys.enabled) return;
            if (e.code === 'Escape' && isOpen()) { close(); e.preventDefault(); e.stopImmediatePropagation(); return; }
            if (isTypingTarget(document.activeElement)) return;
            if (e.ctrlKey || e.altKey || e.metaKey) return;
            if (host.canUseHotkeys && host.canUseHotkeys(e) === false) return;
            if (cfg.hotkeys.panel && e.code === cfg.hotkeys.panel) {
                if (!e.repeat) toggle();
                e.preventDefault(); e.stopImmediatePropagation();
                return;
            }
            const slots = cfg.hotkeys.slots || [];
            let i = slots.indexOf(e.code);
            if (i < 0 && cfg.hotkeys.numpad && /^Numpad\d$/.test(e.code)) i = slots.indexOf('Digit' + e.code.slice(6));
            if (i >= 0 && list()[i]) {
                if (!e.repeat) sendSlot(i);
                e.preventDefault(); e.stopImmediatePropagation();
            }
        }
        if (typeof window !== 'undefined') window.addEventListener('keydown', onKey, true);

        function destroy() {
            if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey, true);
            if (panel) panel.remove();
            panel = null; active.clear(); images.clear();
        }

        loadLib();

        return {
            // 收發
            send: send, sendSlot: sendSlot, receive: receive, handleServerPacket: handleServerPacket, show: show,
            // 畫
            drawOnCell: drawOnCell, nameAlpha: nameAlpha, createOverlay: createOverlay, has: has, clear: clear,
            // 面板
            open: open, close: close, toggle: toggle, isOpen: isOpen,
            // 表情庫
            list: list, addCustom: addCustom, removeCustom: removeCustom, togglePin: togglePin,
            isPinned: id => lib.pinned.indexOf(id) >= 0,
            exportLibrary: () => ({ custom: lib.custom.slice(), pinned: lib.pinned.slice() }),
            importLibrary: importLibrary,
            // 設定
            anim: anim,
            setAnim(p) { Object.assign(anim, p || {}); },
            getConfig: () => ({ anim: Object.assign({}, anim), cooldownMs: cfg.cooldownMs, bakeSize: cfg.bakeSize }),
            setCooldown(ms) { cfg.cooldownMs = Math.max(0, +ms || 0); },
            setBakeSize(n) { cfg.bakeSize = Math.max(0, +n || 0); reloadImages(); },
            preload: preloadBuiltins,
            imageUrl: urlOf,
            activeCount: () => active.size,
            on: on, off: off, destroy: destroy,
        };

        function importLibrary(o) {
            if (!o) return;
            lib.custom = Array.isArray(o.custom) ? o.custom.filter(x => typeof x === 'string' && isAllowedRemote(x) && !isBuiltin(x)) : lib.custom;
            lib.pinned = Array.isArray(o.pinned) ? o.pinned.filter(x => typeof x === 'string') : lib.pinned;
            saveLib(); emit('change', { type: 'import' }); renderGrid();
        }
    }

    return {
        version: '1.0.0',
        create: create,
        sample: sample,
        protocol: protocol,
        parseEmoteStr: parseEmoteStr,
        normalizeInput: normalizeInput,
        DEFAULT_ANIM: DEFAULT_ANIM,
        LEGACY_ANIM: LEGACY_ANIM,
    };
});
