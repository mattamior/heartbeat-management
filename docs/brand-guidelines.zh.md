# Heartbeat 品牌使用说明

## 品牌概念

Heartbeat 的“脉冲节点”标记把两个服务节点与一条实时脉冲轨迹组合成 H 形。它表达本地服务编排、连接和状态流动，不把绿、黄、红等运行状态色固化到品牌标记中。

主色为 Heartbeat 蓝 `#2789f4`，辅助高光为浅青 `#7dd3fc`。锁定文案为 `Heartbeat`，副标题为 `本地开发服务控制台 · Local Dev Service Control`。

## 资源清单

- `client/public/brand/heartbeat-logo.svg`：浅色背景上的完整锁定版（标记、名称、副标题）。
- `client/public/brand/heartbeat-logo-reversed.svg`：深色背景上的反白锁定版。
- `client/public/brand/heartbeat-logo-monochrome.svg`：单色锁定版，适合印刷或单色界面。
- `client/public/brand/heartbeat-mark.svg`：透明背景的主图标；`heartbeat-mark-reversed.svg` 和 `heartbeat-mark-monochrome.svg` 为对应变体。
- `heartbeat-mark-16.png`、`heartbeat-mark-32.png`、`heartbeat-mark-180.png`、`heartbeat-mark-512.png`：由主图标 SVG 导出的透明 PNG 兼容尺寸。

SVG 是唯一源文件；PNG 仅用于 favicon、桌面快捷方式等不便直接使用 SVG 的位置。所有 SVG 均自包含，不引用外部脚本、图片或网络字体。

## 尺寸与背景

- 完整锁定版最小宽度为 180px；低于此尺寸只使用图标标记。
- 图标标记最小显示尺寸为 16px。16px 版本用于 favicon，32px 版本用于高密度浏览器图标，180px/512px 版本用于快捷方式和安装入口。
- 浅色背景（建议白色或 `#f8fafc`）使用标准彩色版；深色背景（建议 `#0b1220` 或同等对比度）使用反白版。
- 单色版应保持单一前景色与透明背景，不与运行状态色混用。确保标记与背景达到可读对比度。

## 禁用示例

- 不得拉伸、压扁、倾斜、旋转或改变图标节点与脉冲轨迹的相对位置。
- 不得替换蓝色为绿、黄、红等状态色，也不得给标记添加渐变以外的投影、描边或发光效果。
- 不得在锁定版中改写 `Heartbeat` 或副标题，不得替换字体、添加图形或把标记放入未经批准的容器形状。
- 不得在复杂照片、低对比度背景或带图案的底图上直接放置标记；必要时使用合适的留白或反白版。
