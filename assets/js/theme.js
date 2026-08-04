/**
 * 小黄鸭 博客 - 主题功能脚本
 * 包含：暗色模式切换、阅读进度、平滑滚动等
 */

(function () {
    'use strict';

    // ==================== 暗色模式管理 ====================
    const ThemeManager = {
        STORAGE_KEY: 'blog-theme',
        DARK: 'dark',
        LIGHT: 'light',

        init() {
            this.createToggleButton();
            this.loadTheme();
            this.attachEventListeners();
        },

        createToggleButton() {
            const button = document.createElement('button');
            button.id = 'theme-toggle';
            button.type = 'button';
            button.setAttribute('aria-label', '切换深色/浅色主题');
            button.innerHTML = this.getThemeIcon();
            // 放进顶部导航，避免再多一个浮在页面上的圆形按钮
            (document.querySelector('.site-nav') || document.body).appendChild(button);
        },

        getThemeIcon() {
            const sun = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.4v2.2M12 19.4v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.4 12h2.2M19.4 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/></svg>';
            const moon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8z"/></svg>';
            return this.getCurrentTheme() === this.DARK ? sun : moon;
        },

        getCurrentTheme() {
            return document.documentElement.getAttribute('data-theme') || this.LIGHT;
        },

        loadTheme() {
            // 没存过就跟随系统；注意这里只能 applyTheme，不能写入存储，
            // 否则「用户显式选择」和「当前生效主题」会被混为一谈，
            // 跟随系统的监听器将永远不再触发。
            const savedTheme = localStorage.getItem(this.STORAGE_KEY);
            this.applyTheme(savedTheme || this.systemTheme());
        },

        systemTheme() {
            return window.matchMedia('(prefers-color-scheme: dark)').matches ? this.DARK : this.LIGHT;
        },

        // 只负责让主题生效
        applyTheme(theme) {
            document.documentElement.setAttribute('data-theme', theme);

            const button = document.getElementById('theme-toggle');
            if (button) {
                button.innerHTML = this.getThemeIcon();
                button.setAttribute('aria-pressed', String(theme === this.DARK));
            }
        },

        // 只在用户显式切换时调用：生效 + 记住选择
        setTheme(theme) {
            this.applyTheme(theme);
            localStorage.setItem(this.STORAGE_KEY, theme);
        },

        toggleTheme() {
            const currentTheme = this.getCurrentTheme();
            const newTheme = currentTheme === this.DARK ? this.LIGHT : this.DARK;
            this.setTheme(newTheme);
        },

        attachEventListeners() {
            const button = document.getElementById('theme-toggle');
            if (button) {
                button.addEventListener('click', () => this.toggleTheme());
            }

            // 用户没有显式选过主题时，跟随系统变化
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                if (!localStorage.getItem(this.STORAGE_KEY)) {
                    this.applyTheme(e.matches ? this.DARK : this.LIGHT);
                }
            });
        }
    };

    // ==================== 滚动调度 ====================
    // 页面上原有 3 个各自独立的 scroll 监听（阅读进度、回到顶部 ×2），
    // 每次滚动事件都同步读取 scrollY / scrollHeight，触发重复的布局计算。
    // 这里合并为单一监听 + rAF 节流：一帧最多执行一次，且标记 passive
    // 让浏览器无需等待回调即可滚动。
    const ScrollDispatcher = {
        handlers: [],
        ticking: false,

        add(fn) {
            this.handlers.push(fn);
            fn();
        },

        init() {
            if (!this.handlers.length) return;
            window.addEventListener('scroll', () => this.request(), { passive: true });
            window.addEventListener('resize', () => this.request(), { passive: true });
        },

        request() {
            if (this.ticking) return;
            this.ticking = true;
            window.requestAnimationFrame(() => {
                this.ticking = false;
                this.handlers.forEach(fn => fn());
            });
        }
    };

    // ==================== 阅读进度条 ====================
    const ReadingProgress = {
        init() {
            // 只在文章页显示
            if (!document.querySelector('.post')) return;

            this.bar = document.createElement('div');
            this.bar.id = 'reading-progress';
            document.body.appendChild(this.bar);

            ScrollDispatcher.add(() => this.updateProgress());
        },

        updateProgress() {
            const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
            // 内容不足一屏时没有进度可言，避免除以 0 得到 NaN
            const progress = maxScroll > 0 ? (window.scrollY / maxScroll) * 100 : 0;
            this.bar.style.width = Math.min(progress, 100) + '%';
        }
    };

    // ==================== 平滑滚动 ====================
    const SmoothScroll = {
        init() {
            // 为所有锚点链接添加平滑滚动
            document.querySelectorAll('a[href^="#"]').forEach(anchor => {
                anchor.addEventListener('click', (e) => {
                    const href = anchor.getAttribute('href');
                    if (href === '#') return;

                    const target = document.querySelector(href);
                    if (target) {
                        e.preventDefault();
                        target.scrollIntoView({
                            behavior: 'smooth',
                            block: 'start'
                        });
                    }
                });
            });
        }
    };

    // ==================== 目录高亮 ====================
    const TocHighlight = {
        init() {
            // 只在文章页且有目录时运行
            const toc = document.getElementById('toc');
            if (!toc) return;

            this.observeHeadings();
        },

        observeHeadings() {
            const headings = document.querySelectorAll('#post-content h1, #post-content h2, #post-content h3');
            if (!headings.length) return;

            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    const id = entry.target.id;
                    const tocLink = document.querySelector(`#toc a[href="#${id}"]`);

                    if (tocLink) {
                        if (entry.isIntersecting) {
                            // 移除其他高亮
                            document.querySelectorAll('#toc a').forEach(link => {
                                link.style.color = '';
                                link.style.fontWeight = '';
                            });

                            // 高亮当前项
                            tocLink.style.color = 'var(--primary-color)';
                            tocLink.style.fontWeight = '600';
                        }
                    }
                });
            }, {
                rootMargin: '-100px 0px -66%',
                threshold: 1.0
            });

            headings.forEach(heading => observer.observe(heading));
        }
    };

    // ==================== 返回顶部 ====================
    // 显隐与点击都收在这里；post.html 里原本还有一份重复实现，已移除。
    const BackToTop = {
        init() {
            this.button = document.getElementById('back-to-top');
            if (!this.button) return;

            this.button.addEventListener('click', () => {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });

            ScrollDispatcher.add(() => this.updateVisibility());
        },

        updateVisibility() {
            const button = this.button;
            if (button) {
                button.style.display = window.scrollY > 300 ? 'flex' : 'none';
            }
        }
    };

    // ==================== 页面动画 ====================
    const PageAnimations = {
        init() {
            // 为主要内容区域添加淡入动画
            const mainContent = document.querySelector('.home, .post, article');
            if (mainContent) {
                mainContent.classList.add('fade-in');
            }

            // 为卡片添加延迟动画
            const cards = document.querySelectorAll('.post-list li, .card');
            cards.forEach((card, index) => {
                card.style.animationDelay = `${index * 50}ms`;
                card.classList.add('fade-in');
            });
        }
    };

    // ==================== 图片懒加载增强 ====================
    const ImageLazyLoad = {
        init() {
            // 为所有图片添加加载效果
            const images = document.querySelectorAll('img');

            images.forEach(img => {
                if (!img.complete) {
                    img.style.opacity = '0';
                    img.style.transition = 'opacity 0.3s ease';

                    img.addEventListener('load', () => {
                        img.style.opacity = '1';
                    });
                }
            });
        }
    };

    // ==================== 外部链接处理 ====================
    const ExternalLinks = {
        init() {
            document.querySelectorAll('a[href^="http"]').forEach(link => {
                const url = new URL(link.href);
                if (url.hostname !== window.location.hostname) {
                    link.setAttribute('target', '_blank');
                    link.setAttribute('rel', 'noopener noreferrer');

                    // 添加外部链接图标（可选）
                    if (!link.querySelector('.external-icon')) {
                        const icon = document.createElement('span');
                        icon.className = 'external-icon';
                        icon.innerHTML = ' ↗';
                        icon.style.fontSize = '0.8em';
                        icon.style.opacity = '0.6';
                        link.appendChild(icon);
                    }
                }
            });
        }
    };

    // ==================== 不蒜子统计显示控制 ====================
    const BusuanziStats = {
        init() {
            // 只在文章页显示文章阅读量
            const pageContainer = document.getElementById('busuanzi_container_page_pv');
            if (!pageContainer) return;

            // 等待不蒜子脚本加载
            const checkInterval = setInterval(() => {
                if (typeof busuanzi !== 'undefined') {
                    clearInterval(checkInterval);
                    pageContainer.style.display = 'inline';
                }
            }, 100);

            // 超时处理
            setTimeout(() => {
                clearInterval(checkInterval);
            }, 5000);
        }
    };

    // ==================== 阅读时长预估 ====================
    const ReadingTime = {
        init() {
            // 只在文章页显示
            const postContent = document.getElementById('post-content');
            if (!postContent) return;

            const text = postContent.textContent || postContent.innerText;
            const wordCount = this.countWords(text);
            const readingTime = this.calculateReadingTime(wordCount);

            this.displayReadingTime(readingTime, wordCount);
        },

        countWords(text) {
            // 移除多余空白
            text = text.trim();

            // 统计中文字符
            const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;

            // 统计英文单词
            const englishWords = text
                .replace(/[\u4e00-\u9fa5]/g, '') // 移除中文
                .split(/\s+/)
                .filter(word => word.length > 0).length;

            return chineseChars + englishWords;
        },

        calculateReadingTime(wordCount) {
            // 中文平均阅读速度: 300-500字/分钟，这里取400
            // 英文平均阅读速度: 200-250词/分钟，这里统一按中文计算
            const wordsPerMinute = 400;
            const minutes = Math.ceil(wordCount / wordsPerMinute);
            return minutes;
        },

        displayReadingTime(minutes, wordCount) {
            const postMeta = document.querySelector('.post-meta');
            if (!postMeta) return;

            const readingTimeEl = document.createElement('span');
            readingTimeEl.className = 'reading-time';
            readingTimeEl.innerHTML = ` · 约 ${minutes} 分钟 · ${wordCount.toLocaleString()} 字`;
            readingTimeEl.style.color = 'var(--text-secondary)';

            postMeta.appendChild(readingTimeEl);
        }
    };

    // ==================== 初始化所有功能 ====================
    function initAll() {
        ThemeManager.init();
        ReadingProgress.init();
        SmoothScroll.init();
        TocHighlight.init();
        BackToTop.init();
        PageAnimations.init();
        ImageLazyLoad.init();
        ExternalLinks.init();
        ReadingTime.init();
        BusuanziStats.init();

        // 必须在所有 ScrollDispatcher.add 之后，此时才知道要不要挂监听
        ScrollDispatcher.init();
    }

    // DOM加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAll);
    } else {
        initAll();
    }

})();

