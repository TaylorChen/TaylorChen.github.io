# Favicon 图标说明

## 设计理念

本博客采用技术风格的小黄鸭作为 favicon 图标，体现了技术与产品的结合：

- **小黄鸭**：象征着"橡皮鸭调试法"（Rubber Duck Debugging），这是程序员常用的问题解决方法
- **金黄色配色**：明亮、友好、充满活力
- **技术元素**：SVG 版本包含代码括号 `</>` 和齿轮图案，象征技术和工程

## 图标文件

本目录包含以下图标文件：

| 文件名 | 尺寸 | 用途 |
|--------|------|------|
| `favicon.svg` | 矢量图 | 现代浏览器的首选格式，支持任意缩放 |
| `favicon.ico` | 多尺寸 | 传统浏览器支持 (16x16, 32x32, 48x48, 64x64, 128x128, 256x256) |
| `favicon-96x96.png` | 96x96 | 标准网站 favicon |
| `apple-touch-icon.png` | 180x180 | iOS/iPadOS 主屏幕图标 |
| `web-app-manifest-192x192.png` | 192x192 | PWA 应用图标 |
| `web-app-manifest-512x512.png` | 512x512 | PWA 应用图标（高分辨率） |

## 设计特点

### 配色方案
- 主体颜色：金黄色渐变 (#FFD700 → #FFA500)
- 嘴巴颜色：橙色渐变 (#FF8C00 → #FF6B00)
- 眼睛：白色外圈，深色瞳孔 (#2C3E50)
- 技术元素：半透明深色 (#2C3E50, 30% 透明度)

### 技术实现
- 使用 Python + Pillow 库生成
- SVG 版本包含矢量图形和渐变效果
- PNG 版本针对不同设备和用途优化
- ICO 文件包含多个尺寸以适配不同场景

## 更新日期

2026-01-25

## 制作工具

- Python 3.13.3
- Pillow 12.1.0

## 如何重新生成

如果需要修改图标设计，可以：

1. 编辑 SVG 定义或 Python 生成脚本
2. 使用以下命令重新生成所有尺寸：

```bash
# 使用提供的生成脚本（如果保留）
python3 generate_favicons.py

# 或手动使用图像处理工具
```

## 参考资料

- [橡皮鸭调试法](https://zh.wikipedia.org/wiki/%E5%B0%8F%E9%BB%84%E9%B8%AD%E8%B0%83%E8%AF%95%E6%B3%95)
- [Favicon 最佳实践](https://evilmartians.com/chronicles/how-to-favicon-in-2021-six-files-that-fit-most-needs)
