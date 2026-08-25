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
    // Theme Config — 页面展示与图片生成共用
    // ========================================
    const themeConfig = {
        white: { bg: '#FFFFFF', text: '#1A1A1A', secondary: '#888888' },
        black: { bg: '#0A0A0A', text: '#F0F0F0', secondary: '#888888' },
        gray:  { bg: '#F2F2F2', text: '#333333', secondary: '#888888' }
    };

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
    // Canvas 图片生成（替代 dom-to-image，彻底解决跨域问题）
    // ========================================
    const CANVAS_W = 1080;
    const CANVAS_H = 1350;
    const PADDING = 162; // 15% of 1080，四周边距
    const POEM_FONT_SIZE = 88;
    const SOURCE_FONT_SIZE = 32;
    const POEM_LINE_HEIGHT = 1.7;
    const GAP_BETWEEN = 64; // 诗句与出处间距

    // 诗句字体族：优先使用思源宋体，降级到系统宋体
    const POEM_FONT_FAMILY = '"Noto Serif SC", "Source Han Serif SC", "PingFang SC", "SimSun", "Songti SC", serif';
    const SOURCE_FONT_FAMILY = '"Inter", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';

    /**
     * 按宽度将文本切分成多行（支持中英文混合）
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

    /**
     * 使用原生 Canvas 绘制诗句图片
     */
    function renderPoemToCanvas(poem, colors) {
        const canvas = document.createElement('canvas');
        const dpr = window.devicePixelRatio || 1;
        // 内部使用更高分辨率绘制，再缩放到目标尺寸，保证清晰
        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
        const ctx = canvas.getContext('2d');

        // 1. 填充背景
        ctx.fillStyle = colors.bg;
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

        const maxTextWidth = CANVAS_W - PADDING * 2;

        // 2. 准备诗句样式并计算换行
        ctx.font = '400 ' + POEM_FONT_SIZE + 'px ' + POEM_FONT_FAMILY;
        ctx.fillStyle = colors.text;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.letterSpacing = '0.05em';

        const poemLines = wrapText(ctx, poem.text, maxTextWidth);

        // 3. 准备出处样式
        const sourceText = '—— ' + poem.source;
        ctx.font = '300 ' + SOURCE_FONT_SIZE + 'px ' + SOURCE_FONT_FAMILY;
        ctx.fillStyle = colors.secondary;
        ctx.textAlign = 'center';

        // 4. 计算整体内容高度，用于垂直居中
        const poemBlockHeight = poemLines.length * POEM_FONT_SIZE * POEM_LINE_HEIGHT;
        const sourceBlockHeight = SOURCE_FONT_SIZE * 1.4;
        const totalContentHeight = poemBlockHeight + GAP_BETWEEN + sourceBlockHeight;

        let currentY = (CANVAS_H - totalContentHeight) / 2;
        const centerX = CANVAS_W / 2;

        // 5. 绘制诗句
        ctx.font = '400 ' + POEM_FONT_SIZE + 'px ' + POEM_FONT_FAMILY;
        ctx.fillStyle = colors.text;
        const lineStep = POEM_FONT_SIZE * POEM_LINE_HEIGHT;
        // 从第一行的中线位置开始绘制
        currentY += POEM_FONT_SIZE * POEM_LINE_HEIGHT / 2;
        for (let i = 0; i < poemLines.length; i++) {
            ctx.fillText(poemLines[i], centerX, currentY);
            currentY += lineStep;
        }

        // 6. 绘制出处
        currentY += GAP_BETWEEN - lineStep / 2 + SOURCE_FONT_SIZE * 1.4 / 2;
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

        try {
            const canvas = renderPoemToCanvas(poem, colors);
            canvas.toBlob(function (blob) {
                try {
                    if (!blob) {
                        throw new Error('Canvas 导出失败');
                    }
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.download = 'verses-' + formatDate() + '.png';
                    link.href = url;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    setTimeout(function () {
                        URL.revokeObjectURL(url);
                    }, 1000);
                    showToast('已下载');
                } catch (err) {
                    console.error(err);
                    showToast('下载失败，请重试');
                } finally {
                    downloadBtn.removeAttribute('disabled');
                }
            }, 'image/png');
        } catch (err) {
            console.error(err);
            showToast('下载失败，请重试');
            downloadBtn.removeAttribute('disabled');
        }
    }

    // ========================================
    // Keyboard Shortcut
    // ========================================
    function initKeyboard() {
        document.addEventListener('keydown', function (e) {
            // 空格键触发生成（排除输入框等场景）
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
