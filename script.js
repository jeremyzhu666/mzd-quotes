(function () {
    'use strict';

    // ========================================
    // State
    // ========================================
    let currentIndex = -1;
    let toastTimer = null;
    let pressedTimers = new WeakMap();       // btn element -> timeout id（拖尾释放）
    const touchLockUntil = new WeakMap();    // btn element -> ms 时间戳，此时间内忽略兼容性 mouse* 事件（桌面路径用）
    const maxHoldTimers = new WeakMap();     // btn element -> timeout id（最长 1500ms 强制释放保安锁：所有路径兜底）
    const pressedStartedAt = new WeakMap();  // btn element -> 按压起始 ms 时间戳（兜底用：定时器被 iOS 挂起时，靠真实时间差判断是否超时）
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
     *   3. setTimeout 3000ms 兜底 + CSS @keyframes 3200ms 终极兜底
     *      —— 网络不通 / 被屏蔽时，JS/CSS 两道独立保险保证页面不会永远白屏。
     * ============================================================== */
    (function unlockWhenFontsReady() {
        var MAX_WAIT_MS = 3000;
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

        // ============= 验证 2：Canvas measureText 字形实体验证 =============
        // 用一个生僻词（含"红橙黄绿青蓝紫"里不容易命中字形回退的笔画）作测试，
        // 对比"目标字体"和"强制 fallback 到系统字体"的渲染宽度：
        //   相同 → 目标字体还没加载（浏览器用 fallback 替代渲染）→ 继续等
        //   不同 → 目标字体真实 glyph 已就绪 → 可以解锁
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
        // 测试文本：必须含笔画丰富的字（生僻字 + 常用字混合），确保 fallback 和目标字体宽度有差
        var PROBE_TEXT = '赤橙黄绿青蓝紫，谁持彩练当空舞？Verses';
        function fontsReallyAvailable() {
            if (!_probeCtx) return true; // 不支持 Canvas 就跳过真实验证，走 timeout 兜底
            // Noto Serif SC 400  vs  Songti SC（系统宋 fallback）
            var notoW = getTextWidth('"Noto Serif SC", "Source Han Serif SC", serif', '400', 40, PROBE_TEXT);
            var songW = getTextWidth('"Songti SC", "STSong", "SimSun", serif', '400', 40, PROBE_TEXT);
            // Inter 300  vs  system-ui sans fallback
            var interW = getTextWidth('"Inter", sans-serif', '300', 20, 'Verses · 主席诗词随机生成工具');
            var sansW  = getTextWidth('-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif', '300', 20, 'Verses · 主席诗词随机生成工具');
            if (notoW < 0 || interW < 0) return true; // 度量失败就跳过
            var notoSansDiff = (interW !== sansW);   // Inter 真的到了
            var notoSerifDiff = (notoW !== songW);   // Noto Serif SC 真的到了
            return notoSansDiff && notoSerifDiff;
        }

        // 硬上限兜底：无论如何 3s 必解锁
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

        // ============= 验证 1：document.fonts.load() 显式预加载关键字重 =============
        try {
            if (document.fonts && typeof document.fonts.load === 'function') {
                // 实际会用到的 4 个 weight：
                //   Noto Serif SC 400（桌面端诗句）、500（移动端诗句）
                //   Inter 300（标题/出处字重 300）、400（按钮字重 400）
                // iOS Safari 不会像桌面 Chrome 那样把 CSS 里声明的全部 weight 都主动预加载，
                // 必须一个个显式 load() 才会真的发起请求。
                var loads = [
                    document.fonts.load('400 40px "Noto Serif SC"', PROBE_TEXT),
                    document.fonts.load('500 40px "Noto Serif SC"', PROBE_TEXT),
                    document.fonts.load('300 20px "Inter"', 'VersesChair'),
                    document.fonts.load('400 20px "Inter"', 'VersesChair')
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
    function getPoems() {
        // 兼容独立文件 poems.js：优先 window.poems，其次全局 poems
        const list = (typeof window !== 'undefined' && window.poems) || (typeof poems !== 'undefined' ? poems : null);
        return Array.isArray(list) ? list : [];
    }

    function getRandomIndex() {
        const list = getPoems();
        if (list.length <= 1) return 0;
        let idx;
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

    // (1) 纯拆分函数：字符串 → { lines: string[], isSevenSeven: boolean }
    //     无 DOM 依赖，可给 DOM 渲染 / Canvas 绘制 / 旧 formatPoemForDisplay 复用
    function splitSevenSevenPoem(text) {
        if (typeof text !== 'string' || !text) {
            return { lines: [], isSevenSeven: false };
        }
        var SEVEN = '[^\\s，。！？、,.!?；;：:「」『』\[\]()（）《》\-—·…\dA-Za-z]{7}';
        var pattern = new RegExp(
            '(?<left>' + SEVEN + ')'
          + '[,，]'
          + '(?<right>' + SEVEN + ')'
          + '[。.](?![，。！？])',
            'g'
        );
        var matched = false;
        var MARKER = '\u0000LB\u0000';
        var replaced = text.replace(pattern, function (m, left, right) {
            matched = true;
            var lastChar = m.charAt(m.length - 1);
            return left + MARKER + right + lastChar;
        });
        if (!matched) {
            // 非 7+7：保留原文（已有 \n 则尊重，否则一行）
            var arr = text.split(/\r?\n/).filter(function (s) { return s !== ''; });
            return {
                lines: (arr.length === 0 ? [text] : arr),
                isSevenSeven: false
            };
        }
        return { lines: replaced.split(MARKER), isSevenSeven: true };
    }

    // (2) DOM 写入函数（桌面端 + 移动端完全同一入口，无端分支）
    //     插入真实 <br> 换行；文本 HTML escape，与 textContent 安全等级一致。
    function renderPoemLinesToElement(el, text) {
        if (!el) return;
        var split = splitSevenSevenPoem(text);
        var span = document.createElement('span');
        var esc = function (s) {
            span.textContent = s;
            return span.innerHTML;
        };
        el.innerHTML = split.lines.map(esc).join('<br>');
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
     * 按钮按压态底层开关
     *   setPressedOn  —— 立即进入 pressed 反色态
     *     · 记录 pressedStartedAt 起始时间戳（绝对时间）—— 用于定时器被 iOS 挂起兜底
     *     · 如果有 pending 释放定时器（pressedTimers），先清掉
     *     · 同时挂 800ms 强制释放（保安锁 maxHoldTimers，iOS 缩短到 800ms），无论什么
     *       原因（事件打架、业务异常、触摸中断、页面切后台冻结定时器）都必释放。
     *   setPressedOff —— 立即退出 pressed 态，同时清理 pressedTimers + maxHoldTimers + 起始时间戳。
     * 统一入口：所有 mouse/touch/keyboard/click 的按压视觉都走这两个函数。
     */
    const MAX_PRESSED_MS = 800;               // 最长按压视觉：≤ 800ms（移动端实际 tap+拖尾 ≤ 200ms，这个阈值是"绝对卡死"兜底判断）
    function setPressedOn(btn) {
        if (!btn) return;
        pressedStartedAt.set(btn, Date.now()); // 绝对时间戳：与 setTimeout 无关，页面切后台回来也能判断是否超时
        // 拖尾定时器（如果有旧的释放挂起中，先清掉避免残留下一次释放把这次打断）
        const existing = pressedTimers.get(btn);
        if (existing) {
            clearTimeout(existing);
            pressedTimers.delete(btn);
        }
        // 保安锁：最长 MAX_PRESSED_MS 无论如何强制释放（页面被冻结导致 setTimeout 不按时走也不怕，还有全局兜底扫描）
        const existingMax = maxHoldTimers.get(btn);
        if (existingMax) {
            clearTimeout(existingMax);
            maxHoldTimers.delete(btn);
        }
        const maxId = setTimeout(function () {
            try { setPressedOff(btn); } catch (_) {}
        }, MAX_PRESSED_MS);
        maxHoldTimers.set(btn, maxId);
        btn.classList.add('pressed');
    }
    function setPressedOff(btn) {
        if (!btn) return;
        // 拖尾定时器清理
        const existing = pressedTimers.get(btn);
        if (existing) {
            clearTimeout(existing);
            pressedTimers.delete(btn);
        }
        // 保安锁也清理（正常释放，不需要它兜底了）
        const existingMax = maxHoldTimers.get(btn);
        if (existingMax) {
            clearTimeout(existingMax);
            maxHoldTimers.delete(btn);
        }
        try { pressedStartedAt.delete(btn); } catch (_) {}
        btn.classList.remove('pressed');
    }
    /**
     * 全局兜底扫描：遍历传入的所有按钮，
     * 只要 pressed 类仍在 且（无 pressedTimers 或 开始时间戳超过 MAX_PRESSED_MS）就强制释放。
     * 触发时机：
     *   · window touchend/touchcancel（任何一次触摸结束都扫一遍，防止单按钮事件漏收）
     *   · window visibilitychange visible（切后台回来立即扫一遍，setTimeout 冻结错过的都捞回来）
     *   · 节流 + 任何一次 setPressedOn/Off 冲突时的"最后防线"
     */
    function forceReleaseStalePressed(btnList) {
        if (!btnList || !btnList.length) return;
        var now = Date.now();
        for (var i = 0; i < btnList.length; i++) {
            var b = btnList[i];
            if (!b) continue;
            if (!b.classList || !b.classList.contains('pressed')) continue;
            var started = pressedStartedAt.get(b);
            var hasTrail = pressedTimers.has(b);
            // 没记录起始时间 → 未知来源 pressed，直接释放；
            // 有起始时间 且 超 MAX_PRESSED_MS 阈值 → 卡死兜底释放；
            // 两者都 OK 但没有定时器（既没有 trail 也没有 maxHold）→ 可能定时器丢失，释放；
            if ((typeof started !== 'number')
                || (now - started >= MAX_PRESSED_MS)
                || (!hasTrail && !maxHoldTimers.has(b))) {
                setPressedOff(b);
            }
        }
    }

    /**
     * 触发一次"带最小持续时长"的按压反馈：
     *   1. 立刻置为按压态
     *   2. 至少 holdMs（默认 140ms）后再释放
     * 关键：对于移动端 touchstart → touchend 只有 20-30ms 的快速 tap，
     * 用这个函数兜底"至少显示 140ms 反色"，用户肉眼才能感知到"按下去了"，
     * 否则只会一闪而过，看起来像"颜色不变"。
     */
    function triggerPressed(btn, holdMs) {
        if (!btn) return;
        setPressedOn(btn);
        const ms = (typeof holdMs === 'number' && holdMs > 0) ? holdMs : 140;
        const timerId = setTimeout(function () {
            setPressedOff(btn);
        }, ms);
        pressedTimers.set(btn, timerId);
    }

    // ========================================
    // Poem Display
    // ========================================
    function displayPoem(index) {
        const list = getPoems();
        const poem = list[index];
        if (!poem) return;

        poemText.style.opacity = '0';
        poemSource.style.opacity = '0';

        setTimeout(function () {
            // 桌面端 + 移动端走同一套独立换行逻辑（真实 <br>，不依赖 white-space）
            renderPoemLinesToElement(poemText, poem.text);
            poemSource.textContent = '—— ' + poem.source;
            poemText.style.transition = 'opacity 100ms ease';
            poemSource.style.transition = 'opacity 100ms ease';
            poemText.style.opacity = '1';
            poemSource.style.opacity = '1';
        }, 80);
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
        /* 注意：按压态反馈不再在这里统一触发。
         *   - 按钮 click：由 mouse/touch 事件的独立绑定负责按压视觉（见 initEvents）
         *   - 空格键：由 keydown/keyup 的独立逻辑负责按压视觉（见 initKeyboard）
         * 功能解耦，避免两条路径叠加导致状态冲突或拖尾时长错乱。
         */
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
                /* 按压视觉统一由 initEvents 中的 touch/mouse 事件负责，
                 * 业务层 click 处理函数不再重复调用 triggerPressed，
                 * 避免与事件层叠加导致状态机错乱。 */
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
        /* 按压视觉统一由 initEvents 中的 touch/mouse 事件负责，
         * 业务函数内不再重复 triggerPressed，避免事件层与业务层叠加冲突。 */

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
        const lines = [];
        // 第一步：按 \\n 拆成逻辑行（对用户强制分行保持尊重，例如七言「7,7.」句式）
        const logicalLines = (text || '').split(/\\r?\\n/);

        logicalLines.forEach(function (logical) {
            // 第二步：逻辑行内部再按宽度做视觉分行
            let current = '';
            for (let i = 0; i < logical.length; i++) {
                const ch = logical[i];
                const next = current + ch;
                const w = ctx.measureText(next).width;
                if (w > maxWidth && current.length > 0) {
                    lines.push(current);
                    current = ch;
                } else {
                    current = next;
                }
            }
            if (current.length > 0) lines.push(current);
            else if (logical === '') lines.push(''); // 保留空行语义（如绝句中间空一行）
        });
        return lines;
    }

    function renderPoemToCanvas(poem, colors) {
        const canvas = document.createElement('canvas');
        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D');

        // 1. 背景
        ctx.fillStyle = colors.bg;
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

        const maxTextWidth = CANVAS_W - PADDING * 2;
        const centerX = CANVAS_W / 2;

        // 2. 诗句（使用系统宋体优先的 CANVAS_SERIF_FAMILY 兜底）
        ctx.font = '400 ' + POEM_FONT_SIZE + 'px ' + CANVAS_SERIF_FAMILY;
        ctx.fillStyle = colors.text;
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'center';

        const poemLines = wrapText(ctx, formatPoemForDisplay(poem.text), maxTextWidth);

        // 3. 出处
        const sourceText = '—— ' + poem.source;
        ctx.font = '300 ' + SOURCE_FONT_SIZE + 'px ' + SOURCE_FONT_FAMILY;
        ctx.fillStyle = colors.secondary;
        ctx.textAlign = 'center';

        // 4. 计算整体内容高度，垂直居中
        const poemBlockHeight = poemLines.length * POEM_FONT_SIZE * POEM_LINE_HEIGHT;
        const sourceBlockHeight = SOURCE_FONT_SIZE * 1.4;
        const totalContentHeight = poemBlockHeight + GAP_BETWEEN + sourceBlockHeight;
        const contentTop = (CANVAS_H - totalContentHeight) / 2;
        let currentY;

        // 5. 绘制诗句
        ctx.font = '400 ' + POEM_FONT_SIZE + 'px ' + CANVAS_SERIF_FAMILY;
        ctx.fillStyle = colors.text;
        const lineStep = POEM_FONT_SIZE * POEM_LINE_HEIGHT;
        currentY = contentTop + POEM_FONT_SIZE * 0.88;
        for (let i = 0; i < poemLines.length; i++) {
            ctx.fillText(poemLines[i], centerX, currentY);
            currentY += lineStep;
        }

        // 6. 绘制出处
        currentY = contentTop + poemBlockHeight + GAP_BETWEEN + SOURCE_FONT_SIZE * 0.85;
        ctx.font = '300 ' + SOURCE_FONT_SIZE + 'px ' + SOURCE_FONT_FAMILY;
        ctx.fillStyle = colors.secondary;
        ctx.fillText(sourceText, centerX, currentY);

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

        /* 按压视觉统一由 initEvents 中的 touch/mouse 事件负责，
         * 业务函数内不再重复 triggerPressed，避免事件层与业务层叠加冲突。 */
        downloadBtn.setAttribute('disabled', 'true');

        waitForFonts().then(function () {
            const canvas = renderPoemToCanvas(poem, colors);
            return new Promise(function (resolve, reject) {
                try {
                    canvas.toBlob(function (blob) {
                        if (!blob) {
                            reject(new Error('Canvas 导出为空'));
                            return;
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
        // 键盘事件绑定说明（版本迭代后的修正）：
        //   · 仅在 document capture 阶段绑定一次就足够覆盖所有正常场景；之前的 document+window
        //     双绑定反而导致**同一个事件被处理两次**—— keydown/onPress 连续执行两遍 setPressedOn，
        //     事件层状态机打架，肉眼看上去像"反色动画一闪就没"。
        //   · 去重保护（lastHandledStamp）：即便将来再出现"多通道重复触发"的写法或浏览器 bug，
        //     也能通过 timestamp+type 保证每一次物理按键动作最多只处理一次，作为防线。
        //   · 其他保障照旧：body tabindex="-1" 合法焦点、code/key/keyCode 三条件兼容、
        //     init 末尾主动把焦点拉回 body。
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
            // 事件级去重：同一 keydown 的时间戳完全相同，只处理一次
            var ts = (typeof e.timeStamp === 'number') ? e.timeStamp : Date.now();
            if (ts === lastHandledStamp.kd) return;
            lastHandledStamp.kd = ts;
            try { e.preventDefault && e.preventDefault(); } catch (_) {}
            try { e.stopPropagation && e.stopPropagation(); } catch (_) {}
            // 空格键独立按压路径：与按钮 click/mouse/touch 完全解耦
            //   keydown   → setPressedOn（保持 pressed 直到 keyup 后拖尾释放）
            //             + 调 generatePoem（内部节流锁 180ms 防重）
            //   keyup     → 直接挂 120ms 拖尾 setPressedOff，不再用 triggerPressed 重复 setPressedOn
            //               快速 tap 空格时（keydown→keyup 只有 30ms），120ms 拖尾保证肉眼仍能看到反色
            setPressedOn(generateBtn);
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
            if (!generateBtn) return;
            // 直接挂短拖尾后 setPressedOff。keydown 时已经 setPressedOn，
            // pressed 类一直保留，直到拖尾到期释放，与桌面鼠标体验一致。
            const existingTrail = pressedTimers.get(generateBtn);
            if (existingTrail) { clearTimeout(existingTrail); pressedTimers.delete(generateBtn); }
            const HOLD_MS = 120;
            const trailId = setTimeout(function () {
                setPressedOff(generateBtn);
            }, HOLD_MS);
            pressedTimers.set(generateBtn, trailId);
        };
        // 仅 document capture 绑定一次，避免双通道重复触发状态机打架
        document.addEventListener('keydown', onPress, true);
        document.addEventListener('keyup', onRelease, true);

        // 失焦立即释放所有 pressed 状态
        window.addEventListener('blur', function () {
            setPressedOff(generateBtn);
            setPressedOff(copyBtn);
            setPressedOff(downloadBtn);
            themeBtns.forEach(function (t) { setPressedOff(t); });
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

        // 触屏 / 鼠标按压态：统一走 setPressedOn / triggerPressed 状态机
        //  — 桌面端：mousedown → setPressedOn；mouseup → triggerPressed(100ms) 拖尾；mouseleave → setPressedOff
        //  — 移动端：touchstart → setPressedOn
        //            + touchmove 位移阈值判断（滑出按钮立即 setPressedOff，模拟桌面 mouseleave）
        //            + touchend → triggerPressed(100ms) 拖尾
        //            + touchcancel → setPressedOff
        //  两端动画完全等价：按下立即变色，抬起后"多显示 100ms 反色"才消失，
        //  避免移动端极快 tap（20-30ms）时颜色一闪而过，肉眼看不到。
        //  关键修复 1：移动端 tap 后浏览器会 ~300ms 补发兼容性 mousedown/mouseup 事件，
        //    不拦截的话 mousedown 会把刚 release 的 pressed class 再加回去，
        //    甚至某些场景下不再发 mouseup → 按钮"卡死在反色"。
        //    → 每次 touch 事件后给该按钮打 500ms 时间锁（之前 700ms，覆盖 300~400ms 的合成事件即可，
        //      太长会导致用户连续快速点第二次的时候，第二次真实 mouse* 被误锁，反而增加卡死风险）。
        //  关键修复 2：iOS Safari 真机的事件丢失场景——
        //    (a) 手指按下按钮，轻微滑出按钮边界 / 页面微滚动 → 既不发 touchend 也不发 touchcancel
        //    (b) 切后台（锁屏/来电/上滑多任务）→ setTimeout 被系统冻结，pressedTimers/maxHoldTimers 都错过触发时机
        //    (c) iOS 自带 -webkit-tap-highlight-color 灰层与我们 pressed 反色叠加 → 视觉残留
        //    → 多层兜底：
        //        · 按钮级 touchmove 监听：位移阈值判断滑出 → 立即 setPressedOff
        //        · 全局 window 级 touchend/touchcancel：任何一次触摸结束都扫一遍所有按钮是否有 stale pressed
        //        · 全局 document visibilitychange → visible 时立即扫（切后台回来兜底）
        //        · pressedStartedAt 绝对时间戳：不靠 setTimeout，用真实 Date.now() 差判断是否超时
        const TOUCH_LOCK_MS = 500;
        const MOVE_OUT_PX = 8;                 // 位移阈值：手指从 touchstart 点向任何方向挪 > 8px 视为"滑出"，立即取消 pressed
        function markTouchLock(btn, extraMs) {
            const ms = (typeof extraMs === 'number' && extraMs > 0) ? extraMs : TOUCH_LOCK_MS;
            touchLockUntil.set(btn, Date.now() + ms);
        }
        function isTouchLocked(btn) {
            const until = touchLockUntil.get(btn);
            return (typeof until === 'number') && (Date.now() < until);
        }
        function getTouchStartPoint(e) {
            try {
                if (e && e.touches && e.touches.length) {
                    return { x: e.touches[0].clientX, y: e.touches[0].clientY };
                }
                if (e && e.changedTouches && e.changedTouches.length) {
                    return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
                }
            } catch (_) {}
            return null;
        }
        function isPointInsideBtn(btn, x, y) {
            try {
                var r = btn.getBoundingClientRect();
                return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
            } catch (_) { return true; }
        }
        const pressables = [generateBtn, copyBtn, downloadBtn];
        const allButtons = pressables.concat(themeBtns || []).filter(Boolean);

        // ------- 主按钮 + 副按钮：随机生成 / 图片分享 / 网址复制 -------
        pressables.forEach(function (btn) {
            if (!btn) return;
            // 保存每个按钮的 touchstart 点，位移阈值判断用
            var startPt = null;

            btn.addEventListener('touchstart', function (e) {
                startPt = getTouchStartPoint(e);
                setPressedOn(btn);
                markTouchLock(btn, TOUCH_LOCK_MS);
            }, { passive: true });

            btn.addEventListener('touchmove', function (e) {
                // iOS Safari 经典 bug：手指按下 → 稍微挪一点（0.5~5px 页面微滚动或轻微位移）
                //   → 系统判定用户要滚动而非点击，后续 touchend/touchcancel **都可能不发**，
                //   于是 pressed 类永远留在那里。
                // 这里主动监听 move：两种情况任一命中就立即释放：
                //   A. 位移超过 MOVE_OUT_PX（手指明显挪了，视为"放弃点击" → 还原）
                //   B. 当前触点坐标已经不在按钮矩形内（滑出按钮 → 还原，对应桌面 mouseleave）
                if (!startPt) return;
                var cur = null;
                try {
                    if (e && e.touches && e.touches.length) {
                        cur = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                    }
                } catch (_) {}
                if (!cur) return;
                var dx = cur.x - startPt.x;
                var dy = cur.y - startPt.y;
                var distSq = dx * dx + dy * dy;
                var moved = distSq > (MOVE_OUT_PX * MOVE_OUT_PX);
                var outside = !isPointInsideBtn(btn, cur.x, cur.y);
                if (moved || outside) {
                    setPressedOff(btn);
                }
            }, { passive: true });

            btn.addEventListener('touchend', function (e) {
                startPt = null;
                triggerPressed(btn, 100);         // 抬起：多显示 100ms 反色，与桌面端 mouseup 完全一致
                markTouchLock(btn, TOUCH_LOCK_MS);
                // 合成 click 即将触发的 300ms 窗口 + 拖尾 100ms = 400ms 后，强制扫一次，
                // 防止合成 mouse 事件 + 拖尾定时器 打架导致 pressed 残留
                var t0 = Date.now();
                setTimeout(function () {
                    forceReleaseStalePressed(allButtons);
                }, 450);
            }, { passive: true });

            btn.addEventListener('touchcancel', function () {
                startPt = null;
                setPressedOff(btn);               // 取消：立即还原（对应桌面端 mouseleave）
                markTouchLock(btn, TOUCH_LOCK_MS);
            }, { passive: true });

            btn.addEventListener('mousedown', function () {
                if (isTouchLocked(btn)) return;   // 刚被触摸过，忽略兼容性 mousedown（避免卡死）
                setPressedOn(btn);
            });
            btn.addEventListener('mouseup', function () {
                if (isTouchLocked(btn)) return;
                triggerPressed(btn, 100);         // 桌面鼠标抬起后 100ms 拖尾
            });
            btn.addEventListener('mouseleave', function () {
                if (isTouchLocked(btn)) return;
                setPressedOff(btn);               // 鼠标滑出：立刻释放（符合桌面习惯）
            });
            btn.addEventListener('blur', function () {
                setPressedOff(btn);
            });
        });

        // ------- 三个配色按钮（纸白/墨黑/素灰）：同一套状态机，拖尾 80ms -------
        themeBtns.forEach(function (btn) {
            if (!btn) return;
            var startPt = null;
            btn.addEventListener('touchstart', function (e) {
                startPt = getTouchStartPoint(e);
                setPressedOn(btn);
                markTouchLock(btn, TOUCH_LOCK_MS);
            }, { passive: true });
            btn.addEventListener('touchmove', function (e) {
                if (!startPt) return;
                var cur = null;
                try {
                    if (e && e.touches && e.touches.length) {
                        cur = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                    }
                } catch (_) {}
                if (!cur) return;
                var dx = cur.x - startPt.x;
                var dy = cur.y - startPt.y;
                var moved = (dx * dx + dy * dy) > (MOVE_OUT_PX * MOVE_OUT_PX);
                var outside = !isPointInsideBtn(btn, cur.x, cur.y);
                if (moved || outside) setPressedOff(btn);
            }, { passive: true });
            btn.addEventListener('touchend', function () {
                startPt = null;
                triggerPressed(btn, 80);          // 与桌面主题按钮 mouseup 拖尾 80ms 一致
                markTouchLock(btn, TOUCH_LOCK_MS);
                setTimeout(function () { forceReleaseStalePressed(allButtons); }, 450);
            }, { passive: true });
            btn.addEventListener('touchcancel', function () {
                startPt = null;
                setPressedOff(btn);
                markTouchLock(btn, TOUCH_LOCK_MS);
            }, { passive: true });
            btn.addEventListener('mousedown', function () {
                if (isTouchLocked(btn)) return;
                setPressedOn(btn);
            });
            btn.addEventListener('mouseup', function () {
                if (isTouchLocked(btn)) return;
                triggerPressed(btn, 80);
            });
            btn.addEventListener('mouseleave', function () {
                if (isTouchLocked(btn)) return;
                setPressedOff(btn);
            });
            btn.addEventListener('blur', function () {
                setPressedOff(btn);
            });
        });

        // ========================================
        // 全局兜底：拦截 iOS Safari 各种"按钮事件漏发 / 定时器冻结"场景
        // ========================================
        var pendingScanTimer = null;
        function scheduleGlobalScan(delayMs) {
            if (pendingScanTimer) clearTimeout(pendingScanTimer);
            pendingScanTimer = setTimeout(function () {
                pendingScanTimer = null;
                forceReleaseStalePressed(allButtons);
            }, delayMs);
        }
        // 任何一次"触摸结束 / 取消"全局事件 —— 扫一遍，
        // 覆盖"单个按钮没收到自己的 touchend/touchcancel，但 window 收到了"的场景。
        window.addEventListener('touchend', function () { scheduleGlobalScan(150); }, { passive: true });
        window.addEventListener('touchcancel', function () { scheduleGlobalScan(100); }, { passive: true });
        // 任何一次"鼠标离开窗口"也把桌面端的 pressed 清掉（对应桌面端 drag-outside-window 卡死场景）
        window.addEventListener('mouseup', function () { scheduleGlobalScan(200); }, { passive: true });
        // 页面切后台回来 / 解锁 / 从其他 app 切回 —— setTimeout 可能冻结错过，回来立即扫。
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                forceReleaseStalePressed(allButtons);
                scheduleGlobalScan(100);
            }
        });
        // 页面被点击任何位置（兜底：iOS 合成 click 触发后仍有残留 pressed）
        document.addEventListener('click', function () { scheduleGlobalScan(260); }, { passive: true });
    }

    // ========================================
    // Initialize
    // ========================================
    function init() {
        // 移动端 / 触屏：DOM 层移除空格提示（独立 .space-hint + 旧 .btn-hint）
        if (!isFinePointerWithKeyboard()) {
            document.querySelectorAll('.space-hint, .btn-hint').forEach(function (el) {
                try { if (el && el.parentNode) el.parentNode.removeChild(el); } catch (_) {}
            });
        }

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
