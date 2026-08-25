(function () {
    'use strict';

    // ========================================
    // State
    // ========================================
    let currentIndex = -1;
    let toastTimer = null;

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
    // Fonts — 覆盖尽量全的系统宋体系列，Noto Serif SC (思源宋体) 优先
    // ========================================
    const POEM_FONT_FAMILY = [
        '"Noto Serif SC"',          // Google Fonts：思源宋体（在线，覆盖最全简体中文）
        '"Source Han Serif SC"',    // Adobe：思源宋体
        '"Source Han Serif CN"',    // Adobe：思源宋体 CN 子集
        '"Songti SC"',              // macOS 自带：宋体-简
        '"STSong"',                 // macOS 旧版：华文宋体
        '"SimSun"',                 // Windows：宋体
        '"WenQuanYi Bitmap Song"',  // Linux：文泉驿点阵宋体
        '"AR PL UMing CN"',         // Linux：AR PL 大宋体
        '"AR PL SungtiL GB"',       // Linux：AR PL 宋体 GB
        '"PingFang SC"',            // macOS/iOS：苹方（无衬线，作为最后兜底以确保字符存在）
        'serif'                     // 最终通用 serif
    ].join(', ');

    const SOURCE_FONT_FAMILY = [
        '"Inter"',
        '-apple-system',
        'BlinkMacSystemFont',
        '"PingFang SC"',
        '"Hiragino Sans GB"',       // macOS：冬青黑体
        '"Microsoft YaHei"',        // Windows：微软雅黑
        '"WenQuanYi Micro Hei"',    // Linux：文泉驿微米黑
        '"Heiti SC"',               // macOS：黑体-简
        '"SimHei"',                 // Windows：黑体
        'sans-serif'
    ].join(', ');

    // ========================================
    // Canvas 图片规格
    // ========================================
    const CANVAS_W = 1080;
    const CANVAS_H = 1350;
    const PADDING = 162;              // 左右各 15% 边距
    const POEM_FONT_SIZE = 88;
    const SOURCE_FONT_SIZE = 32;
    const POEM_LINE_HEIGHT = 1.7;
    const GAP_BETWEEN = 64;

    // ========================================
    // Utilities
    // ========================================
    function getRandomIndex() {
        if (poems.length <= 1) return 0;
        let idx;
        do {
            idx = Math.floor(Math.random() * poems.length);
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

    /**
     * 等待字体加载完成（最多 5 秒超时），确保 Canvas 使用正确字体渲染。
     */
    function waitForFonts() {
        if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
            // ready 返回的 Promise 会在所有字体加载完成后 resolve
            const timeout = new Promise(function (resolve) {
                setTimeout(resolve, 5000);
            });
            return Promise.race([document.fonts.ready, timeout]);
        }
        return Promise.resolve();
    }

    // ========================================
    // Poem Display
    // ========================================
    function displayPoem(index) {
        const poem = poems[index];
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
        currentIndex = getRandomIndex();
        displayPoem(currentIndex);
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
    function copyPoem() {
        const poem = poems[currentIndex];
        const text = poem.text + '\n—— ' + poem.source;

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

    /**
     * 按宽度逐字换行，支持中英文混排
     */
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

        // 2. 诗句：先设置字体，测量并换行
        ctx.font = '400 ' + POEM_FONT_SIZE + 'px ' + POEM_FONT_FAMILY;
        ctx.fillStyle = colors.text;
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'center';

        const poemLines = wrapText(ctx, poem.text, maxTextWidth);

        // 3. 出处：同样先设置字体
        const sourceText = '—— ' + poem.source;
        ctx.font = '300 ' + SOURCE_FONT_SIZE + 'px ' + SOURCE_FONT_FAMILY;
        ctx.fillStyle = colors.secondary;
        ctx.textAlign = 'center';

        // 4. 计算整体内容尺寸，用于绝对垂直居中
        const poemBlockHeight = poemLines.length * POEM_FONT_SIZE * POEM_LINE_HEIGHT;
        const sourceBlockHeight = SOURCE_FONT_SIZE * 1.4;
        const totalContentHeight = poemBlockHeight + GAP_BETWEEN + sourceBlockHeight;

        // contentTop 为内容区顶部位置
        const contentTop = (CANVAS_H - totalContentHeight) / 2;
        let currentY;

        // 5. 绘制诗句：使用 alphabetic baseline，第一行从行高顶部加上 (font-size * 0.8) 开始
        //    这样保证文字在垂直方向上分布均衡
        ctx.font = '400 ' + POEM_FONT_SIZE + 'px ' + POEM_FONT_FAMILY;
        ctx.fillStyle = colors.text;
        const lineStep = POEM_FONT_SIZE * POEM_LINE_HEIGHT;
        currentY = contentTop + POEM_FONT_SIZE * 0.88; // 近似 alphabetic 基线偏移
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
        const poem = poems[currentIndex];
        if (!poem) {
            showToast('数据加载中，请稍后再试');
            return;
        }
        const theme = body.getAttribute('data-theme') || 'white';
        const colors = themeConfig[theme];

        downloadBtn.setAttribute('disabled', 'true');

        // 关键：先等思源宋体加载完成，避免 Canvas 用降级字体渲染
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
    // Keyboard Shortcut
    // ========================================
    function initKeyboard() {
        document.addEventListener('keydown', function (e) {
            if (e.code === 'Space' && !e.repeat) {
                const tag = (e.target.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
                e.preventDefault();
                generatePoem();
            }
        });
    }

    // ========================================
    // Event Bindings
    // ========================================
    function initEvents() {
        generateBtn.addEventListener('click', generatePoem);
        copyBtn.addEventListener('click', copyPoem);
        downloadBtn.addEventListener('click', downloadImage);
    }

    // ========================================
    // Initialize
    // ========================================
    function init() {
        if (typeof poems === 'undefined' || !poems.length) {
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
