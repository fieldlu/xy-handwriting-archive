// ==UserScript==
// @name         小雅作业华为笔记导出
// @namespace    https://gitee.com/fieldlu/xy-handwriting-archive
// @version      1.0.2
// @description  作业题目自动转手写笔迹：打开作业页自动捕获题目，导出 .hinote（华为笔记导入）/ PDF / JPG。原「小雅辅助工具·笔记版手写导出」完整功能，可独立运行
// @author       Confidential
// @license      GPL-3.0-or-later
// @icon         https://www.ai-augmented.com/static/logo3.1dbbea8f.png
// @source       https://gitee.com/fieldlu/xy-handwriting-archive
// @updateURL    https://gitee.com/fieldlu/xy-handwriting-archive/raw/main/%E5%B0%8F%E9%9B%85%E4%BD%9C%E4%B8%9A%E5%8D%8E%E4%B8%BA%E7%AC%94%E8%AE%B0%E5%AF%BC%E5%87%BA.user.js
// @downloadURL  https://gitee.com/fieldlu/xy-handwriting-archive/raw/main/%E5%B0%8F%E9%9B%85%E4%BD%9C%E4%B8%9A%E5%8D%8E%E4%B8%BA%E7%AC%94%E8%AE%B0%E5%AF%BC%E5%87%BA.user.js
// @match        https://*.ai-augmented.com/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      gitee.com
// @connect      cdn.jsdmirror.com
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

/*
 * 小雅作业华为笔记导出 — 引擎备份版
 * 内容 = 原小雅辅助工具 §14 手写纸引擎全文：
 *   XYHinote（华为 .hinote 写入器 + Stroke 笔迹容器）/ XYLayout（文字排版 → 笔顺笔迹）
 *   / XYPaper（A4 笔记纸分页）/ XYExport（JPEG 页 → PDF 合成）/ XY_HW_DB 笔顺库
 *   / xyHWRaster（标点与库外字骨架栅格化）。
 * 本脚本仅提供最小独立入口（粘贴文字 → 导出），不依赖小雅辅助工具。
 */

