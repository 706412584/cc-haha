# 「纸 · 墨 · 印」重设计规范

本文是桌面端整体视觉重构的执行标准。配套阅读 [`desktop/src/components/AGENTS.md`](../src/components/AGENTS.md)（组件与 token 硬约束，冲突时以那份为准）。

## 唯一边界：只换皮，不动功能

- 允许改：`className`、内联展示样式、纯展示用的 DOM 结构、i18n 文案里的视觉措辞。
- **不允许改**：`stores/`、`api/`、`hooks/` 里的任何逻辑，事件处理、状态流转、数据契约、组件 props 语义。
- 设计稿里有、原项目没有的**功能**（例如零态的三个建议胶囊），**不新增**。
- 原项目有、设计稿没画的界面，**不删**，按同一套规则收敛。

判断口径：如果一处改动会让某个 `.test.tsx` 里的行为断言（点击、请求、状态）失败，那它就越界了；只有快照式的样式断言才应该跟着改。

## 设计主张

纸感暖底分层 + 墨色主按钮 + 衬线标题 + 陶土印章。层次靠**底色分层与 1px 细边框**建立，不靠重阴影。

## Token（已定稿，不要改 `theme/globals.css`）

六套主题（`white` 纯白 / `paper` 纸墨 / `warm-classic` 经典暖色 / `celadon` 青瓷 / `dark` 墨夜 / `ink-blue` 墨夜蓝）只换一组 `--cc-*` 源变量，`:root` 语义层把它们映射成 `--color-*`。**组件一律只用 `--color-*` / `--radius-*` / `--shadow-*` / `--z-*`，永远不要直接用 `--cc-*`。**

| 角色 | token |
|---|---|
| 页面底 | `--color-surface` / `--color-background` |
| 侧栏与次级面板底 | `--color-surface-container-low` |
| 悬停 / 选中 | `--color-surface-hover` / `--color-surface-selected` |
| 卡片内衬 | `--color-surface-container` |
| 常规边框 / 强边框 | `--color-border` / `--color-outline` |
| 主 / 次 / 弱文字 | `--color-text-primary` / `--color-text-secondary` / `--color-text-tertiary` |
| 陶土主色 / 深 / 浅底 / 描边 | `--color-brand` / `--color-brand-hover` / `--color-brand-soft` / `--color-primary-fixed-dim` |
| **陶土浅底上的文字** | `--color-on-brand-soft`（**不是** `--color-brand`，见下） |
| 状态色 | `--color-{success,warning,error,info}` + `-container` + `--color-on-*-container` |
| 主按钮墨色 | `--color-btn-primary-bg` / `--color-btn-primary-fg` |

**状态色成对使用。** `--color-<tone>` 是标识色（描边、图标、下划线）；`--color-on-<tone>-container` 才是 `-container` 底上的**文字**色。直接把 `--color-brand` 当 `--color-brand-soft` 上的文字，在两套墨色主题下只有 4.3:1，低于 AA。`contrast.test.ts` 会红。

### 圆角阶梯

`--radius-sm` 6（小徽章）/ `--radius-md` 10（按钮、输入）/ `--radius-lg` 13（卡片内件）/ `--radius-xl` 17（卡片）/ `--radius-2xl` 20（composer）/ `--radius-3xl` 24（模态）/ `--radius-full` 胶囊。

写 `rounded-[var(--radius-md)]`，**不要**写 `rounded-md`（Tailwind 的 `rounded-lg` 是 8px，`--radius-lg` 是 13px，同名不同值）。

### 阴影三级

`--shadow-card`（卡片静止）/ `--shadow-composer`（composer、卡片 hover 抬起）/ `--shadow-overlay`（浮层、下拉、模态）。

### 字体

