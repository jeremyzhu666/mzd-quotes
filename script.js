(function () {
    'use strict';

    // ========================================
    // State
    // ========================================
    let currentIndex = -1;
    let toastTimer = null;
    let pressedTimers = new WeakMap();       // btn element -> timeout id
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
     * Font loading gate (eliminate FOUT / visible glyph jump)
     * Release conditions — winner takes first:
     *   1. document.fonts.ready resolves — fonts all available
     *   2. setTimeout 3000 ms — network / blocked CDN fallback
     *   3. CSS @keyframes 3200 ms — JS disabled / throws safety net
     * ============================================================== */
    (function unlockWhenFontsReady() {
        var MAX_WAIT_MS = 3000;
        var html = document.documentElement;
        if (!html) return;

        function unlock() {
            if (html.classList && !html.classList.contains('fonts-loaded')) {
                html.classList.add('fonts-loaded');
            }
        }

        var fallbackTimer = setTimeout(unlock, MAX_WAIT_MS);

        try {
            if (document.fonts &&
                typeof document.fonts.ready !== 'undefined' &&
                document.fonts.ready &&
                typeof document.fonts.ready.then === 'function') {
                document.fonts.ready.then(function () {
                    clearTimeout(fallbackTimer);
                    unlock();
                }).catch(function () { unlock(); });
            }
            // else: keep fallback timer running; CSS animation at 3.2s also backs up
        } catch (e) { unlock(); }
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
     *   setPressedOn  —— 立即进入 pressed 反色态（如果有 pending 释放定时器，先清掉）
     *   setPressedOff —— 立即退出 pressed 态，同时清理 pending 的释放定时器
     * 统一入口：所有 mouse/touch/keyboard/click 的按压视觉都走这两个函数，
     * 避免各自加 class / 清 class 导致状态错乱。
     */
    function setPressedOn(btn) {
        if (!btn) return;
        const existing = pressedTimers.get(btn);
        if (existing) {
            clearTimeout(existing);
            pressedTimers.delete(btn);
        }
        btn.classList.add('pressed');
    }
    function setPressedOff(btn) {
        if (!btn) return;
        const existing = pressedTimers.get(btn);
        if (existing) {
            clearTimeout(existing);
            pressedTimers.delete(btn);
        }
        btn.classList.remove('pressed');
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
                triggerPressed(btn, 140);
            });
        });
    }

    // ========================================
    // Copy
    // ========================================

    function buildShareUrl() {
        // 构造分享链接：附 ?p=<诗句索引>，对方打开时直接展示同一句诗
        const base = (location.origin || '') + (location.pathname || '/');
        const q = (typeof currentIndex === 'number' && currentIndex >= 0)
            ? '?p=' + encodeURIComponent(currentIndex)
            : '';
        return base + q;
    }

    function copyShareLink() {
        const url = buildShareUrl();
        if (currentIndex < 0) {
            showToast('数据加载中，请稍后再试');
            return;
        }
        triggerPressed(copyBtn, 140);

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

        triggerPressed(downloadBtn, 180);
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
        // 三重保障修复"空格需要选中按钮才生效"：
        //   1) body tabindex="-1" 让 body 成为合法焦点接收者（HTML 端已加）
        //   2) document + window 双通道 capture 阶段绑定，不漏事件
        //   3) e.code / e.key / e.keyCode 三条件命中（兼容老浏览器/iPad 外接键盘）
        //   4) init 末尾 document.body.focus({ preventScroll: true }) 拉回焦点
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
            // 老 Safari / IE 兼容
            var kc = (typeof e.keyCode === 'number') ? e.keyCode : (typeof e.which === 'number' ? e.which : -1);
            if (kc === 32) return true;
            return false;
        };
        var onPress = function (e) {
            if (!isSpaceEvent(e)) return;
            if (isEditableTarget(e.target)) return;
            try { e.preventDefault && e.preventDefault(); } catch (_) {}
            try { e.stopPropagation && e.stopPropagation(); } catch (_) {}
            // 空格键独立按压路径：与按钮 click/mouse/touch 完全解耦
            //   keydown   → setPressedOn（保持 pressed 直到 keyup）+ 调 generatePoem（内部节流锁 180ms 防重）
            //   keyup     → triggerPressed(120ms 拖尾)，与桌面鼠标抬起体验一致
            setPressedOn(generateBtn);
            if (!e.repeat) generatePoem();
        };
        var onRelease = function (e) {
            if (!isSpaceEvent(e)) return;
            if (isEditableTarget(e.target)) return;
            try { e.preventDefault && e.preventDefault(); } catch (_) {}
            triggerPressed(generateBtn, 120);
        };
        // capture=true：事件在捕获阶段就拦截，防止焦点元素吞事件
        document.addEventListener('keydown', onPress, true);
        window.addEventListener('keydown', onPress, true);
        document.addEventListener('keyup', onRelease, true);
        window.addEventListener('keyup', onRelease, true);

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
        //  关键：鼠标抬起 / 触屏抬起后，再"多显示 120ms 反色"才消失，
        //        避免移动端极快 tap（20-30ms）时颜色一闪而过，肉眼看不到。
        const pressables = [generateBtn, copyBtn, downloadBtn];
        pressables.forEach(function (btn) {
            if (!btn) return;

            btn.addEventListener('touchstart', function () {
                setPressedOn(btn);                // 按下：立即 pressed（变色反馈）
            }, { passive: true });
            btn.addEventListener('touchend', function () {
                setPressedOff(btn);               // 手指一离开：立即回到原色，无拖尾
            }, { passive: true });
            btn.addEventListener('touchcancel', function () {
                setPressedOff(btn);               // 取消：立即还原
            }, { passive: true });

            btn.addEventListener('mousedown', function () {
                setPressedOn(btn);
            });
            btn.addEventListener('mouseup', function () {
                triggerPressed(btn, 100);         // 桌面鼠标抬起后稍短一些
            });
            btn.addEventListener('mouseleave', function () {
                setPressedOff(btn);               // 鼠标滑出：立刻释放（符合桌面习惯）
            });
            btn.addEventListener('blur', function () {
                setPressedOff(btn);
            });
        });

        // 三个配色按钮（纸白/墨黑/素灰）也同步同一套按压视觉状态机
        themeBtns.forEach(function (btn) {
            if (!btn) return;
            btn.addEventListener('touchstart', function () { setPressedOn(btn); }, { passive: true });
            btn.addEventListener('touchend',   function () { setPressedOff(btn); }, { passive: true });
            btn.addEventListener('touchcancel',function () { setPressedOff(btn); }, { passive: true });
            btn.addEventListener('mousedown',  function () { setPressedOn(btn); });
            btn.addEventListener('mouseup',    function () { triggerPressed(btn, 80); });
            btn.addEventListener('mouseleave', function () { setPressedOff(btn); });
            btn.addEventListener('blur',       function () { setPressedOff(btn); });
        });
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
