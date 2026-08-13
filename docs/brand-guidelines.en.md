# Heartbeat v5 Brand Guidelines

## Brand position and symbol semantics

Heartbeat v5 is the formal brand kit for a local development service control console. The mark has three inseparable semantic elements:

- **Symmetrical square brackets (对称方括号)**: the controlled service boundary (受控服务边界). Keep both sides symmetrical; never turn them into round brackets or an arbitrary container.
- **Square-ended, sharp QRS pulse (方端尖角 QRS 脉冲)**: a real-time service signal (实时服务信号) and one controlled handoff (受控交接). The spike uses right angles, straight segments, and square ends for a precise technology feel; it is not a medical ECG or heart symbol.
- **Endpoint nodes (端点节点)**: connection points (连接点) between services. Nodes and pulse together mean “connect and pass a signal inside the boundary.”

The locked wording (锁定文案) is `Heartbeat`, with the subtitle `本地开发服务控制台 · Local Dev Service Control`. The [pulse-brackets-v5.svg](brand-drafts/round-3/pulse-brackets-v5.svg) board is a concept reference; the paths below are the formal v5 kit.

## Core colors

| Color | Value | Use |
| --- | --- | --- |
| Heartbeat blue | `#2789f4` | Primary pulse, brand emphasis, and primary interaction |
| Light cyan highlight | `#7dd3fc` | Pulse highlight, nodes, and emphasis on dark surfaces |
| Service navy | `#10233e` | Dark headers and the main background for reversed artwork |
| Frost text | `#eaf4ff` | Wordmark (字标) and supporting text on dark surfaces |

Green, yellow, and red are runtime status colors (运行状态色), not brand colors. They must not replace the blue palette above.

## Formal asset matrix

All paths below are relative to `client/public`; they define the filenames and usage boundary of the formal v5 kit.

| Category | Formal path | Use |
| --- | --- | --- |
| Mark (标记) | `/brand/heartbeat-mark.svg` | Transparent primary mark, header, and in-app navigation |
| Logo lockup (Logo 锁定版) | `/brand/heartbeat-logo.svg` | Mark + `Heartbeat` + subtitle on light surfaces |
| Reversed (反白版) | `/brand/heartbeat-mark-reversed.svg`, `/brand/heartbeat-logo-reversed.svg` | `#10233e` and other dark surfaces |
| Mono (单色版) | `/brand/heartbeat-mark-monochrome.svg`, `/brand/heartbeat-logo-monochrome.svg` | Print, engraving, one-color interfaces, or surfaces where color contrast cannot be guaranteed |
| Favicon (网站图标) | `/brand/heartbeat-mark-16.png` | Browser tabs and other tiny icon slots |
| PNG compatibility exports (兼容导出) | `/brand/heartbeat-mark-32.png`, `/brand/heartbeat-mark-180.png`, `/brand/heartbeat-mark-512.png` | High-density browser icons, shortcuts, and install surfaces |
| Web App Manifest (Web 应用清单) | `/site.webmanifest` | Web App icon and theme-color declaration; reference the formal PNGs instead of copying or redrawing the mark |

SVG is the sole editable source (唯一可编辑源文件); PNG is only a compatibility export. Boards, sketches, and historical versions are not production assets and must not replace the formal files above.

## Background, clear space, and minimum display size

- Use the standard color version on light surfaces (white or a surface close to `#eaf4ff`); use the reversed version on dark surfaces (prefer `#10233e` or darker). When the background is uncertain or output must be one color, use the Mono version.
- **Clear space (留白)**: define `X` as the diameter of one endpoint node. Keep at least `1X` of empty space around the Mark; in a horizontal lockup, keep at least `1X` between the mark and wordmark. No text, border, status badge, or other graphic may enter this space.
- **Minimum display size (最小显示尺寸)**—a display rule, not a source-file dimension claim: the full lockup must be at least `180 CSS px` wide; the Mark must be at least `24 CSS px` high. Below that threshold, use the Mark alone and switch to the matching favicon/PNG compatibility export.
- At 16px favicon scale and other tiny contexts, retain only the brackets, pulse, and nodes. Do not add `Heartbeat` or the subtitle; never squeeze the wordmark into the icon.

## Do not

- Do not round the sharp QRS pulse, turn it into a smooth ECG, change the spike height, or redraw the square-bracket proportions.
- Do not stretch, squash, skew, rotate, crop, or change the relative positions of brackets, pulse, and nodes.
- Do not replace the brand blue/light-cyan palette with runtime green, yellow, or red, and do not communicate runtime status by color alone.
- Do not add a medical heart, ECG monitor, cross, lightning bolt, or any other graphic that changes the meaning from a controlled service signal.
- Do not add unapproved gradients, shadows, outer glow, extra strokes, textures, or containers; do not redraw a second version with different v5 proportions.
- Do not rewrite `Heartbeat` or the subtitle, substitute the letterforms (字形), add a slogan, or place the mark on a low-contrast or busy patterned surface (复杂图案底图).

## Accessibility and delivery checks

- SVG must retain an accessible name (可访问名称) through `role="img"` plus `title`/`desc` or an equivalent label. Give interface images meaningful `alt` text, such as “Heartbeat mark.” Use empty `alt` for decorative repeats so screen readers (屏幕阅读器) do not announce the same mark twice.
- Meet WCAG 2.1 AA contrast requirements (对比度要求): at least 4.5:1 for normal text and 3:1 for large text; never rely only on blue, green, yellow, or red to distinguish service states.
- Check lowercase kebab-case filenames (短横线命名) and the `heartbeat-{mark|logo}-{variant}` plus `heartbeat-mark-{size}.png` naming patterns. The Manifest must reference only formal kit files.
- Before release, verify that SVG is self-contained (自包含) and has no external scripts, images, web fonts, or runtime filters (运行时滤镜). Check recognizability on light, dark, narrow-screen, and favicon surfaces.
