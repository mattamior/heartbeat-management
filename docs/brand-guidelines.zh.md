# Heartbeat v5 品牌使用规范

## 品牌定位与符号语义

Heartbeat v5 是面向本地开发服务控制台的正式品牌套件。标志由三个不可拆分的语义元素组成：

- **对称方括号**：表示被管理、被约束的服务边界（controlled service boundary）。两侧必须保持对称，不能改成圆括号或任意容器。
- **方端尖角 QRS 脉冲**：表示实时服务信号（real-time service signal）和一次受控交接。尖峰使用直角、折线和方端，体现精确、快速的科技感；它不是医疗心电图或心脏图形。
- **端点节点**：表示服务之间的连接点（connection point）。节点与脉冲共同表达“在边界内连接并传递信号”。

锁定文案为 `Heartbeat`，副标题为 `本地开发服务控制台 · Local Dev Service Control`。设计稿 [pulse-brackets-v5.svg](brand-drafts/round-3/pulse-brackets-v5.svg) 是概念参考；下表列出的路径属于正式 v5 套件。

## 核心色彩

| 色彩 | 色值 | 用途 |
| --- | --- | --- |
| Heartbeat 蓝 | `#2789f4` | 主脉冲、品牌重点和主要交互 |
| 浅青高光 | `#7dd3fc` | 脉冲高光、节点、深色背景上的强调 |
| 服务深蓝 | `#10233e` | 深色页头、反白版的主要背景 |
| 霜白文字 | `#eaf4ff` | 深色背景上的字标与辅助文字 |

绿、黄、红只表示运行状态，不属于品牌色，也不得替换上述蓝色体系。

## 正式资产矩阵

以下路径均相对于 `client/public`；它们是正式 v5 套件的文件命名和使用边界。

| 类别 | 正式路径 | 使用场景 |
| --- | --- | --- |
| Mark 标记 | `/brand/heartbeat-mark.svg` | 透明背景主图标、页头、应用内导航 |
| Logo 锁定版 | `/brand/heartbeat-logo.svg` | 浅色背景上的图标 + `Heartbeat` + 副标题组合 |
| Reversed 反白版 | `/brand/heartbeat-mark-reversed.svg`、`/brand/heartbeat-logo-reversed.svg` | `#10233e` 等深色背景 |
| Mono 单色版 | `/brand/heartbeat-mark-monochrome.svg`、`/brand/heartbeat-logo-monochrome.svg` | 印刷、雕刻、单色界面或无法保证彩色对比度的场景 |
| Favicon 网站图标 | `/brand/heartbeat-mark-16.png` | 浏览器标签页等极小图标位置 |
| PNG 兼容导出 | `/brand/heartbeat-mark-32.png`、`/brand/heartbeat-mark-180.png`、`/brand/heartbeat-mark-512.png` | 高密度浏览器图标、快捷方式和安装入口等位图场景 |
| Web App Manifest | `/site.webmanifest` | Web App 图标和主题色声明；引用正式 PNG，不复制或重绘标志 |

SVG 是唯一可编辑源文件；PNG 只作为兼容导出。设计稿、草图和历史版本不属于生产资产，不得直接替代上述正式文件。

## 背景、留白与最小显示尺寸

- 浅色表面（白色或接近 `#eaf4ff` 的浅底）使用标准彩色版；深色表面（优先 `#10233e` 或更深）使用反白版。背景不确定或必须单色输出时使用 Mono 版。
- **留白规则**：以一个端点节点的直径作为 `X`。Mark 四周至少保留 `1X` 的空白；横向锁定版中，图标与字标之间至少保留 `1X`。留白区域不得放置文字、边框、状态徽标或其他图形。
- **最小显示尺寸**（显示尺寸，不是源文件尺寸声明）：完整锁定版宽度不小于 `180 CSS px`；Mark 高度不小于 `24 CSS px`。小于该阈值时只使用 Mark，并切换到对应的 favicon/PNG 兼容导出。
- 在 16px favicon 等极小尺寸下只保留方括号、脉冲和节点，不加入 `Heartbeat` 或副标题；不得通过缩放字标来挤入图标。

## 禁止事项

- 不得把尖锐 QRS 脉冲圆角化、改为平滑心电图、改变尖峰高度或重画方括号比例。
- 不得拉伸、压扁、倾斜、旋转、裁切或改变方括号、脉冲和节点的相对位置。
- 不得使用运行状态的绿、黄、红替换品牌蓝/浅青，也不得用颜色单独传达运行状态。
- 不得加入医疗心脏、心电监护、十字、闪电或其他会改变“受控服务信号”含义的图形。
- 不得添加未批准的渐变、阴影、外发光、描边、纹理或容器；不得从 v5 标记重新绘制一套比例不同的版本。
- 不得改写 `Heartbeat` 或副标题、替换字形、添加口号，也不得把标记放在低对比度或复杂图案背景上。

## 无障碍与交付检查

- SVG 必须保留可访问名称（`role="img"`、`title`/`desc` 或等效标签）；在界面中为图像提供有意义的 `alt`，例如“Heartbeat 标志”。装饰性重复图标使用空 `alt`，避免屏幕阅读器重复朗读。
- 文字与背景遵循 WCAG 2.1 AA 对比度要求（普通文字至少 4.5:1，大号文字至少 3:1）；不要只用蓝、绿、黄、红区分服务状态。
- 检查文件名是否使用小写 kebab-case，路径是否遵循 `heartbeat-{mark|logo}-{variant}` 与 `heartbeat-mark-{size}.png` 约定；Manifest 只引用正式套件文件。
- 发布前确认 SVG 自包含、不依赖外部脚本、图片、网络字体或运行时滤镜，并在浅色、深色、窄屏和 favicon 场景分别核对辨识度。
