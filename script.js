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
    const exportContainer = document.getElementById('exportContainer');
    const exportText = document.getElementById('exportText');
    const exportSource = document.getElementById('exportSource');

    // ========================================
    // Theme Config — 用于图片生成时的配色映射
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
    // Download Image
    // ========================================
    function downloadImage() {
        if (typeof domtoimage === 'undefined') {
            showToast('图片组件加载中，请稍后再试');
            return;
        }

        const poem = poems[currentIndex];
        const theme = body.getAttribute('data-theme') || 'white';
        const colors = themeConfig[theme];

        // 设置导出容器的内容与配色
        exportContainer.style.backgroundColor = colors.bg;
        exportContainer.style.color = colors.text;
        exportText.textContent = poem.text;
        exportText.style.color = colors.text;
        exportSource.textContent = '—— ' + poem.source;
        exportSource.style.color = colors.secondary;

        // 等字体加载完成（尽量确保字体生效）
        const ensureFonts = function () {
            if (document.fonts && document.fonts.ready) {
                return document.fonts.ready;
            }
            return Promise.resolve();
        };

        downloadBtn.setAttribute('disabled', 'true');

        ensureFonts().then(function () {
            return domtoimage.toPng(exportContainer, {
                width: 1080,
                height: 1350,
                style: {
                    'font-family': '"Noto Serif SC", "PingFang SC", "SimSun", serif'
                }
            });
        }).then(function (dataUrl) {
            const link = document.createElement('a');
            link.download = 'verses-' + formatDate() + '.png';
            link.href = dataUrl;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            showToast('已下载');
        }).catch(function (err) {
            console.error(err);
            showToast('下载失败，请重试');
        }).finally(function () {
            downloadBtn.removeAttribute('disabled');
        });
    }

    // ========================================
    // Keyboard Shortcut
    // ========================================
    function initKeyboard() {
        document.addEventListener('keydown', function (e) {
            // 空格键触发生成（防止输入框等场景）
            if (e.code === 'Space' && !e.repeat) {
                const tag = (e.target.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
                e.preventDefault();
                generatePoem();
            }
            // Enter 触发复制（当焦点在按钮时由浏览器原生处理）
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
        // 确保 poems 存在
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

    // DOM 就绪后启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
