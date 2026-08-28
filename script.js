(function () {
    'use strict';

    // ========================================
    // State
    // ========================================
    let currentIndex = -1;
    let toastTimer = null;
    const releaseTimers = new WeakMap();      // btn → setTimeout id（延迟释放 pressed 类）
    let generateThrottleTimer = null;        // generatePoem 节流锁，防止空格+click 双重触发

    // ========================================
    // DOM Elements
    // ========================================
    const poemText = document.getElementById('poemText');
    const poemSource = document.getElementById('poemSource');
    const generateBtn = document.getElementById('generateBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const copyBtn = document.getElementById('copyBtn');
    const themeBtns = document.querySelectorAll('.theme-btn');
    const body = document.body;
    const toast = document.getElementById('toast');

    // ========================================
    // Theme Config
    // ========================================
    const themeConfig = {
        white: { bg: '#FFFFFF', text: '#1A1A1A', secondary: '#888888' },
        black: { bg: '#0A0A0A', text: '#F0F0F0', secondary: '#888888' },
        gray:  { bg: '#F2F2F2', text: '#333333', secondary: '#888888' }
    };

    /* ==============================================================
     * Font loading gate — eliminate FOUT / "iOS half-rendered then jump"
     *  显示策略（两端 100% 一致）：
     *    body opacity=0 保持黑盒 → 字体字形真实验证通过 → 一次性加 fonts-loaded → 淡入
     *
     *  三重验证机制（winner takes last，缺一不可）：
     *   1. document.fonts.load() 显式预加载 4 个关键字重（Noto Serif SC 400/500、Inter 300/400）
     *      —— iOS Safari 的 document.fonts.ready 只会被动解析 CSS，不会主动去拉没用到的字重，
     *         必须显式 load 才能保证真的发起请求。
     *   2. Canvas measureText 字形实体验证（对比 Noto/Inter vs 强制 fallback 字体的宽度差）
     *      —— 解决 iOS document.fonts.ready 虚假 resolve（浏览器说"好了"但字形还在路上）。
     *         Noto Serif SC 和系统宋体（Songti SC）的字形宽度不同，Inter 和系统 sans 也不同，
     *         measureText 宽度相同 → 还在 fallback → 继续轮询；宽度不同 → 真实加载完成。
     *   3. setTimeout 5000ms 兜底 + CSS @keyframes 5200ms 终极兜底
     *      —— 网络不通 / 被屏蔽时，JS/CSS 两道独立保险保证页面不会永远白屏。
     * ============================================================== */
    (function unlockWhenFontsReady() {
        var MAX_WAIT_MS = 5000;          // 用户接受「显示慢一点」，给生僻字子集更多加载时间
        var POLL_INTERVAL_MS = 80;
        var html = document.documentElement;
        if (!html) return;

        var unlocked = false;
        function unlock() {
            if (unlocked) return;
            unlocked = true;
            if (html.classList && !html.classList.contains('fonts-loaded')) {
                html.classList.add('fonts-loaded');
            }
        }

        // ============= 构建探针文本：覆盖诗词库全部字符（含生僻字） =============
        // 原探针只有「赤橙黄绿青蓝紫…」一句，没覆盖诗里的生僻字，导致那些字的
        // Noto Serif SC 子集没被预加载、也没被验证 → 解锁后字形才到 → 可见跳变。
        // 现把全部诗词的 text+source 去重拼接，确保每个字（含生僻字）都被
        // document.fonts.load() 请求 + measureText 验证。poems.js 先于 script.js
        // 加载，此处 poems 已可用。
        function buildProbeText() {
            var arr = (typeof poems !== 'undefined') ? poems : [];
            if (!Array.isArray(arr)) arr = [];
            var seen = Object.create(null);
            var chars = '';
            for (var i = 0; i < arr.length; i++) {
                var p = arr[i] || {};
                var t = (p.text || '') + (p.source || '');
                for (var j = 0; j < t.length; j++) {
                    var c = t.charAt(j);
                    if (!seen[c]) { seen[c] = 1; chars += c; }
                }
            }
            // 兜底：poems 为空时用原探针保证常用字 + 拉丁字
            if (chars.length < 8) chars = '赤橙黄绿青蓝紫，谁持彩练当空舞？Verses';
            return chars;
        }
        var PROBE_TEXT = buildProbeText();
        var UI_TEXT = 'Verses · 主席诗词随机生成工具';

        // ============= 验证 2：Canvas measureText 字形实体验证 + 稳定性轮询 =============
        // 对比「目标字体」与「强制 fallback 到系统字体」的渲染宽度：
        //   Noto 宽度 = Songti 宽度 → 目标字体还没加载（仍在 fallback）→ 继续等
        //   Noto 宽度 ≠ Songti 宽度 → 目标字体已加载
        // 但生僻字子集可能晚于常用字加载：常用字已是 Noto、生僻字仍在 fallback 时，
        // 总宽度已 ≠ 全 fallback，单次度量会「假通过」。故再加稳定性轮询：
        //   连续 STABLE_REQUIRED 次宽度不变（没有更多子集在切换）才认为「全部渲染好」。
        var _probeCanvas = null;
        var _probeCtx = null;
        try {
            _probeCanvas = document.createElement('canvas');
            _probeCtx = _probeCanvas.getContext('2d');
        } catch (_) { _probeCtx = null; }

        function getTextWidth(family, weight, size, text) {
            if (!_probeCtx) return -1;
            try {
                _probeCtx.font = weight + ' ' + size + 'px ' + family;
                return _probeCtx.measureText(text).width;
            } catch (_) { return -1; }
        }

        var NOTO_FAMILY = '"Noto Serif SC", "Source Han Serif SC", serif';
        var SONG_FAMILY = '"Songti SC", "STSong", "SimSun", serif';
        var INTER_FAMILY = '"Inter", sans-serif';
        var SANS_FAMILY  = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

        var lastNotoW = -1;
        var stableCount = 0;
        var STABLE_REQUIRED = 2;   // 连续 2 次不变 ≈ 160ms 无字形切换
        function fontsReallyAvailable() {
            if (!_probeCtx) return true; // 不支持 Canvas 就跳过，走 timeout 兜底
            var notoW = getTextWidth(NOTO_FAMILY, '400', 40, PROBE_TEXT);
            var songW = getTextWidth(SONG_FAMILY, '400', 40, PROBE_TEXT);
            var interW = getTextWidth(INTER_FAMILY, '300', 20, UI_TEXT);
            var sansW  = getTextWidth(SANS_FAMILY, '300', 20, UI_TEXT);
            if (notoW < 0 || interW < 0) return true; // 度量失败跳过
            // Noto/Inter 是否真的加载（宽度 ≠ 系统回退）
            var notoLoaded = (notoW !== songW) && (interW !== sansW);
            if (!notoLoaded) {
                // 还在回退（或被屏蔽），重置稳定计数继续等
                stableCount = 0;
                lastNotoW = notoW;
                return false;
            }
            // Noto 已加载，确认宽度稳定（没有生僻字子集还在切换）
            if (notoW === lastNotoW) {
                stableCount++;
            } else {
                stableCount = 0;
                lastNotoW = notoW;
            }
            return stableCount >= STABLE_REQUIRED;
        }

        // 硬上限兜底：无论如何 5s 必解锁（生僻字子集加载慢，给足时间）
        var fallbackTimer = setTimeout(unlock, MAX_WAIT_MS);

        function pollUntilGlyphsReady() {
            if (unlocked) return;
            if (fontsReallyAvailable()) {
                unlock();
                try { clearTimeout(fallbackTimer); } catch (_) {}
                return;
            }
            // 继续轮询，直到 glyphs 真到了或 MAX_WAIT_MS 兜底触发
            setTimeout(pollUntilGlyphsReady, POLL_INTERVAL_MS);
        }

        // ============= 验证 1：document.fonts.load() 显式预加载（含生僻字子集） =============
        try {
            if (document.fonts && typeof document.fonts.load === 'function') {
                // 用 PROBE_TEXT（全部诗词字符，含生僻字）显式请求 Noto Serif SC 的所有
                // 相关 unicode-range 子集——不显式 load 的话浏览器不会主动拉生僻字所在
                // 的子集，直到真正渲染时才请求 → 解锁后才到 → 可见 fallback→Noto 跳变。
                // iOS Safari 不会像桌面 Chrome 那样把 CSS 里声明的全部 weight 都主动预加载，
                // 必须一个个显式 load() 才会真的发起请求。
                var loads = [
                    document.fonts.load('400 40px "Noto Serif SC"', PROBE_TEXT),
                    document.fonts.load('500 40px "Noto Serif SC"', PROBE_TEXT),
                    document.fonts.load('300 20px "Inter"', UI_TEXT),
                    document.fonts.load('400 20px "Inter"', UI_TEXT)
                ];
                Promise.all(loads).then(function () {
                    // 所有 load() resolve → 开始轮询真实验证（glyph 是否真的画出来不同宽度）
                    pollUntilGlyphsReady();
                }).catch(function () {
                    // 有请求失败也不直接放弃，先轮询看是否部分可用
                    pollUntilGlyphsReady();
                });
                // 同时 document.fonts.ready 作为第二个信号（有比没有好），
                // resolve 后再触发一轮验证（避免遗漏）
                if (document.fonts.ready && typeof document.fonts.ready.then === 'function') {
                    document.fonts.ready.then(function () { pollUntilGlyphsReady(); }).catch(function () {});
                }
            } else {
                // 老旧浏览器无 document.fonts → 直接启动轮询，看 Canvas 能否分辨；
                // 最差情况 MAX_WAIT_MS 兜底会解锁
                pollUntilGlyphsReady();
            }
        } catch (e) {
            // 异常兜底：立刻启动轮询（最差也是 MAX_WAIT_MS 必解锁）
            try { pollUntilGlyphsReady(); } catch (_) { unlock(); }
        }
    })();

    // ========================================
    // Fonts
    // ========================================
    // 页面展示字体（DOM）：优先思源宋体在线版，失败再回退系统宋体
    const DISPLAY_SERIF_FAMILY = [
        '"Noto Serif SC"',
        '"Source Han Serif SC"',
        '"Source Han Serif CN"',
        '"Songti SC"',
        '"STSong"',
        '"SimSun"',
        '"WenQuanYi Bitmap Song"',
        '"AR PL UMing CN"',
        '"AR PL SungtiL GB"',
        '"PingFang SC"',
        'serif'
    ].join(', ');

    // Canvas 导出字体（导出优先，必须保证 100% 有字）：
    //   关键修复 —— 把"系统自带宋体/无衬线兜底"放在最前面，
    //   Google Fonts 放到最后。避免 Noto Serif SC 未就绪时 Canvas 画空白字，
    //   导致下载出来只剩一张"白底 / 黑底 / 灰底"的纯色图。
    const CANVAS_SERIF_FAMILY = [
        '"Songti SC"',              // macOS：宋体-简（系统自带，可靠）
        '"STSong"',                 // macOS：华文宋体
        '"PingFang SC"',            // macOS/iOS：苹方（无衬线兜底，确保字符必存在）
        '"Hiragino Sans GB"',       // macOS：冬青黑体
        '"SimSun"',                 // Windows：宋体
        '"Microsoft YaHei"',        // Windows：微软雅黑（无衬线兜底）
        '"WenQuanYi Bitmap Song"',  // Linux：文泉驿点阵宋
        '"AR PL UMing CN"',         // Linux：大宋体
        '"AR PL SungtiL GB"',       // Linux：宋体 GB
        '"Heiti SC"',               // 黑体兜底
        '"SimHei"',                 // 黑体兜底
        '"Noto Serif SC"',          // Google Fonts（最后使用，仅当它真正就绪时才生效）
        '"Source Han Serif SC"',
        '"Source Han Serif CN"',
        'serif'
    ].join(', ');

    const SOURCE_FONT_FAMILY = [
        '"Inter"',
        '-apple-system',
        'BlinkMacSystemFont',
        '"PingFang SC"',
        '"Hiragino Sans GB"',
        '"Microsoft YaHei"',
        '"WenQuanYi Micro Hei"',
        '"Heiti SC"',
        '"SimHei"',
        'sans-serif'
    ].join(', ');

    // 确保页面 CSS DOM 展示用的也是统一回退链
    if (poemText) poemText.style.fontFamily = DISPLAY_SERIF_FAMILY;
    if (poemSource) poemSource.style.fontFamily = SOURCE_FONT_FAMILY;

    // ========================================
    // Canvas 图片规格（1080 x 1350，4:5 标准分享图）
    // ========================================
    const CANVAS_W = 1080;
    const CANVAS_H = 1350;
    const PADDING = 162;
    const POEM_FONT_SIZE = 88;
    const SOURCE_FONT_SIZE = 32;
    const POEM_LINE_HEIGHT = 1.19;
    const GAP_BETWEEN = 44;   // 原 64，行距 -30% 同步收缩（64 × 0.7 ≈ 45，取 44）

    // ========================================
    // Utilities
    // ========================================
    // —— 性能：getPoems 只在第一次做 typeof/Array 判定，之后返回同一引用（不做深拷贝，
    //    因为项目中从不修改返回数组，所有调用都是只读读条目/长度/索引）——
    var _cachedPoems = null;
    function getPoems() {
        if (_cachedPoems !== null) return _cachedPoems;
        var list = (typeof window !== 'undefined' && window.poems) || (typeof poems !== 'undefined' ? poems : null);
        _cachedPoems = Array.isArray(list) ? list : [];
        return _cachedPoems;
    }

    function getRandomIndex() {
        var list = getPoems();
        if (list.length <= 1) return 0;
        var idx;
        do {
            idx = Math.floor(Math.random() * list.length);
        } while (idx === currentIndex);
        return idx;
    }

    function showToast(message) {
        toast.textContent = message;
        toast.classList.remove('show');
        // 强制重排：连续快速点击时每次都重新淡入动画，而不是"保持亮着没反应"
        // eslint-disable-next-line no-unused-expressions
        void toast.offsetHeight;
        toast.classList.add('show');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toast.classList.remove('show');
        }, 2200);  /* 1.5s → 2.2s，足够用户有时间确认看到了提示 */
    }


    /**
    /* ================================================================
     * 【独立换行逻辑——桌面端 / 移动端 / 导出图片 三者共用，完全一致】
     *
     * 用户要求："移动端诗词换行逻辑和桌面端同步，逻辑单独写，很重要"。
     * 历史根因：之前靠 textContent + \n + white-space: pre-wrap 换行，
     *   但移动端 @media 单独写了 longhand `text-wrap: wrap`（CSS Text 4
     *   把 white-space 拆成 white-space-collapse / text-wrap 等 longhand，
     *   单独声明 text-wrap 会让 shorthand white-space 的 pre-wrap 语义失效，
     *   导致 \n 在移动端被折叠成空格，看起来"桌面有换行、移动端没有"）。
     *
     * 解  决：不依赖任何 CSS white-space 语义，用真实 <br> 节点做物理换行，
     *   + 纯函数 splitSevenSevenPoem() 保证 7,7. 拆分逻辑唯一来源，
     *   桌面 DOM / 移动端 DOM / Canvas 导出图 三者 100% 一致。
     * ================================================================ */

    // —— 性能：七言正则只构建一次（原每次调用都 new RegExp，开销巨大）
    //    —— Markers / escape span 也只创建一次
    var _SEVEN_RE = (function () {
        var SEVEN = '[^\\s，。！？、,.!?；;：:「」『』\\[\\]()（）《》\\-—·…\\dA-Za-z]{7}';
        return new RegExp('(?<left>' + SEVEN + ')'
            + '(?<comma>[,，])'
            + '(?<right>' + SEVEN + ')'
            + '[。.](?![，。！？])', 'g');
    })();
    var _LB_MARKER = '\u0000LB\u0000';
    // 拆分结果缓存（同一句诗多次出现无需再正则匹配）
    var _splitCache = new Map();
    var _SPLIT_CACHE_MAX = 512;    // 超过上限就清空（内存友好）

    var _escapeSpan = null;
    function _escapeHtml(s) {
        // 性能：全局只创建一个 span，避免每次 createElement + GC
        if (!_escapeSpan) _escapeSpan = document.createElement('span');
        _escapeSpan.textContent = s;
        return _escapeSpan.innerHTML;
    }

    // (1) 纯拆分函数：字符串 → { lines: string[], isSevenSeven: boolean }
    //     无 DOM 依赖，可给 DOM 渲染 / Canvas 绘制 / 旧 formatPoemForDisplay 复用
    function splitSevenSevenPoem(text) {
        if (typeof text !== 'string' || !text) {
            return { lines: [], isSevenSeven: false };
        }
        var hit = _splitCache.get(text);
        if (hit !== undefined) return hit;
        var matched = false;
        var replaced = text.replace(_SEVEN_RE, function (m, left, comma, right) {
            matched = true;
            var lastChar = m.charAt(m.length - 1);
            return left + comma + _LB_MARKER + right + lastChar;
        });
        var res;
        if (!matched) {
            var arr = text.split(/\r?\n/).filter(function (s) { return s !== ''; });
            res = { lines: (arr.length === 0 ? [text] : arr), isSevenSeven: false };
        } else {
            res = { lines: replaced.split(_LB_MARKER), isSevenSeven: true };
        }
        // 写缓存；超限清空避免无限增长
        if (_splitCache.size >= _SPLIT_CACHE_MAX) _splitCache.clear();
        _splitCache.set(text, res);
        return res;
    }

    // (2) DOM 写入函数（桌面端 + 移动端完全同一入口，无端分支）
    //     插入真实 <br> 换行；文本 HTML escape，与 textContent 安全等级一致。
    function renderPoemLinesToElement(el, text) {
        if (!el) return;
        var split = splitSevenSevenPoem(text);
        var lines = split.lines;
        var n = lines.length;
        var out = '';
        if (n > 0) {
            out = _escapeHtml(lines[0]);
            for (var i = 1; i < n; i++) {
                out += '<br>' + _escapeHtml(lines[i]);
            }
        }
        el.innerHTML = out;
    }

    // (3) 旧 API 兼容层：formatPoemForDisplay 仍返回 \n 分隔字符串（给 Canvas 等下游）
    function formatPoemForDisplay(text) {
        var split = splitSevenSevenPoem(text);
        return split.lines.join('\n');
    }

    function formatDate() {
        const d = new Date();
        const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        return d.getFullYear()
            + pad(d.getMonth() + 1)
            + pad(d.getDate()) + '-'
            + pad(d.getHours())
            + pad(d.getMinutes())
            + pad(d.getSeconds());
    }

    function waitForFonts() {
        if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
            const timeout = new Promise(function (resolve) {
                setTimeout(resolve, 5000);
            });
            return Promise.race([document.fonts.ready, timeout]);
        }
        return Promise.resolve();
    }

    /**
     * 按钮按压态 —— 简洁状态管理（重写版）
     *
     * 只有两个函数：
     *   showPressed(btn)      → 立即加 .pressed 类（反色）
     *   scheduleRelease(btn, ms) → ms 后移除 .pressed 类（恢复）
     *                               ms=0 → 立即移除（先清旧定时器）
     *
     * 设计原则：
     *   · 不做 touchmove 位移判定、不做全局兜底扫描、不做 visibilitychange 监听
     *   · touch 事件只监听 touchstart / touchend / touchcancel 三个
     *   · 移动端合成 mouse 事件防互：用简单的时间差（500ms 内忽略）
     *   · iOS 不发 touchend 的兜底：touchstart 时挂 800ms 强制释放定时器
     *   · 页面切后台的兜底：visibilitychange → visible 时释放所有
     */
    function showPressed(btn) {
        if (!btn) return;
        btn.classList.add('pressed');
    }
    function scheduleRelease(btn, ms) {
        if (!btn) return;
        const existing = releaseTimers.get(btn);
        if (existing) { clearTimeout(existing); releaseTimers.delete(btn); }
        if (ms > 0) {
            releaseTimers.set(btn, setTimeout(function () {
                btn.classList.remove('pressed');
                releaseTimers.delete(btn);
            }, ms));
        } else {
            btn.classList.remove('pressed');
        }
    }

    // ========================================
    // Poem Display
    // ========================================
    function displayPoem(index) {
        const list = getPoems();
        const poem = list[index];
        if (!poem) return;

        // 1. 即时隐藏当前文字（先清 transition，避免上一次的 100ms 残留触发 fade-out 动画）
        poemText.style.transition = 'none';
        poemSource.style.transition = 'none';
        poemText.style.opacity = '0';
        poemSource.style.opacity = '0';

        // 2. 等一帧 → 写新文字 → 强制布局 → 再等一帧 → 才淡入
        //    关键：rAF1 写入内容 + 读 offsetHeight 强制 reflow（新文字进入布局树），
        //    浏览器在 rAF1 与 rAF2 之间会 commit 一次 paint（新文字已画到屏幕，
        //    但 opacity=0 不可见）。rAF2 设 opacity=1 触发淡入时，文字已是完整渲染
        //    状态——移动端不再出现「半渲染文字先闪一下再跳变」，与桌面端观感一致。
        requestAnimationFrame(function () {
            // 桌面端 + 移动端走同一套独立换行逻辑（真实 <br>，不依赖 white-space）
            renderPoemLinesToElement(poemText, poem.text);
            poemSource.textContent = '—— ' + poem.source;
            // 强制同步布局，确保新文字已进入布局树（commit opacity=0 + 新内容）
            void poemText.offsetHeight;
            requestAnimationFrame(function () {
                poemText.style.transition = 'opacity 100ms ease';
                poemSource.style.transition = 'opacity 100ms ease';
                poemText.style.opacity = '1';
                poemSource.style.opacity = '1';
            });
        });
    }

    function generatePoem() {
        // 180ms 节流锁：空格/按钮 click 两条路径共用同一个入口，无论连按空格、
        // 快速连点按钮、还是"按钮 focus 时按空格被浏览器同时当 click 触发"，
        // 加锁后都只会真正执行一次，杜绝重复生成。
        if (generateThrottleTimer) return;
        generateThrottleTimer = setTimeout(function () {
            generateThrottleTimer = null;
        }, 180);

        const list = getPoems();
        if (!list.length) return;
        currentIndex = getRandomIndex();
        displayPoem(currentIndex);
        /* 按压视觉由事件层（initEvents 的 mouse/touch 绑定）与 initKeyboard 负责，
         * 业务函数内不再触碰按压态，避免双重触发导致状态冲突。 */
    }

    // ========================================
    // Theme Switching
    // ========================================
    function setTheme(theme) {
        if (!themeConfig[theme]) return;
        body.setAttribute('data-theme', theme);
    }

    function initThemeButtons() {
        themeBtns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                const theme = btn.getAttribute('data-theme');
                setTheme(theme);
            });
        });
    }

    // ========================================
    // Copy
    // ========================================

    function buildShareUrl() {
        // 写死固定：部署地址。复制出去的链接永远指向线上正式页。
        return 'https://jeremyzhu666.github.io/mzd-quotes/';
    }

    function copyShareLink() {
        const url = buildShareUrl();
        if (currentIndex < 0) {
            showToast('数据加载中，请稍后再试');
            return;
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(function () {
                showToast('✓ 网址已复制到剪贴板');
            }).catch(function () {
                fallbackCopyText(url, '✓ 网址已复制到剪贴板');
            });
        } else {
            fallbackCopyText(url, '✓ 网址已复制到剪贴板');
        }
    }

    function fallbackCopyText(text, okMsg) {
        var textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');   // iOS Safari 防止拉软键盘
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '-9999px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        try { textarea.focus(); } catch (_) {}
        try {
            textarea.select();
            textarea.setSelectionRange(0, (text || '').length || 999999);   // iOS Safari 必须显式设置选中范围
        } catch (_) {}
        var ok = false;
        try {
            // execCommand 返回 bool（true 成功 / false 失败），比 try/catch 更可靠
            ok = !!document.execCommand('copy');
        } catch (e) { ok = false; }

        if (ok) {
            showToast(okMsg || '✓ 已复制');
        } else {
            // 终极兜底：如果浏览器权限/沙箱不允许，弹出 prompt 让用户手动复制
            // 这样保证用户 100% 知道"操作有反馈"，不会"点完什么都没发生"
            try {
                window.prompt('请手动复制下面的网址（已全选，按 Cmd/Ctrl+C）：', text || '');
            } catch (_) {}
            showToast('浏览器权限受限，请手动复制');
        }
        try { if (textarea.parentNode) textarea.parentNode.removeChild(textarea); } catch (_) {}
    }

    // 保留原 copyPoem/fallbackCopy 不再使用（统一走 copyShareLink/fallbackCopyText）


    // ========================================
    // Canvas 图片生成
    // ========================================
    function wrapText(ctx, text, maxWidth) {
        var lines = [];
        var logicalLines = (text || '').split(/\r?\n/);
        var i, j, n, m, ch, chW;
        // 性能：字宽按字符累加（ctx.measureText('a') + ctx.measureText('b')
        //   与 ctx.measureText('ab') 宽度在等宽字体/CJK 下误差可忽略；
        //   在等宽比例下累加等价，但减少 O(n) 次字符串拼接与 measureText 全串重算。
        //   若累加超宽，则再 measureText 确认一次（避免 kerning 误差造成溢出）。
        for (i = 0, n = logicalLines.length; i < n; i++) {
            var logical = logicalLines[i];
            var current = '';
            var currentW = 0;
            for (j = 0, m = logical.length; j < m; j++) {
                ch = logical.charAt(j);
                chW = ctx.measureText(ch).width;
                if (currentW + chW > maxWidth && current.length > 0) {
                    // 用全量 measureText 做一次最终确认（消除字间距误差）
                    var confirm = ctx.measureText(current + ch).width;
                    if (confirm > maxWidth) {
                        lines.push(current);
                        current = ch;
                        currentW = chW;
                        continue;
                    }
                    // 确认没超宽 → 按累加是误判，继续拼
                }
                current += ch;
                currentW += chW;
            }
            if (current.length > 0) lines.push(current);
            else if (logical === '') lines.push('');
        }
        return lines;
    }

    function renderPoemToCanvas(poem, colors) {
        var W = CANVAS_W, H = CANVAS_H;

        // —— 参考图（微信读书日签）风格：
        //    仅对"导出图"做风格化，不影响页面 DOM 的三个主题色
        //    · 浅色主题 → 米白底 + 深棕字；深色主题 → 保持暗色
        var isDark = (colors.bg || '').toLowerCase() === '#0a0a0a';
        var bg        = isDark ? '#14100C' : '#FAF8F3';
        var ink       = isDark ? '#E9E0D0' : '#3A2A1A';
        var subInk    = isDark ? '#8D8272' : '#8A7D68';
        var lineCol   = isDark ? '#2B231A' : '#D6CDC0';
        var footInk   = isDark ? '#4A4238' : '#BBB4A7';

        var padX = 140;                        // 左右留白
        var maxTextWidth = W - padX * 2;
        var today = new Date();
        var MONTHS = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE',
                        'JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
        var WEEKDAYS = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
        var dayNum   = String(today.getDate());
        var monthStr = MONTHS[today.getMonth()] + ' ' + today.getFullYear();
        var weekStr  = WEEKDAYS[today.getDay()];

        var sansF = SOURCE_FONT_FAMILY;
        var serifF = CANVAS_SERIF_FAMILY;

        // 诗句字号（先用 84 试排，过长再降到 72）
        var POEM_FS = 84;
        var POEM_LH = 1.38;
        var poemLines = [];
        try {
            var wrapC = document.createElement('canvas').getContext('2d');
            wrapC.font = '500 ' + POEM_FS + 'px ' + serifF;
            poemLines = wrapText(wrapC, formatPoemForDisplay(poem.text || ''), maxTextWidth) || [];
        } catch (eWrap) { poemLines = []; }
        if (!poemLines.length) poemLines = [''];
        // 过长 (>8 行) 降字号到 72，给顶/底安全边距留出空间
        if (poemLines.length > 8) {
            POEM_FS = 72;
            POEM_LH = 1.35;
            try {
                var wrapC2 = document.createElement('canvas').getContext('2d');
                wrapC2.font = '500 ' + POEM_FS + 'px ' + serifF;
                poemLines = wrapText(wrapC2, formatPoemForDisplay(poem.text || ''), maxTextWidth) || [''];
            } catch (eW) {}
        }
        var lineStep = POEM_FS * POEM_LH;

        // [A] 日期日签区尺寸（gap 固定，字号仅用于真实绘制）
        var A_digitFS      = 230;
        var A_digitGapA    = 24;
        var A_monthFS      = 50;
        var A_monthGapA    = 24;
        var A_weekFS       = 36;
        // [B] 分隔线 gap
        var B_gapWeekLine  = 66;
        var B_lineThick    = 2;
        var B_gapLinePoem  = 82;
        var lineW = 110;
        // [D] 来源
        var D_gapPoem = 70;
        var D_fs = 34;

        // ================================================================
        // 关键：像素级垂直居中
        //   1) 在离屏 canvas 上（以 contentTop=0 起，不考虑居中）先画完整「日期+分隔+诗句+来源」
        //   2) getImageData 扫出真实 bbox（非背景最小/最大 y）
        //   3) 算出 dy = (H/2) - (bboxTop + bboxBot)/2，即需要下移的距离
        //   4) 在正式 canvas 上 fillRect(bg) → ctx.save → ctx.translate(0, dy) → 再按 0 基重画一次 → restore → 署名贴底
        //   5) 若平移后 bbox 出了上沿/下沿（极长诗），就夹紧到 safe 区（保证署名贴底不被挤掉）
        // ================================================================
        var A_digitBaselineOffset = A_digitFS * 0.88;
        var hasLetterSpacing;

        function drawContent(ctx0, baseY) {
            // 画「日期+分隔+诗句+来源」整块，所有 y 都基于 baseY（整块的假想 contentTop）
            var c;
            ctx0.textBaseline = 'alphabetic';

            // 3a. 日期数字
            var cursorY = baseY + A_digitBaselineOffset;
            ctx0.textAlign = 'center';
            ctx0.font = '900 ' + A_digitFS + 'px ' + sansF;
            ctx0.fillStyle = ink;
            ctx0.fillText(dayNum, W / 2, cursorY);

            // 3b. 月年
            cursorY += (A_digitFS - A_digitBaselineOffset) + A_digitGapA + A_monthFS;
            ctx0.font = '600 ' + A_monthFS + 'px ' + sansF;
            if (hasLetterSpacing) ctx0.letterSpacing = '6px';
            ctx0.fillText(monthStr, W / 2, cursorY);
            if (hasLetterSpacing) ctx0.letterSpacing = '0px';

            // 3c. 星期
            cursorY += A_monthGapA + A_weekFS * 0.85;
            ctx0.font = '400 ' + A_weekFS + 'px ' + serifF;
            ctx0.fillStyle = subInk;
            ctx0.fillText(weekStr, W / 2, cursorY);

            // 3d. 分隔线
            var weekBottomY = cursorY - A_weekFS * 0.85 + A_weekFS;
            var lineCenterY = weekBottomY + B_gapWeekLine + B_lineThick / 2;
            var lineX = (W - lineW) / 2;
            ctx0.fillStyle = lineCol;
            ctx0.fillRect(lineX, lineCenterY - B_lineThick / 2, lineW, B_lineThick);

            // 3e. 诗句
            var firstPoemTop = lineCenterY + B_lineThick / 2 + B_gapLinePoem;
            var firstPoemBaseline = firstPoemTop + POEM_FS * 0.88;
            ctx0.textAlign = 'left';
            ctx0.font = '500 ' + POEM_FS + 'px ' + serifF;
            ctx0.fillStyle = ink;
            cursorY = firstPoemBaseline;
            var i;
            for (i = 0; i < poemLines.length; i++) {
                ctx0.fillText(poemLines[i], padX, cursorY);
                cursorY += lineStep;
            }
            var lastPoemBottom = firstPoemBaseline + (poemLines.length - 1) * lineStep + POEM_FS * 0.88;

            // 3f. 来源
            var sourceText = '《' + (poem.source || '') + '》';
            var sourceY = lastPoemBottom + D_gapPoem + D_fs * 0.85;
            ctx0.font = '400 ' + D_fs + 'px ' + serifF;
            ctx0.fillStyle = subInk;
            ctx0.textAlign = 'center';
            ctx0.fillText(sourceText, W / 2, sourceY);
        }

        // Step 1：两个离屏扫描
        //   a) 先单独扫描「日期号数字」的真实顶部：在 mini dummy 上 (0,0) 起画数字，扫出 dateTop0
        //      → 本轮 dy 的锚点："日期号顶部"最终落在 DATE_TOP_TARGET = 100px。
        //   b) 再画整块 (日期+分隔+诗句+来源) 扫全局 bbox，用于夹紧底部，不撞署名。
        var dummy = document.createElement('canvas');
        dummy.width = W; dummy.height = H;
        var dCtx = dummy.getContext('2d', { willReadFrequently: true });
        if (!dCtx) dCtx = dummy.getContext('2d');
        hasLetterSpacing = dCtx && ('letterSpacing' in dCtx);
        var bbox = null;
        var dateTop0 = 0;  // 当 drawContent(dCtx, baseY=0) 时，日期数字在像素上的顶部 y
        if (dCtx) {
            // --- 1a) 仅画日期号，扫 dateTop0（要与 3a 所用 font/textAlign/ink 完全一致）
            try {
                dCtx.clearRect(0, 0, W, H);
                dCtx.textAlign = 'center';
                dCtx.textBaseline = 'alphabetic';
                dCtx.font = '900 ' + A_digitFS + 'px ' + sansF;
                dCtx.fillStyle = ink;
                dCtx.fillText(dayNum, W / 2, 0 + A_digitBaselineOffset);   // baseY=0 时数字 baseline
                var d1 = dCtx.getImageData(0, 0, W, H).data;
                function d1Alpha(x, y) { return d1[(y * W + x) * 4 + 3]; }
                var xMin = (W * 0.35) | 0, xMax = (W * 0.65) | 0;
                for (var yA = 0; yA < (A_digitFS * 1.5 | 0); yA++) {
                    for (var xA = xMin; xA < xMax; xA += 2) {
                        if (d1Alpha(xA, yA) > 20) { dateTop0 = yA; yA = 1e9; break; }
                    }
                }
            } catch (eA) { dateTop0 = 0; }

            // --- 1b) 画整块，扫整体 bbox（用于底部夹紧署名）
            try {
                dCtx.clearRect(0, 0, W, H);
                drawContent(dCtx, 0);
                var img = dCtx.getImageData(0, 0, W, H).data;
                function alphaAt(x, y) { return img[(y * W + x) * 4 + 3]; }
                var xL = 80, xR = W - 80;
                var bTop = -1, bBot = -1;
                var y, x, aHit;
                for (y = 0; y < H; y++) {
                    aHit = false;
                    for (x = xL; x < xR; x += 4) {
                        if (alphaAt(x, y) > 20) { aHit = true; break; }
                    }
                    if (aHit) { if (bTop < 0) bTop = y; bBot = y; }
                    else if (bTop >= 0 && bBot >= 0 && y - bBot > 40) break;
                }
                if (bTop >= 0 && bBot >= bTop) bbox = { top: bTop, bot: bBot };
            } catch (e) { bbox = null; }
        }

        // Step 2：平移量 dy
        //   目标：日期号顶部最终落在 DATE_TOP_TARGET (100px)
        //   因此 dy = DATE_TOP_TARGET - dateTop0
        //   若上移后整块底部 (bbox.bot + dy) 撞署名 ( > H - bottomSafe=1190)，则回拉到不撞署名
        var DATE_TOP_TARGET = 100;   // 用户希望"日期区上沿距顶约 100px"
        var topSafe = 30;            // 允许上移再高也不能让日期撞 0 线（至少留 30）
        var bottomSafe = 160;        // 距下沿 ≥160，署名 H-90 留 70 呼吸空间
        var dy = DATE_TOP_TARGET - dateTop0;
        // 夹紧：不能让顶部 (dateTop0+dy) < topSafe → dy < topSafe - dateTop0
        var maxDyTop = topSafe - dateTop0;
        if (dy < maxDyTop) dy = maxDyTop;
        if (bbox) {
            var maxDyBot = (H - bottomSafe) - bbox.bot;
            if (dy > maxDyBot) dy = maxDyBot;   // 长诗会撞署名，先保署名不被撞
        }
        // bbox 扫失败 fallback：估算 dateTop0 ≈ A_digitBaselineOffset - A_digitFS*0.9 ≈ 202.4 - 207 = -5
        //   => dy ≈ 100 - (-5) ≈ 105；同时兜底 topSafe 40，bottomSafe 160
        if (!isFinite(dy)) {
            dy = 100 - (-5);
            if (dy < topSafe + 5) dy = topSafe + 5;
        }

        // Step 3：正式 canvas 画背景 → 带 dy 平移重画整块 → 最后署名贴底
        var canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        var ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D');
        hasLetterSpacing = ('letterSpacing' in ctx);

        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        ctx.save();
        ctx.translate(0, dy);
        drawContent(ctx, 0);   // 整块内容从 y=0 起画，外层 translate(dy) 负责精准居中
        ctx.restore();

        // 署名：贴底 H-90 固定（与参考图一致）；如 bbox.bot+dy 撞到底部 safe，
        //       这里仍然画在 H-90，用户如需参与居中后续再扩展。
        ctx.font = '400 28px ' + sansF;
        ctx.fillStyle = footInk;
        ctx.textAlign = 'center';
        ctx.fillText('主席诗词·日签', W / 2, H - 90 + 28 * 0.85);

        return canvas;
    }

    function downloadImage() {
        const list = getPoems();
        const poem = list[currentIndex];
        if (!poem) {
            showToast('数据加载中，请稍后再试');
            return;
        }
        const theme = body.getAttribute('data-theme') || 'white';
        const colors = themeConfig[theme];

        downloadBtn.setAttribute('disabled', 'true');

        waitForFonts().then(function () {
            var canvas = renderPoemToCanvas(poem, colors);
            return new Promise(function (resolve, reject) {
                try {
                    canvas.toBlob(function (blob) {
                        if (!blob) {
                            reject(new Error('Canvas 导出为空'));
                            return;
                        }
                        // —— 无法预览的关键修复 ——
                        // 少数浏览器在 canvas API 调用链异常时会给出"空 Blob / 超小 Blob"，
                        // 这种文件字节头不是真正 PNG，Finder/预览/微信等都打不开。
                        // 1080x1350 的 PNG 即使空白也在 30KB 以上，< 5KB 就当它损坏。
                        if (blob.size < 5000) {
                            try {
                                var dataURL = canvas.toDataURL('image/png');
                                var commaIdx = dataURL.indexOf(',');
                                var b64 = commaIdx >= 0 ? dataURL.slice(commaIdx + 1) : '';
                                if (b64.length > 400 && /^iVBORw0KGgo/.test(b64.slice(0, 24))) {   // PNG 头
                                    var bin = atob(b64);
                                    var u8 = new Uint8Array(bin.length);
                                    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
                                    blob = new Blob([u8.buffer], { type: 'image/png' });
                                }
                                // 经过 toDataURL 后仍然很小 → 说明真的内容很少（画布全白也算正常 PNG，
                                // 但我们 1080x1350 全白 PNG ≈ 30KB，真 < 5KB 还不是 PNG 头就直接 reject）
                                if (blob.size < 5000) {
                                    reject(new Error('PNG 字节异常 (size=' + blob.size + ')'));
                                    return;
                                }
                            } catch (e2) {
                                reject(e2);
                                return;
                            }
                        }
                        resolve(blob);
                    }, 'image/png');
                } catch (e) {
                    reject(e);
                }
            });
        }).then(function (blob) {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.download = 'verses-' + formatDate() + '.png';
            link.href = url;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(function () {
                URL.revokeObjectURL(url);
            }, 1500);
            showToast('已下载');
        }).catch(function (err) {
            console.error('downloadImage failed:', err);
            showToast('图片生成失败，请重试');
        }).finally(function () {
            downloadBtn.removeAttribute('disabled');
        });
    }

    // ========================================
    // Keyboard Shortcut — 空格键切换 + 按钮按压视觉
    //   只在"有物理键盘（细指针）且非触屏"的桌面端绑定
    //   移动端 / 触屏设备没有 Space 键，绑定既浪费也与 UI 隐藏的语义不符
    // ========================================
    function isFinePointerWithKeyboard() {
        // 优先用 matchMedia 的 pointer: fine 判定（有细指针的设备通常有键盘）
        try {
            if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) return true;
        } catch (e) { /* 忽略 */ }
        // 兜底：非触屏设备且 UA 看起来是桌面浏览器
        const ua = (navigator.userAgent || '').toLowerCase();
        const isMobileUA = /iphone|ipad|ipod|android|harmonyos|openharmony|mobile|tablet|kindle|silk|touch|webos/i.test(ua);
        const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints && navigator.maxTouchPoints > 1);
        return !isMobileUA && !hasTouch;
    }

    function initKeyboard() {
        // 仅 document capture 绑定一次（之前 document+window 双绑定导致同一事件处理两次）
        var lastHandledStamp = { kd: -1, ku: -1 };
        var isEditableTarget = function (t) {
            if (!t) return false;
            try {
                var tag = (t.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea') return true;
                if (t.isContentEditable) return true;
            } catch (e) { /* ignore */ }
            return false;
        };
        var isSpaceEvent = function (e) {
            if (e.code === 'Space') return true;
            if (e.key === ' ') return true;
            var kc = (typeof e.keyCode === 'number') ? e.keyCode : (typeof e.which === 'number' ? e.which : -1);
            if (kc === 32) return true;
            return false;
        };
        var onPress = function (e) {
            if (!isSpaceEvent(e)) return;
            if (isEditableTarget(e.target)) return;
            var ts = (typeof e.timeStamp === 'number') ? e.timeStamp : Date.now();
            if (ts === lastHandledStamp.kd) return;
            lastHandledStamp.kd = ts;
            try { e.preventDefault && e.preventDefault(); } catch (_) {}
            try { e.stopPropagation && e.stopPropagation(); } catch (_) {}
            showPressed(generateBtn);
            if (!e.repeat) generatePoem();
        };
        var onRelease = function (e) {
            if (!isSpaceEvent(e)) return;
            if (isEditableTarget(e.target)) return;
            var ts = (typeof e.timeStamp === 'number') ? e.timeStamp : Date.now();
            if (ts === lastHandledStamp.ku) return;
            lastHandledStamp.ku = ts;
            try { e.preventDefault && e.preventDefault(); } catch (_) {}
            try { e.stopPropagation && e.stopPropagation(); } catch (_) {}
            // keyup → 120ms 拖尾后释放（快速 tap 空格时保证反色肉眼可见）
            scheduleRelease(generateBtn, 120);
        };
        document.addEventListener('keydown', onPress, true);
        document.addEventListener('keyup', onRelease, true);

        // 失焦立即释放所有 pressed 状态
        window.addEventListener('blur', function () {
            scheduleRelease(generateBtn, 0);
            scheduleRelease(copyBtn, 0);
            scheduleRelease(downloadBtn, 0);
            themeBtns.forEach(function (t) { scheduleRelease(t, 0); });
        });

        // 焦点拉回 body（防止首屏第一下 Space 丢失）
        try {
            if (document.body && typeof document.body.focus === 'function') {
                setTimeout(function () {
                    try {
                        document.body.focus({ preventScroll: true });
                    } catch (_) {
                        try { document.body.focus(); } catch (__) {}
                    }
                }, 80);
            }
        } catch (e) { /* ignore */ }
    }

    // ========================================
    // Event Bindings
    // ========================================
    function initEvents() {
        generateBtn.addEventListener('click', generatePoem);
        copyBtn.addEventListener('click', copyShareLink);
        downloadBtn.addEventListener('click', downloadImage);

        // 绑定按压动画（主按钮 + 副按钮）：100ms 拖尾
        bindPressAnimation([generateBtn, copyBtn, downloadBtn], 100);
        // 绑定按压动画（主题按钮）：80ms 拖尾
        bindPressAnimation(themeBtns, 80);

        // 页面切后台回来 / 解锁 / 从其他 app 切回 —— iOS Safari 后台时
        // setTimeout 可能被系统冻结错过，回来立即释放所有 pressed 状态。
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState !== 'visible') return;
            [generateBtn, copyBtn, downloadBtn].forEach(function (b) { scheduleRelease(b, 0); });
            themeBtns.forEach(function (b) { scheduleRelease(b, 0); });
        });
    }

    /* ================================================================
     * 统一绑定按压动画的辅助函数
     *   holdMs = 抬起后拖尾时长（主按钮 100ms，主题按钮 80ms）
     *
     * 设计要点（两端动画完全等价）：
     *   · 按下立即反色，抬起后"多显示 holdMs 毫秒反色"才消失，
     *     避免移动端极快 tap（20~30ms）时颜色一闪而过肉眼看不到。
     *   · 移动端：touchstart 立即反色 + 800ms 安全定时器
     *             （iOS 手指轻滑 / 切后台导致 touchend 不发的兜底）；
     *             touchend → holdMs 拖尾后释放；touchcancel → 立即释放。
     *   · 桌面端：mousedown 立即反色，mouseup → holdMs 拖尾，
     *             mouseleave / blur → 立即释放。
     *   · 合成事件防护：移动端 tap 后浏览器会 ~300ms 补发兼容性
     *     mousedown/mouseup 事件，touch 后 500ms 内忽略这些合成 mouse
     *     事件，避免 mousedown 把刚 release 的 pressed 类再加回去导致
     *     "反色回不去"。
     * ============================================================== */
    function bindPressAnimation(btns, holdMs) {
        // 接受 数组 / NodeList / HTMLCollection / 单个元素
        // querySelectorAll 返回 NodeList，原 [btns] 包裹会让 NodeList 整体当一项
        // → btn.addEventListener 报 TypeError，故显式转数组
        if (!btns) return;
        if (Array.isArray(btns)) {
            /* 已是数组，原样使用 */
        } else if (typeof btns.length === 'number' && typeof btns !== 'string') {
            btns = Array.prototype.slice.call(btns);   // NodeList / HTMLCollection
        } else {
            btns = [btns];                              // 单个 DOM 元素
        }
        const TOUCH_LOCK_MS = 500;
        const touchLockUntil = new WeakMap();

        function isTouchLocked(btn) {
            const until = touchLockUntil.get(btn);
            return (typeof until === 'number') && (Date.now() < until);
        }
        function lockTouch(btn) {
            touchLockUntil.set(btn, Date.now() + TOUCH_LOCK_MS);
        }

        btns.forEach(function (btn) {
            if (!btn) return;

            // —— 移动端触摸事件 ——
            btn.addEventListener('touchstart', function () {
                showPressed(btn);
                lockTouch(btn);
                // iOS 不发 touchend 的兜底：800ms 后强制释放
                scheduleRelease(btn, 800);
            }, { passive: true });

            btn.addEventListener('touchend', function () {
                scheduleRelease(btn, holdMs);   // 抬起后 holdMs 毫秒释放
                lockTouch(btn);                 // 锁 500ms 防合成 mouse 事件
            }, { passive: true });

            btn.addEventListener('touchcancel', function () {
                scheduleRelease(btn, 0);         // 取消立即释放
                lockTouch(btn);
            }, { passive: true });

            // —— 桌面鼠标事件（带合成事件防护）——
            btn.addEventListener('mousedown', function () {
                if (isTouchLocked(btn)) return;  // 刚被触摸过，忽略兼容性 mousedown
                showPressed(btn);
            });
            btn.addEventListener('mouseup', function () {
                if (isTouchLocked(btn)) return;
                scheduleRelease(btn, holdMs);
            });
            btn.addEventListener('mouseleave', function () {
                if (isTouchLocked(btn)) return;
                scheduleRelease(btn, 0);         // 鼠标滑出：立刻释放
            });
            btn.addEventListener('blur', function () {
                scheduleRelease(btn, 0);
            });
        });
    }


    // ========================================
    // Initialize
    // ========================================
    function init() {
        const list = getPoems();
        if (!list.length) {
            poemText.textContent = '数据加载失败';
            poemSource.textContent = '';
            return;
        }

        // 提前触发字体加载 Promise，后续下载时大概率已就绪
        waitForFonts();

        // 支持分享链接 ?p=<index>：打开时固定显示同一句诗（方便他人点开看到相同内容）
        let initialIndex = -1;
        try {
            const params = new URLSearchParams(window.location.search || '');
            if (params.has('p')) {
                const p = parseInt(params.get('p'), 10);
                if (!isNaN(p) && p >= 0 && p < list.length) initialIndex = p;
            }
        } catch (e) { /* 忽略解析错误，走随机 */ }

        if (initialIndex >= 0) {
            currentIndex = initialIndex;
        } else {
            currentIndex = getRandomIndex();
        }
        displayPoem(currentIndex);

        initThemeButtons();
        initEvents();
        initKeyboard();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
