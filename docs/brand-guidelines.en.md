# Heartbeat Brand Guidelines

## Brand idea

The Heartbeat “pulse node” mark combines two service nodes with a live pulse trace in an H-shaped form. It communicates local service orchestration (服务编排), connection, and moving status without assigning green, yellow, or red runtime colors to the brand itself.

Heartbeat blue is `#2789f4`; the supporting highlight is light cyan `#7dd3fc`. The locked wording (固定文案) is `Heartbeat`, with the subtitle `本地开发服务控制台 · Local Dev Service Control`.

## Asset set

- `client/public/brand/heartbeat-logo.svg`: full lockup (完整锁定版) for light backgrounds, including mark, name, and subtitle.
- `client/public/brand/heartbeat-logo-reversed.svg`: reversed (反白版) lockup for dark backgrounds.
- `client/public/brand/heartbeat-logo-monochrome.svg`: monochrome (单色版) lockup for print or one-color interfaces.
- `client/public/brand/heartbeat-mark.svg`: transparent primary mark; `heartbeat-mark-reversed.svg` and `heartbeat-mark-monochrome.svg` are its variants.
- `heartbeat-mark-16.png`, `heartbeat-mark-32.png`, `heartbeat-mark-180.png`, `heartbeat-mark-512.png`: transparent PNG compatibility exports (兼容导出) from the primary SVG mark.

SVG is the sole source (唯一源文件). PNG is reserved for favicon, desktop shortcut, and other contexts where SVG is inconvenient. Every SVG is self-contained (自包含): it references no external scripts, images, or web fonts (网络字体).

## Size and background

- The full lockup has a minimum width of 180px. Below that size, use the mark alone.
- The mark has a minimum display size of 16px. Use the 16px export for favicon（网站图标）, 32px for high-density browser icons（高密度浏览器图标）, and 180px/512px for shortcuts and install surfaces（安装入口）.
- Use the standard color version on light backgrounds (prefer white or `#f8fafc`); use the reversed version on dark backgrounds (prefer `#0b1220` or equivalent contrast).
- The monochrome version must keep one foreground color（前景色） and a transparent background; do not mix it with runtime status colors（运行时状态色）. Preserve readable contrast (可读对比度) against the surface（界面底色）.

## Do not

- Do not stretch, squash, skew, rotate, or change the relative positions of the nodes and pulse trace.
- Do not replace the blue palette with green, yellow, or red status colors. Do not add shadows, extra strokes, or glow effects beyond the supplied gradient.
- Do not rewrite `Heartbeat` or the subtitle in the lockup, substitute fonts, add graphics, or place the mark in an unapproved container shape.
- Do not place the mark directly over a busy photo, low-contrast surface, or patterned background; add clear space or use the reversed version when needed.