(function () {
    'use strict';

    /* ================================================================
     * 实时请求劫持（v1.0.6，自小雅辅助工具 §11 迁移）：先于页面脚本安装，
     * 实时截获平台自发发出的 queryStuPaper/v2 试卷请求（fetch + XHR 双通道），
     * 响应解析入库 hwQuestionsData —— 页面打开即捕获，无需等待主动拉取。
     * hwCaptureParams / hwProcessPaperData 为后文函数声明（提升可用）。
     * ================================================================ */
    var _hw_nativeFetch = window.fetch.bind(window);
    (function () {
        const _prevFetch = window.fetch;
        window.fetch = async function (input, init) {
            const rawUrl = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
            if (rawUrl && rawUrl.includes('/queryStuPaper/v2')) {
                // 同时兼容旧 quiz/ 前缀与新 survey/course/ 前缀的试卷接口
                const response = await _hw_nativeFetch.apply(this, arguments);
                if (response.ok) {
                    console.log('[小雅作业华为笔记导出] 已捕获 fetch 题目数据包(200)');
                    hwCaptureParams(rawUrl);
                }
                try {
                    const cloned = response.clone();
                    let data;
                    try { data = await cloned.json(); } catch (e) { data = JSON.parse(await cloned.text()); }
                    if (data && data.data && data.data.questions) hwProcessPaperData(data);
                } catch (e) { console.error('[小雅作业华为笔记导出] fetch 数据解包失败', e); }
                return response;
            }
            return _prevFetch.apply(this, arguments);
        };
    })();
    if (typeof XMLHttpRequest !== 'undefined') {
    var _hw_nativeXhrOpen = XMLHttpRequest.prototype.open;
    var _hw_nativeXhrSend = XMLHttpRequest.prototype.send;
        (function () {
            const _prevXhrOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (method, url) {
                this._hw_url = typeof url === 'string' ? url : String(url);
                return _prevXhrOpen.apply(this, [method, url].concat(Array.prototype.slice.call(arguments, 2)));
            };
            const _prevXhrSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function () {
                const self = this;
                if (self._hw_url && self._hw_url.includes('/queryStuPaper/v2')) {
                    self.addEventListener('load', function () {
                        if (self.status === 200) {
                            console.log('[小雅作业华为笔记导出] 已捕获 XHR 题目数据包(200)');
                            hwCaptureParams(self._hw_url);
                        }
                    });
                    self.addEventListener('load', function () {
                        try {
                            let data;
                            if (self.responseType === 'blob' && self.response) {
                                self.response.text().then(function (text) {
                                    const parsed = JSON.parse(text);
                                    if (parsed && parsed.data && parsed.data.questions) hwProcessPaperData(parsed);
                                }).catch(function (e) { console.error('[小雅作业华为笔记导出] blob→text 解包失败', e); });
                                return;
                            }
                            if (self.responseType === 'json' && self.response) data = self.response;
                            else if ((self.responseType === '' || self.responseType === 'text') && self.responseText) data = JSON.parse(self.responseText);
                            if (data && data.data && data.data.questions) hwProcessPaperData(data);
                        } catch (e) { console.error('[小雅作业华为笔记导出] XHR 解包失败', e); }
                    });
                    return _hw_nativeXhrSend.apply(this, arguments);
                }
                return _prevXhrSend.apply(this, arguments);
            };
        })();
    }

/* hinote.js — 华为 .hinote 生成器（零依赖，浏览器 / Node 双端）
   移植自 tools/hinote_writer.py，二进制布局逐字段对齐。
   格式要点（真机验证过，勿改）：
   - 记录头 20B 大端 5xu32 {0x14,0x49,0x14,28n,0x1d} + 16B UUID
   - 样式 16B: f32 1.6667 + 4B ABGR + f32 1.0 + f32 1.0
   - 每个点 28B: x,y (f32) / t (u32) / pressure (f32) / 0.2 (f32) / 8B padding
   - 统计尾 28B: [5.0, 0.25L, 0.9L, L, 0.0, 0.0981, 0.1286]，L = 折线长度
   - 每条记录末尾 1 个 0x00 分隔字节（含最后一条）
   - gsd 头 0x38 = 真实瓦片字节数、0x3c = 瓦片条数（错了只渲染第一块瓦片）
*/
var XYHinote = (function () {  'use strict';

  var TILE = 2500.0;
  var T5 = 0.0981, T6 = 0.1286;

  // ---------- CRC32 ----------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---------- 环境适配 ----------
  var _zlib = null, _nodecrypto = null;
  try { if (typeof require === 'function') { _zlib = require('zlib'); _nodecrypto = require('crypto'); } } catch (e) {}
  var isNode = !!_zlib;

  function deflateRaw(bytes) {
    if (isNode) {
      return Promise.resolve(new Uint8Array(_zlib.deflateRawSync(Buffer.from(bytes), { level: 9 })));
    }
    try {
      var cs = new CompressionStream('deflate-raw');
      var w = cs.writable.getWriter();
      w.write(bytes);
      w.close();
      return new Response(cs.readable).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
    } catch (e) {
      return Promise.resolve(bytes);   // 环境不支持压缩时退化，zip 改用 STORED
    }
  }

  // 自己拼 gzip 头，确保 mtime = 0（与 Python gzip.compress(mtime=0) 一致）
  function gzip(bytes) {
    return deflateRaw(bytes).then(function (d) {
      var out = new Uint8Array(10 + d.length + 8);
      out[0] = 0x1f; out[1] = 0x8b; out[2] = 0x08; out[3] = 0x00;
      out[4] = 0; out[5] = 0; out[6] = 0; out[7] = 0;   // mtime = 0
      out[8] = 0x02; out[9] = 0xff;                      // XFL=2, OS=unknown
      out.set(d, 10);
      var crc = crc32(bytes);
      var len = bytes.length;
      var o = 10 + d.length;
      out[o] = crc & 0xFF; out[o + 1] = (crc >>> 8) & 0xFF;
      out[o + 2] = (crc >>> 16) & 0xFF; out[o + 3] = (crc >>> 24) & 0xFF;
      out[o + 4] = len & 0xFF; out[o + 5] = (len >>> 8) & 0xFF;
      out[o + 6] = (len >>> 16) & 0xFF; out[o + 7] = (len >>> 24) & 0xFF;
      return out;
    });
  }

  function toHex(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i++) s += ('0' + u8[i].toString(16)).slice(-2);
    return s;
  }

  // file:// 下 crypto.subtle 不可用（非安全上下文），因此自带纯 JS 实现
  var K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }
  function sha256Pure(msg) {
    var H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    var len = msg.length, i, t;
    var total = (Math.ceil((len + 9) / 64)) * 64;
    var buf = new Uint8Array(total);
    buf.set(msg);
    buf[len] = 0x80;
    var dv = new DataView(buf.buffer);
    var bits = len * 8;
    dv.setUint32(total - 8, Math.floor(bits / 4294967296), false);
    dv.setUint32(total - 4, bits >>> 0, false);
    var w = new Uint32Array(64);
    for (i = 0; i < total / 64; i++) {
      var off = i * 64;
      for (t = 0; t < 16; t++) w[t] = dv.getUint32(off + t * 4, false);
      for (t = 16; t < 64; t++) {
        var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K256[t] + w[t]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = new Uint8Array(32), ov = new DataView(out.buffer);
    for (i = 0; i < 8; i++) ov.setUint32(i * 4, H[i], false);
    return out;
  }

  function sha256Hex(bytes) {
    if (isNode && !process.env.HINOTE_PURE_SHA) {
      return Promise.resolve(_nodecrypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex').toUpperCase());
    }
    return Promise.resolve(toHex(sha256Pure(bytes)).toUpperCase());
  }

  function uuidBytes() {
    var b = new Uint8Array(16);
    if ((typeof crypto !== 'undefined') && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;   // version 4
    b[8] = (b[8] & 0x3f) | 0x80;   // variant 10
    return b;
  }
  function uuidHex() { return toHex(uuidBytes()); }

  var TE = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
  function utf8(s) {
    if (TE) return TE.encode(s);
    return new Uint8Array(Buffer.from(s, 'utf8'));
  }

  // ---------- Stroke ----------
  function Stroke(points, color, tool) {
    if (points.length < 2) throw new Error('Stroke needs at least 2 points');
    this.points = points.map(function (p) { return [+p[0], +p[1], p[2] | 0, +p[3]]; });
    this.color = (color === undefined ? 0xFFFFFF : color) & 0xFFFFFF;
    this.tool = tool || 0;
  }
  Object.defineProperty(Stroke.prototype, 'pathLen', {
    get: function () {
      var p = this.points, s = 0;
      for (var i = 0; i < p.length - 1; i++) {
        s += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
      }
      return s;
    }
  });

  Stroke.prototype.record = function (seq, ts) {
    var pts = this.points, n = pts.length;
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (var i = 0; i < n; i++) {
      if (pts[i][0] < minx) minx = pts[i][0];
      if (pts[i][0] > maxx) maxx = pts[i][0];
      if (pts[i][1] < miny) miny = pts[i][1];
      if (pts[i][1] > maxy) maxy = pts[i][1];
    }
    var L = this.pathLen;
    var size = 142 + 28 * n;
    var buf = new ArrayBuffer(size);
    var dv = new DataView(buf);
    var o = 0;
    dv.setUint32(o, 0x14, false); o += 4;
    dv.setUint32(o, 0x49, false); o += 4;
    dv.setUint32(o, 0x14, false); o += 4;
    dv.setUint32(o, 28 * n, false); o += 4;
    dv.setUint32(o, 0x1d, false); o += 4;
    new Uint8Array(buf, o, 16).set(uuidBytes()); o += 16;
    dv.setUint32(o, 0, false); o += 4;
    dv.setUint32(o, ts >>> 0, false); o += 4;
    dv.setUint32(o, this.tool, false); o += 4;
    dv.setUint32(o, 0, false); o += 4;
    dv.setUint32(o, n, false); o += 4;
    dv.setUint32(o, 28, false); o += 4;
    dv.setUint32(o, 0, false); o += 4;
    dv.setFloat32(o, n - 1, false); o += 4;
    dv.setFloat32(o, minx, false); o += 4;
    dv.setFloat32(o, miny, false); o += 4;
    dv.setFloat32(o, maxx, false); o += 4;
    dv.setFloat32(o, maxy, false); o += 4;
    dv.setUint32(o, seq, false); o += 4;
    dv.setInt32(o, -1, false); o += 4;
    dv.setUint8(o++, 1); dv.setUint8(o++, 0); dv.setUint8(o++, 0);
    dv.setUint8(o++, 0); dv.setUint8(o++, 0x0c);
    dv.setFloat32(o, 1.6666666, false); o += 4;
    var r = (this.color >> 16) & 0xff, g = (this.color >> 8) & 0xff, b = this.color & 0xff;
    dv.setUint8(o++, 0xff); dv.setUint8(o++, b); dv.setUint8(o++, g); dv.setUint8(o++, r);
    dv.setFloat32(o, 1.0, false); o += 4;
    dv.setFloat32(o, 1.0, false); o += 4;
    for (var j = 0; j < n; j++) {
      var p = pts[j];
      dv.setFloat32(o, p[0], false); o += 4;
      dv.setFloat32(o, p[1], false); o += 4;
      dv.setUint32(o, p[2] >>> 0, false); o += 4;
      dv.setFloat32(o, p[3], false); o += 4;
      dv.setFloat32(o, 0.2, false); o += 4;
      o += 8;   // 8B padding，已为 0
    }
    dv.setFloat32(o, 5.0, false); o += 4;
    dv.setFloat32(o, 0.25 * L, false); o += 4;
    dv.setFloat32(o, 0.9 * L, false); o += 4;
    dv.setFloat32(o, L, false); o += 4;
    dv.setFloat32(o, 0.0, false); o += 4;
    dv.setFloat32(o, T5, false); o += 4;
    dv.setFloat32(o, T6, false); o += 4;
    dv.setUint8(o++, 0);
    return new Uint8Array(buf);
  };

  // ---------- PENKIT 容器头 ----------
  function penkitHeader(rtype, fid, lenA, lenB, cntA, cntB) {
    var buf = new ArrayBuffer(52), dv = new DataView(buf), o = 0;
    var magic = utf8('PENKITINFENG');
    new Uint8Array(buf, 0, 12).set(magic); o = 12;
    dv.setUint32(o, rtype, false); o += 4;
    dv.setUint32(o, 0x00010000, false); o += 4;
    dv.setBigUint64(o, fid, false); o += 8;
    dv.setUint32(o, 16, false); o += 4;
    dv.setUint32(o, 8, false); o += 4;
    dv.setUint32(o, lenA, false); o += 4;
    dv.setUint32(o, lenB, false); o += 4;
    dv.setUint32(o, cntA, false); o += 4;
    dv.setUint32(o, cntB, false); o += 4;
    return new Uint8Array(buf);
  }

  function concat(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total), o = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; }
    return out;
  }

  // ---------- zip 打包（DEFLATED） ----------
  function zipStore(entries) {
    var parts = [], central = [], offset = 0, i;
    var jobs = entries.map(function (e) {
      return deflateRaw(e.data).then(function (comp) {
        var useComp = comp.length < e.data.length;
        var body = useComp ? comp : e.data;
        var method = useComp ? 8 : 0;
        return { name: e.name, raw: e.data, body: body, method: method, crc: crc32(e.data) };
      });
    });
    return Promise.all(jobs).then(function (items) {
      for (i = 0; i < items.length; i++) {
        var it = items[i];
        var nameBytes = utf8(it.name);
        var lh = new Uint8Array(30 + nameBytes.length), dv = new DataView(lh.buffer), o = 0;
        dv.setUint32(o, 0x04034b50, true); o += 4;
        dv.setUint16(o, 20, true); o += 2;
        dv.setUint16(o, 0x0800, true); o += 2;      // UTF-8 名
        dv.setUint16(o, it.method, true); o += 2;
        dv.setUint16(o, 0, true); o += 2;           // time
        dv.setUint16(o, 0x21, true); o += 2;        // date (1980-01-01)
        dv.setUint32(o, it.crc, true); o += 4;
        dv.setUint32(o, it.body.length, true); o += 4;
        dv.setUint32(o, it.raw.length, true); o += 4;
        dv.setUint16(o, nameBytes.length, true); o += 2;
        dv.setUint16(o, 0, true); o += 2;
        lh.set(nameBytes, 30);
        parts.push(lh, it.body);

        var ch = new Uint8Array(46 + nameBytes.length);
        dv = new DataView(ch.buffer); o = 0;
        dv.setUint32(o, 0x02014b50, true); o += 4;
        dv.setUint16(o, 0x031E, true); o += 2;      // version made by (UNIX)
        dv.setUint16(o, 20, true); o += 2;
        dv.setUint16(o, 0x0800, true); o += 2;
        dv.setUint16(o, it.method, true); o += 2;
        dv.setUint16(o, 0, true); o += 2;
        dv.setUint16(o, 0x21, true); o += 2;
        dv.setUint32(o, it.crc, true); o += 4;
        dv.setUint32(o, it.body.length, true); o += 4;
        dv.setUint32(o, it.raw.length, true); o += 4;
        dv.setUint16(o, nameBytes.length, true); o += 2;
        dv.setUint16(o, 0, true); o += 2;
        dv.setUint16(o, 0, true); o += 2;
        dv.setUint16(o, 0, true); o += 2;
        dv.setUint16(o, 0, true); o += 2;
        dv.setUint32(o, 0x81A40000, true); o += 4;  // 外部属性 0644
        dv.setUint32(o, offset, true); o += 4;
        ch.set(nameBytes, 46);
        central.push(ch);

        offset += lh.length + it.body.length;
      }
      var cdSize = 0;
      for (i = 0; i < central.length; i++) cdSize += central[i].length;
      var eocd = new Uint8Array(22);
      var dv2 = new DataView(eocd.buffer), o2 = 0;
      dv2.setUint32(o2, 0x06054b50, true); o2 += 4;
      dv2.setUint16(o2, 0, true); o2 += 2;
      dv2.setUint16(o2, 0, true); o2 += 2;
      dv2.setUint16(o2, entries.length, true); o2 += 2;
      dv2.setUint16(o2, entries.length, true); o2 += 2;
      dv2.setUint32(o2, cdSize, true); o2 += 4;
      dv2.setUint32(o2, offset, true); o2 += 4;
      dv2.setUint16(o2, 0, true); o2 += 2;
      return concat(parts.concat(central, [eocd]));
    });
  }

  // ---------- 主入口 ----------
  function writeHinote(strokes, opts) {
    opts = opts || {};
    var title = opts.title || '手写笔记';
    // page_color 为 ARGB 有符号 32 位：默认 -14671324 = 0xFF202224（深灰底）
    // 白纸传 -1 (0xFFFFFFFF)；米白 #FAF8F5 传 -331531
    var page_color = (opts.pageColor === undefined) ? -14671324 : opts.pageColor;
    var background = opts.background || 'base1';
    var now_ms = Date.now();
    var fid = BigInt(now_ms) * 1000n;
    var notesId = uuidHex(), pageMain = uuidHex(), folderId = uuidHex();

    // 按首点瓦片分组，并按 (tx, ty) 字典序排序（与 Python sorted(tiles.items()) 一致）
    var tileMap = {};
    var keys = [];
    strokes.forEach(function (s) {
      var tx = Math.floor(s.points[0][0] / TILE);
      var ty = Math.floor(s.points[0][1] / TILE);
      var key = tx + '|' + ty;
      if (!tileMap[key]) { tileMap[key] = { tx: tx, ty: ty, list: [] }; keys.push(key); }
      tileMap[key].list.push(s);
    });
    keys.sort(function (a, b) {
      var A = tileMap[a], B = tileMap[b];
      return (A.tx - B.tx) || (A.ty - B.ty);
    });

    var files = [];                 // 保持插入顺序
    var filesIndex = {};
    function addFile(name, data) {
      files.push({ name: name, data: data });
      filesIndex[name] = data;
    }

    var tilePages = [];
    var seq = 0, ts = now_ms % 100000000;
    var gsdRecs = [];

    keys.forEach(function (key) {
      var t = tileMap[key];
      var tfid = fid + BigInt(files.length);
      var bodies = [];
      t.list.forEach(function (s) {
        seq += 1; ts += 137;
        bodies.push(s.record(seq, ts));
      });
      var body = concat(bodies);
      var bsdName = 'bsd_' + t.tx + '_' + t.ty + '_' + tfid.toString() + '.bin';
      addFile(bsdName, concat([penkitHeader(1, tfid, body.length, 0, t.list.length, 0), body]));

      var gr = new Uint8Array(16), dv = new DataView(gr.buffer);
      dv.setInt32(0, t.tx, false);
      dv.setInt32(4, t.ty, false);
      dv.setBigUint64(8, tfid, false);
      gsdRecs.push(gr);

      tilePages.push({ pid: uuidHex(), bsd: bsdName });
    });

    // gsd 索引
    var sentinel = new Uint8Array(16), sdv = new DataView(sentinel.buffer);
    sdv.setInt32(0, 12, false); sdv.setInt32(4, 4, false); sdv.setBigUint64(8, 0n, false);
    var gsdBody = concat(gsdRecs.concat([sentinel]));
    var nReal = keys.length;
    var gsd = concat([
      utf8('PENKITINFENG'),
      packIIQ(3, 0x00010000, fid),
      pack6(0x10, 0x04, gsdBody.length, 0x10),
      packF(TILE),
      pack6(0x0c, 0x04, 16 * nReal, nReal),
      gsdBody
    ]);
    var gsdName = 'gsd_' + fid.toString() + '.bin';
    addFile(gsdName, gsd);

    var gedName = 'ged_' + fid.toString() + '.bin';
    addFile(gedName, concat([
      utf8('PENKITINFENG'),
      packIIQ(4, 0x00010000, fid),
      pack6(0x0c, 0x04, 0, 0)
    ]));

    var outlineName = notesId + '_' + now_ms + '_outline.json';
    var navName = pageMain + '_' + now_ms + '_navigation.json';
    addFile(outlineName, utf8(notesId));
    // 与 Python json.dumps 默认格式一致（带空格），保持哈希语义相同
    addFile(navName, utf8('{"positions": [{"x": 0, "y": 0}], "curIndex": 0}'));

    function pack6(a, b, c, d) {
      var u = new Uint8Array(16), dv = new DataView(u.buffer);
      dv.setUint32(0, a, false); dv.setUint32(4, b, false);
      dv.setUint32(8, c, false); dv.setUint32(12, d, false);
      return u;
    }
    function packF(v) {
      var u = new Uint8Array(4), dv = new DataView(u.buffer);
      dv.setFloat32(0, v, false);
      return u;
    }
    function packIIQ(a, b, c) {
      var u = new Uint8Array(16), dv = new DataView(u.buffer);
      dv.setUint32(0, a, false); dv.setUint32(4, b, false); dv.setBigUint64(8, c, false);
      return u;
    }

    // 哈希：三处同步（根 fileList+data1、瓦片页 fileList+data1、custom_md）
    var hashJobs = files.map(function (f) {
      return sha256Hex(f.data).then(function (h) {
        return Promise.resolve({ name: f.name, hash: h });
      });
    });

    return Promise.all(hashJobs).then(function (hashes) {
      var H = {};
      hashes.forEach(function (x) { H[x.name] = x.hash; });

      function detailFileMap(names) {
        var obj = {};
        names.forEach(function (n) { obj[n] = [{ name: n, hash: H[n] }]; });
        return JSON.stringify(obj);
      }
      function attach(atype, fpath, pageId) {
        return {
          attachType: atype, cloudSyncState: 1, createTime: now_ms,
          filePath: fpath, isDelete: 0, modifiedTime: now_ms,
          notesId: notesId, playbackProgress: 0, id: uuidHex(),
          notePageId: pageId === undefined ? null : pageId,
          data1: '{"pageElementId":""}',
          data2: '', data3: '', data4: '', data5: '',
          unStructUuid: '', transText: null, contentText: ''
        };
      }
      function pageJson(pageId, number, main, atts, fileList, dfmNames) {
        return {
          customNotePageContent: {
            pageBookMarks: [], attachment: atts,
            background: background, bkgAttachmentId: '',
            bkgAttachmentIndex: 0, chapterNumber: '', cloudSyncState: 0,
            createTime: now_ms, guid: '', id: pageId, isDelete: 0,
            lastPageTag: main ? 1 : 0, modifiedTime: now_ms,
            notesId: notesId, pageColor: page_color,
            pageElement: [], pageNumber: number,
            pageOrientation: main ? 1 : 0, pageRatio: main ? 0.625 : 1,
            pageType: 1, thumbnail: '', unStructUuid: '',
            data1: JSON.stringify({
              detailFileMap: detailFileMap(dfmNames),
              thumbnail_area: '', book_mark: ''
            }),
            data2: '', data3: '', data4: '', data5: ''
          },
          fileList: fileList
        };
      }

      var infDir = '/data/user/0/com.huawei.hinote/files/hwFile_infinite/' + folderId;

      var pages = [{ pid: pageMain, json: pageJson(pageMain, 1, true, [], [], []) }];
      tilePages.forEach(function (tp, i) {
        pages.push({
          pid: tp.pid,
          json: pageJson(tp.pid, i + 2, false,
            [attach(13, infDir + '/' + tp.bsd, tp.pid)],
            [{ name: tp.bsd, hash: H[tp.bsd] }],
            [tp.bsd])
        });
      });

      var rootData1 = {
        relationTags: '[]', relationPages: '', originDeviceType: 'tablet',
        isContentCover: '1', isInfNote: '1',
        infStylusPath: '/data/storage/el2/distributedfiles/hwFile_infinite/' + folderId,
        detailFileMap: detailFileMap([outlineName, gsdName, gedName, navName]),
        record_item_mapper_key: '',
        localData1: '{"cloud_syncing_files":"{}"}'
      };
      var root = {
        customNoteContent: {
          attachment: [
            attach(11, '/data/user/0/com.huawei.hinote/files/navigation/' + navName),
            attach(12, infDir + '/' + gsdName),
            attach(12, infDir + '/' + gedName)
          ],
          background: background, categoryId: 'fee4b44b92cb4651806fec059f6bd17f',
          cloudSyncState: 0, createTime: now_ms, data1: JSON.stringify(rootData1),
          deleteTag: 0, deleteTime: 0, extendFields: 'infinite_1.0.2',
          guid: '', hasCover: 1, id: notesId, isFavorite: 0, isTop: 0,
          modifiedTime: now_ms, noteIcon: 'fresh_1', noteTitle: title,
          noteType: 100, pageColor: page_color, pageOrientation: 1,
          pageRatio: 0.625, unStructUuid: '', bookIntroduction: '',
          userId: '', noteTemplate: '', data2: '', data3: '', data4: '',
          data5: '', coverId: '', parentId: 'fee4b44b92cb4651806fec059f6bd17f',
          outLineAttachment: [], recordItemEntities: []
        },
        fileList: [outlineName, gsdName, gedName, navName].map(function (n) {
          return { name: n, hash: H[n] };
        })
      };

      var customMd = {
        customMdContents: files.map(function (f) {
          return { fileMdStr: H[f.name], fileNameMdStr: null };
        })
      };

      // fileNameMdStr = sha256(文件名)，Node 与浏览器均可算
      var nameJobs = files.map(function (f) { return sha256Hex(utf8(f.name)); });
      return Promise.all(nameJobs).then(function (nameHashes) {
        nameHashes.forEach(function (h, i) {
          customMd.customMdContents[i].fileNameMdStr = h.toLowerCase();
        });

        var entries = [];
        var jRoot = utf8(JSON.stringify(root));
        var jMd = utf8(JSON.stringify(customMd));
        entries.push({ name: notesId + '.jhinote', data: null, raw: jRoot });
        entries.push({ name: 'custom_md.jhinote', data: null, raw: jMd });
        var pageRaw = pages.map(function (p) {
          return { name: 'pages/' + p.pid + '.jhinote', raw: utf8(JSON.stringify(p.json)) };
        });
        pageRaw.forEach(function (p) { entries.push(p); });
        files.forEach(function (f) { entries.push({ name: 'files/' + f.name, raw: f.data }); });

        var gzJobs = entries.map(function (e) {
          if (e.name.indexOf('files/') === 0) return Promise.resolve(e.raw);
          return gzip(e.raw);
        });
        return Promise.all(gzJobs).then(function (datas) {
          var zipEntries = entries.map(function (e, i) {
            return { name: e.name, data: datas[i] };
          });
          return zipStore(zipEntries);
        });
      });
    });
  }

  return {
    Stroke: Stroke, writeHinote: writeHinote, TILE: TILE, isNode: isNode,
    sha256Hex: sha256Hex, sha256Pure: sha256Pure, K256: K256
  };
})();


/* layout.js — 文字排版 → 手写笔迹（移植自 tools/text2handwriting.py）
   两套引擎：
     medians  笔顺中心线（Make Me a Hanzi 数据，1024 坐标系 y 向上），识别友好，优先
     skeleton 字体栅格 → Zhang-Suen 细化 → 骨架行走，用于标点和库外字兜底
   骨架兜底需要外部提供 raster(ch) 把字符栅格化成 0/1 位图；浏览器用 Canvas，Node 下留空即跳过。
*/
var XYLayout = (function (Hinote) {  'use strict';

  var MARGIN = 150.0;
  var TILE = 2500.0;
  var CANVAS = 240;      // 骨架栅格画布边长
  var RENDER = 200;      // 字体渲染字号

  // ---------- 确定性随机 ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- 分词：CJK 逐字、ASCII 成词、标点不开头、\n 强制换行 ----------
  var PUNCT = '，。、；：？！』」）';
  // 图片标记：\uE000 + 十进制索引（如 \uE0003 = 第 3 张图）。tokenize 拆成 IMG token，
  // layoutRows 与主循环按 opts.images[idx].blockRows 占行，防跨页时整体推到下一页。
  var IMG_CHAR = '\uE000';
  function tokenize(text) {
    var toks = [], i = 0;
    while (i < text.length) {
      var c = text[i];
      if (c === '\n') { toks.push(['', 'NL']); i += 1; }
      else if (c.charCodeAt(0) === 0xE000) {
        var j = i + 1;
        while (j < text.length && text[j] >= '0' && text[j] <= '9') j += 1;
        toks.push([c + text.slice(i + 1, j), 'IMG']);
        i = j;
      }
      else if (c.charCodeAt(0) < 128) {
        var j = i;
        while (j < text.length && text.charCodeAt(j) < 128 && text[j] !== '\n') j += 1;
        toks.push([text.slice(i, j), false]);
        i = j;
      } else {
        toks.push([c, PUNCT.indexOf(c) >= 0]);
        i += 1;
      }
    }
    return toks;
  }

  // 逐字符宽度：正确处理中英混合 token（ASCII 0.55 宽，CJK 1.0 宽）
  function tokWidth(tok, c) {
    var w = 0;
    for (var i = 0; i < tok.length; i++) {
      w += c * (tok.charCodeAt(i) < 128 ? 0.55 : 1.0);
    }
    return w;
  }

  // ---------- 弧长重采样 ----------
  function interpAt(t, xs, ys) {
    if (t <= xs[0]) return ys[0];
    var n = xs.length;
    if (t >= xs[n - 1]) return ys[n - 1];
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (xs[mid] <= t) lo = mid; else hi = mid;
    }
    var d = xs[hi] - xs[lo];
    return d === 0 ? ys[lo] : ys[lo] + (ys[hi] - ys[lo]) * (t - xs[lo]) / d;
  }
  // pts: [[x,y],...]；spacing<=0 表示不重采样
  function resampleArc(pts, spacing) {
    if (pts.length < 2) return pts;
    var s = [0], i;
    for (i = 1; i < pts.length; i++) {
      s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    var total = s[s.length - 1];
    if (spacing > 0 && total <= spacing) return pts;
    var count = spacing > 0 ? Math.ceil((total + spacing) / spacing) : pts.length;
    var out = [];
    for (i = 0; i < count; i++) {
      var t = spacing > 0 ? i * spacing : s[i];
      if (t > total) t = total;
      out.push([interpAt(t, s, pts.map(function (p) { return p[0]; })),
                interpAt(t, s, pts.map(function (p) { return p[1]; }))]);
    }
    if (out.length < 2) out = pts;
    return out;
  }

  // ---------- 引擎一：笔顺中心线 ----------
  function charStrokesMedians(ch, ox, oy, scale, db, rnd) {
    var meds = db[ch];
    if (!meds) return null;
    var ang = (rnd() * 2 - 1) * 1.0 * Math.PI / 180;   // ±1°，笔画写歪一点
    var ca = Math.cos(ang), sa = Math.sin(ang);
    var out = [];
    for (var k = 0; k < meds.length; k++) {
      var stroke = meds[k];
      if (stroke.length < 2) continue;
      var pts = stroke.map(function (p) { return [p[0], p[1]]; });
      var total = 0;
      for (var i = 1; i < pts.length; i++) {
        total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      }
      if (total > 25) pts = resampleArc(pts, 25);
      var res = [];
      for (var j = 0; j < pts.length; j++) {
        var x = (pts[j][0] - 512.0) * scale;
        var y = (512.0 - pts[j][1]) * scale;      // 字体坐标系 y 向上，需翻转
        res.push([ox + x * ca - y * sa, oy + x * sa + y * ca, 0, 0.021]);
      }
      if (res.length >= 2) out.push(res);
    }
    return out.length ? out : null;
  }

  // ---------- Zhang-Suen 细化（原地，0/1） ----------
  function thin(a, w, h) {
    var changed = true, step, mark, x, y;
    while (changed) {
      changed = false;
      for (step = 0; step < 2; step++) {
        mark = [];
        for (y = 1; y < h - 1; y++) {
          for (x = 1; x < w - 1; x++) {
            var i = y * w + x;
            if (a[i] !== 1) continue;
            var p2 = a[(y - 1) * w + x], p3 = a[(y - 1) * w + x + 1];
            var p4 = a[y * w + x + 1], p5 = a[(y + 1) * w + x + 1];
            var p6 = a[(y + 1) * w + x], p7 = a[(y + 1) * w + x - 1];
            var p8 = a[y * w + x - 1], p9 = a[(y - 1) * w + x - 1];
            var B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
            if (B < 2 || B > 6) continue;
            var seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2], A = 0;
            for (var k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) A += 1;
            if (A !== 1) continue;
            var cond = (step === 0)
              ? (p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0)
              : (p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0);
            if (!cond) continue;
            mark.push(i);
          }
        }
        if (mark.length) {
          for (var m = 0; m < mark.length; m++) a[mark[m]] = 0;
          changed = true;
        }
      }
    }
    return a;
  }

  // ---------- 骨架 → 贪心最直行走拆笔画 ----------
  var NB = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  function traceStrokes(a, w, h) {
    var S = {}, i;
    for (i = 0; i < a.length; i++) if (a[i]) S[i] = 1;
    function nbs(k) {
      var y = Math.floor(k / w), x = k % w, out = [], t;
      for (t = 0; t < 8; t++) {
        var ny = y + NB[t][0], nx = x + NB[t][1];
        if (ny >= 0 && ny < h && nx >= 0 && nx < w && S[ny * w + nx]) out.push(ny * w + nx);
      }
      return out;
    }
    var visited = {};
    function ek(p, q) { return p < q ? (p + ',' + q) : (q + ',' + p); }
    var deg = {}, keys = [];
    for (var kk in S) { deg[kk] = nbs(+kk).length; keys.push(+kk); }
    var paths = [];
    function walk(start) {
      var path = [start], prev = null, cur = start;
      for (;;) {
        var candAll = nbs(cur), cand = [], t;
        for (t = 0; t < candAll.length; t++) if (!visited[ek(cur, candAll[t])]) cand.push(candAll[t]);
        if (!cand.length) break;
        var nxt;
        if (prev === null || cand.length === 1) {
          nxt = cand[0];
        } else {
          var dy = Math.floor(cur / w) - Math.floor(prev / w);
          var dx = (cur % w) - (prev % w);
          var nl = Math.hypot(dx, dy);
          var best = null, bs = -2;
          for (t = 0; t < cand.length; t++) {
            var q = cand[t];
            var oy = Math.floor(q / w) - Math.floor(cur / w);
            var ox = (q % w) - (cur % w);
            var ol = Math.hypot(ox, oy);
            var sc = (dx * ox + dy * oy) / (nl * ol);
            if (sc > bs) { bs = sc; best = q; }
          }
          nxt = best;
        }
        visited[ek(cur, nxt)] = 1;
        path.push(nxt);
        prev = cur; cur = nxt;
      }
      return path;
    }
    keys.sort(function (p, q) { return p - q; });
    var t2;
    for (t2 = 0; t2 < keys.length; t2++) {
      var p = keys[t2];
      if (deg[p] !== 1) continue;
      var c1 = nbs(p), has = false;
      for (i = 0; i < c1.length; i++) if (!visited[ek(p, c1[i])]) has = true;
      if (has) paths.push(walk(p));
    }
    for (t2 = 0; t2 < keys.length; t2++) {
      var q2 = keys[t2];
      var c2 = nbs(q2), has2 = false;
      for (i = 0; i < c2.length; i++) if (!visited[ek(q2, c2[i])]) has2 = true;
      if (has2) paths.push(walk(q2));
    }
    function arcLen(pa) {
      var s = 0;
      for (var z = 0; z < pa.length - 1; z++) {
        s += Math.hypot((pa[z + 1] % w) - (pa[z] % w),
                        Math.floor(pa[z + 1] / w) - Math.floor(pa[z] / w));
      }
      return s;
    }
    return paths.filter(function (pa) { return pa.length >= 2 && arcLen(pa) >= 3.0; });
  }

  // ---------- 引擎二：字体骨架兜底 ----------
  function charStrokesSkeleton(ch, ox, oy, scale, raster, rnd) {
    if (!raster) return [];
    var bmp = raster(ch, CANVAS, RENDER);
    if (!bmp) return [];
    var a = new Uint8Array(bmp.data.length), i;
    var any = false;
    for (i = 0; i < bmp.data.length; i++) { a[i] = bmp.data[i] > 128 ? 1 : 0; if (a[i]) any = true; }
    if (!any) return [];
    thin(a, bmp.w, bmp.h);
    var paths = traceStrokes(a, bmp.w, bmp.h);
    // 与 Python 一致：按 (min_y, min_x) 排序
    paths.sort(function (p, q) {
      function mn(pa, f) { var m = Infinity; for (var z = 0; z < pa.length; z++) m = Math.min(m, f(pa[z])); return m; }
      var ay = mn(p, function (k) { return Math.floor(k / bmp.w); });
      var by = mn(q, function (k) { return Math.floor(k / bmp.w); });
      if (ay !== by) return ay - by;
      return mn(p, function (k) { return k % bmp.w; }) - mn(q, function (k) { return k % bmp.w; });
    });
    var ang = (rnd() * 2 - 1) * 2.5 * Math.PI / 180;
    var ca = Math.cos(ang), sa = Math.sin(ang);
    var out = [];
    for (i = 0; i < paths.length; i++) {
      var xy = paths[i].map(function (k) { return [k % bmp.w, Math.floor(k / bmp.w)]; });
      var pts = resampleArc(xy, 3.0);
      if (pts.length < 2) continue;
      var res = [], n = pts.length;
      for (var j = 0; j < n; j++) {
        var x = (pts[j][0] - CANVAS / 2) * scale;
        var y = (pts[j][1] - CANVAS / 2) * scale;
        var taper = Math.min(1.0, j / 3.0, (n - 1 - j) / 3.0);
        var pr = 0.38 + 0.25 * taper + (rnd() * 0.06 - 0.03);
        res.push([ox + x * ca - y * sa, oy + x * sa + y * ca,
                  j * 10, Math.round(pr * 1000) / 1000]);
      }
      out.push(res);
    }
    return out;
  }

  // ---------- 主排版 ----------
  function layout(text, opts) {
    opts = opts || {};
    var cols = opts.cols || 17;
    var ink = (opts.ink === undefined) ? 0xFFE93B : (opts.ink & 0xFFFFFF);
    var db = opts.db || {};
    var raster = opts.raster || null;
    var fit = !!opts.fit;
    var engine = opts.engine || 'auto';
    var rnd = mulberry32(opts.seed === undefined ? 42 : opts.seed);

    var toks = tokenize(text);
    var cell = opts.cell || ((TILE - 2 * MARGIN) / cols);
    var pitchY = opts.pitchY || (cell * 1.35);
    var contentW = opts.contentWidth || (cols * cell);
    var X0 = (opts.originX === undefined) ? MARGIN : opts.originX;
    var Y0 = (opts.originY === undefined) ? MARGIN : opts.originY;
    var rowYFn = opts.rowY || null;                       // 分页：行号 → 全局 y
    var indentW = opts.paragraphIndent ? 2 * cell : 0;    // 段首缩进两格
    var drift = !!opts.sizeDrift;                         // 字号随行缓慢漂移
    var lineOffset = opts.lineOffset || (cell * 1.2);     // rowY → 该行横线 y 的偏移
    var pageCapacity = opts.pageCapacity || null;         // {c0,c1}：封面页/正文页行容量
    var imgList = opts.images || null;                    // 图片元数据（与 \uE000 索引对齐）

    // 行号 → 页号 / 当前页剩余行数（无分页配置时视为单页无限行）
    function pageOfRow(r) {
      if (!pageCapacity) return 0;
      return r < pageCapacity.c0 ? 0 : 1 + Math.floor((r - pageCapacity.c0) / pageCapacity.c1);
    }
    function rowsLeftOnPage(r) {
      if (!pageCapacity) return Infinity;
      return r < pageCapacity.c0
        ? (pageCapacity.c0 - r)
        : (pageCapacity.c1 - ((r - pageCapacity.c0) % pageCapacity.c1));
    }
    // 图片块占行数：按索引取 blockRows；缺失/失败条目回退 1 行
    function imgBlockRows(idx) {
      return (imgList && imgList[idx] && imgList[idx].blockRows) ? imgList[idx].blockRows : 1;
    }

    function layoutRows(c) {
      var rows = 1, x = 0.0, first = true;
      for (var i = 0; i < toks.length; i++) {
        var tok = toks[i][0], isPunct = toks[i][1];
        if (isPunct === 'NL') { rows += 1; x = 0.0; first = true; continue; }
        if (isPunct === 'IMG') {
          var bi = parseInt(tok.slice(1), 10);
          var br = imgBlockRows(bi);
          var cur = rows - 1;
          var left = rowsLeftOnPage(cur);
          if (br > left) { rows += left; }        // 本页放不下 → 空白行推到下一页起点
          rows += br; x = 0.0; first = true;
          continue;
        }
        if (first && indentW) { x = indentW; first = false; }
        var w = tokWidth(tok, c);
        if (w > contentW) {
          // 超长 token（如无空格长串）：逐字符断行，避免溢出
          for (var j = 0; j < tok.length; j++) {
            var cw = c * (tok.charCodeAt(j) < 128 ? 0.55 : 1.0);
            if (x + cw > contentW && x > 0) { rows += 1; x = 0.0; }
            x += cw;
          }
        } else {
          if (x + w > contentW && !isPunct) { rows += 1; x = 0.0; }
          x += w;
        }
      }
      return rows;
    }
    var rows = layoutRows(cell);
    var availH = TILE - MARGIN - MARGIN;
    if (fit && rows * pitchY + cell > availH) {
      var k = availH / (rows * pitchY + cell);
      cell *= k; pitchY *= k;
      rows = layoutRows(cell);
    }
    var scale = cell / CANVAS;
    var mscale = cell / 1024.0;

    var strokes = [], nMed = 0, nSkel = 0, row = 0, x = 0.0, first = true;
    var imgLayout = [];                       // 图片块定位：{idx,page,x,y,w,h}（全局坐标）
    for (var i = 0; i < toks.length; i++) {
      var tok = toks[i][0], isPunct = toks[i][1];
      if (isPunct === 'NL') { row += 1; x = 0.0; first = true; continue; }
      if (isPunct === 'IMG') {
        var bi = parseInt(tok.slice(1), 10);
        var im = (imgList && imgList[bi]) ? imgList[bi] : null;
        var br = im && im.blockRows ? im.blockRows : 1;
        var left = rowsLeftOnPage(row);
        if (br > left) { row += left; x = 0.0; first = true; }   // 与 layoutRows 同口径防跨页
        if (im && rowYFn) {
          // 行块带域：[该块首行横线顶, 末行横线底]；行横线 y = rowY + lineOffset
          var bandTop = rowYFn(row) + lineOffset - pitchY;
          var bandBot = rowYFn(row + br - 1) + lineOffset;
          var bandH = bandBot - bandTop;
          var pad = pitchY * 0.25;
          var w = Math.min(im.w, contentW - 2 * pad);
          var h = w * (im.h / Math.max(1, im.w));
          if (h > bandH - 2 * pad) { h = Math.max(1, bandH - 2 * pad); w = h * (im.w / Math.max(1, im.h)); }
          var _fl = { idx: bi, page: pageOfRow(row),
            x: X0 + (contentW - w) / 2,
            y: bandTop + (bandH - h) / 2,
            w: w, h: h };
          imgLayout.push(_fl);
          /* [FORMULA-FIX] 公式位图 → 骨架笔迹：thin + traceStrokes 后缩放平移到
           * imgLayout 定位（与图片同位同缩放），使 .hinote（纯笔迹格式）里公式可见。 */
          if (im.bitmap && im.bitmap.data) {
            var ba = new Uint8Array(im.bitmap.data.length);
            for (var bq = 0; bq < ba.length; bq++) ba[bq] = im.bitmap.data[bq] > 128 ? 1 : 0;
            thin(ba, im.bitmap.w, im.bitmap.h);
            var fpaths = traceStrokes(ba, im.bitmap.w, im.bitmap.h);
            var fsx = _fl.w / im.bitmap.w, fsy = _fl.h / im.bitmap.h;
            for (var fp = 0; fp < fpaths.length; fp++) {
              var fpts = fpaths[fp];
              if (!fpts || fpts.length < 2) continue;
              var fpts2 = [];
              for (var fq = 0; fq < fpts.length; fq++) {
                fpts2.push([_fl.x + fpts[fq][0] * fsx, _fl.y + fpts[fq][1] * fsy, 0, 0.021]);
              }
              strokes.push(new Hinote.Stroke(fpts2, ink));
            }
          }
        }
        row += br; x = 0.0; first = true;
        continue;
      }
      if (first && indentW) { x = indentW; first = false; }
      var tw = tokWidth(tok, cell);
      var canBreak = tw > contentW;   // 超长 token（如无空格长串）允许逐字符断行
      if (!canBreak && x + tw > contentW && !isPunct) { row += 1; x = 0.0; }
      var dS = drift ? (1 + 0.012 * Math.sin(row * 0.37 + 1.1)) : 1;
      for (var j = 0; j < tok.length; j++) {
        var ch = tok[j];
        var jitter = 1 + (rnd() - 0.5) * 0.05;                 // 逐字大小 ±2.5%
        var cw = cell * dS * jitter * (ch.charCodeAt(0) < 128 ? 0.55 : 1.0);
        if (canBreak && x + cw > contentW && x > 0) { row += 1; x = 0.0; }
        var jx = rnd() * 3 - 1.5, jy = rnd() * 3 - 1.5;        // 位置抖动 ±1.5 单位
        var wobble = 2.0 * Math.sin((x / cell) * 0.45 + row * 1.7);  // 行基线波动
        var ox = X0 + x + cw / 2 + jx;
        var baseY = rowYFn ? rowYFn(row) : (Y0 + row * pitchY);
        var oy = baseY + cell * dS * jitter / 2 + jy + wobble;
        var cs = null;
        if (engine !== 'skeleton') cs = charStrokesMedians(ch, ox, oy, mscale * dS * jitter, db, rnd);
        if (cs === null) {
          cs = charStrokesSkeleton(ch, ox, oy, scale * dS * jitter, raster, rnd);
          nSkel += 1;
        } else {
          nMed += 1;
        }
        for (var k = 0; k < cs.length; k++) strokes.push(new Hinote.Stroke(cs[k], ink));
        x += cw;
      }
    }

    return {
      strokes: strokes,
      imgLayout: imgLayout,
      stats: {
        cols: cols, cell: cell, rows: row + 1, pitchY: pitchY,
        medians: nMed, skeleton: nSkel,
        points: strokes.reduce(function (a, s) { return a + s.points.length; }, 0)
      }
    };
  }

  return { layout: layout, tokenize: tokenize, thin: thin, traceStrokes: traceStrokes, resampleArc: resampleArc };
})(XYHinote);


/* paper.js — 作业手写纸（多页版）：A4 空白横格纸（唯一版式）
   几何沿用原「课程论文、大作业专用纸」实测参数（大作业纸/笔记版版式均已移除）：
     A4 210x297mm；左右边距 1800dxa=31.75mm；正文横格行高 567dxa=10mm。
   画布换算：内容宽 2200 单位 = 210mm，1mm = 2200/210。
   结构：每页画纸边框 + 横格画满整页 + 页码；页与页纵向排列、留 25mm 间隔。
   图片：o.images[{src,w,h}] 与文本内 \uE000<idx> 标记一一对应，排版引擎按行块占行
     并输出 imgLayout（全局坐标），由导出层渲染嵌入；图片块不跨页（放不下整体推至下一页）。
   真人感：段首缩进两格、字号随行缓慢漂移、行基线波动、逐字抖动（都在排版引擎里）。
*/
var XYPaper = (function (Hinote, Layout) {  'use strict';

  var MM = 2200 / 210;
  var PAGE_W = 210 * MM;
  var PAGE_H = 297 * MM;
  var PAGE_GAP = 25 * MM;       // 页与页的间隔
  var SIDE = 31.75 * MM;        // 左右页边距（原纸 pgMar）
  var ROW_H = 10 * MM;          // 横格行高（原纸 trHeight 567dxa）
  var CELL = 6.3 * MM;          // 正文字大小（约 63% 格高，一行约 24 字）
  var BASELINE_GAP = 0.8 * MM;  // 字底距横格线的空隙
  var FOOT_H = 16 * MM;         // 页脚（页码）区高
  var PLAIN_PAD = 18 * MM;      // 顶部/页眉留白
  var X0 = 150, Y0 = 150;
  var BODY_ROWS = Math.floor((PAGE_H - PLAIN_PAD - FOOT_H) / ROW_H);  // 每页正文行数

  function pageTop(p) { return Y0 + p * (PAGE_H + PAGE_GAP); }
  function bodyX() { return X0 + SIDE; }
  function bodyW() { return PAGE_W - 2 * SIDE; }

  function dottedLine(x1, y1, x2, y2, color, dashLen, gapLen) {
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.hypot(dx, dy);
    var ux = dx / len, uy = dy / len;
    var out = [], pos = 0;
    while (pos < len) {
      var s = pos;
      var e = Math.min(pos + dashLen, len);
      out.push(new Hinote.Stroke([[x1 + ux * s, y1 + uy * s, 0, 0.3], [x1 + ux * e, y1 + uy * e, 0, 0.3]], color));
      pos += dashLen + gapLen;
    }
    return out;
  }

  function line(x1, y1, x2, y2, color) {
    return new Hinote.Stroke([[x1, y1, 0, 0.021], [x2, y2, 0, 0.021]], color);
  }

  // 印刷体抬头：真实字体（宋体）渲染 → 骨架 → 笔划；无旋转无抖动，横平竖直
  function putPrinted(out, txt, pt, y, color, bold, center, o, fontFamily) {
    if (!o.rasterPrinted) return;
    var cellU = pt * 0.3528 * MM;       // pt → 画布单位（1pt = 0.3528mm）
    var REND = 120;                     // 渲染字号（像素）
    var w = 0, i;
    for (i = 0; i < txt.length; i++) {
      w += cellU * (txt.charCodeAt(i) < 128 ? 0.5 : 1.0);
    }
    var ox = center ? (X0 + (PAGE_W - w) / 2) : bodyX();
    var x = 0;
    for (i = 0; i < txt.length; i++) {
      var ch = txt[i];
      if (ch === ' ') { x += cellU * 0.5; continue; }
      var bmp = o.rasterPrinted(ch, REND, bold, fontFamily);
      if (!bmp) { x += cellU; continue; }
      var a = new Uint8Array(bmp.data.length), any = false, k;
      for (k = 0; k < bmp.data.length; k++) {
        a[k] = bmp.data[k] > 128 ? 1 : 0;
        if (a[k]) any = true;
      }
      if (!any) { x += cellU; continue; }
      Layout.thin(a, bmp.w, bmp.h);
      var paths = Layout.traceStrokes(a, bmp.w, bmp.h);
      var scale = cellU / (REND * 0.9);   // 字形高 ≈ 0.9 × 渲染字号
      paths.sort(function (p, q) {
        function mn(pa, f) { var m = Infinity; for (var z = 0; z < pa.length; z++) m = Math.min(m, f(pa[z])); return m; }
        var ay = mn(p, function (kk) { return Math.floor(kk / bmp.w); });
        var by = mn(q, function (kk) { return Math.floor(kk / bmp.w); });
        if (ay !== by) return ay - by;
        return mn(p, function (kk) { return kk % bmp.w; }) - mn(q, function (kk) { return kk % bmp.w; });
      });
      var cx = ox + x + cellU / 2, cy = y + cellU / 2;
      for (k = 0; k < paths.length; k++) {
        var xy = paths[k].map(function (kk) { return [kk % bmp.w, Math.floor(kk / bmp.w)]; });
        var pts = Layout.resampleArc(xy, 3);
        if (pts.length < 2) continue;
        var res = [];
        for (var j = 0; j < pts.length; j++) {
          res.push([cx + (pts[j][0] - bmp.w / 2) * scale,
                    cy + (pts[j][1] - bmp.h / 2) * scale, j * 10, 0.3]);
        }
        out.push(new Hinote.Stroke(res, color));
      }
      x += cellU;
    }
  }

  // 纸张边框（表示一页纸的物理边界）
  function frame(p, o) {
    var t = pageTop(p), b = t + PAGE_H;
    var L = X0 + SIDE * 0.45, R = X0 + PAGE_W - SIDE * 0.45;
    var c = o.frameColor === undefined ? 0xCBCBCB : o.frameColor;
    return [
      line(L, t, R, t, c), line(L, b, R, b, c),
      line(L, t, L, b, c), line(R, t, R, b, c)
    ];
  }

  // 该页的横格：画满整页容量（纸是完整的，不因没写满而缺行）
  function ruled(p, n, o) {
    var t = (p === 0 ? pageTop(0) + o.headH : pageTop(p) + o.subHeadH);
    var c = o.ruleColor === undefined ? 0xB9B9B9 : o.ruleColor;
    var out = [], i;
    for (i = 0; i <= n; i++) {
      var y = t + i * ROW_H;
      out = out.concat(dottedLine(bodyX(), y, bodyX() + bodyW(), y, c, 2.5 * MM, 1.5 * MM));
    }
    return out;
  }

  function pageNum(p, o) {
    var out = [];
    putPrinted(out, '第 ' + (p + 1) + ' 页', 10.5,
               pageTop(p) + PAGE_H - 100, 0x666666, false, true, o);
    return out;
  }

  function build(text, o) {
    o = o || {};
    var ink = (o.ink === undefined) ? 0x000000 : o.ink;
    // 唯一版式：A4 空白横格纸（大作业纸/笔记版已移除）
    o.headH = PLAIN_PAD;
    o.subHeadH = PLAIN_PAD;
    o.c0 = BODY_ROWS;
    o.c1 = BODY_ROWS;
    o.ruleColor = o.ruleColor === undefined ? 0xB9B9B9 : o.ruleColor;
    o.frameColor = o.frameColor === undefined ? 0xCBCBCB : o.frameColor;
    // 图片块：w/h 为画布单位；blockRows 按高占行（含一行呼吸），上限一页容量防死循环
    var images = null;
    if (Array.isArray(o.images) && o.images.length) {
      images = o.images.map(function (im) {
        if (!im) return null;
        var w = Math.max(1, im.w || 100), h = Math.max(1, im.h || 100);
        var br = Math.max(1, Math.ceil(h / ROW_H) + 1);
        if (br > BODY_ROWS - 1) br = BODY_ROWS - 1;
        return { src: im.src, w: w, h: h, blockRows: br, bitmap: im.bitmap || null };
      });
    }
    var common = {
      cell: CELL, pitchY: ROW_H, contentWidth: bodyW(),
      originX: bodyX(), db: o.db, raster: o.raster, ink: ink,
      seed: o.seed === undefined ? 42 : o.seed,
      paragraphIndent: true, sizeDrift: true,
      lineOffset: CELL + BASELINE_GAP,
      pageCapacity: { c0: BODY_ROWS, c1: BODY_ROWS },
      images: images
    };

    // 第一遍：估行数 → 算页数与每行的全局 y
    var probe = Layout.layout(text || '', common);
    var rows = probe.stats.rows;
    var pages = rows <= o.c0 ? 1 : 1 + Math.ceil((rows - o.c0) / o.c1);
    // rowY 返回「字格顶部」：使字底坐在该行的横线上（横线为每行下边界）
    function rowY(row) {
      var lineY;
      if (row < o.c0) {
        lineY = pageTop(0) + o.headH + (row + 1) * ROW_H;
      } else {
        var r = row - o.c0;
        lineY = pageTop(1 + Math.floor(r / o.c1)) + o.subHeadH + ((r % o.c1) + 1) * ROW_H;
      }
      return lineY - CELL - BASELINE_GAP;
    }
    common.rowY = rowY;

    // 第二遍：正式排版（相同种子，几何与预览一致）
    var body = Layout.layout(text || '', common);

    var strokes = [], p;
    for (p = 0; p < pages; p++) {
      strokes = strokes.concat(frame(p, o));
      strokes = strokes.concat(ruled(p, p === 0 ? o.c0 : o.c1, o));
      strokes = strokes.concat(pageNum(p, o));
    }
    strokes = strokes.concat(body.strokes);

    return {
      strokes: strokes,
      imgLayout: body.imgLayout || [],
      pageColor: o.pageColor === undefined ? -1 : o.pageColor,
      pageInfo: {
        pages: pages,
        top: pageTop,          // pageTop(p) = 第 p 页的全局 y 起点
        height: PAGE_H,
        width: PAGE_W,
        x0: X0,
        gap: PAGE_GAP
      },
      stats: {
        pages: pages, rows: rows, coverRows: o.c0, bodyRows: o.c1,
        chars: body.stats.medians + body.stats.skeleton,
        medians: body.stats.medians, skeleton: body.stats.skeleton,
        bodyStrokes: body.strokes.length,
        points: strokes.reduce(function (a, s) { return a + s.points.length; }, 0),
        paperHeightMM: Math.round((pages * PAGE_H + (pages - 1) * PAGE_GAP) / MM)
      }
    };
  }

  return { build: build, MM: MM, BODY_ROWS: BODY_ROWS };
})(XYHinote, XYLayout);


/* export.js — 把论文纸的每一页渲染成分页 JPG 与合成 PDF（纯前端，零依赖）
   PDF 为手写最小实现：每页嵌入一张 JPEG（DCTDecode），A4 MediaBox。 */
var XYExport = (function (Hinote) {  'use strict';

  var A4_W_PT = 595.28, A4_H_PT = 841.89;

  // 把第 p 页渲染到 canvas（dpi 控制清晰度，150 → 1240x1754）
  // imgs: [{page,x,y,w,h,img}] 全局坐标（来自 XYPaper.imgLayout + HTMLImageElement）；
  // 先画白色底盖住横格线，再画图，保证图片区干净。
  function pageCanvas(paper, strokes, p, dpi, imgs) {
    var info = paper.pageInfo;
    var W = Math.round(210 / 25.4 * dpi), H = Math.round(297 / 25.4 * dpi);
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var g = cv.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, H);
    var top = info.top(p), bottom = top + info.height;
    var k = W / info.width;
    var x0 = info.x0;
    var lw = Math.max(0.8, 6.6 * k);        // 笔宽约 0.63mm

    strokes.forEach(function (s) {
      var y0 = s.points[0][1];
      if (y0 < top - 60 || y0 > bottom + 60) return;   // 只画本页（含少量越界容差）
      g.strokeStyle = '#' + ('000000' + (s.color & 0xFFFFFF).toString(16)).slice(-6);
      g.lineWidth = lw;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      s.points.forEach(function (pt, i) {
        var X = (pt[0] - x0) * k, Y = (pt[1] - top) * k;
        if (i) g.lineTo(X, Y); else g.moveTo(X, Y);
      });
      g.stroke();
    });

    (imgs || []).forEach(function (im) {
      if (im.page !== p) return;
      var X = (im.x - x0) * k, Y = (im.y - top) * k;
      var W2 = im.w * k, H2 = im.h * k;
      g.fillStyle = '#ffffff';
      g.fillRect(X - 1, Y - 1, W2 + 2, H2 + 2);        // 盖住横格线
      if (im.img && im.img.width) {
        try { g.drawImage(im.img, X, Y, W2, H2); }
        catch (e) { /* 解码失败降级：仅留白 */ }
      }
    });
    return cv;
  }

  function toJPEG(cv, quality) {
    return new Promise(function (resolve, reject) {
      cv.toBlob(function (b) {
        if (!b) { reject(new Error('toBlob failed')); return; }
        b.arrayBuffer().then(function (ab) {
          resolve({ data: new Uint8Array(ab), w: cv.width, h: cv.height });
        }, reject);
      }, 'image/jpeg', quality || 0.92);
    });
  }

  function saveBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  // 按页导出 JPG：每页触发一次下载
  function downloadJPGs(paper, strokes, title, dpi, quality, imgs) {
    var info = paper.pageInfo;
    var chain = Promise.resolve();
    for (var p = 0; p < info.pages; p++) {
      (function (p) {
        chain = chain.then(function () {
          var cv = pageCanvas(paper, strokes, p, dpi || 150, imgs);
          return toJPEG(cv, quality).then(function (jp) {
            saveBlob(new Blob([jp.data], { type: 'image/jpeg' }),
                     title + '_p' + (p + 1) + '.jpg');
          });
        });
      })(p);
    }
    return chain;
  }

  // ---------- 最小 PDF writer：图片页合成 ----------
  function makePDF(jpegs, wPt, hPt) {
    var TE = new TextEncoder();
    var chunks = [], pos = 0, offsets = [];
    function w(b) { chunks.push(b); pos += b.length; }
    function ws(s) { w(TE.encode(s)); }
    function num(n) { offsets[n] = pos; }

    w(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34,
                      0x0A, 0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    var n = jpegs.length, kids = [], i;
    for (i = 0; i < n; i++) kids.push((3 + 3 * i) + ' 0 R');

    num(1);
    ws('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    num(2);
    ws('2 0 obj\n<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >>\nendobj\n');

    jpegs.forEach(function (jp, i) {
      var pN = 3 + 3 * i, imN = 4 + 3 * i, cN = 5 + 3 * i;
      num(pN);
      ws(pN + ' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' +
         wPt + ' ' + hPt + '] /Resources << /XObject << /Im0 ' + imN +
         ' 0 R >> >> /Contents ' + cN + ' 0 R >>\nendobj\n');
      num(imN);
      ws(imN + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + jp.w +
         ' /Height ' + jp.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8' +
         ' /Filter /DCTDecode /Length ' + jp.data.length + ' >>\nstream\n');
      w(jp.data);
      ws('\nendstream\nendobj\n');
      var content = 'q\n' + wPt + ' 0 0 ' + hPt + ' 0 0\ncm\n/Im0 Do\nQ\n';
      num(cN);
      ws(cN + ' 0 obj\n<< /Length ' + content.length + ' >>\nstream\n' +
         content + 'endstream\nendobj\n');
    });

    var maxObj = 2 + 3 * n, xrefPos = pos;
    var xs = 'xref\n0 ' + (maxObj + 1) + '\n0000000000 65535 f \n';
    for (i = 1; i <= maxObj; i++) {
      xs += ('0000000000' + String(offsets[i])).slice(-10) + ' 00000 n \n';
    }
    ws(xs);
    ws('trailer\n<< /Size ' + (maxObj + 1) + ' /Root 1 0 R >>\nstartxref\n' +
       xrefPos + '\n%%EOF\n');

    var total = 0;
    chunks.forEach(function (c) { total += c.length; });
    var out = new Uint8Array(total), o = 0;
    chunks.forEach(function (c) { out.set(c, o); o += c.length; });
    return out;
  }

  function downloadPDF(paper, strokes, title, dpi, quality, imgs) {
    var info = paper.pageInfo;
    var jobs = [], p;
    for (p = 0; p < info.pages; p++) {
      (function (p) {
        jobs.push(toJPEG(pageCanvas(paper, strokes, p, dpi || 150, imgs), quality || 0.92));
      })(p);
    }
    return Promise.all(jobs).then(function (jpegs) {
      var pdf = makePDF(jpegs, A4_W_PT, A4_H_PT);
      saveBlob(new Blob([pdf], { type: 'application/pdf' }), title + '.pdf');
      return pdf.length;
    });
  }

  return {
    pageCanvas: pageCanvas, downloadJPGs: downloadJPGs,
    downloadPDF: downloadPDF, makePDF: makePDF
  };
})(XYHinote);

    /* 笔顺库（Make Me a Hanzi 常用字子集）：字符 → 笔顺中心线数组，
     * 1024 坐标系。库外字与标点由 xyHWRaster 走字体骨架兜底。 */
    var XY_HW_DB = null;
    var XY_HW_DB_URL = 'https://gitee.com/fieldlu/xy-handwriting-archive/raw/main/xy-hw-db.json';
    var xyhDbReady = null;
    /** 笔顺库懒加载（外置分发：脚本本体不含 2.3MB 字库，过 ScriptCat 2MB 上限）。
     * GM 特权拉取 + 自动重试 2 次；UI 挂载后预取，首次导出零等待。 */
    function xyhDbCacheKey() { return 'xyh_db_' + (typeof GM_info !== 'undefined' && GM_info.script ? GM_info.script.version : '0'); }
    function xyhLoadDb() {
        if (xyhDbReady) return xyhDbReady;
        try {
            var cached = (typeof GM_getValue === 'function') ? GM_getValue(xyhDbCacheKey(), '') : '';
            if (cached) { XY_HW_DB = JSON.parse(cached); xyhDbReady = Promise.resolve(XY_HW_DB); return xyhDbReady; }
        } catch (e) { /* 缓存读取失败走网络 */ }
        xyhDbReady = new Promise(function (resolve, reject) {
            var attempt = 0;
            var run = function () {
                attempt++;
                var fail = function (why) {
                    if (attempt >= 3) { xyhDbReady = null; reject(new Error(why + '（已重试 2 次）')); return; }
                    setTimeout(run, 1500);
                };
                GM_xmlhttpRequest({
                    method: 'GET', url: XY_HW_DB_URL, timeout: 60000,
                    onload: function (r) {
                        if (r.status !== 200 || !r.responseText) return fail('笔顺库加载 HTTP ' + r.status);
                        try { XY_HW_DB = JSON.parse(r.responseText); try { if (typeof GM_setValue === 'function') GM_setValue(xyhDbCacheKey(), r.responseText); } catch (e) {} resolve(XY_HW_DB); }
                        catch (e) { fail('笔顺库解析失败: ' + (e.message || e)); }
                    },
                    onerror: function () { fail('笔顺库网络错误'); },
                    ontimeout: function () { fail('笔顺库加载超时'); }
                });
            };
            run();
        });
        return xyhDbReady;
    }

    /* LaTeX → Unicode 线性化映射表（xy-hw-tex.json）：希腊字母 / 运算符 / 上下标
     * 全部外置分发，脚本本体不内嵌映射数据。加载方式与笔顺库一致：
     * GM 特权拉取 + 版本缓存 + 懒加载；加载失败静默降级（仅保留结构命令兜底）。 */
    var _XY_HW_TEX = null;
    var XY_HW_TEX_URL = 'https://gitee.com/fieldlu/xy-handwriting-archive/raw/main/xy-hw-tex.json';
    var xyhTexReady = null;
    /* 结构命令兜底：仅排版控制符（非字符映射），映射表未就绪时保证 \left 等不被剥成残留文字 */
    var _XY_HW_TEX_CORE_OPS = { left: '', right: '', big: '', Big: '', bigg: '', Bigg: '', displaystyle: '', textstyle: '', scriptstyle: '', limits: '', nolimits: '' };
    function xyhTexCacheKey() { return 'xyh_tex_' + (typeof GM_info !== 'undefined' && GM_info.script ? GM_info.script.version : '0'); }
    function xyhLoadTexMap() {
        if (xyhTexReady) return xyhTexReady;
        try {
            var cached = (typeof GM_getValue === 'function') ? GM_getValue(xyhTexCacheKey(), '') : '';
            if (cached) { _XY_HW_TEX = JSON.parse(cached); xyhTexReady = Promise.resolve(_XY_HW_TEX); return xyhTexReady; }
        } catch (e) { /* 缓存读取失败走网络 */ }
        xyhTexReady = new Promise(function (resolve) {
            var attempt = 0;
            var run = function () {
                attempt++;
                var done = function (map) {
                    _XY_HW_TEX = map;
                    try { if (typeof GM_setValue === 'function' && map) GM_setValue(xyhTexCacheKey(), JSON.stringify(map)); } catch (e) {}
                    resolve(map);
                };
                var giveUp = function (why) { xyhTexReady = null; resolve(null); };
                GM_xmlhttpRequest({
                    method: 'GET', url: XY_HW_TEX_URL, timeout: 30000,
                    onload: function (r) {
                        if (r.status !== 200 || !r.responseText) { if (attempt >= 3) return giveUp('映射表 HTTP ' + r.status); return setTimeout(run, 1500); }
                        try { done(JSON.parse(r.responseText)); }
                        catch (e) { if (attempt >= 3) return giveUp('映射表解析失败'); setTimeout(run, 1500); }
                    },
                    onerror: function () { if (attempt >= 3) return giveUp('映射表网络错误'); setTimeout(run, 1500); },
                    ontimeout: function () { if (attempt >= 3) return giveUp('映射表加载超时'); setTimeout(run, 1500); }
                });
            };
            run();
        });
        return xyhTexReady;
    }

    /* 应用内更新提醒：拉取 hw-script.latest.json 比对版本，6 小时频控。
     * 脚本管理器另有 @updateURL 自动更新，此提示兜底让用户感知更新内容。 */
    function xyhCheckUpdate() {
        try {
            var KEY = 'xyh_upd_at';
            var now = Date.now();
            var last = 0;
            try { last = Number((typeof GM_getValue === 'function') ? GM_getValue(KEY, 0) : localStorage.getItem(KEY)) || 0; } catch (e) {}
            if (now - last < 6 * 3600 * 1000) return;
            try { if (typeof GM_setValue === 'function') GM_setValue(KEY, String(now)); localStorage.setItem(KEY, String(now)); } catch (e) {}
            var myVer = (typeof GM_info !== 'undefined' && GM_info.script) ? GM_info.script.version : '';
            GM_xmlhttpRequest({
                method: 'GET', url: 'https://gitee.com/fieldlu/xy-handwriting-archive/raw/main/hw-script.latest.json', timeout: 20000,
                onload: function (r) {
                    if (r.status !== 200 || !r.responseText) return;
                    try {
                        var j = JSON.parse(r.responseText);
                        if (j.version && j.version !== myVer) {
                            xyhToast('🆕 发现新版本 v' + j.version + '（当前 v' + myVer + '）' + (j.notes && j.notes[0] ? '：' + j.notes[0] : '') + '，请从安装渠道更新', 'info');
                        }
                    } catch (e) {}
                }
            });
        } catch (e) {}
    }

    /* ---------- 应用内「检查更新」按钮 + 弹窗（交互对齐小雅辅助工具） ----------
     * 手动检查绕过 6h 频控；清单含 installUrl（新版一键跳安装页）与 notes 更新日志。 */
    var XYH_LATEST_URL = 'https://gitee.com/fieldlu/xy-handwriting-archive/raw/main/hw-script.latest.json';
    var XYH_INSTALL_URL = 'https://gitee.com/fieldlu/xy-handwriting-archive/raw/main/%E5%B0%8F%E9%9B%85%E4%BD%9C%E4%B8%9A%E5%8D%8E%E4%B8%BA%E7%AC%94%E8%AE%B0%E5%AF%BC%E5%87%BA.user.js';
    var _xyhUpdState = { checking: false, info: null, error: '' };
    var _xyhUpdModal = null;
    function xyhCurVer() { return (typeof GM_info !== 'undefined' && GM_info.script) ? GM_info.script.version : ''; }
    function xyhCmpVer(a, b) {
        var pa = String(a || '').split('.'), pb = String(b || '').split('.');
        for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
            var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
            if (x !== y) return x - y;
        }
        return 0;
    }
    function xyhEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function xyhThemeNow() {
        var f = document.getElementById('xyh-fab');
        return (f && f.getAttribute('data-theme') === 'light') ? 'light' : 'dark';
    }
    function xyhUpdHasNew() {
        var info = _xyhUpdState.info;
        return !!(info && info.version && xyhCmpVer(info.version, xyhCurVer()) > 0);
    }
    function xyhUpdFetch() {
        _xyhUpdState.checking = true; _xyhUpdState.error = '';
        xyhUpdRender();
        GM_xmlhttpRequest({
            method: 'GET', url: XYH_LATEST_URL + '?t=' + Date.now(), timeout: 20000,
            onload: function (r) {
                _xyhUpdState.checking = false;
                if (r.status !== 200 || !r.responseText) { _xyhUpdState.error = 'HTTP ' + r.status; xyhUpdRender(); return; }
                try { _xyhUpdState.info = JSON.parse(r.responseText); }
                catch (e) { _xyhUpdState.error = '清单解析失败'; }
                xyhUpdRender();
            },
            onerror: function () { _xyhUpdState.checking = false; _xyhUpdState.error = '网络错误（Gitee 不可达）'; xyhUpdRender(); },
            ontimeout: function () { _xyhUpdState.checking = false; _xyhUpdState.error = '检查超时'; xyhUpdRender(); }
        });
    }
    function xyhUpdRender() {
        if (!_xyhUpdModal || !document.body.contains(_xyhUpdModal)) return;
        var box = _xyhUpdModal.querySelector('#xyh-upd-box');
        if (!box) return;
        var v = xyhThemeVars(xyhThemeNow());
        var dark = xyhThemeNow() === 'dark';
        var T = function (dk, lt) { return dark ? dk : lt; };
        var cur = xyhCurVer() || '-';
        var info = _xyhUpdState.info || {};
        var latest = info.version || '-';
        var hasNew = xyhUpdHasNew();
        var statusText = _xyhUpdState.checking ? '⏳ 正在检查更新...'
            : (_xyhUpdState.error ? ('❌ 检查失败：' + _xyhUpdState.error)
            : (info.version ? (hasNew ? ('🎉 发现新版本 v' + latest) : '✅ 当前已是最新版本') : '尚未检查'));
        var statusColor = _xyhUpdState.error ? '#f87171' : (hasNew ? '#34d399' : T('#818cf8', '#4f46e5'));
        var notes = Array.isArray(info.notes) ? info.notes : [];
        var notesHtml = notes.length
            ? '<div style="margin-bottom:14px; padding:11px 13px; background:' + T('rgba(129,140,248,0.08)', '#f8fafc') + '; border:1px solid ' + T('rgba(71,85,105,0.3)', '#e2e8f0') + '; border-radius:10px;">' +
              '<div style="font-size:12px; font-weight:700; color:' + v.text + '; margin-bottom:6px;">📋 更新内容</div>' +
              '<ul style="margin:0; padding-left:18px; color:' + v.text2 + '; line-height:1.7; font-size:12px;">' +
              notes.map(function (n) { return '<li style="margin:2px 0;">' + xyhEsc(n) + '</li>'; }).join('') + '</ul></div>'
            : '';
        box.innerHTML =
            '<div style="background:' + v.surface + '; border:1px solid ' + v.border + '; border-radius:14px; width:400px; max-width:92%; max-height:82vh; overflow-y:auto; padding:22px; box-shadow:0 20px 50px rgba(0,0,0,0.35); position:relative;">' +
                '<div style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">' +
                    '<div style="width:38px; height:38px; border-radius:10px; background:' + T('rgba(129,140,248,0.12)', '#eef2ff') + '; display:flex; align-items:center; justify-content:center; font-size:19px;">↻</div>' +
                    '<div><div style="color:' + v.text + '; font-size:15.5px; font-weight:700;">脚本更新</div>' +
                    '<div style="color:' + v.muted + '; font-size:11px; margin-top:2px;">通过 Gitee 版本清单检查，交由脚本管理器安装</div></div>' +
                '</div>' +
                '<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:13px;">' +
                    '<div style="background:' + v.surface2 + '; border:1px solid ' + v.border + '; border-radius:10px; padding:12px;">' +
                        '<div style="font-size:10.5px; font-weight:700; color:' + v.muted + '; margin-bottom:4px;">当前版本</div>' +
                        '<div style="color:' + T('#818cf8', '#4f46e5') + '; font-size:20px; font-weight:800;">' + xyhEsc(cur) + '</div></div>' +
                    '<div style="background:' + v.surface2 + '; border:1px solid ' + (hasNew ? '#34d39966' : v.border) + '; border-radius:10px; padding:12px;">' +
                        '<div style="font-size:10.5px; font-weight:700; color:' + v.muted + '; margin-bottom:4px;">最新版本</div>' +
                        '<div style="color:' + (hasNew ? '#34d399' : T('#818cf8', '#4f46e5')) + '; font-size:20px; font-weight:800;">' + xyhEsc(latest) + '</div></div>' +
                '</div>' +
                '<div style="color:' + statusColor + '; font-size:12.5px; font-weight:700; margin-bottom:12px;">' + statusText + '</div>' +
                notesHtml +
                '<div style="display:flex; gap:9px; justify-content:flex-end; flex-wrap:wrap;">' +
                    '<button id="xyh-upd-close" style="padding:8px 16px; border:1px solid ' + v.border + '; background:transparent; color:' + v.text2 + '; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; font-family:inherit;">关闭</button>' +
                    '<button id="xyh-upd-check" style="padding:8px 16px; border:1px solid ' + T('rgba(129,140,248,0.4)', '#c7d2fe') + '; background:' + T('rgba(129,140,248,0.1)', '#eef2ff') + '; color:' + T('#a5b4fc', '#4f46e5') + '; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; font-family:inherit;"' + (_xyhUpdState.checking ? ' disabled' : '') + '>' + (_xyhUpdState.checking ? '⏳ 检查中...' : '↻ 重新检查') + '</button>' +
                    '<button id="xyh-upd-open"' + (hasNew ? '' : ' disabled') + ' style="padding:8px 16px; border:none; background:' + (hasNew ? 'linear-gradient(135deg,#818cf8,#6366f1)' : T('rgba(71,85,105,0.3)', '#e2e8f0')) + '; color:' + (hasNew ? '#fff' : v.muted) + '; border-radius:8px; font-size:12px; font-weight:600; cursor:' + (hasNew ? 'pointer' : 'not-allowed') + '; font-family:inherit;">' + (hasNew ? '⬇ 打开安装页' : '已是最新') + '</button>' +
                '</div>' +
            '</div>';
        var bClose = box.querySelector('#xyh-upd-close');
        if (bClose) bClose.onclick = function (e) { e.stopPropagation(); xyhUpdClose(); };
        var bCheck = box.querySelector('#xyh-upd-check');
        if (bCheck) bCheck.onclick = function (e) { e.stopPropagation(); if (!_xyhUpdState.checking) xyhUpdFetch(); };
        var bOpen = box.querySelector('#xyh-upd-open');
        if (bOpen) bOpen.onclick = function (e) {
            e.stopPropagation();
            if (!xyhUpdHasNew()) return;
            var url = (_xyhUpdState.info && _xyhUpdState.info.installUrl) || XYH_INSTALL_URL;
            try { window.open(url, '_blank'); } catch (e2) { GM_openInTab(url, { active: true }); }
        };
    }
    function xyhUpdClose() {
        if (_xyhUpdModal && _xyhUpdModal.parentNode) _xyhUpdModal.parentNode.removeChild(_xyhUpdModal);
        _xyhUpdModal = null;
    }
    function xyhUpdOpen() {
        if (!document.body) return;
        if (_xyhUpdModal && document.body.contains(_xyhUpdModal)) { xyhUpdRender(); return; }
        var mask = document.createElement('div');
        mask.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; display:flex; align-items:center; justify-content:center; z-index:2147483647; padding:20px; background:rgba(0,0,0,0.45);';
        mask.appendChild(document.createElement('div')).id = 'xyh-upd-box';
        mask.addEventListener('click', function (e) { if (e.target === mask) xyhUpdClose(); });
        document.body.appendChild(mask);
        _xyhUpdModal = mask;
        xyhUpdRender();
        if (!_xyhUpdState.info && !_xyhUpdState.checking) xyhUpdFetch();
    }

    /* ================================================================
     * §14 手写纸引擎（XYHinote / XYLayout / XYPaper / XYExport + XY_HW_DB）
     * ----------------------------------------------------------------
     * 定位：手写笔迹排版引擎与导出器（纯前端，零依赖）。
     *   - XYHinote：笔划容器 + .hinote（华为笔记）写入器（纯笔迹，无图片）；
     *   - XYLayout：确定性排版引擎（CJK 逐字 / ASCII 成词 / \uE000<idx> 图片标记，
     *     行块占行 + 防跨页，输出 imgLayout 供导出层渲染嵌入）；
     *   - XYPaper：A4 手写纸多页排版（普通版横格 / 笔记版淡蓝横线+装订线）；
     *   - XYExport：分页 JPG 与最小 PDF 合成（canvas 渲染，支持图片叠层）。
     * 上层 UI 与内容收集见 §15 统一导出模块（xyExp*）。
     * ================================================================ */

    /** 手写栅格缓存画布：供排版引擎对标点与库外字做骨架兜底。 */
    let _xyHWRasterCtx = null;
    /** 印刷体栅格缓存画布：页码等印刷文字使用（putPrinted 骨架化）。 */
    let _xyHWPrintCtx = null;

    /**
     * 骨架栅格：把单个字符画进离屏 Canvas，返回灰度位图供细化取骨架。
     *
     * 签名必须与 layout.js 的调用一致 —— raster(ch, CANVAS, RENDER)：
     *   CANVAS(240) = 画布边长，RENDER(200) = 渲染字号。
     * 切勿写成 (ch, px, bold)：那样会把画布边长当字号，字溢出画布被裁成
     * 实心块，细化后碎片暴涨（实测每字近 10 万点，产物可达 16MB）。
     *
     * @param {string} ch - 单个字符
     * @param {number} canvasSize - 画布边长（layout.js 的 CANVAS）
     * @param {number} renderPx - 渲染字号（layout.js 的 RENDER）
     * @returns {{w:number,h:number,data:Uint8Array}} 灰度位图（0 墨迹 / 255 空白）
     */
    function xyHWRaster(ch, canvasSize, renderPx) {
        const size = canvasSize || 240;
        const px = renderPx || 200;
        if (!_xyHWRasterCtx || _xyHWRasterCtx.canvas.width !== size) {
            const cv = document.createElement('canvas');
            cv.width = size; cv.height = size;
            _xyHWRasterCtx = cv.getContext('2d', { willReadFrequently: true });
        }
        const g = _xyHWRasterCtx;
        // 关键：透明底 + 白字。layout.js 的二值化是 `>128 ? 1 : 0`（亮 = 墨迹），
        // 若改成白底黑字，会把背景当成墨迹去细化，描出整张网格 → 点数暴涨。
        g.clearRect(0, 0, size, size);
        g.fillStyle = '#fff';
        g.font = px + 'px "FangSong","FangSong_GB2312","仿宋","STFangsong","KaiTi","STKaiti","楷体",serif';
        g.textAlign = 'left';
        g.textBaseline = 'top';
        g.fillText(ch, (size - px) / 2, (size - px) / 2);
        const d = g.getImageData(0, 0, size, size).data;
        const out = new Uint8Array(size * size);
        for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
        return { w: size, h: size, data: out };
    }

    /**
     * 印刷体栅格（仅课程论文纸抬头用）—— 签名是 (ch, px, bold, fontFamily)，
     * 与上面的骨架栅格 raster(ch, CANVAS, RENDER) 不同，两者不可互换。
     *
     * @param {string} ch - 单个字符
     * @param {number} px - 渲染字号（像素）
     * @param {boolean} bold - 是否加粗
     * @param {string} fontFamily - 字体族键名（LiSu / Arial / 其它）
     * @returns {{w:number,h:number,data:Uint8Array}} 灰度位图
     */
    const _XY_HW_FONTS = {
        LiSu: '"LiSu","STXingkai","STFangsong","FangSong","KaiTi","SimSun",serif',
        Arial: '"Arial","Helvetica","Liberation Sans","FangSong","SimSun",serif'
    };
    function xyHWRasterPrinted(ch, px, bold, fontFamily) {
        if (!_xyHWPrintCtx) {
            const cv = document.createElement('canvas');
            cv.width = 240; cv.height = 240;
            _xyHWPrintCtx = cv.getContext('2d', { willReadFrequently: true });
        }
        const g = _xyHWPrintCtx;
        const ff = _XY_HW_FONTS[fontFamily] || '"FangSong","FangSong_GB2312","仿宋","STFangsong","SimSun","宋体",serif';
        // 同上：透明底 + 白字（亮 = 墨迹）
        g.clearRect(0, 0, 240, 240);
        g.fillStyle = '#fff';
        g.font = (bold ? 'bold ' : '') + px + 'px ' + ff;
        g.textAlign = 'left';
        g.textBaseline = 'top';
        g.fillText(ch, (240 - px) / 2, (240 - px) / 2);
        const d = g.getImageData(0, 0, 240, 240).data;
        const out = new Uint8Array(240 * 240);
        for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
        return { w: 240, h: 240, data: out };
    }



    /* ── 平台作业数据状态（自小雅辅助工具 §11 迁移） ── */
    let hwQuestionsData = [];
    let hwExtractedText = '';
    let hwImageAssets = [];
    let hwPdfQuestions = [];
    let hwSubmissionResult = { state: 'waiting', message: '等待题目数据加载...' };
    let hwGroupId = '', hwNodeId = '', hwPaperId = '';
    let hwActiveTaskKey = '';
    let hwRecordId = '';            
    let hwResultFilter = 'all';     
    let hwResultOpen = false;       
    let hwActiveTab = 'answer';     

    function hwUpdateUI() {
        var el = document.getElementById('xyh-databar-text');
        if (el) el.textContent = hwQuestionsData.length
            ? '📡 已捕获 ' + hwQuestionsData.length + ' 题 · 可直接导出'
            : '📡 未捕获作业数据 · 请先打开作业/试卷页面';
    }

    const domain = window.location.hostname;
    function getCourseGroupId() { const match = window.location.href.match(/(?:mycourse|course)\/(\d+)/); return match ? match[1] : null; }
    function getPaperId() {
        // course_paper URL 两种代际结构：
        //   新版: /course_paper/mycourse/{gid}/{nodeId}/{flowId}/{paperId}（paper 为末段）
        //   旧版: /course_paper/mycourse/{gid}/{paperId}/{nodeId}
        const nums = window.location.pathname.match(/course_paper\/mycourse\/\d+((?:\/\d+)+)$/);
        if (nums && nums[1]) {
            const parts = nums[1].split('/').filter(Boolean);
            if (parts.length >= 3) return parts[parts.length - 1]; // 新结构：末段为 paperId
            if (parts.length >= 1) return parts[0];                // 旧结构：首段为 paperId
        }
        let match = window.location.href.match(/resource\/(\d+)\/(\d+)/);
        return match ? match[2] : null;
    }
    function getResourceNodeId() {
        // 与 getPaperId 同一套代际判断：新结构 node=第1段；旧结构 node=第2段
        const nums = window.location.pathname.match(/course_paper\/mycourse\/\d+((?:\/\d+)+)$/);
        if (nums && nums[1]) {
            const parts = nums[1].split('/').filter(Boolean);
            if (parts.length >= 3) return parts[0];  // 新结构：首参数段为 nodeId
            if (parts.length === 2) return parts[1]; // 旧结构：第2段为 nodeId
            if (parts.length === 1) return '';
        }
        let match = window.location.href.match(/resource\/(\d+)\//);
        return match ? match[1] : null;
    }
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    function getCookie(keyword = 'prd-access-token') {
        for (const cookie of document.cookie.split('; ')) {
            const separatorIndex = cookie.indexOf('=');
            if (separatorIndex < 0) continue;
            const name = cookie.slice(0, separatorIndex);
            if (name.includes(keyword)) return cookie.slice(separatorIndex + 1);
        }
        return null;
    }
    function hwCaptureParams(rawUrl) {
        try {
            const urlObj = new URL(rawUrl, window.location.origin);
            hwGroupId = urlObj.searchParams.get('group_id') || hwGroupId;
            hwNodeId = urlObj.searchParams.get('node_id') || hwNodeId;
            hwPaperId = urlObj.searchParams.get('paper_id') || hwPaperId;
        } catch(e) { console.warn('[小雅辅助] 无法解析作业请求参数', e); }
    }

    async function xyFetch(url, options = {}, timeoutMs = 15000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try { return await fetch(url, { ...options, signal: controller.signal }); }
        finally { clearTimeout(timer); }
    }
    async function xyNativeFetch(url, options = {}, timeoutMs = 15000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try { return await _hw_nativeFetch(url, { ...options, signal: controller.signal }); }
        finally { clearTimeout(timer); }
    }

    /* 响应拦截：独立脚本无全局 fetch 劫持，主动拉取的试卷响应在此直接解析入库
       （主工具中该职责由 window.fetch 劫持链承担）。包装 xyFetch / xyNativeFetch。 */
    var _xyhOrigXyFetch = xyFetch;
    xyFetch = async function (url, options, timeoutMs) {
        var res = await _xyhOrigXyFetch(url, options, timeoutMs);
        try {
            if (res && res.ok && String(url).includes('queryStuPaper')) {
                var _d = await (res.clone ? res.clone() : res).json();
                hwProcessPaperData(_d);
            }
        } catch (e) { /* 解析失败不影响原响应返回 */ }
        return res;
    };
    var _xyhOrigNative = xyNativeFetch;
    xyNativeFetch = async function (url, options, timeoutMs) {
        var res = await _xyhOrigNative(url, options, timeoutMs);
        try {
            if (res && res.ok && String(url).includes('queryStuPaper')) {
                var _d2 = await (res.clone ? res.clone() : res).json();
                hwProcessPaperData(_d2);
            }
        } catch (e) { /* 同上 */ }
        return res;
    };

    function hwBuildTaskKey(gid, nid, pid) { return [gid||'', nid||'', pid||''].join(':'); }

    function getNodeId() { const match = window.location.href.match(/resource\/\d+\/(\d+)/); return match ? match[1] : null; }

    function hwExtractRecordId(payload) {
        const direct=payload?.answer_record?.id||payload?.answer_record_id||payload?.record_id;
        if(direct)return String(direct);
        for(const list of [payload?.task_flow_record,payload?.task_flow_template]){
            if(!Array.isArray(list))continue;
            for(const item of list){
                const recordId=item?.answer_record_id||item?.answer_record?.id||item?.record_id;
                if(recordId)return String(recordId);
            }
        }
        return '';
    }
    /** 记录 ID 获取编排：hwRecordId 缓存非空直返；否则 RefreshPaperData 触发
     * 劫持链重新捕获试卷载荷补齐，仍拿不到抛错（上层提示初始化失败）。
     * [DEEP-DOC]
    function hwSafeText(v) { return String(v??'').slice(0,32767); }
    /** 作业域安全转数：Number() 结果有限才返回，否则 null（区别于概览域的 fallback-0 语义——这里 null 参与判空分支）。
     * [DEEP-DOC]
     */
    function hwToNum(v) { const n=Number(v); return Number.isFinite(n)?n:null; }
    /**
     * 疑似 JSON 字符串惰性解析：trim 后非空、非纯数字才尝试 JSON.parse；
     * 解析失败原样返回字符串。平台字段「有时是对象有时是序列化串」的双形态兼容。
     * [DEEP-DOC]
     */
    function hwMaybeParse(v) { if(typeof v!=='string')return v; const t=v.trim(); if(!t||/^\d+$/.test(t))return v; try{return JSON.parse(t)}catch(e){return v}; }
    /** 从 DraftJS 节点提取图片 src：entity data 直接携带或经 key 查 entityMap；兼容 file_access 协议与 data URI 两形态。
     * [DEEP-DOC]
     */
    function hwGetImageSrc(data={}) {
        const type=String(data.type||data.blockType||data.kind||"").toUpperCase();
        return data.src||data.imageUrl||data.image_url||data?.data?.src||data?.data?.imageUrl||data?.data?.image_url||data?.data?.file||data?.data?.url||((type.includes("IMAGE")||type=="IMG")?(data.url||data.href||data.file||data?.data?.url||data?.data?.href||data?.data?.file||""):"");
    }
    /** LaTeX 公式原文提取：经 hwGetEntityByKey 取 MATH 实体的 formula/latex/tex 字段。
     * [DEEP-DOC]
     */
    function hwGetFormula(data={}) { return data.teX||data.tex||data.latex||data.formula||data.value||data.content||data.text||data?.data?.teX||data?.data?.tex||data?.data?.latex||""; }
    /** DraftJS entityMap 键查找：contentState.entityMap[key] 直取，缺失返回 undefined。
     * [DEEP-DOC]
     */
    function hwGetEntityByKey(em,key) {
        if(!em||typeof em!=="object")return null;
        if(Object.prototype.hasOwnProperty.call(em,key))return em[key];
        const sk=String(key);
        if(sk!==String(key)&&Object.prototype.hasOwnProperty.call(em,sk))return em[sk];
        return null;
    }
    /**
     * 题目富文本统一解析器 —— 作业模块的数据入口汇合点。
     *
     * 三形态输入：DraftJS JSON 串（blocks+entityMap）/ 已解析对象 / 纯文本。
     * 输出 { text, images[], segments[] }：text 为拼接纯文本（AI 提示词用）、
     * images 收集全部图片 src（导出 docx 用）、segments 保序混合段
     * （{type:'text'|'image'|'formula', value/src}，docx 还原排版顺序用）。
     * 解析失败降级为单文本段，绝不抛出——题目展示不允许因单个坏题中断。
     * [DEEP-DOC]
     */
    function hwParseRichContent(raw) {
        if(!raw)return{text:"",images:[],segments:[]};
        let obj=null;
        if(typeof raw==="string"){try{obj=JSON.parse(raw)}catch(e){const t=raw.replace(/^"|"$/g,"").trim();return{text:t,images:[],segments:t?[{type:"text",value:t}]:[]}}}
        else if(typeof raw==="object")obj=raw;
        else{const t=String(raw).trim();return{text:t,images:[],segments:t?[{type:"text",value:t}]:[]}}
        if(!obj||!Array.isArray(obj.blocks)){
            /* dist 附件数组作答（手写/上传图片）：[{type:'dist',name,quote_id,mimetype,...}]
               → 逐项转为 image 段（quote_id 经 cloud/file_access 拉取）。 */
            if(Array.isArray(obj)){
                const imgs=[],segs=[];
                obj.forEach(it=>{if(it&&it.quote_id){segs.push({type:"image",src:window.location.origin+"/api/jx-oresource/cloud/file_access/"+it.quote_id});imgs.push({src:"/api/jx-oresource/cloud/file_access/"+it.quote_id,kind:"image"})}});
                if(segs.length)return{text:imgs.map(x=>"[图片]").join(""),images:imgs,segments:segs};
            }
            const t=typeof obj==="string"?obj.trim():(typeof raw==="string"?raw.trim():JSON.stringify(raw));return{text:t,images:[],segments:t?[{type:"text",value:t}]:[]}}
        const parts=[],images=[],segs=[],em=obj.entityMap||{};
        const pt=(t)=>{const c=String(t||"").trim();if(c){parts.push(c);segs.push({type:"text",value:c})}};
        const pi=(s)=>{if(!s)return;parts.push("[图片]");images.push({src:s,kind:"image"});segs.push({type:"image",src:s})};
        const pf=(f)=>{const c=String(f||"").trim();if(c){parts.push("[公式: "+c+"]");segs.push({type:"formula",value:c})}};
        const hd=(d)=>{if(!d)return;const t=String(d.type||"").toUpperCase();if(t.includes("IMAGE")||t=="IMG"||d.src||d.imageUrl||d.image_url||d.file||(d&&d.data&&(d.data.src||d.data.imageUrl||d.data.image_url||d.data.file||d.data.url)))pi(hwGetImageSrc(d));else if(t.includes("TEX")||t.includes("MATH")||t.includes("FORMULA"))pf(hwGetFormula(d))};
        obj.blocks.forEach(b=>{if(!b)return;if(b.type==="atomic"&&b.data){hd(b.data);return}pt(b.text);if(Array.isArray(b.entityRanges))b.entityRanges.forEach(r=>{const e=hwGetEntityByKey(em,r?.key);if(e&&e.data)hd({...e.data,type:e.type||e.data.type})})});
                return{text:parts.join("\n").trim(),images,segments:segs.length?segs:(parts.length?[{type:"text",value:parts.join("\n").trim()}]:[])}
    }
    /** 图片资产登记：把解析出的 images 追加进模块级 hwImageAssets 数组（附题目序号
     * 与可选选项字母定位），供 hwHydrateImageMap 批量下载。去重靠后续 Set 化。
     * [DEEP-DOC]
     */
    function hwCollectImages(qi,parsed,optL) { if(!parsed||!Array.isArray(parsed.images))return; parsed.images.forEach(im=>{if(!im.src)return;if(!hwImageAssets.some(a=>a.qi===qi&&a.src===im.src&&a.optL===optL))hwImageAssets.push({qi,src:im.src,optL})})}
    /** 平台题型代码 → 中文标签映射：1 单选 / 2 多选 / 4 填空 / 5 判断 / 6 简答 /
     * 7 附件 / 13 匹配 / 9 组合子题；未知码兜底「未知题型」。
     * [DEEP-DOC]
     */
    function hwTypeLabel(t) { return {1:'[单选题]',2:'[多选题]',4:'[填空题]',5:'[判断题]',6:'[简答题]',7:'[附件题]',9:'[组合题]',13:'[匹配题]'}[t]||'[其他]' }
    /** answer_items 排序复用：answer_items_sort 逗号 id 序 → 重排 sItems（无 sort 原序返回）。
     * [DEEP-DOC]
     */
    function hwSortAnswerItems(q) {
        let sItems = Array.isArray(q.answer_items) ? [...q.answer_items] : [];
        if (q.answer_items_sort && Array.isArray(q.answer_items)) {
            const si = String(q.answer_items_sort).split(',');
            sItems = si.map(id => q.answer_items.find(it => String(it.id) === String(id))).filter(Boolean);
        }
        return sItems;
    }
    /** 富文本答案 → 纯文本：hwMaybeParse 后走 blocks 拼接或直接 String。填空比对与结果展示共用。
     * [DEEP-DOC]
     */
    function hwExtractPlainText(v) {
        if(v===null||v===undefined)return'';
        const p=hwMaybeParse(v);
        if(p&&typeof p==='object'&&Array.isArray(p.blocks))return p.blocks.map(b=>b?.text||'').join('\n').trim();
        if(Array.isArray(p))return p.map(hwExtractPlainText).filter(Boolean).join('；');
        if(p&&typeof p==='object')return Object.values(p).map(hwExtractPlainText).filter(Boolean).join('；');
        return String(p).trim();
    }
    /** 富文本答案 → 展示 HTML：blocks 逐段还原段落与图片占位，供结果面板 innerHTML 渲染。
     * [DEEP-DOC]
     */
    function hwExtractRichDisplay(v) {
        if(v===null||v===undefined||v==='')return'';
        const p=hwParseRichContent(v);
        return p.text||hwExtractPlainText(v);
    }
    /** 答案项 ID 归一：String() 统一数字/字符串混型，保证作答回填时的键匹配稳定。
     * [DEEP-DOC]
     */
    function hwNormalizeAnswerIds(a) {
        if(Array.isArray(a))return a.map(x=>String(x).trim()).filter(Boolean);
        if(a===null||a===undefined)return[];
        const p=hwMaybeParse(a);
        if(Array.isArray(p))return p.map(x=>String(x).trim()).filter(Boolean);
        return String(p).split(/[,，、\s]+/).map(x=>x.trim()).filter(Boolean);
    }
    /** 选择题格式化：answerChecked===2 判定正确项；输出「字母. 文本」列表，标准答案存在时标注 ✓。
     * [DEEP-DOC]
     */
    function hwFormatChoice(qData,answer) {
        const ids=hwNormalizeAnswerIds(answer);if(!ids.length)return'无记录';
        return ids.map(id=>{const o=qData.options?.find(x=>String(x.id)===String(id));if(!o)return id;const t=o.text?' '+o.text:'';return o.letter+'.'+t}).join('；');
    }
    /** 填空题格式化：sItems 序号对应答案数组逐空展示「空N：内容」，缺答显示空位。
     * [DEEP-DOC]
     */
    function hwFormatFill(qData,answer) {
        const p=hwMaybeParse(answer);
        if(!p||typeof p!=='object'||Array.isArray(p)){const t=hwExtractPlainText(answer);return t||'无记录';}
        const parts=(qData.sItems||[]).map((it,i)=>{const v=hwExtractPlainText(p[it.id]);return'空'+(i+1)+'：'+(v||'未填')});
        return parts.length?parts.join('；'):'无记录';
    }
    /** 匹配题格式化：左右项按 id 配对输出「左项 → 右项」行序列。
     * [DEEP-DOC]
     */
    function hwFormatMatching(qData,answer) {
        const p=hwMaybeParse(answer);const l=qData.matchingLeftItems||[],r=qData.matchingRightItems||[];
        if(!p||typeof p!=='object'||Array.isArray(p)){const t=hwExtractPlainText(answer);return t||'无记录';}
        const rm=new Map(r.map(x=>[String(x.id),x]));let has=false;
        const lines=l.map(li=>{const rv=p[li.id]??p[String(li.id)];const rids=hwNormalizeAnswerIds(rv);if(!rids.length)return li.letter+'. '+(li.text||'')+' => 未匹配';has=true;const rt=rids.map(id=>{const ri=rm.get(String(id));return ri?ri.letter+'. '+(ri.text||''):id}).join('、');return li.letter+'. '+(li.text||'')+' => '+rt});
        return has?lines.join('\n'):'无记录';
    }
    /** 作答内容总分发：按 qData.type 路由到 choice(1,2,5)/fill(4)/matching(13)/
     * rich(6)/附件(7 占位)；未知类型显示原始 JSON 截断。
     * [DEEP-DOC]
     */
    function hwFormatAnswer(qData,answer) {
        if(!qData)return hwExtractPlainText(answer)||'无记录';
        if(qData.type===1||qData.type===2||qData.type===5)return hwFormatChoice(qData,answer);
        if(qData.type===4)return hwFormatFill(qData,answer);
        if(qData.type===6)return hwExtractRichDisplay(answer)||'无记录';
        if(qData.type===7)return'附件题';
        if(qData.type===13)return hwFormatMatching(qData,answer);
        return hwExtractPlainText(answer)||'无记录';
    }
    /** 标准答案提取（仅平台发布答案后下发）：优先 question.std_answer，兼容 answer 字段。
     * [DEEP-DOC]
     */
    function hwGetStdAnswer(qData,canShow) {
        if(!canShow||!qData)return'';
        if(qData.type===1||qData.type===2||qData.type===5){const co=(qData.options||[]).filter(o=>o.answerChecked===2);return co.map(o=>{const t=o.text?' '+o.text:'';return o.letter+'.'+t}).join('；')||''}
        if(qData.type===4){const parts=(qData.sItems||[]).map((it,i)=>{const v=hwExtractPlainText(it.answer);return v?'空'+(i+1)+'：'+v:''}).filter(Boolean);return parts.join('；')}
        if(qData.type===6&&(qData.sItems||[])[0])return hwExtractRichDisplay(qData.sItems[0].answer);
        return'';
    }
    /**
     * 单题批改状态机：correct===2 或满分 → ok 正确；score>0 → partial 部分；
     * correct===1 或零分 → bad 错误；有记录无成绩 → pending 待批改；无记录 →
     * muted 未作答。输出 {label, tone}，tone 驱动结果面板配色与筛选键。
     * [DEEP-DOC]
     */
    function hwGetResultState(a,qd) {
        if(!a)return{label:'无记录',tone:'muted'};
        const s=hwToNum(a.score),c=hwToNum(a.correct),fs=hwToNum(qd?.score);
        if(c===2||(s!==null&&fs!==null&&fs>0&&s>=fs))return{label:'正确',tone:'ok'};
        if(s!==null&&s>0)return{label:'部分得分',tone:'partial'};
        if(c===1||(s!==null&&s===0))return{label:'错误',tone:'bad'};
        return{label:'待批改',tone:'pending'};
    }
    /**
     * 提交结果装配器：answer_record 缺失/answers 空数组 → waiting/not_submitted
     * 早退；status!==2 → not_submitted（有记录未交）；否则 submitted 态：
     * canShowStandardAnswer 由 publish_record.is_show_answer 决定、totalScore/
     * actualScore/answerNum 收敛、逐题 questionResults 经 GetResultState 构建。
     * [DEEP-DOC]
     */
    function hwBuildSubmissionResult(pd) {
        const ar=pd?.answer_record,answers=ar?.answers;
        if(!ar||!Array.isArray(answers)||!answers.length)return{state:hwQuestionsData.length?'not_submitted':'waiting',message:hwQuestionsData.length?'未检测到已提交作业记录。':'等待题目数据加载...'};
        if(Number(ar.status)!==2)return{state:'not_submitted',message:'检测到作答记录，但当前任务尚未确认。'};
        const canShow=pd?.publish_record?.is_show_answer===true;
        const am=new Map(answers.map(a=>[String(a.question_id),a]));
        const qrs=hwQuestionsData.map(qd=>{const a=am.get(String(qd.id));const rs=hwGetResultState(a,qd);const s=hwToNum(a?.score),fs=hwToNum(qd.score);const st=s!==null?`${s} / ${fs!==null?fs:'-'} 分`:`- / ${fs!==null?fs:'-'} 分`;return{index:qd.index,id:qd.id,type:qd.type,typeLabel:hwTypeLabel(qd.type),title:qd.titleText,stateLabel:rs.label,tone:rs.tone,scoreText:st,userAnswer:hwFormatAnswer(qd,a?.answer),rawUserAnswer:a?.answer,standardAnswer:hwGetStdAnswer(qd,canShow)}});
        return{state:'submitted',canShowStandardAnswer:canShow,totalScore:hwToNum(pd?.total_score),actualScore:hwToNum(ar.actual_score??ar.score),answerNum:hwToNum(ar.answer_num||hwQuestionsData.length),correctNum:hwToNum(ar.answer_correct_num),questionResults:qrs};
    }

    
    let _hwDataJustLoaded = false;
    /**
     * 试卷归属校验（防串包闸门）：payloadGroupId 存在且与当前路由课程不符 → false；
     * payloadPaperId 与 getPaperId()/已捕获 hwPaperId 均无法对上 → false。
     * 后台预加载的其他试卷响应在此被拦截，不会污染当前答题会话。
     * [DEEP-DOC]
     */
    function hwIsCurrentPaperPayload(json) {
        const payloadGroupId = json?.data?.group_id;
        const currentGroupId = getCourseGroupId();
        if (payloadGroupId && currentGroupId && String(payloadGroupId) !== String(currentGroupId)) return false;
        const payloadPaperId = json?.data?.paper_id || json?.data?.paperId || json?.data?.id;
        if (!payloadPaperId) return true;
        /* 新版 resource 作业页：URL 末段是资源节点 ID，真卷 ID 是内层 quote/资源 id，
           两者不同但都属于本卷。课程内守卫已足够拦截串包（载荷 group_id 必须与当前
           课程一致），paper_id 只在双 ID 都已知且都匹配不上时才拒收。 */
        if (hwPaperId && String(payloadPaperId) === String(hwPaperId)) return true;
        const urlPaperId = getPaperId();
        if (urlPaperId && String(payloadPaperId) === String(urlPaperId)) return true;
        /* 放宽兜底：URL 是 resource/{dir}/{paperNode} 作业页形态时，直接信任课程守卫，
           不因 paper_id 形态差异丢弃（防脚本启动早期 hwPaperId 未定值时误杀） */
        if (/resource\/\d+\/\d+/.test(window.location.href) && !window.location.href.includes('/course_paper/')) return true;
        return false;
    }
    /**
     * 题目数据主处理器 —— 作业模块的心脏。
     *
     * 管线五级：
     *   1. 结构守卫：json/data/questions 三层存在性 + Array.isArray 类型校验
     *      （畸形载荷 warn 后优雅 return，绝不抛出打断页面）；
     *   2. 归属守卫：hwIsCurrentPaperPayload 拦过期试卷；
     *   3. 元数据补齐：paper/group/node/record 四 ID 就位（已有值不覆盖）；
     *   4. 逐题清洗 forEach：题型分流——选择类分配字母、填空计空数、匹配题
     *      左右分列、附件标记免答；每题走 ParseRichContent 三元组解析 + 图片收集；
     *      同时拼 AI 提示词模板 tpl（含内容格式说明头）；
     *   5. 收尾：hwActiveTaskKey 固化 → BuildSubmissionResult → 非 dashboard
     *      钉住场景自动切作业区 → hwUpdateUI 全量刷新。
     *
     * 副作用：重置并重建 hwQuestionsData/hwImageAssets/hwPdfQuestions 三大数组。
     * [DEEP-DOC]
     */

    function hwProcessPaperData(json) {
        if(!json||!json.data||!Array.isArray(json.data.questions)){console.warn('[小雅辅助·作业区] 题目数据结构不完整，已跳过处理',!!json,!!json?.data,!!json?.data?.questions);return;}
        if (!hwIsCurrentPaperPayload(json)) {
            console.warn('[小雅辅助·作业区] 已忽略过期课程的题目响应');
            return;
        }
        clearTimeout(window._hwResetGuard);
        _hwDataJustLoaded = true;
        setTimeout(() => { _hwDataJustLoaded = false; }, 3000);
        console.log('[小雅辅助·作业区] 开始处理题目数据，题目数:', json.data.questions.length);
        hwPaperId=hwPaperId||json.data.paper_id||json.data.paperId||json.data.id||'';
        if(!hwGroupId)hwGroupId=json.data.group_id;
        if(!hwNodeId)hwNodeId=getNodeId()||'';
        hwRecordId=hwRecordId||hwExtractRecordId(json.data);
        const qs=json.data.questions;
        hwQuestionsData=[];hwImageAssets=[];hwPdfQuestions=[];
        let tpl='📌 学习任务单\n按下列题目整理要点，只输出内容本身，不要附带解析或任何说明文字。\n【答案格式】\n单选/判断 → 题号 => 大写字母（如 1 => A）\n多选 → 题号 => 字母，逗号分隔（如 2 => A,C）\n填空 → 题号 => 各空用竖线分隔（如 3 => const | let）\n简答 → 题号 => 完整文字\n匹配 → 题号 => 左:右（如 10 => A:a,d | B:b,c）\n附件题无作答内容。\n\n════════════════════\n以下为题目内容：\n════════════════════\n';
        qs.forEach((q,idx)=>{
            /* 组合题（type 9）：大题干 + subQuestions[] 子题，作答记录按子题 id 拍平。
               按用户约定展开为 1.1 / 1.2 独立条目；大题干并入每道子题标题前，保证
               单看一道子题也能读懂题意。若平台未下发子题则退化为普通题处理。 */
            if (q.type === 9 && Array.isArray(q.subQuestions) && q.subQuestions.length) {
                const qBase = (idx + 1) + '';            // 大题号（1）
                const pt0 = hwParseRichContent(q.title);
                const stem = pt0.text;                    // 大题干
                pt0.images.forEach(im => { if (im.src) hwImageAssets.push({ qi: idx + 1, src: im.src, optL: '' }); });
                q.subQuestions.forEach((sq, si) => {
                    const qi = idx + 1;                   // 图片归集沿用大题号
                    const label = qBase + '.' + (si + 1); // 1.1 / 1.2
                    const pt = hwParseRichContent(sq.title);
                    const fullTitle = (stem ? stem + '　' : '') + pt.text;
                    const sItems = hwSortAnswerItems(sq);
                    /* 每道子题都是独立条目：完整携带大题干段（含图片段），
                       手写/导出时每道子题旁都有题图可对照（同图去重由 imgList 保证） */
                    const stemSegs = pt0.segments && pt0.segments.length ? pt0.segments : (stem ? [{ type: 'text', value: stem + '　' }] : []);
                    const pq = { index: label, type: sq.type, typeLabel: hwTypeLabel(sq.type),
                        titleSegments: stemSegs.concat(pt.segments && pt.segments.length ? pt.segments : (pt.text ? [{ type: 'text', value: pt.text }] : [])),
                        options: [], matchingLeftItems: [], matchingRightItems: [], blankCount: sItems.length };
                    const rOpts = [], mLeft = [], mRight = [];
                    hwCollectImages(qi, pt);
                    let line = label + ' ' + hwTypeLabel(sq.type) + '\n' + (stem ? stem + '\n' : '') + pt.text + '\n';
                    const subLike = { index: label, id: sq.id, type: sq.type, score: sq.score, titleText: fullTitle, options: rOpts, matchingLeftItems: mLeft, matchingRightItems: mRight, sItems, parentIndex: idx + 1, subLabel: label };
                    if (sq.type === 1 || sq.type === 2 || sq.type === 5) {
                        let lc = 65;
                        sItems.forEach(opt => {
                            const ol = String.fromCharCode(lc++);
                            const po = hwParseRichContent(opt.value);
                            let ot = po.text;
                            hwCollectImages(qi, po, ol);
                            if (sq.type === 5 && !ot) ot = ol === 'A' ? '正确' : '错误';
                            pq.options.push({ letter: ol, text: ot, segments: po.segments && po.segments.length ? po.segments : (ot ? [{ type: 'text', value: ot }] : []) });
                            rOpts.push({ id: opt.id, letter: ol, text: ot, answerChecked: opt.answer_checked });
                            line += '   ' + ol + '. ' + ot + '\n';
                        });
                    } else if (sq.type === 4) {
                        line += '   (本题共 ' + sItems.length + ' 个填空)\n';
                    } else if (sq.type === 7) {
                        line += '   附件题无需回答。\n';
                    } else if (sq.type === 13) {
                        const li = sItems.filter(it => it && it.is_target_opt !== true), ri = sItems.filter(it => it && it.is_target_opt === true);
                        line += '   左侧：\n';
                        li.forEach((opt, ii) => {
                            const ol = String.fromCharCode(65 + ii);
                            const po = hwParseRichContent(opt.value);
                            hwCollectImages(qi, po, ol);
                            const d = { id: opt.id, letter: ol, text: po.text, segments: po.segments && po.segments.length ? po.segments : (po.text ? [{ type: 'text', value: po.text }] : []) };
                            mLeft.push(d); pq.matchingLeftItems.push(d); line += '   ' + ol + '. ' + po.text + '\n';
                        });
                        line += '\n   右侧候选：\n';
                        ri.forEach((opt, ii) => {
                            const ol = String.fromCharCode(97 + ii);
                            const po = hwParseRichContent(opt.value);
                            hwCollectImages(qi, po, ol);
                            const d = { id: opt.id, letter: ol, text: po.text, segments: po.segments && po.segments.length ? po.segments : (po.text ? [{ type: 'text', value: po.text }] : []) };
                            mRight.push(d); pq.matchingRightItems.push(d); line += '   ' + ol + '. ' + po.text + '\n';
                        });
                    }
                    tpl += line + '\n';
                    hwQuestionsData.push(subLike);
                    hwPdfQuestions.push(pq);
                });
                return;
            }
            /* 普通题（1/2/4/5/6/7/13）：原有路径 */
            const qi=idx+1;const pt=hwParseRichContent(q.title);let qTitle=pt.text;let qType=hwTypeLabel(q.type);const rOpts=[],mLeft=[],mRight=[];hwCollectImages(qi,pt);tpl+=qi+'. '+qTitle+' '+qType+'\n';
        let sItems=Array.isArray(q.answer_items)?[...q.answer_items]:[];if(q.answer_items_sort&&Array.isArray(q.answer_items)){const si=String(q.answer_items_sort).split(',');sItems=si.map(id=>q.answer_items.find(it=>String(it.id)===String(id))).filter(Boolean)}
        const pq={index:qi,type:q.type,typeLabel:qType,titleSegments:pt.segments&&pt.segments.length?pt.segments:(qTitle?[{type:'text',value:qTitle}]:[]),options:[],matchingLeftItems:[],matchingRightItems:[],blankCount:sItems.length};
        if(q.type===1||q.type===2||q.type===5){let lc=65;sItems.forEach(opt=>{const ol=String.fromCharCode(lc);const po=hwParseRichContent(opt.value);let ot=po.text;hwCollectImages(qi,po,ol);if(q.type===5&&!ot)ot=ol==='A'?'正确':'错误';pq.options.push({letter:ol,text:ot,segments:po.segments&&po.segments.length?po.segments:(ot?[{type:'text',value:ot}]:[])});rOpts.push({id:opt.id,letter:ol,text:ot,answerChecked:opt.answer_checked});tpl+='   '+ol+'. '+ot+'\n';lc++})}
        else if(q.type===4)tpl+='   (本题共 '+sItems.length+' 个填空)\n';
        else if(q.type===7)tpl+='   附件题无需回答。\n';
        else if(q.type===13){const li=sItems.filter(it=>it&&it.is_target_opt!==true),ri=sItems.filter(it=>it&&it.is_target_opt===true);tpl+='   左侧：\n';li.forEach((opt,ii)=>{const ol=String.fromCharCode(65+ii);const po=hwParseRichContent(opt.value);const ot=po.text,segs=po.segments&&po.segments.length?po.segments:(ot?[{type:'text',value:ot}]:[]);hwCollectImages(qi,po,ol);const d={id:opt.id,letter:ol,text:ot,segments:segs};mLeft.push(d);pq.matchingLeftItems.push(d);tpl+='   '+ol+'. '+ot+'\n'});tpl+='\n   右侧候选：\n';ri.forEach((opt,ii)=>{const ol=String.fromCharCode(97+ii);const po=hwParseRichContent(opt.value);const ot=po.text,segs=po.segments&&po.segments.length?po.segments:(ot?[{type:'text',value:ot}]:[]);hwCollectImages(qi,po,ol);const d={id:opt.id,letter:ol,text:ot,segments:segs};mRight.push(d);pq.matchingRightItems.push(d);tpl+='   '+ol+'. '+ot+'\n'})}
        tpl+='\n';hwQuestionsData.push({index:qi,id:q.id,type:q.type,score:q.score,titleText:qTitle,options:rOpts,matchingLeftItems:mLeft,matchingRightItems:mRight,sItems});hwPdfQuestions.push(pq)});
        hwExtractedText=tpl;hwActiveTaskKey=hwBuildTaskKey(hwGroupId,hwNodeId,hwPaperId);hwSubmissionResult=hwBuildSubmissionResult(json.data);hwActiveTab='answer';
        console.log('[小雅辅助·作业区] 数据清洗完毕：', hwQuestionsData.length, '题,', hwImageAssets.length, '图, 已提交:', hwSubmissionResult.state);
                hwUpdateUI();
        hwUpdateUI();
    }

    
    let _hwProactiveFetching = false;
    /**
     * 主动拉题管线（截包失效时的补救通道）。
     *
     * URL 参数三参补齐（searchParams → 全局提取函数回退）后分流：
     *   resource 页形态 → queryResource/v3 单次请求，questions 数组展开子题
     *     （type=9 组合题的 subQuestions 平铺并标 _parentId）后走主处理器；
     *   course_paper 形态 → queryStuPaper/v2 指数退避轮询 6 次（200ms×2^n）,
     *     依赖劫持链在响应到达时自动处理（本函数只负责触发请求），轮询结束
     *     仍未拿到则放弃并 warn。
     * _hwProactiveFetching 重入门防并发重复拉取。
     * [DEEP-DOC]
     */
    let _hwProactiveNextAt = 0;

    async function hwProactiveFetchData() {
        if (_hwProactiveFetching) return;
        if (hwQuestionsData.length > 0) return;
        /* 失败节流：上一轮拉取未拿到题目时至少间隔 10s 再试，
           防止 scanner 每秒重入造成接口风暴（实测旧版曾 40+ 次连发） */
        if (Date.now() < _hwProactiveNextAt) return;
        try {
            const urlObj = new URL(window.location.href);
            let groupId = urlObj.searchParams.get('group_id');
            let nodeId = urlObj.searchParams.get('node_id');
            let paperId = urlObj.searchParams.get('paper_id');
            
            if (!groupId || !nodeId || !paperId) {
                if (!groupId) groupId = getCourseGroupId();
                if (!nodeId) nodeId = getResourceNodeId();
                if (!paperId) paperId = getPaperId();
            }
            
            const isResourcePage = window.location.href.includes('/resource/') && !window.location.href.includes('/course_paper/');
            if (isResourcePage && groupId && paperId) {
                _hwProactiveFetching = true;
                try {
                    const token = getCookie();
                    if (!token) { _hwProactiveFetching = false; return; }
                    /* 新版作业页数据链（实测）：resource/{gid}/{dirId}/{paperNodeId} →
                       ① queryResource/v3?node_id={paperNodeId} 取 resource.id(真卷 quote_id)
                       ② survey/course/queryStuPaper/v2?paper_id={quote_id}&group_id&node_id={paperNodeId}
                         一次拿全 questions + answer_record（批改状态） */
                    const resUrl = `https://${domain}/api/jx-iresource/resource/queryResource/v3?node_id=${encodeURIComponent(paperId)}`;
                    console.log('[小雅辅助·作业区] resource 页面用 queryResource/v3');
                    const res = await xyNativeFetch(resUrl, { headers: { 'Authorization': `Bearer ${token}` } }, 30000);
                    const data = await res.json();
                    if (data && data.success && data.data && data.data.resource && Array.isArray(data.data.resource.questions)) {
                        const questions = data.data.resource.questions;
                        console.log('[小雅辅助·作业区] queryResource/v3 获取到题目:', questions.length, '题');
                        const paperIdFromRes = data.data.resource.id || paperId;
                        hwGroupId = groupId;
                        hwNodeId = paperId;
                        hwPaperId = String(paperIdFromRes);
                        // 优先走正式试卷接口：题目+作答记录一次拿全（queryResource/v3 无 answer_record）
                        try {
                            const stuUrl = `https://${domain}/api/jx-iresource/survey/course/queryStuPaper/v2?paper_id=${encodeURIComponent(paperIdFromRes)}&group_id=${encodeURIComponent(groupId)}&node_id=${encodeURIComponent(paperId)}`;
                            const stuRes = await xyNativeFetch(stuUrl, { headers: { 'Authorization': `Bearer ${token}` } }, 45000);
                            const stuData = await stuRes.json();
                            if (stuData && stuData.success && stuData.data && Array.isArray(stuData.data.questions)) {
                                console.log('[小雅辅助·作业区] survey/course/queryStuPaper/v2 获取到完整试卷数据');
                                hwProcessPaperData(stuData);
                                _hwProactiveFetching = false;
                                return;
                            }
                            console.warn('[小雅辅助·作业区] survey 接口无 questions，回退 queryResource 组包');
                        } catch(e) { console.warn('[小雅辅助·作业区] survey 接口失败，回退 queryResource 组包:', e); }

                        // 子题平铺：type=9 组合题的 subQuestions 展开并标 _parentId
                        const allQuestions = [];
                        questions.forEach(q => {
                            allQuestions.push(q);
                            if (q.type === 9 && Array.isArray(q.subQuestions)) {
                                q.subQuestions.forEach(sq => { sq._parentId = q.id; allQuestions.push(sq); });
                            }
                        });

                        // 归属校验已在 hwIsCurrentPaperPayload 内做双 ID 白名单（URL 末段+内层卷 ID），无需临时包装
                        try {
                            const compatData = {
                                data: {
                                    paper_id: paperIdFromRes,
                                    group_id: groupId,
                                    questions: allQuestions,
                                    answer_record: data.data.answer_record || null
                                }
                            };
                            hwGroupId = groupId;
                            hwPaperId = String(paperIdFromRes);
                            hwProcessPaperData(compatData);
                        } catch(e) { console.warn('[小雅辅助·作业区] compatData 组包失败:', e); }
                        _hwProactiveFetching = false;
                        return;
                    }
                    console.warn('[小雅辅助·作业区] queryResource/v3 返回值无 questions');
                } catch(e) {
                    console.warn('[小雅辅助·作业区] queryResource/v3 失败:', e);
                }
                _hwProactiveFetching = false;
                return;
            }
            if (!groupId || !nodeId || !paperId) {
                console.log('[小雅辅助·作业区] 主动拉取参数缺失:', { groupId, nodeId, paperId });
                return;
            }
            _hwProactiveFetching = true;
            hwGroupId = groupId;
            hwNodeId = nodeId;
            hwPaperId = paperId;
            console.log('[小雅辅助·作业区] 主动拉取参数:', { groupId, nodeId, paperId, isResourcePage: window.location.href.includes('/resource/') });
            const token = getCookie();
            if (!token) { _hwProactiveFetching = false; return; }
            
            let data = null;
            for (let attempt = 0; attempt < 6; attempt++) {
                if (hwQuestionsData.length > 0) { data = true; break; }
                try {
                const url = `https://${domain}/api/jx-iresource/survey/course/queryStuPaper/v2?paper_id=${encodeURIComponent(paperId)}&group_id=${encodeURIComponent(groupId)}&node_id=${encodeURIComponent(nodeId)}`;

                    const res = await xyFetch(url, { headers: { 'Authorization': `Bearer ${token}` } }, 45000);
                    if (!res.ok) console.warn(`[小雅辅助·作业区] 试卷接口返回异常状态 ${res.status}(第${attempt + 1}次)`);
                } catch(e) { console.warn(`[小雅辅助·作业区] 试卷接口请求失败(第${attempt + 1}次):`, e); }
                if (hwQuestionsData.length > 0) { data = true; break; } 
                if (attempt < 5) await sleep(200 * Math.pow(2, attempt)); 
            }
            if (data) {
                console.log('[小雅辅助·作业区] 主动拉取题目数据成功');
                if (hwQuestionsData.length > 0 && hwSubmissionResult.state === 'waiting') {
                    hwSubmissionResult.state = 'not_submitted';
                    hwUpdateUI();
                }
            } else {
                console.warn('[小雅辅助·作业区] 主动拉取未获得到题目数据（6次重试后放弃）');
            }
        } catch(e) {
            console.warn('[小雅辅助·作业区] 主动拉取题目数据失败', e);
        } finally {
            _hwProactiveFetching = false;
            if (hwQuestionsData.length === 0) _hwProactiveNextAt = Date.now() + 10000;
        }
    }
    /**
     * 图片尺寸探测：Blob → objectURL → Image onload 读 natural 尺寸 → revoke。
     * onerror reject「无法获取图片尺寸」。用于 docx 中按原始宽高比缩放排版。
     * [DEEP-DOC]
     */

    function hwGetImageSize(ab){return new Promise((resolve,reject)=>{const blob=new Blob([ab]);const url=URL.createObjectURL(blob);const img=new Image();img.onload=()=>{const d={width:img.width,height:img.height};URL.revokeObjectURL(url);resolve(d)};img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('无法获取图片尺寸'))};img.src=url})}
    /**
     * 平台图片二进制拉取：从 src 解析 file_access/{id} 段 → 拼 cloud/file_access
     * API（random 时间戳防缓存）→ GET arrayBuffer。非 2xx 抛业务错误。
     * [DEEP-DOC]
     */
    async function hwFetchImageBlob(src){var s=String(src||'').trim();if(!s)throw new Error("图片地址为空");
      if(s.startsWith("data:")){var m=/^data:[^,]*,([\s\S]*)$/.exec(s);if(!m)throw new Error("无法解析 data URI");var payload=m[1];var bytes;if(/;base64/i.test(s.slice(0,s.indexOf(',')))){var bin=atob(payload);bytes=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i)}else{bytes=new TextEncoder().encode(decodeURIComponent(payload))}return bytes.buffer}
      if(s.startsWith("http")||s.startsWith("/")){var rd=await xyFetch(s,{method:"GET"},45000);if(!rd.ok)throw new Error("图片请求失败:"+rd.status);return await rd.arrayBuffer()}
      var p=s.indexOf("file_access/");if(p===-1)throw new Error("无法解析图片ID");
      var id=s.substring(p+12).split(/[?/]/)[0];
      var url=window.location.origin+"/api/jx-oresource/cloud/file_access/"+id+"?random="+Date.now();
      var r=await xyFetch(url,{method:"GET"},45000);if(!r.ok)throw new Error("图片请求失败:"+r.status);return await r.arrayBuffer()}
    /** 并发受限映射（与 xyCourseDashboardMapLimit 同构）：固定 worker 池共享游标，保序输出。图片下载限制 3 路防打爆接口。
     * [DEEP-DOC]
     */
    async function hwMapLimit(list,limit,worker){const res=new Array(list.length);let c=0;const runners=Array.from({length:Math.min(limit,list.length)},async()=>{while(c<list.length){const i=c++;res[i]=await worker(list[i],i)}});await Promise.all(runners);return res}
    /**
     * 图片批量水合：全部 src 去重 → hwMapLimit(3) 逐张 FetchImageBlob +
     * GetImageSize（超宽 450px 等比缩放排版尺寸）→ 产出 Map<src,{ok,arrayBuffer,
     * width,height}>。单张失败不拖垮整体，错误记录在条目内供 docx 渲染降级。
     * [DEEP-DOC]
     */
    async function hwHydrateImageMap(extra, maxW, includeAssets){const list=(extra||[]).map(a=>typeof a==='string'?{src:a}:a);const all=[...(includeAssets===false?[]:hwImageAssets),...list];const us=Array.from(new Set(all.map(a=>a&&a.src).filter(Boolean)));if(!us.length)return new Map();const cap=Math.max(120,(maxW||450));const results=await hwMapLimit(us,3,async src=>{try{const ab=await hwFetchImageBlob(src);let w=300,h=180;try{const d=await hwGetImageSize(ab.slice(0));if(d.width&&d.height){w=d.width;h=d.height;if(w>cap){h=Math.round(h*(cap/w));w=cap}}}catch(e){}return{src,ok:true,arrayBuffer:ab,width:w,height:h}}catch(e){return{src,ok:false,error:e?.message||String(e)}}});const m=new Map();results.forEach(r=>m.set(r.src,r));return m}
    /**
     * 图文段序列 → docx Paragraph[]：text 段累积 TextRun 后 flush（相邻文本合并
     * 减少段落数）；image 段查 imMap 成功则 ImageRun（缩放后尺寸）失败插入灰色
     * 占位文字；formula 段斜体「[公式: ...]」占位（docx 不支持原生 LaTeX）。
     * indentLvl 控制选项级缩进（240 twips/级）。
     * [DEEP-DOC]
     */

    function xyExpCollect() {
        const items = [];
        const qs = hwQuestionsData || [];
        const pqs = hwPdfQuestions || [];
        const rs = (hwSubmissionResult && hwSubmissionResult.questionResults) || [];
        const rmap = new Map(rs.map(r => [String(r.id), r]));
        qs.forEach((qd, i) => {
            const pq = pqs && pqs[i] ? pqs[i] : null;
            const ri = qd ? rmap.get(String(qd.id)) : null;
            const it = {
                index: (pq && pq.index) || (i + 1),
                type: qd ? qd.type : 0,
                typeLabel: (pq && pq.typeLabel) || hwTypeLabel(qd ? qd.type : 0),
                titleSegs: (pq && pq.titleSegments) || (qd && qd.titleText ? [{ type: 'text', value: qd.titleText }] : []),
                options: (pq && pq.options) || (qd && qd.options ? qd.options.map(o => ({ letter: o.letter, text: o.text, segments: o.text ? [{ type: 'text', value: o.text }] : [] })) : []),
                blankCount: (pq && pq.blankCount) || (qd && qd.sItems ? qd.sItems.length : 0),
                matchingL: (pq && pq.matchingLeftItems) || [],
                matchingR: (pq && pq.matchingRightItems) || [],
                isAttach: !!(qd && qd.type === 7),
                mineSegs: null, mineText: '',
                stdSegs: null, stdText: '',
                scoreLine: ri ? String((ri.stateLabel || '') + '  ' + (ri.scoreText || '')).trim() : ''
            };
            if (ri && ri.rawUserAnswer != null && typeof ri.rawUserAnswer === 'string' &&
                (ri.rawUserAnswer.includes('"blocks"') || ri.rawUserAnswer.includes('"dist"'))) {
                const p = hwParseRichContent(ri.rawUserAnswer);
                if (p.segments && p.segments.length) it.mineSegs = p.segments;
            }
            if (!it.mineSegs) {
                let ua = ri ? ri.userAnswer : (qd ? hwFormatAnswer(qd, null) : '');
                if (qd && qd.options && qd.options.length && /^\d{8,}$/.test(String(ua || '').trim())) {
                    const o = qd.options.find(o => String(o.id) === String(ua).trim());
                    if (o) ua = o.letter + '. ' + (o.text || '');
                }
                it.mineText = ua || '无记录';
            }
            if (ri && ri.standardAnswer && qd && qd.sItems) {
                if (qd.type === 6 && qd.sItems[0] && qd.sItems[0].answer) {
                    const p = hwParseRichContent(qd.sItems[0].answer);
                    if (p.segments && p.segments.length) it.stdSegs = p.segments;
                } else if (qd.type === 4) {
                    const fp = [];
                    qd.sItems.forEach((s, k) => {
                        if (k > 0) fp.push({ type: 'text', value: ' | ' });
                        const v = hwExtractRichDisplay(s.answer);
                        fp.push({ type: 'text', value: '空' + (k + 1) + '：' + (v || '未填') });
                    });
                    it.stdSegs = fp;
                }
            }
            if (!it.stdSegs) it.stdText = (ri && ri.standardAnswer) ? String(ri.standardAnswer).trim() : '';
            items.push(it);
        });
        return items;
    }

    /** 段序列 → 图片来源列表（保序去重）。 */
    function xyExpSegSrcs(segs) {
        const out = [];
        (segs || []).forEach(s => { if (s && s.type === 'image' && s.src && !out.includes(s.src)) out.push(s.src); });
        return out;
    }
    /** 按内容范围收集全部图片来源（题目/选项/匹配/我的作答/标准答案）。 */
    function xyExpCollectSrcs(items, scope) {
        const srcs = [];
        items.forEach(it => {
            if (scope.q !== false) {
                xyExpSegSrcs(it.titleSegs).forEach(s => srcs.push(s));
                (it.options || []).forEach(o => xyExpSegSrcs(o.segments).forEach(s => srcs.push(s)));
                (it.matchingL || []).forEach(o => xyExpSegSrcs(o.segments).forEach(s => srcs.push(s)));
                (it.matchingR || []).forEach(o => xyExpSegSrcs(o.segments).forEach(s => srcs.push(s)));
            }
            if (scope.mine !== false && it.mineSegs) xyExpSegSrcs(it.mineSegs).forEach(s => srcs.push(s));
            if (scope.std !== false && it.stdSegs) xyExpSegSrcs(it.stdSegs).forEach(s => srcs.push(s));
        });
        const uniq = [];
        srcs.forEach(s => { if (!uniq.includes(s)) uniq.push(s); });
        return uniq;
    }

    /** 笔记版文本流构建：按内容范围拼纯文本；withImages 时图片段写为
     *  \uE000<idx> 标记（idx 与 imgList 一一对应），否则写［图片：见平台］占位。 */
    function xyExpNotesText(items, scope, withImages) {
        const imgList = [];
        const imgIdx = new Map();
        const markIdx = src => {
            if (!imgIdx.has(src)) { imgIdx.set(src, imgList.length); imgList.push(src); }
            return imgIdx.get(src);
        };
        const L = [];
        const emitSegs = segs => {
            (segs || []).forEach(s => {
                if (!s) return;
                if (s.type === 'image') {
                    L.push(withImages && s.src ? '\uE000' + markIdx(s.src) : '［图片：见平台］');
                } else if (s.type === 'formula') {
                    L.push('[公式: ' + String(s.value || '').trim() + ']');
                } else if (s.value != null) {
                    String(s.value).split('\n').forEach(ln => { if (ln) L.push(ln); });
                }
            });
        };
        let n = 0;
        items.forEach(it => {
            n += 1;
            L.push('第 ' + n + ' 题 ' + it.typeLabel);
            if (scope.q !== false) {
                emitSegs(it.titleSegs);
                if (it.type === 4 && it.blankCount) L.push('（共 ' + it.blankCount + ' 个填空）');
                if (it.type === 13) {
                    L.push('左侧：');
                    (it.matchingL || []).forEach(o => { L.push(o.letter + '. ' + (o.text || '')); emitSegs(o.segments); });
                    L.push('右侧候选：');
                    (it.matchingR || []).forEach(o => { L.push(o.letter + '. ' + (o.text || '')); emitSegs(o.segments); });
                }
                if ((it.options || []).length) {
                    const hasImg = (it.options || []).some(o => (o.segments || []).some(s => s && s.type === 'image'));
                    if (hasImg) it.options.forEach(o => { L.push(o.letter + '. ' + (o.text || '')); emitSegs(o.segments); });
                    else L.push(it.options.map(o => o.letter + '. ' + (o.text || '')).join('   '));
                }
                if (it.isAttach) L.push('附件题，无作答内容。');
            }
            if (scope.mine !== false) {
                if (it.isAttach) {
                    L.push('我的答案：附件题无作答内容');
                } else if (it.mineSegs) {
                    L.push('我的答案：');
                    emitSegs(it.mineSegs);
                } else {
                    L.push('我的答案：' + (it.mineText || '无记录'));
                }
                if (it.scoreLine) L.push('得分：' + it.scoreLine);
            }
            if (scope.std !== false) {
                if (it.stdSegs) { L.push('标准答案：'); emitSegs(it.stdSegs); }
                else L.push('标准答案：' + (it.stdText || '（平台未公布）'));
            }
            L.push('');
        });
        return { text: L.join('\n'), imgList };
    }



    /** 生成时间戳（与 §11 docx 导出命名风格一致）。 */
    function xyHWStamp() {
        const d = new Date(), p = v => String(v).padStart(2, '0');
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
               p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

    /** 触发浏览器下载（FileSaver 优先，降级到 a[download]）。 */
    function xyHWSave(blob, filename) {
        try {
            if (typeof saveAs === 'function') { saveAs(blob, filename); return; }
        } catch (e) { /* 降级 */ }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    /** 笔记版图片块尺寸：按 150dpi 显示密度（5.9px/mm）换算为画布单位；
     *  下载失败条目置 null（排版引擎按 1 行占位，不中断流程）。 */
    function xyExpNotesImages(imgList, imMap) {
        const MM = XYPaper.MM;
        const contentWmm = 146.5;
        return imgList.map(src => {
            const rec = imMap.get(src);
            if (!rec || !rec.ok) return null;
            const wpx = rec.width || 300, hpx = rec.height || 180;
            const wmm = Math.min(contentWmm, wpx / 5.9);
            const hmm = wmm * hpx / Math.max(1, wpx);
            return { src: src, w: wmm * MM, h: hmm * MM };
        });
    }

    /** arrayBuffer → HTMLImageElement（objectURL 生命周期由调用方管理）。 */
    function xyExpBlobToImg(ab) {
        const blob = new Blob([ab]);
        const url = URL.createObjectURL(blob);
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
            img.src = url;
        });
    }
    /** 图片元素（模块级缓存，避免预览/导出重复解码）。 */
    function xyExpImgEl(src, imMap) {
        const rec = imMap.get(src);
        if (!rec || !rec.ok) return Promise.resolve(null);
        if (!_xyExpImgCache.has(src)) {
            _xyExpImgCache.set(src, xyExpBlobToImg(rec.arrayBuffer).catch(() => null));
        }
        return _xyExpImgCache.get(src);
    }

    function xyExpCanvasToJPEG(cv, quality) {
        return new Promise((resolve, reject) => {
            cv.toBlob(b => {
                if (!b) { reject(new Error('toBlob failed')); return; }
                b.arrayBuffer().then(ab => resolve({ data: new Uint8Array(ab), w: cv.width, h: cv.height }), reject);
            }, 'image/jpeg', quality || 0.92);
        });
    }

    /* ================= 独立入口 UI =================
     * 设计语言对齐「小雅辅助工具」主控台：
     *   - CSS 变量双主题（默认深色，可切换浅色，localStorage 持久化）
     *   - xy-panel / xy-action-btn / xy-mini-btn 组件家族 + xy-* 配色变量
     *   - FAB 可拖拽（pointer events，位置持久化）、面板标题栏拖拽
     *   - SVG 渐变 logo、aria 可访问性、prefers-reduced-motion 适配
     * 借鉴 GitHub 同类项目最佳实践（Summarizerrrr 拖拽记忆 / CKUI 主题系统 /
     * userscript UI 隔离规范）：样式作用域 #xyh-* 前缀，z-index 顶层。
     */

    var XyhTheme = {
        KEY: 'xyh_theme',
        get: function () {
            try { var t = (typeof GM_getValue === 'function') ? GM_getValue(this.KEY, '') : localStorage.getItem(this.KEY); return (t === 'light' || t === 'dark') ? t : 'dark'; }
            catch (e) { return 'dark'; }
        },
        set: function (t) {
            try { if (typeof GM_setValue === 'function') GM_setValue(this.KEY, t); } catch (e) {}
            try { localStorage.setItem(this.KEY, t); } catch (e) {}
        }
    };

    var XyhScope = {
        KEY: 'xyh_scope',
        get: function () {
            try {
                var raw = (typeof GM_getValue === 'function') ? GM_getValue(this.KEY, '') : localStorage.getItem(this.KEY);
                var o = raw ? JSON.parse(raw) : {};
                return { q: o.q !== false, std: o.std !== false, mine: o.mine !== false };
            } catch (e) { return { q: true, std: true, mine: true }; }
        },
        set: function (scope) {
            try { if (typeof GM_setValue === 'function') GM_setValue(this.KEY, JSON.stringify(scope)); } catch (e) {}
            try { localStorage.setItem(this.KEY, JSON.stringify(scope)); } catch (e) {}
        }
    };
    console.log('[小雅作业华为笔记导出] 引擎加载完成 v1.0.1');

    // 调试句柄：控制台可用 XyHandwriting.* 手动调用引擎各模块
    try { globalThis.XyHandwriting = { XYPaper: XYPaper, XYHinote: XYHinote, XYExport: XYExport, get XY_HW_DB() { return XY_HW_DB; }, xyHWRaster: xyHWRaster, xyHWRasterPrinted: xyHWRasterPrinted }; } catch (e) {}

    function xyhToast(msg, type) {
        var colors = { success: '#10b981', error: '#ef4444', warning: '#f59e0b', info: '#4f46e5' };
        var t = document.createElement('div');
        t.setAttribute('role', 'status');
        t.style.cssText = 'position:fixed; left:50%; transform:translateX(-50%); bottom:96px; z-index:2147483647;' +
            'background:rgba(15,23,42,.94); color:#fff; font-size:12.5px; padding:10px 16px; border-radius:10px; max-width:72vw;' +
            'border-left:3px solid ' + (colors[type] || colors.info) + '; box-shadow:0 8px 28px rgba(0,0,0,.28);' +
            (document.getElementById('xyh-fab') && document.getElementById('xyh-fab').getAttribute('data-theme') === 'light'
                ? 'background:#ffffff; color:#0f172a; border:1px solid #e2e8f0;' : '');
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(function () { t.remove(); }, 3200);
    }
    var toast = xyhToast;

    function xyhSaveBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }
    var saveBlob = xyhSaveBlob;

    function xyhStamp() {
        var d = new Date(), p = function (v) { return String(v).padStart(2, '0'); };
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
               p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }
    var stamp = xyhStamp;

    /** SVG 渐变 logo：钢笔笔尖 + 笔迹波线（紫→青渐变，与主工具 accent 家族同源） */
    var XYH_LOGO_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
        '<defs><linearGradient id="xyh-lg" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#a855f7"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs>' +
        '<rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="url(#xyh-lg)" stroke-width="1.6"/>' +
        '<path d="M12 6.2 L14.6 12.4 L12 11.2 L9.4 12.4 Z" fill="url(#xyh-lg)"/>' +
        '<path d="M12 11.2 L12 16.2" stroke="url(#xyh-lg)" stroke-width="1.5" stroke-linecap="round"/>' +
        '<path d="M6.4 18.4 C8.2 17.2 9.8 19.2 11.6 18.2 C13.4 17.2 15 19 17.6 18" fill="none" stroke="url(#xyh-lg)" stroke-width="1.4" stroke-linecap="round"/></svg>';

    /** 主题变量表：与主控台 --xy-* 配色同源 */
    function xyhThemeVars(t) {
        return t === 'light'
            ? { surface: '#ffffff', surface2: '#f8fafc', border: '#e2e8f0', borderLight: '#cbd5e1',
                text: '#0f172a', text2: '#475569', muted: '#94a3b8', inputBg: '#ffffff', maskBg: 'rgba(15,23,42,0.35)' }
            : { surface: 'rgba(15,23,42,0.92)', surface2: 'rgba(30,41,59,0.65)', border: 'rgba(71,85,105,0.45)', borderLight: 'rgba(71,85,105,0.6)',
                text: '#e2e8f0', text2: '#cbd5e1', muted: '#94a3b8', inputBg: 'rgba(15,23,42,0.5)', maskBg: 'rgba(0,0,0,0.4)' };
    }
    function xyhApplyTheme(root, fab, theme) {
        var v = xyhThemeVars(theme);
        var s = root.style;
        s.setProperty('--xyh-surface', v.surface);
        s.setProperty('--xyh-surface2', v.surface2);
        s.setProperty('--xyh-border', v.border);
        s.setProperty('--xyh-border-light', v.borderLight);
        s.setProperty('--xyh-text', v.text);
        s.setProperty('--xyh-text2', v.text2);
        s.setProperty('--xyh-muted', v.muted);
        s.setProperty('--xyh-input-bg', v.inputBg);
        fab.setAttribute('data-theme', theme);
        var tg = root.querySelector('#xyh-theme-toggle');
        if (tg) tg.textContent = theme === 'light' ? '🌙' : '☀️';
    }

    function xyhScopeGet() { var sc = XyhScope.get();
        ['q', 'std', 'mine'].forEach(function (k) {
            var el = document.getElementById('xyh-scope-' + k);
            if (el) sc[k] = el.checked;
        });
        return sc;
    }

    async function exportAs(fmt) {
        var autoImages = [];
        var imMap = new Map();
        var text = '';
        if (hwQuestionsData && hwQuestionsData.length) {
            var _items = xyExpCollect();
            var _nt = xyExpNotesText(_items, xyhScopeGet(), true);
            text = _nt.text;
            imMap = _nt.imgList.length ? await hwHydrateImageMap(_nt.imgList, 1000, false) : new Map();
            autoImages = xyExpNotesImages(_nt.imgList, imMap);
        }
        if (!text) { xyhToast('还未捕获到作业题目，请先打开作业/试卷页面', 'warning'); return; }
        try { await xyhLoadDb(); } catch (e) { xyhToast('笔顺库加载失败：' + ((e && e.message) || e), 'error'); return; }
        await xyhLoadTexMap(); /* 公式映射表，失败静默降级 */
        var btns = document.querySelectorAll('[data-xhn-fmt]');
        btns.forEach(function (b) { b.disabled = true; });
        var st = document.getElementById('xyh-status');
        if (st) { st.textContent = '⏳ 正在生成' + (fmt === 'hinote' ? ' .hinote' : fmt === 'pdf' ? ' PDF' : ' 图片') + '…'; st.style.opacity = '1'; }
        try {
            var res = XYPaper.build(text, {
                db: XY_HW_DB, ink: 0x1A1A1A,
                raster: xyHWRaster, rasterPrinted: xyHWRasterPrinted,
                images: autoImages
            });
            if (!res || !res.strokes || !res.strokes.length) { xyhToast('生成失败：未产出笔迹', 'error'); return; }
            var rawName = (document.getElementById('xhn-fname') && document.getElementById('xhn-fname').value) || '手写归档';
            var title = rawName.replace(/[\\/:*?"<>|]/g, '_') + '_' + xyhStamp();
            if (fmt === 'hinote') {
                var buf = await XYHinote.writeHinote(res.strokes, { title: title, pageColor: -1 });
                xyhSaveBlob(new Blob([buf], { type: 'application/octet-stream' }), title + '.hinote');
                xyhToast('✅ 已导出 ' + title + '.hinote（' + res.stats.pages + ' 页）', 'success');
            } else {
                var imgLayout = [];
                if (autoImages.length && res.imgLayout) {
                    for (var _pi = 0; _pi < res.imgLayout.length; _pi++) {
                        var pl = res.imgLayout[_pi];
                        var im = autoImages[pl.idx];
                        if (!im) continue;
                        var el = await xyExpImgEl(im.src, imMap);
                        if (el) imgLayout.push({ page: pl.page, x: pl.x, y: pl.y, w: pl.w, h: pl.h, img: el });
                    }
                }
                if (fmt === 'pdf') {
                    await XYExport.downloadPDF(res, res.strokes, title, 150, 0.92, imgLayout);
                    xyhToast('✅ 已导出 PDF（' + res.stats.pages + ' 页）', 'success');
                } else {
                    await XYExport.downloadJPGs(res, res.strokes, title, 150, 0.92, imgLayout);
                    xyhToast('✅ 已导出图片（' + res.stats.pages + ' 页）', 'success');
                }
            }
            if (st) { st.textContent = '✅ 上次导出：' + res.stats.chars + ' 字 / ' + res.stats.pages + ' 页'; st.style.opacity = '.85'; }
        } catch (e) {
            xyhToast('导出失败：' + ((e && e.message) || e), 'error');
            if (st) { st.textContent = '❌ 导出失败'; }
        } finally {
            btns.forEach(function (b) { b.disabled = false; });
        }
    }

    /* ================= 文字 / Markdown → 手写 =================
     * 借鉴：matt-bat/programmatic-text-to-handwriting（MD → 块解析 → 逐块渲染·确定性种子）、
     * RustyPiano/Markdown2Handwrite（块解析先行再渲染）、本地 remark-docx fork（块类型集合）。
     * 三段式：MD 块解析 → 块到排版文本映射（■ 标题/• 列表/缩进代码/引用前缀）→ 交给
     * XYPaper.build 现有手写引擎，引擎零改动。 */
    function xyhMdInline(t) {
        return String(t || '')
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/__([^_]+)__/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/~~([^~]+)~~/g, '$1')
            .replace(/`([^`]+)`/g, '$1');
    }

    function xyhMdParse(md) {
        var rows = String(md || '').replace(/\r\n/g, '\n').split('\n');
        var blocks = [], inCode = false, codeBuf = [];
        var listRe = /^(\s*)([-*+]|\d+[.、)])\s+(.*)$/;
        for (var i = 0; i < rows.length; i++) {
            var ln = rows[i];
            if (/^```/.test(ln.trim())) {
                if (!inCode) { inCode = true; codeBuf = []; }
                else { blocks.push({ t: 'code', text: codeBuf.join('\n') }); inCode = false; }
                continue;
            }
            if (inCode) { codeBuf.push(ln); continue; }
            var t = ln.trim();
            /* [MD-LAYOUT] 空行保留为 blank 块——作者分段意图，转文本时作段落间距 */
            if (!t) { blocks.push({ t: 'blank' }); continue; }
            var h = t.match(/^(#{1,6})\s+(.*)$/);
            if (h) { blocks.push({ t: 'h', level: Math.min(h[1].length, 3), text: xyhMdInline(h[2]) }); continue; }
            if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { blocks.push({ t: 'hr' }); continue; }
            var q = t.match(/^>\s?(.*)$/);
            if (q) { blocks.push({ t: 'quote', text: xyhMdInline(q[1]) }); continue; }
            var li = ln.match(listRe);
            /* [MD-FIX] 无空格星号列表（*要点——网页/聊天复制常见丢空格形态），
             * 仅当 * 后紧跟非空白非 * 才认定，防误伤 **粗体** 与乘号 */
            if (!li && /^\*[^*\s]/.test(t)) li = [t, '', '*', t.slice(1)];
            if (li) {
                var depth = Math.floor(li[1].replace(/\t/g, '  ').length / 2);
                var ordered = /\d/.test(li[2]);
                blocks.push({ t: 'li', depth: Math.min(depth, 2), mark: ordered ? li[2] : '•', text: xyhMdInline(li[3]) });
                continue;
            }
            blocks.push({ t: 'p', text: xyhMdInline(t) });
        }
        if (inCode && codeBuf.length) blocks.push({ t: 'code', text: codeBuf.join('\n') });
        return blocks;
    }

    function xyhDetectMd(text) {
        if (!text) return false;
        var n = 0;
        String(text).split('\n').forEach(function (l) {
            if (/^#{1,6}\s/.test(l) || /^```/.test(l) || /^[-*+]\s/.test(l) || /^\d+[.、)]\s/.test(l) || /^>\s/.test(l)) n++;
            /* 行内标记（粗体/删除线）与无空格星号列表同样算 MD 特征——
             * 修「纯段落带 **粗体** 却走纯文本路径遗留星号」问题 */
            else if (/\*\*[^*]+\*\*/.test(l) || /~~[^~]+~~/.test(l) || /^\*[^*\s]/.test(l)) n++;
        });
        return n >= 1;
    }

    function xyhBlocksToText(blocks) {
        var out = [];
        blocks.forEach(function (b) {
            var pad = b.depth ? new Array(b.depth + 1).join('　') : '';
            if (b.t === 'blank') { out.push(''); return; }
            /* [MD-LAYOUT] 结构块（标题/代码/引用/分割线）前自动空一行，与正文呼吸分隔 */
            if ((b.t === 'h' || b.t === 'hr' || b.t === 'code' || b.t === 'quote') && out.length && out[out.length - 1] !== '') out.push('');
            if (b.t === 'h') {
                out.push((b.level === 1 ? '■ ' : b.level === 2 ? '◆ ' : '· ') + b.text);
                out.push(''); /* 标题后空一行 */
            }
            else if (b.t === 'li') out.push(pad + b.mark + ' ' + b.text);
            else if (b.t === 'code') {
                out.push('── 代码 ──');
                b.text.split('\n').forEach(function (cl) { out.push('　' + cl); });
                out.push('────────');
                out.push('');
            }
            else if (b.t === 'quote') out.push('▍ ' + b.text);
            else if (b.t === 'hr') out.push('────────────');
            else out.push(b.text);
        });
        /* [MD-LAYOUT] 归一：连续空行压成一行、去首尾空行——空行只作段落间距不堆叠 */
        var res = [];
        for (var i = 0; i < out.length; i++) {
            if (out[i] === '' && (res.length === 0 || res[res.length - 1] === '')) continue;
            res.push(out[i]);
        }
        while (res.length && res[res.length - 1] === '') res.pop();
        return res.join('\n');
    }

    /* ================= LaTeX 公式 → 手写笔迹 =================
     * 方案参考 GitHub 通用管线（MathJax v3 tex2svg → SVG → Image → canvas 逐像素，
     * 见 texsvg / dsh-latex-tools）：SVG 自包含 path 无字体依赖，境内走 jsdmirror。
     * 位图格式与 xyHWRasterPrinted 同构（透明底+白字，亮=墨迹），导出层经
     * thin → traceStrokes 转真笔迹——.hinote（纯笔迹格式）里公式同样有效。 */
    var XYH_MJ_URL = 'https://cdn.jsdmirror.com/npm/mathjax@3.2.2/es5/tex-svg.js';
    var _xyhMjReady = null;
    var _xyhMjEngine = null;   /* 就绪后的 MathJax 引擎引用（页面上下文或沙箱） */

    /** MathJax v3 配置：必须在脚本执行前就位；fontCache='none' 让每个 SVG 自包含
     * path，否则 dataURL 化后 <use> 引用全局缓存失效，导出空白。 */
    function xyhMjConfig() {
        return {
            svg: { fontCache: 'none' },
            tex: { packages: { '[+]': ['ams'] } },
            startup: { typeset: false },
            options: { enableMenu: false }
        };
    }

    /** 公式引擎加载（script 注入 + unsafeWindow，CDP 真机验证）：
     * 真实站点页面实测：script 注入 jsdmirror 655ms、CSP 未拦截、tex2svg 5/5 全过。
     * GM eval 沙箱通道真机失败（MathJax 大包在脚本沙箱内初始化异常）→ 弃用。
     * MathJax 运行在页面上下文，通过 unsafeWindow.MathJax 访问。 */
    function xyhLoadMathJax() {
        if (_xyhMjReady) return _xyhMjReady;
        _xyhMjReady = new Promise(function (resolve, reject) {
            var UW = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
            try { if (!UW.MathJax) UW.MathJax = xyhMjConfig(); } catch (e) { /* 只读时忽略 */ }
            var sc = document.createElement('script');
            sc.src = XYH_MJ_URL;
            sc.onload = function () {
                console.log('[小雅作业华为笔记导出] 公式引擎脚本加载完成，等待初始化…');
                var _mjTries = 0;
                (function _mjWait() {
                    if (UW.MathJax && UW.MathJax.tex2svg) { _xyhMjEngine = UW.MathJax; resolve(UW.MathJax); return; }
                    if (++_mjTries > 100) { _xyhMjReady = null; reject(new Error('MathJax 初始化超时（10s）')); return; }
                    setTimeout(_mjWait, 100);
                })();
            };
            sc.onerror = function () { _xyhMjReady = null; reject(new Error('MathJax 脚本加载失败（网络或 CSP）')); };
            document.head.appendChild(sc);
        });
        return _xyhMjReady;
    }

    /** LaTeX → Unicode 线性文本：公式不再走 MathJax 位图（与手写风格不搭、链路
     * 脆弱），改为线性化后并入正文，走与其他文字完全相同的手写笔迹引擎——
     * 手写笔记场景下分式写 a/b、上标写 ² 完全符合真实书写习惯。 */
    function xyhTexToLinear(tex) {
        var t = String(tex || '');
        /* 映射表外置（xy-hw-tex.json）：希腊字母 / 运算符 / 上下标均不内嵌脚本。
         * 未加载成功时仅保留结构命令兜底，公式结构转换（分式/根号/上下标剥除）不受影响。 */
        var MAP = _XY_HW_TEX || {};
        var greek = MAP.greek || {};
        var ops = {}, _k;
        for (_k in _XY_HW_TEX_CORE_OPS) ops[_k] = _XY_HW_TEX_CORE_OPS[_k];
        for (_k in (MAP.ops || {})) ops[_k] = MAP.ops[_k];
        var sup = MAP.sup || {};
        var sub = MAP.sub || {};
        Object.keys(greek).forEach(function (k) { t = t.split('\\' + k).join(greek[k]); });
        /* 运算符：命令长度降序替换，防 \le 抢配 \leq */
        Object.keys(ops).sort(function (a, b) { return b.length - a.length; }).forEach(function (k) { t = t.split('\\' + k).join(ops[k]); });
        /* 数学函数名保留原文（cos/sin/tan/lim/log/ln/max/min/exp） */
        /* 上下标 → Unicode 上/下标（常见单字符与数字）；无对应时保留 ^ x 原样 */
        function supSub(re, table) {
            t = t.replace(re, function (m, body) {
                body = body.trim();
                /* 整段可映射则全转，否则保留原记法 */
                var ok = true, mapped = '';
                for (var q = 0; q < body.length; q++) {
                    var ch = body[q];
                    if (table[ch]) mapped += table[ch];
                    else if (ch === ' ') { mapped += ''; }
                    else { ok = false; break; }
                }
                return ok ? mapped : m;
            });
        }
        supSub(/\^\{([^{}]*)\}/g, sup);
        supSub(/\^(\S)/g, sup);
        supSub(/_\{([^{}]*)\}/g, sub);
        supSub(/_(\S)/g, sub);
        /* 分式 → (分子)/(分母)：反复处理最内层（嵌套 \frac 由内向外） */
        var guard = 0;
        while (t.indexOf('\\frac') !== -1 && guard++ < 20) {
            t = t.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, function (m, a, b) {
                return '(' + a.trim() + ')/(' + b.trim() + ')';
            });
        }
        /* 根号：\sqrt{x} → √(x)；\sqrt[n]{x} → ⁿ√(x) */
        t = t.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, function (m, n, x) { return (sup[n] || '^(' + n + ')') + '√(' + x.trim() + ')'; });
        t = t.replace(/\\sqrt\s*\{([^{}]*)\}/g, function (m, x) { return '√(' + x.trim() + ')'; });
        /* 定界符与修饰清理 */
        t = t.replace(/\\left\s*\\\{/g, '{').replace(/\\right\s*\\\}/g, '}');
        t = t.replace(/\\left\s*\[/g, '[').replace(/\\right\s*\]/g, ']');
        t = t.replace(/\\left\s*\|/g, '|').replace(/\\right\s*\|/g, '|');
        t = t.replace(/\\left\s*\./g, '').replace(/\\right\s*\./g, '');
        t = t.replace(/\\(text|mathrm|mathbf|mathit)\s*\{([^{}]*)\}/g, '$2');
        t = t.replace(/\\(,|;|:|!)/g, ' ');
        t = t.replace(/\\\\/g, '；');
        t = t.replace(/\\overline\s*\{([^{}]*)\}/g, 'overline($1)');
        t = t.replace(/\\hat\s*\{([^{}]*)\}/g, '$1^');
        t = t.replace(/\\vec\s*\{([^{}]*)\}/g, '$1→');
        /* 残留命令兜底：未知 \command 直接剥掉反斜杠保留名字 */
        t = t.replace(/\\([a-zA-Z]+)/g, '$1');
        t = t.replace(/[{}]/g, '');
        /* 多空格归一 */
        t = t.replace(/ {3,}/g, '  ');
        return t.trim();
    }
    /** 提取 $..$（块级）与 $..$（行内）公式，替换为图片占位符（复用图片占行机制）。
     * 规则：$ 后非空白且配对侧非数字，避免「价格 $5」误判。 */
    function xyhExtractFormulas(text) {
        /* 公式 → 线性手写文本：不再走 MathJax 位图/占位符/引擎加载整条链，
         * 公式与正文共用同一手写笔迹引擎（风格统一）。formulas 恒空使
         * 调用点的引擎加载/光栅化分支自然短路（保留以兼容结构）。 */
        var t = String(text || '');
        var n = 0;
        t = t.replace(/\$\$([\s\S]+?)\$\$/g, function (m, f) { n++; return '\n' + xyhTexToLinear(f) + '\n'; });
        t = t.replace(/\$(\S(?:[^$\n]*\S)?)\$/g, function (m, f) {
            var core = f.trim();
            if (!core) return m;
            n++;
            return xyhTexToLinear(core);
        });
        /* [MD-LAYOUT] 排版归一：块级公式自带前后空行，与正文不粘连；
         * 行尾空白清除、连续空行压成一个、去首尾空行 */
        t = t.replace(/[ \t]+\n/g, '\n');
        t = t.replace(/\n{3,}/g, '\n\n');
        t = t.replace(/^\n+/, '').replace(/\n+$/, '');
        return { text: t, formulas: [], count: n };
    }

    /** 公式 → 光栅位图：tex2svg → SVG（白字，亮=墨迹）→ dataURL → Image → canvas 灰度。 */
    function xyhRasterFormula(latex, display) {
        return new Promise(function (resolve, reject) {
            var svg;
            try {
                if (!_xyhMjEngine) throw new Error('公式引擎未就绪');
                var node = _xyhMjEngine.tex2svg(latex, { display: !!display });
                svg = node.firstElementChild;
                if (!svg || svg.tagName.toLowerCase() !== 'svg') throw new Error('tex2svg 无输出');
                svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                /* 不设 color：MathJax glyph 默认黑字（不赌 currentColor 行为），
                 * 画布填白底后按「暗=墨迹」二值化，与栅格格式等价。 */
            } catch (e) { reject(e); return; }
            var vb = svg.viewBox && svg.viewBox.baseVal;
            var vw = (vb && vb.width) || 300, vh = (vb && vb.height) || 100;
            /* 尺寸防御：位图最大边限 400px（真实复杂公式 SVG 可达数百 pt，无限制时大位图消耗过大）；小 SVG 最多 3x 超采样 */
            var scale = Math.min(3, 400 / Math.max(vw, vh));
            if (scale < 0.05) scale = 0.05;
            var cw = Math.max(8, Math.round(vw * scale)), chh = Math.max(8, Math.round(vh * scale));
            var url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg.outerHTML)));
            var img = new Image();
            img.onload = function () {
                try {
                    var cv = document.createElement('canvas');
                    cv.width = cw; cv.height = chh;
                    var g = cv.getContext('2d', { willReadFrequently: true });
                    g.fillStyle = '#fff';
                    g.fillRect(0, 0, cw, chh);                  /* 白底：黑字公式与底形成对比 */
                    g.drawImage(img, 0, 0, cw, chh);
                    var d = g.getImageData(0, 0, cw, chh).data;
                    var out = new Uint8Array(cw * chh);
                    var inkN = 0;
                    for (var i = 0; i < out.length; i++) {
                        /* 暗=墨迹：输出 0/255 二值，与栅格格式（>128=墨迹）完全同构 */
                        out[i] = d[i * 4] < 128 ? 255 : 0;
                        if (out[i]) inkN++;
                    }
                    if (inkN < out.length * 0.0005) throw new Error('公式渲染空白（MathJax 输出未落墨）');
                    resolve({ w: cw, h: chh, data: out, dataUrl: url });
                } catch (e) { reject(e); }
            };
            img.onerror = function () { reject(new Error('公式 SVG 加载失败')); };
            img.src = url;
        });
    }

    /** 文字/Markdown → 手写（双模式）：plain=纯文字面板所见即所得（零解析零剥除，
     * 公式也不处理）；MD=结构化解析 + LaTeX 公式 → MathJax 笔迹。 */
    async function xyhExportText(fmt, plain) {
        var ta = document.getElementById(plain ? 'xyh-text-input' : 'xyh-md-input');
        var raw = (ta && ta.value || '').trim();
        if (!raw) { xyhToast(plain ? '请先粘贴文字内容' : '请先粘贴 Markdown 内容', 'warning'); return; }
        try { await xyhLoadDb(); } catch (e) { xyhToast('笔顺库加载失败：' + ((e && e.message) || e), 'error'); return; }
        await xyhLoadTexMap(); /* 公式映射表，失败静默降级 */
        var st0 = document.getElementById(plain ? 'xyh-text-status' : 'xyh-md-status');
        /* [SPLIT] 双面板分离：纯文字面板所见即所得；Markdown 面板永远走结构化解析。 */
        var text = raw, blockCount = 0;
        if (!plain) {
            var blocks = xyhMdParse(raw);
            blockCount = blocks.length;
            text = xyhBlocksToText(blocks);
        }
        var btns = document.querySelectorAll(plain ? '[data-xhn-text-fmt]' : '[data-xhn-md-fmt]');
        btns.forEach(function (b) { b.disabled = true; });
        var st = st0;
        if (st) { st.textContent = '⏳ 正在生成' + (fmt === 'hinote' ? ' .hinote' : fmt === 'pdf' ? ' PDF' : ' 图片') + '…'; st.style.opacity = '1'; }
        /* [FORMULA-FIX] LaTeX 公式提取（仅 Markdown 面板）：$$..$$ 与 $..$ → 占位符，
         * MathJax 光栅化转真笔迹；纯文字面板所见即所得，不做公式处理。 */
        var ext = plain ? { formulas: [], text: text } : xyhExtractFormulas(text);
        text = ext.text;
        var fmlBitmaps = [];
        if (ext.formulas.length) {
            if (st0) st0.textContent = '🧮 检测到 ' + ext.formulas.length + ' 个公式，正在准备渲染…';
            try { await xyhLoadMathJax(); } catch (e) { xyhToast('公式引擎加载失败，公式将以原文手写：' + ((e && e.message) || e), 'warning'); }
        }
        if (ext.formulas.length && _xyhMjEngine && _xyhMjEngine.tex2svg) {
            var failed = [];
            for (var _fi = 0; _fi < ext.formulas.length; _fi++) {
                try {
                    var bm = await xyhRasterFormula(ext.formulas[_fi], true);
                    fmlBitmaps.push(bm);
                    console.log('[小雅作业华为笔记导出] 公式 ' + (_fi + 1) + '/' + ext.formulas.length + ' 渲染成功');
                } catch (e2) { failed.push(_fi); fmlBitmaps.push(null); console.log('[小雅作业华为笔记导出] 公式 ' + (_fi + 1) + ' 渲染失败（回退原文）:', (e2 && e2.message) || e2); }
            }
            /* 渲染失败的公式：占位符回退为 LaTeX 原文（按普通文本手写） */
            if (failed.length) {
                failed.forEach(function (fi) {
                    text = text.split('\uE000' + fi).join('$' + ext.formulas[fi] + '$');
                });
                xyhToast(failed.length + ' 个公式渲染失败，已按原文手写', 'warning');
            }
        }
        var fmlImages = ext.formulas.length ? ext.formulas.map(function (f, fi) {
            var bm = fmlBitmaps[fi];
            if (!bm) return null;
            return { src: bm.dataUrl, w: bm.w, h: bm.h, bitmap: { w: bm.w, h: bm.h, data: bm.data } };
        }) : null;
        try {
            var res = XYPaper.build(text, {
                db: XY_HW_DB, ink: 0x1A1A1A,
                raster: xyHWRaster, rasterPrinted: xyHWRasterPrinted,
                images: fmlImages
            });
            if (!res || !res.strokes || !res.strokes.length) { xyhToast('生成失败：未产出笔迹', 'error'); return; }
            var fnameEl = document.getElementById(plain ? 'xhn-text-fname' : 'xyh-md-fname');
            var rawName = (fnameEl && fnameEl.value) || '笔记转换';
            var title = rawName.replace(/[\/:*?"<>|]/g, '_') + '_' + xyhStamp();
            if (fmt === 'hinote') {
                /* [PAPER-FIX] pageColor:-1 = 白纸 0xFFFFFFFF（引擎默认深灰底导致黑底黑字） */
                var buf = await XYHinote.writeHinote(res.strokes, { title: title, pageColor: -1 });
                xyhSaveBlob(new Blob([buf], { type: 'application/octet-stream' }), title + '.hinote');
                xyhToast('✅ 已导出 ' + title + '.hinote（' + res.stats.pages + ' 页）', 'success');
            } else {
                /* [FORMULA-FIX] 公式位图渲染为 Image，按 res.imgLayout 定位传入导出层 */
                var imgLayout = [];
                if (fmlImages && res.imgLayout) {
                    for (var _pi = 0; _pi < res.imgLayout.length; _pi++) {
                        var pl = res.imgLayout[_pi];
                        var fim = fmlImages[pl.idx];
                        if (!fim || !fim.src) continue;
                        var fel = await new Promise(function (resolve) {
                            var el = new Image();
                            el.onload = function () { resolve(el); };
                            el.onerror = function () { resolve(null); };
                            el.src = fim.src;
                        });
                        if (fel) imgLayout.push({ page: pl.page, x: pl.x, y: pl.y, w: pl.w, h: pl.h, img: fel });
                    }
                }
                if (fmt === 'pdf') {
                    await XYExport.downloadPDF(res, res.strokes, title, 150, 0.92, imgLayout);
                    xyhToast('✅ 已导出 PDF（' + res.stats.pages + ' 页）', 'success');
                } else {
                    await XYExport.downloadJPGs(res, res.strokes, title, 150, 0.92, imgLayout);
                    xyhToast('✅ 已导出图片（' + res.stats.pages + ' 页）', 'success');
                }
            }
            if (st) { st.textContent = '✅ 上次导出：' + res.stats.chars + ' 字 / ' + res.stats.pages + ' 页' + (!plain && blockCount ? ' · Markdown ' + blockCount + ' 区块' : ''); st.style.opacity = '1'; }
        } catch (e) {
            xyhToast('导出失败：' + ((e && e.message) || e), 'error');
            if (st) { st.textContent = '❌ 导出失败'; }
        } finally {
            btns.forEach(function (b) { b.disabled = false; });
        }
    }

    function xyhMakeDraggable(handle, target, posKey) {
        handle.style.cursor = 'move';
        handle.addEventListener('pointerdown', function (ev) {
            if (ev.target.closest('#xyh-theme-toggle,#xyh-minimize')) return;
            ev.preventDefault();
            var startX = ev.clientX, startY = ev.clientY;
            var rect = target.getBoundingClientRect();
            var ox = rect.left, oy = rect.top;
            function move(e) {
                var nx = Math.min(Math.max(0, ox + e.clientX - startX), window.innerWidth - rect.width);
                var ny = Math.min(Math.max(0, oy + e.clientY - startY), window.innerHeight - 48);
                target.style.left = nx + 'px'; target.style.top = ny + 'px';
                target.style.right = 'auto'; target.style.bottom = 'auto';
            }
            function up() {
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', up);
                try { localStorage.setItem(posKey, JSON.stringify({ l: target.style.left, t: target.style.top })); } catch (e) {}
            }
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', up);
        });
    }

    function xyhRestoreFabPos(fab) {
        try {
            var p = JSON.parse(localStorage.getItem('xyh_fab_pos') || 'null');
            if (p && p.l && p.t) { fab.style.left = p.l; fab.style.top = p.t; fab.style.right = 'auto'; fab.style.bottom = 'auto'; }
        } catch (e) {}
    }

    function buildUI() {
        try {
        if (document.getElementById('xyh-fab')) return;
        var theme = XyhTheme.get();

        /* ── FAB 悬浮按钮（SVG logo，可拖拽记忆位置） ── */
        var fab = document.createElement('button');
        fab.id = 'xyh-fab';
        fab.type = 'button';
        fab.setAttribute('aria-label', '手写归档');
        fab.setAttribute('data-theme', theme);
        fab.innerHTML = XYH_LOGO_SVG;
        fab.style.cssText = 'position:fixed; right:18px; bottom:18px; z-index:2147483647; width:46px; height:46px;' +
            'border-radius:14px; border:1px solid rgba(168,85,247,.5); background:linear-gradient(135deg,rgba(168,85,247,.16),rgba(6,182,212,.16))' +
            ',' + xyhThemeVars(theme).surface + '; cursor:pointer; box-shadow:0 4px 16px rgba(0,0,0,.2); touch-action:none;';
        xyhRestoreFabPos(fab);
        xyhMakeDraggable(fab, fab, 'xyh_fab_pos');
        fab.addEventListener('click', function (ev) {
            if (fab._dragged) { fab._dragged = false; return; }
            var p = document.getElementById('xyh-panel');
            if (p) p.style.display = p.style.display === 'none' ? 'flex' : 'none';
        });
        fab.addEventListener('pointerdown', function () { fab._downX = null; });
        fab.addEventListener('pointermove', function () {});

        /* ── 主面板（xy-panel 风格） ── */
        var panel = document.createElement('div');
        panel.id = 'xyh-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', '手写归档面板');
        panel.style.cssText = 'display:none; position:fixed; right:18px; bottom:74px; z-index:2147483647; width:368px;' +
            'max-height:min(78vh, 640px); overflow-y:auto; flex-direction:column; border-radius:12px; padding:0;' +
            'background:var(--xyh-surface); border:1px solid var(--xyh-border); box-shadow:0 16px 48px rgba(0,0,0,.3);' +
            "font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;";

        var css = document.createElement('style');
        css.textContent =
            '#xyh-panel *{box-sizing:border-box;}' +
            '@media (prefers-reduced-motion: reduce){#xyh-panel,#xyh-fab{transition:none !important;}}' +
            '#xyh-panel .xyh-head{display:flex; align-items:center; gap:9px; padding:11px 13px; border-bottom:1px solid var(--xyh-border);' +
                'background:var(--xyh-surface2); border-radius:12px 12px 0 0; user-select:none; touch-action:none;}' +
            '#xyh-panel .xyh-title{flex:1; font-size:12.5px; font-weight:700; color:var(--xyh-text); letter-spacing:.3px;}' +
            '#xyh-panel .xyh-icon-btn{border:none; background:transparent; color:var(--xyh-muted); font-size:14px; cursor:pointer;' +
                'padding:3px 6px; border-radius:7px; line-height:1;}' +
            '#xyh-panel .xyh-icon-btn:hover{background:var(--xyh-surface2); color:var(--xyh-text);}' +
            '#xyh-panel .xyh-body{padding:12px 13px; display:flex; flex-direction:column; gap:9px;}' +
            '#xyh-panel .xyh-tabs{display:flex; gap:6px; margin-bottom:8px;}' +
            '#xyh-panel .xyh-tab{flex:1; padding:7px 0; font-size:11.5px; font-weight:700; border-radius:8px; border:1px solid var(--xyh-border); background:transparent; color:var(--xyh-muted); cursor:pointer; transition:all .15s;}' +
            '#xyh-panel .xyh-tab.active{border-color:#06b6d4; color:#06b6d4; background:rgba(6,182,212,0.08);}' +
            '#xyh-panel textarea{width:100%; box-sizing:border-box; min-height:130px; resize:vertical; padding:8px 10px; font-size:11.5px; line-height:1.6; border-radius:8px; border:1px solid var(--xyh-border); background:var(--xyh-input-bg); color:var(--xyh-text); outline:none; font-family:inherit;}' +
            '#xyh-panel textarea:focus{border-color:#a855f7; box-shadow:0 0 0 3px rgba(168,85,247,.14);}' +
            '#xyh-panel .xyh-md-hint{font-size:10px; color:var(--xyh-muted); line-height:1.5; margin:3px 0 6px;}' +
            '#xyh-panel input{width:100%; padding:7px 10px; font-size:11.5px; border-radius:8px; border:1px solid var(--xyh-border);' +
                'background:var(--xyh-input-bg); color:var(--xyh-text); outline:none;}' +
            '#xyh-panel .xyh-meta{display:flex; justify-content:space-between; font-size:10px; color:var(--xyh-muted);}' +
            '#xyh-panel .xyh-btns{display:flex; gap:8px;}' +
            '#xyh-panel .xyh-btn{flex:1; min-height:36px; font-size:11.5px; font-weight:600; border-radius:9px; cursor:pointer;' +
                'display:flex; align-items:center; justify-content:center; gap:5px; transition:box-shadow .15s ease, transform .1s ease;}' +
            '#xyh-panel .xyh-btn:disabled{opacity:.5; cursor:not-allowed;}' +
            '#xyh-panel .xyh-btn:not(:disabled):active{transform:translateY(1px);}' +
            '#xyh-panel .xyh-btn-hinote{border:1px solid rgba(168,85,247,.45); background:rgba(168,85,247,.12); color:#a855f7;}' +
            '#xyh-panel .xyh-btn-hinote:not(:disabled):hover{box-shadow:0 2px 10px rgba(168,85,247,.3);}' +
            '#xyh-panel .xyh-btn-pdf{border:1px solid rgba(6,182,212,.45); background:rgba(6,182,212,.12); color:#06b6d4;}' +
            '#xyh-panel .xyh-btn-pdf:not(:disabled):hover{box-shadow:0 2px 10px rgba(6,182,212,.3);}' +
            '#xyh-panel .xyh-btn-jpg{border:1px solid var(--xyh-border-light); background:var(--xyh-surface2); color:var(--xyh-text2);}' +
            '#xyh-panel .xyh-btn-jpg:not(:disabled):hover{box-shadow:0 2px 10px rgba(0,0,0,.12);}' +
            '#xyh-panel .xyh-status{min-height:16px; font-size:10.5px; color:var(--xyh-muted); line-height:1.5;}' +
            '#xyh-panel .xyh-databar{display:flex; align-items:center; gap:8px; padding:7px 13px; font-size:10.5px;' +
                'color:var(--xyh-muted); background:var(--xyh-surface2); border-top:1px solid var(--xyh-border); border-bottom:1px solid var(--xyh-border);}' +
            '#xyh-panel .xyh-foot{font-size:9.5px; color:var(--xyh-muted); line-height:1.6; border-top:1px solid var(--xyh-border);' +
                'padding:8px 13px 10px;}';

        var head = document.createElement('div');
        head.className = 'xyh-head';
        head.innerHTML =
            '<span aria-hidden="true">' + XYH_LOGO_SVG + '</span>' +
            '<span class="xyh-title">小雅作业华为笔记导出</span>' +
            '<button type="button" id="xyh-upd-btn" class="xyh-icon-btn" aria-label="检查更新" title="检查更新" style="font-size:12.5px;">↻</button>' +
            '<button type="button" id="xyh-theme-toggle" class="xyh-icon-btn" aria-label="切换主题" title="切换主题"></button>' +
            '<button type="button" id="xyh-minimize" class="xyh-icon-btn" aria-label="收起面板" title="收起">—</button>';

        var body = document.createElement('div');
        body.className = 'xyh-body';
        body.innerHTML =
            '<div class="xyh-tabs">' +
                '<button class="xyh-tab active" data-xyh-tab="notes" type="button">📚 作业归档</button>' +
                '<button class="xyh-tab" data-xyh-tab="text" type="button">📄 纯文字</button>' +
                '<button class="xyh-tab" data-xyh-tab="md" type="button">📝 Markdown</button>' +
            '</div>' +
            '<div id="xyh-page-notes">' +
            '<div class="xyh-meta" style="margin-bottom:0;"><span id="xyh-count">进入作业页面自动捕获题目</span><span>A4 笔记纸 · 自动分页</span></div>' +
            '<div class="xyh-scope" style="display:flex; gap:11px; font-size:11px; color:var(--xyh-text2); margin-bottom:2px;">' +
                '<label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer;"><input type="checkbox" id="xyh-scope-q" style="accent-color:#06b6d4; cursor:pointer; margin:0;" checked/>题目</label>' +
                '<label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer;"><input type="checkbox" id="xyh-scope-std" style="accent-color:#06b6d4; cursor:pointer; margin:0;" checked/>标准答案</label>' +
                '<label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer;"><input type="checkbox" id="xyh-scope-mine" style="accent-color:#06b6d4; cursor:pointer; margin:0;" checked/>我的作答</label>' +
            '</div>' +
            '<input id="xhn-fname" placeholder="文件名（默认：作业手写归档）" aria-label="文件名">' +
            '<div class="xyh-btns">' +
                '<button class="xyh-btn xyh-btn-hinote" data-xhn-fmt="hinote" type="button">📒 .hinote</button>' +
                '<button class="xyh-btn xyh-btn-pdf" data-xhn-fmt="pdf" type="button">📄 PDF</button>' +
                '<button class="xyh-btn xyh-btn-jpg" data-xhn-fmt="jpg" type="button">🖼 图片</button>' +
            '</div>' +
            '<div id="xyh-status" class="xyh-status"></div>' +
            '</div>' +
            '<div id="xyh-page-text" style="display:none;">' +
                '<textarea id="xyh-text-input" placeholder="粘贴纯文字…&#10;所见即所得：原样手写，不解析任何标记" aria-label="纯文字内容"></textarea>' +
                '<div class="xyh-meta"><span id="xyh-text-count">0 字</span><span>A4 笔记纸 · 自动分页</span></div>' +
                '<input id="xhn-text-fname" placeholder="文件名（默认：手写笔记）" aria-label="文件名">' +
                '<div class="xyh-btns">' +
                    '<button class="xyh-btn xyh-btn-hinote" data-xhn-text-fmt="hinote" type="button">📒 .hinote</button>' +
                    '<button class="xyh-btn xyh-btn-pdf" data-xhn-text-fmt="pdf" type="button">📄 PDF</button>' +
                    '<button class="xyh-btn xyh-btn-jpg" data-xhn-text-fmt="jpg" type="button">🖼 图片</button>' +
                '</div>' +
                '<div id="xyh-text-status" class="xyh-status"></div>' +
            '</div>' +
            '<div id="xyh-page-md" style="display:none;">' +
            '<textarea id="xyh-md-input" placeholder="粘贴 Markdown…&#10;支持：# 标题 · - 列表 · 代码块 · > 引用 · --- 分隔线 · 公式&#10;标题与列表转结构化手写排版，公式转 MathJax 笔迹" aria-label="Markdown 内容"></textarea>' +
            '<div class="xyh-md-hint" id="xyh-md-hint">💡 自动识别：检测到 Markdown 语法按结构化排版（■ 标题 / • 列表 / 缩进代码），否则按纯文本手写</div>' +
            '<input id="xyh-md-fname" placeholder="文件名（默认：笔记转换）" aria-label="文件名">' +
            '<div class="xyh-btns">' +
                '<button class="xyh-btn xyh-btn-hinote" data-xhn-md-fmt="hinote" type="button">📒 .hinote</button>' +
                '<button class="xyh-btn xyh-btn-pdf" data-xhn-md-fmt="pdf" type="button">📄 PDF</button>' +
                '<button class="xyh-btn xyh-btn-jpg" data-xhn-md-fmt="jpg" type="button">🖼 图片</button>' +
            '</div>' +
            '<div id="xyh-md-status" class="xyh-status"></div>' +
            '</div>';

        var foot = document.createElement('div');
        foot.className = 'xyh-foot';
        foot.textContent = '✍️ 笔顺级仿真手写 · 320 字/页自动排版 · 全程本地生成，数据不出浏览器';

        var shadowWrap = panel;
        shadowWrap.appendChild(css);
        shadowWrap.appendChild(head);
        shadowWrap.appendChild(body);
        shadowWrap.appendChild(foot);

        var databar = document.createElement('div');
        databar.className = 'xyh-databar';
        databar.innerHTML =
            '<span id="xyh-databar-text" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">📡 正在检测作业数据…</span>' +
            '<button type="button" id="xyh-refetch" class="xyh-icon-btn" aria-label="重新获取作业题目" title="重新获取作业题目" style="font-size:12px;">🔄</button>';
        shadowWrap.insertBefore(databar, body);
        xyhApplyTheme(panel, fab, theme);

        document.body.appendChild(fab);
        document.body.appendChild(panel);

        /* 主题切换 */
        panel.querySelector('#xyh-upd-btn').addEventListener('click', function () { try { xyhUpdOpen(); } catch (e) {} });
        panel.querySelector('#xyh-theme-toggle').addEventListener('click', function () {
            theme = theme === 'light' ? 'dark' : 'light';
            XyhTheme.set(theme);
            xyhApplyTheme(panel, fab, theme);
        });
        /* 收起 */
        panel.querySelector('#xyh-minimize').addEventListener('click', function () {
            panel.style.display = 'none';
        });
        /* 面板标题栏拖拽（跳过按钮） */
        xyhMakeDraggable(head, panel, 'xyh_panel_pos');
        try {
            var pp = JSON.parse(localStorage.getItem('xyh_panel_pos') || 'null');
            if (pp && pp.l && pp.t) { panel.style.left = pp.l; panel.style.top = pp.t; panel.style.right = 'auto'; panel.style.bottom = 'auto'; }
        } catch (e) {}
        /* FAB 拖拽 vs 点击判定 */
        (function () {
            var down = null;
            fab.addEventListener('pointerdown', function (e) { down = { x: e.clientX, y: e.clientY }; });
            fab.addEventListener('click', function (e) {
                if (down && (Math.abs(e.clientX - down.x) > 6 || Math.abs(e.clientY - down.y) > 6)) {
                    e.stopImmediatePropagation();
                }
            }, true);
        })();
        /* 导出按钮 */
        panel.querySelectorAll('[data-xhn-fmt]').forEach(function (b) {
            b.addEventListener('click', function () { void exportAs(b.getAttribute('data-xhn-fmt')); });
        });
        /* [MD-PANEL] 面板 Tab 切换 + 文字/Markdown 导出按钮 */
        panel.querySelectorAll('.xyh-tab').forEach(function (t) {
            t.addEventListener('click', function () {
                panel.querySelectorAll('.xyh-tab').forEach(function (x) { x.classList.remove('active'); });
                t.classList.add('active');
                var tab = t.getAttribute('data-xyh-tab');
                var pNotes = panel.querySelector('#xyh-page-notes'), pMd = panel.querySelector('#xyh-page-md'), pText = panel.querySelector('#xyh-page-text');
                if (pNotes) pNotes.style.display = tab === 'notes' ? '' : 'none';
                if (pText) pText.style.display = tab === 'text' ? '' : 'none';
                if (pMd) pMd.style.display = tab === 'md' ? '' : 'none';
            });
        });
        panel.querySelectorAll('[data-xhn-md-fmt]').forEach(function (b) {
            b.addEventListener('click', function () { void xyhExportText(b.getAttribute('data-xhn-md-fmt')); });
            /* [SPLIT] 纯文字面板：字数统计 + 导出（plain 模式，原样手写） */
            var taTxt = panel.querySelector('#xyh-text-input'), cntTxt = panel.querySelector('#xyh-text-count');
            if (taTxt && cntTxt) taTxt.addEventListener('input', function () {
                var n = taTxt.value.replace(/\s/g, '').length;
                cntTxt.textContent = n + ' 字' + (n > 0 ? ' · 约 ' + Math.max(1, Math.ceil(n / 320)) + ' 页' : '');
            });
            panel.querySelectorAll('[data-xhn-text-fmt]').forEach(function (b) {
                b.addEventListener('click', function () { void xyhExportText(b.getAttribute('data-xhn-text-fmt'), true); });
            });
        });
        /* 作业数据：手动重拉 + 自动探测 */
        panel.querySelector('#xyh-refetch').addEventListener('click', function () {
            var el = document.getElementById('xyh-databar-text');
            if (el) el.textContent = '📡 正在拉取作业题目…';
            if (hwQuestionsData.length === 0 && !getPaperId() && !/[?&]paper_id=/.test(location.href)) {
                if (el) el.textContent = '📡 未检测到作业参数 · 请先打开作业/试卷页面';
                xyhToast('请先进入作业或试卷页面再获取', 'warning');
                return;
            }
            hwQuestionsData = []; hwPdfQuestions = [];
            void hwProactiveFetchData();
        });
        function xyhAutoScan() {
            if (hwQuestionsData.length) { hwUpdateUI(); return; }
            if (getPaperId() || /[?&]paper_id=/.test(location.href)) void hwProactiveFetchData();
        }
        /* 内容范围：恢复勾选 + 变更持久化 */
        var sc = XyhScope.get();
        ['q', 'std', 'mine'].forEach(function (k) {
            var el = panel.querySelector('#xyh-scope-' + k);
            if (el) {
                el.checked = sc[k];
                el.addEventListener('change', function () {
                    var cur = { q: panel.querySelector('#xyh-scope-q').checked, std: panel.querySelector('#xyh-scope-std').checked, mine: panel.querySelector('#xyh-scope-mine').checked };
                    if (!cur.q && !cur.std && !cur.mine) { el.checked = true; xyhToast('至少保留一项内容', 'warning'); return; }
                    XyhScope.set(cur);
                });
            }
        });
        /* 笔顺库预取：后台静默加载，首次导出零等待 */
        setTimeout(function () { xyhLoadDb().catch(function () {}); xyhLoadTexMap().catch(function () {}); }, 1200);
        /* 更新提醒检查（6h 频控） */
        setTimeout(function () { try { xyhCheckUpdate(); } catch (e) {} }, 5000);
        setTimeout(xyhAutoScan, 800);
        setInterval(xyhAutoScan, 8000);
        hwUpdateUI();
        console.log('[小雅作业华为笔记导出] UI 已挂载');
        } catch (e) { console.error('[小雅作业华为笔记导出] UI 挂载失败：', e); }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', buildUI);
    } else {
        buildUI();
    }
})();