- 标题走 `style={{ fontFamily: 'var(--font-headline)' }}`：所有 h1/h2/h3、页面大标题、统计大数字、弹层里的大号数值（上下文百分比、推理档位名）。中文会落到系统衬线，这是预期。
- 正文默认 `--font-body`，14px / 1.5。
- 代码、路径、快捷键、ID、耗时、token 数走 `--font-mono`（Tailwind `font-mono`）。
- 字号阶梯：11 / 12 / 12.5 / 13 / 13.5 / 14 / 14.5 / 15 / 16.5 / 21 / 24–28（衬线页标题）/ 32（详情页标题）。

## 组件规则

优先用 `components/ui/` 里的原语，别手写 `<button>`。表在 `components/AGENTS.md` 第一节。

已按设计稿改好、**直接复用**的：

- `Button` — `primary` 已是墨色实心 + hover 转陶土 + 上浮 1px + `active:scale(.97)`；禁用态是不透明的 `--s1`/`--t3`。
- `Card` — 新增 `shadow`（`none`/`card`/`composer`）与 `lift`（hover 抬起 2px）两个 prop，以及 `radius="2xl"`。**`lift` 与 `shadow` 不要同时传**，两个 `shadow-[…]` 不会叠加。
- `IconButton` / `Badge` / `Modal`（圆角已是 24）/ `SegmentedControl` / `Switch` / `Progress` — 都已走 token，跟随主题。
- `composite/BrandSeal` — 品牌标记 cc-haha（原 app-icon 的矢量重建），`sm`24 / `md`32 / `lg`38 / `xl`80，随尺寸减件（星芒只在 `xl`，光标到 `sm` 去掉）。

焦点态统一：`focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]`。

### 动效

- 按钮 `transition-[background-color,color,border-color,box-shadow,transform] duration-150 ease-out`。
- 卡片 hover 抬起用 `Card` 的 `lift`。
- 屏幕入场用 `.animate-screen-pop`。
- 已有 `.animate-spin`（.9s）、`.animate-pulse-dot`（1.6s）、`.animate-overlay-in*`。
- 任何位移动效都要配 `motion-reduce:` 兜底。

## 常见形态

- **页头**：衬线 24–28px 标题 + 次级说明行 + 右侧墨色主按钮。
- **统计卡**：`Card` + 衬线大数字（21–26px）+ 12px `--color-text-tertiary` 标签。
- **列表行**：状态点 + 主标题 + 12.5px 次级信息 + 右侧 mono 指标；hover 出 `--color-surface-hover`。
- **chip / 胶囊**：`rounded-full`，1px `--color-border`，hover 转 `--color-outline`；激活态 `--color-brand-soft` 底 + `--color-on-brand-soft` 字 + `--color-primary-fixed-dim` 描边。
- **警示条**：`--color-{warning,error}-container` 底 + `--color-on-*-container` 字 + 同色描边。
- **磨砂浮层**：`glass-panel` 类（已含 blur 18px + `--shadow-overlay`）。
- **代码块**：`--color-code-bg` 底 + `font-mono` 13px/1.7 + 头部带 Copy。

## 硬约束（会让 CI 红）

- 不用 Tailwind 原色（`bg-amber-50`、`text-red-400`…）—— 它们不跟随 `data-theme`。`paletteEscapes.test.ts` 拦截。
- 不用 `/N` alpha 修饰符（`bg-[var(--x)]/10`）—— Safari 15 WebView 解析不了。需要浅底就用现成的 `-soft` / `-container` token。
- 不写裸 `zIndex: 9999` 或 `z-[10000]`，层级只能来自 `--z-*`。
- 不写硬编码 hex。
- 所有用户可见文案（含 `aria-label`、`title`）走 `useTranslation()`，五种语言（`zh` / `zh-TW` / `en` / `jp` / `kr`）都要加。
- 图标按钮必须有名字（用 `IconButton`，`label` 必填）。
- 会被浮层锚定的组件必须 `forwardRef`。

## 参考原型

`/Users/nanmi/Downloads/design_handoff_cc_haha_redesign/` 下的 `CC Haha.dc.html` 是高保真交互原型，README.md 是像素级规格。原型用浏览器直接打开可交互。
