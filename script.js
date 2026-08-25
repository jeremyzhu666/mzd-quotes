(function () {
    'use strict';

    // ========================================
    // State
    // ========================================
    let currentIndex = -1;
    let toastTimer = null;
    let pressedTimers = Object.create(null); // btn id -> timeout id

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
        toast.classList.add('show');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toast.classList.remove('show');
        }, 1500);
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
     * 给按钮一个"被按下去"的视觉反馈（空格键模拟点击时使用）
     * @param {HTMLElement} btn
     * @param {number} [duration=140]
     */
    function triggerPressed(btn, duration) {
        if (!btn) return;
        btn.classList.add('pressed');
        const id = btn.id || ('__btn_' + Math.random().toString(36).slice(2, 7));
        if (pressedTimers[id]) clearTimeout(pressedTimers[id]);
        pressedTimers[id] = setTimeout(function () {
            btn.classList.remove('pressed');
            delete pressedTimers[id];
        }, typeof duration === 'number' ? duration : 140);
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
            poemText.textContent = poem.text;
            poemSource.textContent = '—— ' + poem.source;
            poemText.style.transition = 'opacity 100ms ease';
            poemSource.style.transition = 'opacity 100ms ease';
            poemText.style.opacity = '1';
            poemSource.style.opacity = '1';
        }, 80);
    }

    function generatePoem() {
        const list = getPoems();
        if (!list.length) return;
        currentIndex = getRandomIndex();
        displayPoem(currentIndex);
        triggerPressed(generateBtn, 160);
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
    function copyPoem() {
        const list = getPoems();
        const poem = list[currentIndex];
        if (!poem) {
            showToast('数据加载中，请稍后再试');
            return;
        }
        const text = poem.text + '\n—— ' + poem.source;

        triggerPressed(copyBtn, 140);

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                showToast('已复制');
            }).catch(function () {
                fallbackCopy(text);
            });
        } else {
            fallbackCopy(text);
        }
    }

    function fallbackCopy(text) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try {
            document.execCommand('copy');
            showToast('已复制');
        } catch (e) {
            showToast('复制失败');
        }
        document.body.removeChild(textarea);
    }

    // ========================================
    // Canvas 图片生成
    // ========================================
    function wrapText(ctx, text, maxWidth) {
        const lines = [];
        let current = '';
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
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

        const poemLines = wrapText(ctx, poem.text, maxTextWidth);

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
        if (!isFinePointerWithKeyboard()) return; // 移动端 / 触屏：不绑定空格键

        // keydown：按下瞬间加 pressed 类 + 触发生成
        document.addEventListener('keydown', function (e) {
            if (e.code === 'Space') {
                const tag = (e.target.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
                e.preventDefault();

                // 只在首次按下触发（不重复），避免 hold 时狂刷
                if (!e.repeat) {
                    triggerPressed(generateBtn, 180);
                    generatePoem();
                } else {
                    // 长按时也保持 pressed 的视觉
                    generateBtn.classList.add('pressed');
                }
            }
        });

        // keyup / 失焦：确保移除 pressed 状态
        document.addEventListener('keyup', function (e) {
            if (e.code === 'Space') {
                generateBtn.classList.remove('pressed');
            }
        });
        window.addEventListener('blur', function () {
            generateBtn.classList.remove('pressed');
            copyBtn.classList.remove('pressed');
            downloadBtn.classList.remove('pressed');
        });
    }

    // ========================================
    // Event Bindings
    // ========================================
    function initEvents() {
        generateBtn.addEventListener('click', generatePoem);
        copyBtn.addEventListener('click', copyPoem);
        downloadBtn.addEventListener('click', downloadImage);

        // 触屏 / 鼠标按下时也加 pressed，与空格键的反馈保持一致
        const pressables = [generateBtn, copyBtn, downloadBtn];
        pressables.forEach(function (btn) {
            if (!btn) return;
            const add = function () { btn.classList.add('pressed'); };
            const remove = function () { btn.classList.remove('pressed'); };
            btn.addEventListener('mousedown', add);
            btn.addEventListener('touchstart', add, { passive: true });
            btn.addEventListener('mouseup', remove);
            btn.addEventListener('mouseleave', remove);
            btn.addEventListener('touchend', remove);
            btn.addEventListener('touchcancel', remove);
            btn.addEventListener('blur', remove);
        });
    }

    // ========================================
    // Initialize
    // ========================================
    function init() {
        // 移动端 / 触屏：DOM 层面移除「按空格键切换」提示，
        // 作为 CSS @media 之外的一层兜底，保证任何端（含老旧浏览器）都看不到这条提示。
        if (!isFinePointerWithKeyboard()) {
            document.querySelectorAll('.btn-hint').forEach(function (el) {
                el.parentNode && el.parentNode.removeChild(el);
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

        currentIndex = getRandomIndex();
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
