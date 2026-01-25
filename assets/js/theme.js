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
            button.setAttribute('aria-label', '切换主题');
            button.innerHTML = this.getThemeIcon();
            document.body.appendChild(button);
        },

        getThemeIcon() {
            const currentTheme = this.getCurrentTheme();
            return currentTheme === this.DARK ? '🌞' : '🌙';
        },

        getCurrentTheme() {
            return document.documentElement.getAttribute('data-theme') || this.LIGHT;
        },

        loadTheme() {
            // 优先读取本地存储
            const savedTheme = localStorage.getItem(this.STORAGE_KEY);

            // 如果没有保存过，检测系统偏好
            const preferredTheme = savedTheme ||
                (window.matchMedia('(prefers-color-scheme: dark)').matches ? this.DARK : this.LIGHT);

            this.setTheme(preferredTheme);
        },

        setTheme(theme) {
            document.documentElement.setAttribute('data-theme', theme);
            localStorage.setItem(this.STORAGE_KEY, theme);

            // 更新按钮图标
            const button = document.getElementById('theme-toggle');
            if (button) {
                button.innerHTML = this.getThemeIcon();
            }
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

            // 监听系统主题变化
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                if (!localStorage.getItem(this.STORAGE_KEY)) {
                    this.setTheme(e.matches ? this.DARK : this.LIGHT);
                }
            });
        }
    };

    // ==================== 阅读进度条 ====================
    const ReadingProgress = {
        init() {
            // 只在文章页显示
            if (!document.querySelector('.post')) return;

            this.createProgressBar();
            this.updateProgress();
            window.addEventListener('scroll', () => this.updateProgress());
        },

        createProgressBar() {
            const bar = document.createElement('div');
            bar.id = 'reading-progress';
            document.body.appendChild(bar);
        },

        updateProgress() {
            const windowHeight = window.innerHeight;
            const documentHeight = document.documentElement.scrollHeight;
            const scrollTop = window.scrollY;

            const maxScroll = documentHeight - windowHeight;
            const progress = (scrollTop / maxScroll) * 100;

            const bar = document.getElementById('reading-progress');
            if (bar) {
                bar.style.width = Math.min(progress, 100) + '%';
            }
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

    // ==================== 返回顶部按钮优化 ====================
    const BackToTop = {
        init() {
            const button = document.getElementById('back-to-top');
            if (!button) return;

            this.updateVisibility();
            window.addEventListener('scroll', () => this.updateVisibility());
        },

        updateVisibility() {
            const button = document.getElementById('back-to-top');
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

    }

    // DOM加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAll);
    } else {
        initAll();
    }

})();

