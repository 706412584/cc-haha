# 桌面端组件库：抽取与迁移计划

本文是 [`desktop/src/components/AGENTS.md`](../src/components/AGENTS.md) 的配套执行文档，记录审计证据、待抽组件的 API 草稿和分批落地顺序。

审计范围：`desktop/src/**`（492 个 ts/tsx，其中 tsx 235 个）。方法：5 个并行只读 agent 分域扫描（设计 token / 交互原语 / 浮层 / 数据展示 / 共享层与工程约束），结论经主控 agent 抽样复核。

> **执行状态（2026-07-26）**：阶段 0–8 已全部落地，`shared/` 与 `common/` 已删除。
> 落地过程中对本文的偏离与新发现记录在 [附录二](#附二实施记录与对本文的偏离)。**改动清单以那一节为准，本文正文保留为当时的审计快照。**

---

## 一、现状：问题不是"开发者偷懒"

### 1.1 量化

| 指标 | 数值 |
|---|---|
| `components/` 下组件 / 测试文件 | 117 / 67 |
| 原生 `<button>` / `<Button>` 实例 | **362**(非测试) / 102 → 复用率 **22%** |
| 完全不知道 `shared/Button` 存在的文件 | **80** |
| 同一文件里两套写法混用 | 13 |
| 原生 input / textarea / select | 56 / 13 / 7 |
| 手撸浮层（弹窗/抽屉/下拉/右键菜单/popover/tooltip） | **31** |
| 手写 outside-click 逻辑 | **21 处** |
| 手写空态 | **22 处**（24 个 `border-dashed` 壳，横跨 15 文件） |
| 手写骨架屏 | 6 个块 / 15 处 |
| pill 徽章 / 状态点 | 45 / 41 |
| 卡片容器组合（前 7 名合计） | **115 处** |
| `[var(--x)]` 桥接 vs `@theme` 裸 utility | **4874 / 8** |
| 按钮 focus 写法 / disabled 写法 | **32 种 / 19 种** |
| 按钮高度 / 圆角 / 字号档位 | **18 / 21 / 21 种** |
| z-index 取值 / z token | **17 种 / 0** |

### 1.2 根因：没有索引，不是没有能力

三个铁证，都是**同一份代码被复制而作者显然不知道已有实现**：

1. **`shared/Button.tsx:56-63` 自己私有实现了一个 `Spinner`，SVG path 与相邻的 `shared/Spinner.tsx` 逐字符相同**（`M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z`）。而 `shared/Spinner.tsx` 被 **0 个文件**导入，是纯死代码 —— 连 shared 目录内部、相邻两个文件之间都在复制粘贴。

2. **`chat/ChatInput.tsx:408-466` 与 `pages/EmptySession.tsx:140-198` 是 59 行逐字节相同的复制**（`diff` 输出为空），四个 outside-click effect 一模一样。

3. **`chat/SessionTaskBar.tsx:65-76` 与 `teams/TeamStatusBar.tsx:62-71` 的进度条连 `{/* Progress bar */}` 注释都一样**，只有三元里的变量名不同。

再加上目录学证据：`shared/` 和 `controls/` 是**同一个 commit**（`993b96cd`, 2026-04-06）建的，隐含规则从未写下；`common/`（2026-05-29）的 commit message 一行，没解释为何新开目录 —— 而 shared/common 本就是同义词。

> **结论**：`desktop/AGENTS.md` 里那句 "Reuse the existing desktop design system" 对人和 AI 都是不可执行指令 —— 它没说去哪查、查到什么算数。这就是本次要补的东西。

### 1.3 现有共享层复用率

| 组件 | 生产调用方 | 行数 | 耦合 | 判定 |
|---|---:|---:|---|---|
| `shared/Button` | 23 | 63 | 纯 UI | 真·公共 |
| `shared/ConfirmDialog` | 13 | 49 | 纯 UI | 真·公共 |
| `shared/Modal` | 10 | 119 | 纯 UI | 真·公共 |
| `shared/CopyButton` | 8 | 61 | 纯 UI\* | 真·公共 |
| `shared/Input` | 7 | 38 | 纯 UI | 真·公共 |
| `shared/MobileBottomSheet` | 5 | 94 | 纯 UI | 真·公共 |
| `shared/DirectoryPicker` | 5 | 363 | api×2 | **业务件** |
| `shared/ActionDialog` | 4 | 66 | 纯 UI | 真·公共 |
| `shared/Dropdown` | 4 | 103 | 纯 UI | 真·公共 |
| `controls/ModelSelector` | 3 | 658 | store×7 | **业务件** |
| `controls/PermissionModeSelector` | 3 | 418 | store×5 | **业务件** |
| `shared/RepositoryLaunchControls` | 2 | 664 | api | **伪公共** |
| `controls/ReasoningEffortPopover` | **1** | 214 | 纯 UI | **伪公共**（唯一调用方是同目录 ModelSelector） |
| `controls/AutoModeOptInDialog` | **1** | 47 | — | **伪公共** |
| `shared/ConfirmPopover` | **1** | 33 | 纯 UI | **伪公共** |
| `shared/ProjectContextChip` | **1** | 71 | — | **伪公共** |
| `shared/Toast` | **1** | 54 | store | 应用单例 |
| `shared/UpdateChecker` | **1** | 74 | store | 应用单例 |
| `shared/Spinner` | **0** | 30 | 纯 UI | **死代码** |

23 个"公共"组件里，真·公共只有 8 个；单调用方的伪公共占 35%。

\* `CopyButton` 反向 import 了 `../chat/clipboard`，是 4 处层级倒挂之一。

---

## 二、可以立刻修的缺陷

审计顺带发现的、与抽取解耦的问题。**建议先修这批**：改动小、风险低，且能验证提交流程。

### P0 —— 影响用户可见行为

| # | 问题 | 位置 | 证据 |
|---|---|---|---|
| 1 | **`dark:` 变体绑到了操作系统而非应用主题**。`globals.css` 无 `@custom-variant dark`、无 `prefers-color-scheme`，13 处 `dark:` 全是坏的。系统浅色 + 应用 dark 时，流式重试提示条会炸出近白色块 | `chat/StreamingIndicator.tsx:68,70,72,75,78,84`、`features/pets/PetApp.tsx:600` | 已验证：`@custom-variant` 0 处、`prefers-color-scheme` 0 处、`dark:` 13 处 |
| 2 | **6 个 token 被引用但从未定义**，导致边框回落 `currentColor`、暗色下焦点环外圈变白、面板背景透明 | `--color-bg-secondary`(3处) `--color-bg-primary` `--color-bg` `--color-surface-secondary` `--color-border-strong` `--color-on-primary-container` | 已验证：定义 0 处、tsx 引用 1–3 处 |
| 3 | **Toast 被 BottomSheet 完全遮住**（z 100 vs 10000）→ H5 上在 sheet 里操作，结果反馈用户看不到 | `shared/Toast.tsx:48` vs `shared/MobileBottomSheet.tsx:49` | z 值直读 |
| 4 | **portal 下拉盖过 Modal 遮罩**（内联 9999 vs z-50）。`DirectoryPicker` 被 `AgentManager` 在 Modal 内使用 | `shared/DirectoryPicker.tsx:178`、`RepositoryLaunchControls.tsx:306,314,325,333` | z 值直读 |
| 5 | **浮层进场动画全部失效**。`animate-in slide-in-from-right fade-in` 是 `tailwindcss-animate` 的类，该依赖已在 shadcn 回滚时删除，`globals.css` 也没定义 | `shared/Toast.tsx:25`、`shared/Dropdown.tsx:69,72` | 已验证：package.json 无该依赖、globals.css 无定义 |
| 6 | **MCP 状态徽章配色两份副本已漂移**，`toneForStatus` 缺 `checking` 分支 → 同一个 server 在设置页有徽章、在 slash 面板里渲染成裸文字 | `pages/McpSettings.tsx:71-77` vs `chat/LocalSlashCommandPanel.tsx:32-44` | — |
| 7 | **内嵌终端硬锁暗色**。20 个 hex 写死，而三主题的终端 token 齐备却被完全绕过 → white 主题下嵌一块纯黑终端 | `pages/TerminalSettings.tsx:229-249`（token 在 `globals.css:577-584/786-793/988-995`） | — |

### P1 —— 一致性与死代码

| # | 问题 | 位置 |
|---|---|---|
| 8 | `pages/NewTaskModal.tsx` **整文件零引用死代码**（真正在用的是 `components/tasks/NewTaskModal.tsx`），且是废弃 token `--color-primary` 的最大残留方（9/29 处）。**抽取前应删除**，否则会把废弃 token 带进新组件 | 已验证零 import |
| 9 | 状态点误用 `animate-pulse`(2s) 而非 `animate-pulse-dot`(1.5s)，与其余 13 处不同频呼吸 | `layout/TabBar.tsx:610`、`chat/SessionTaskBar.tsx:143` |
| 10 | 不确定态进度条用 `animate-pulse` 假装，而 `globals.css:1487-1506` 已有正确实现没人用 | `pages/Settings.tsx:4241` |
| 11 | `content-visibility` 写成内联 style，绕过了针对触屏 H5 的关闭覆盖（iOS 长按选词会乱跳）；且 `'212px'` 少了 `auto` 关键字 | `market/SkillCard.tsx:35` |
| 12 | 硬编码 DOM id 在两处渲染 → 重复 id，`aria-controls` 指向不确定 | `controls/PermissionModeSelector.tsx:129` 渲染于 `:176` 和 `:291` |
| 13 | 4 个死 class，其中 `.pet-status-pulse` 引用了根本不存在的 keyframe | `globals.css:1073, 1121, 2056, 2074` |
| 14 | 4 处层级倒挂，最严重是复用率第 4 的基础件反向依赖功能目录 | `shared/CopyButton.tsx:2` → `../chat/clipboard`（修法：`chat/clipboard.ts` 移到 `lib/clipboard.ts`） |
| 15 | 硬编码文案：`Modal.tsx:98` `aria-label="Close dialog"` 无覆盖口、`ReasoningEffortPopover.tsx:35` 默认 `'推理强度'`、`AttachmentGallery.tsx:193` `'修改内容'` | — |
| 16 | 10 个 icon-only 按钮对屏幕阅读器完全无名，含全局 chrome | `layout/TitleBar.tsx:62`(设置入口)、`layout/TabBar.tsx:404,483`(标签滚动)、`tasks/TaskRow.tsx:135`、`tasks/TaskRunsPanel.tsx:232`、`chat/LocalSlashCommandPanel.tsx:84`、`pages/TerminalSettings.tsx:848`、`pages/AgentTeams.tsx:156,175` |

### 待验证（未下结论）

- **Tailwind 冲突类的实际胜负**：84 处 `<Button className=>` 中已出现 `size="sm"`(px-2) 与 `px-0`/`px-3` 直接冲突。确定的是 class 属性顺序不决定层叠；具体谁胜出需 `bun run build` 后比对生成 CSS 中两条规则的偏移量。
- **`color-mix` 的 WebKit 下限**：`globals.test.ts:118` 固化了"启动关键路径不得含 color-mix"（Safari 15 WebView），但 Tailwind v4 把 `bg-[var(--x)]/40` 编译成 `color-mix`，全库有 **422 处**这类暴露面。抽库前需确认 Tauri 壳的实际最低 WebKit 版本（`color-mix` 需 Safari 16.2+）。若 Safari 15 仍在矩阵内，组件库内部不能用 `/N` alpha 修饰符。

---

## 三、抽取清单

排序依据：重复次数 × 单处代码量 × 视觉不一致度 × 行为风险。

### 第 1 批：纯样式，零行为风险

#### 1. `Spinner`（复活现有死代码）

覆盖 17 处手撸 border 转圈 + `Button.tsx:56` 私有副本。最小改动、最高确定性，适合用来验证整个流程。

```ts
export type SpinnerProps = {
  size?: number                  // 默认 16
  tone?: 'brand' | 'current'     // 覆盖现存两种方言
  respectReducedMotion?: boolean // 默认 true
  className?: string
}
```

现存两种方言：brand + `border-2`（11 处）与 `currentColor`（6 处）。`chat/ContextUsageIndicator.tsx:276` 是唯一尊重 `motion-safe:` 的，抽取时把它变成默认。

#### 2. `IconButton`（新建）

**数量最大的一类**：76 个严格 icon-only 按钮，跨 40 文件，15 种圆角 × 12 种尺寸，focus ring 仅 41% 覆盖，10 个无障碍名称缺失。

```ts
export type IconButtonProps =
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> & {
    icon: ReactNode | string       // lucide 组件、material 图标名，或任意 ReactNode
    label: string                  // 必填：icon-only 无可见文本，无障碍名不可省
    showTooltip?: boolean          // 默认 true，同时写入 title
    size?: 'xs' | 'sm' | 'md' | 'lg'   // h-6/h-7/h-8/h-9，各配等宽
    tone?: 'default' | 'muted' | 'danger' | 'brand'
    shape?: 'square' | 'circle'
    loading?: boolean
    className?: string
  }
```

内部固定：`type="button"`、`aria-label={label}`、统一 focus ring、统一 disabled。

> 同为 h-7 方形图标按钮，现在有三种写法：`Sidebar.tsx:1005`(rounded-lg + border-focus ring)、`WorkbenchPanel.tsx:119`(rounded-[7px] + info/30 ring)、`ChatInput.tsx:1193`(rounded-[6px] + 无 ring)。

#### 3. 强化 `Button`（就地扩 API，不新建）

78% 的按钮绕开它是有原因的 —— 缺 focus 环、缺 icon-only 模式、三个尺寸档**都没有 `h-*`**（这是全库 18 种高度泛滥的直接诱因）、`type` 未默认为 `button`、缺 `tonal`/`link` 变体。

```ts
export type ButtonVariant =
  | 'primary'         // 收敛到 gradient-btn-primary（现存 5 套配方的胜出者）
  | 'secondary'
  | 'tonal'           // 新增：现存 27 处无处安放
  | 'ghost'
  | 'danger'          // 实心
  | 'danger-outline'  // 新增：现存 17 个 danger 里 11 个是描边派
  | 'link'            // 新增：纯文字 + hover:underline

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: 'xs' | 'sm' | 'md' | 'lg'   // 每档绑定固定 h-*，终结 18 种高度
  loading?: boolean
  icon?: ReactNode
  iconPosition?: 'start' | 'end'     // 新增：下拉箭头场景
  block?: boolean                    // 新增：替代散落的 w-full
  className?: string
}
```

配套修 4 条：基类补 focus ring；`type` 默认 `'button'`；`loading` 时补 `aria-busy`；删掉内部私有 Spinner 改用 `shared/Spinner`。

> **最刺眼的证据**：`pages/Settings.tsx:2623`（主题选择器）与 `:2643`（语言选择器）是相邻两个控件，外层 className **逐字符相同**，只有 active 填色不同 —— 一个用渐变+阴影，一个用扁平 brand 填色。用户能直接看出来。

#### 4. `Badge` + `StatusDot`

覆盖 45 处 pill 徽章 + 41 处状态点。纯展示无状态，可逐文件分批合入。

```ts
export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info'

export type BadgeProps = {
  tone?: BadgeTone
  variant?: 'soft' | 'outline' | 'solid'   // soft = 有底无边（默认）
  size?: 'xs' | 'sm'                       // xs = text-[10px] px-2 py-0.5（覆盖 27/45）
  pill?: boolean                           // false → radius-sm，用于计数徽章
  icon?: ReactNode
  mono?: boolean                           // 版本号/路径
  className?: string
  children: ReactNode
}

export type StatusDotProps = {
  tone: BadgeTone
  size?: 'sm' | 'md' | 'lg'   // sm = 1.5（覆盖 23/41）
  pulse?: boolean             // 统一走 animate-pulse-dot
  className?: string
}
```

> `market/InstallStateBadge.tsx:27-39` 与 `market/SecurityBadge.tsx:25-37` 的 shell **逐字符相同**，只有映射表不同 —— 抽完这两个文件各自只剩一张映射表。
> 顺带修 P0#6（MCP tone 漂移）与 P1#9（两处 pulse 误用）。

#### 5. `Checkbox` / `Switch`

Checkbox 20 实例 5 套写法（3 种尺寸、2 种 accent token、外加一套 `globals.css:162` 的隐藏 input + peer 自绘机制），连类名书写顺序都不统一（`w-4 h-4` vs `h-4 w-4`）。

Switch 只有 3 个实例，但**不一致率 100%**（3 套实现，尺寸差 27%：56×32 vs 44×24），且新功能会继续复制。

```ts
export type SwitchProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string                 // 必填，无可见文案时作 aria-label
  labelHidden?: boolean
  description?: ReactNode
  disabled?: boolean
  size?: 'sm' | 'md'            // 采用 PetSettings 比例，弃用 h-8 w-14
  as?: 'switch' | 'checkbox'    // 语义按钮 vs 原生 input
}
```

统一走已存在的 `--color-switch-checked-bg` / `--color-switch-thumb` token。

### 第 2 批：含行为，逐个走查

#### 6. `EmptyState` / `ErrorState` / `LoadingState`

覆盖 22 + 12 + 19 处，同时**删掉 5 个同名局部定义**。

现状最严重的一处：项目里有 **3 个叫 `EmptyState`、2 个叫 `LoadingState` 的局部组件，跨文件导入 0 次**，且两个 `EmptyState` 的 props 互不兼容（`{icon, text}` vs `{title, body}`）。

```ts
export type StateSize = 'sm' | 'md' | 'lg'

export type EmptyStateProps = {
  icon?: ReactNode
  title?: string                 // 渲染为 <h3>，可用 headingLevel 覆盖
  description?: string
  action?: { label: string; onClick: () => void; variant?: 'primary' | 'secondary' }
  size?: StateSize
  variant?: 'dashed' | 'plain' | 'inline'
  headingLevel?: 2 | 3 | 4
  className?: string
}

export type ErrorStateProps = {
  title: string
  detail?: string
  onRetry?: () => void
  retryLabel?: string
  size?: StateSize
  tone?: 'soft' | 'strong'       // 把 20 种错误底色收敛到 2 档
  className?: string
}
```

不一致现状：图标系统三并存（lucide / material-symbols / 内联 svg）、图标尺寸 9 种、标题标签 4 种（只有 2 处有真标题标签，其余对屏幕阅读器就是普通段落）、圆角 5 种、padding 8 种、**24 个空态只有 1 个带行动按钮**。

错误态的 alpha 完全失控：背景 5 档 + 边框 7 档 + container 8 档 = **20 种错误底色**。

#### 7. `SearchField` / `TextField` / `TextArea` / `SelectField`

输入类控件是全库无障碍最差的一块：76 个 input/textarea/select 中 `focus-visible:` **使用 0 次**、`disabled:` 样式 **0 处**、`aria-invalid` 仅 1 处、13 个 textarea **全部无 id**、7 个 select **全部无 aria-label**。**3 处焦点完全不可见**（`trace/TraceTree.tsx:86`、`shared/RepositoryLaunchControls.tsx:437,506`、`search/GlobalSearchModal.tsx:229`）。

搜索框有 **11 个独立实现、2 种结构、7 种 focus 反馈**。

```ts
export type SearchFieldProps =
  Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type' | 'value' | 'onChange'> & {
    value: string
    onChange: (value: string) => void
    label: string                 // 必填，搜索框通常无可见 label
    showLabel?: boolean
    size?: 'sm' | 'md' | 'lg'
    clearable?: boolean
    onClear?: () => void
    icon?: ReactNode
    containerClassName?: string
    onNavigate?: (direction: 'up' | 'down') => void   // 上下键导航到结果
    controlsId?: string
    activeDescendantId?: string                       // combobox
  }
```

`TextField`/`TextArea` 必须补齐现有 `Input.tsx` 全缺的：`aria-invalid={!!error}`、`aria-describedby` 指向 hint/error（用 `useId()` 生成，顺带修掉现在按 label 文本派生 id 的中文碰撞风险）、error 节点 `role="alert"`、`disabled:` 样式。

#### 8. `SegmentedControl` / `Tabs`

10 处实现、**6 种激活态视觉**（渐变填充 / 扁平填充 / 边框+浅底 / 白底浮起 / 下边框 / 纯色差），单 `pages/Settings.tsx` 内部就有 5 种。4 处 `role="tab"` **全都没有 `role="tablist"` 父容器**，也没有左右方向键。

```ts
export type SegmentedControlProps<T extends string> = {
  items: Array<{ value: T; label: ReactNode; description?: ReactNode; icon?: ReactNode; disabled?: boolean }>
  value: T
  onChange: (value: T) => void
  label: string                                     // 必填，挂在容器上
  appearance?: 'solid' | 'raised' | 'underline'
  size?: 'sm' | 'md'
  layout?: 'fill' | 'auto' | number
  as?: 'radiogroup' | 'tablist'                     // 单选组 vs 视图切换
}
```

#### 9. `Skeleton` 族

覆盖 6 个手撸骨架块 / 15 处。需先定 pulse 打容器还是叶子（**建议容器级**，但注意容器级会让 border 一起呼吸，两种现状视觉不同）。

```ts
export function Skeleton(props: {
  shape?: 'line' | 'block' | 'circle' | 'avatar'
  width?: string; height?: string
  radius?: 'sm' | 'md' | 'lg' | 'full'
  tone?: 'base' | 'strong'      // 把现存 4 种占位底色收敛到 2 种
  className?: string
}): JSX.Element

/** 唯一持有 animate-pulse 的地方，并统一挂 role/aria-busy */
export function SkeletonGroup(props: { label: string; className?: string; children: ReactNode }): JSX.Element
export function SkeletonRows(props: { count: number; rowHeight?: string; lines?: number; divided?: boolean }): JSX.Element
export function SkeletonCards(props: { count: number; minHeight?: string; withAvatar?: boolean }): JSX.Element
```

#### 10. `Card` / `Panel`

覆盖 115 处。**建议只在新代码和顺手重构时用，不做全局批量替换。**

抽 `Card` 的真正价值不是省代码，而是**给圆角 token 收敛提供渐进路径**：现在硬编码 Tailwind 刻度（433 次）是设计 token（184 次）的 2.35 倍，且 `rounded-lg` 与 `rounded-[var(--radius-lg)]` 同名不同值（8px vs 12px）。调用方改成 `<Card radius="md">` 后，433 处硬编码就有了收敛出口，不需要危险的全局替换。

```ts
export type CardProps = {
  radius?: 'sm' | 'md' | 'lg' | 'xl'
  surface?: 'base' | 'low' | 'lowest' | 'high' | 'inspector'
  border?: 'solid' | 'dashed' | 'none'
  padding?: 'none' | 'sm' | 'md' | 'lg'
  interactive?: boolean          // hover 边框高亮 + focus ring
  as?: 'div' | 'section' | 'article'
  className?: string
  children: ReactNode
}
```

#### 11. `Progress`

```ts
export type ProgressProps = {
  value?: number
  indeterminate?: boolean        // 走 globals.css:1487 已有实现
  size?: 'xs' | 'sm' | 'md'
  tone?: BadgeTone | 'auto'      // 'auto' = 满 100% 转 success
  label: string                  // 必填，挂 role="progressbar" + aria-valuenow
  className?: string
}
```

现状只有 `browser/BrowserAddressBar.tsx:48` 有 `role="progressbar"`。抽取后 `chat/SessionTaskBar.tsx:65-76` 与 `teams/TeamStatusBar.tsx:62-71` 那份复制粘贴一次消掉。

### 第 3 批：风险最高，单独 PR + 真机走查

#### 12. 两个 hook 先行

```ts
// hooks/useDismissable.ts —— 消灭 21 处手写 outside-click
export type DismissReason = 'outside' | 'escape' | 'scroll' | 'resize' | 'blur'
export function useDismissable(options: {
  open: boolean
  refs: ReadonlyArray<{ current: HTMLElement | null }>
  triggerRef?: { current: HTMLElement | null }   // 点它时不派发 outside，避免"关了立刻又开"
  onDismiss: (reason: DismissReason) => void
  event?: 'pointerdown' | 'mousedown' | 'click'  // 默认 pointerdown
  capture?: boolean                              // 默认 true，保证嵌套浮层内层先关
  closeOnEscape?: boolean                        // 默认 true
  closeOnScroll?: boolean
  isExempt?: (target: EventTarget | null) => boolean
}): void

// hooks/useAnchoredPosition.ts —— 合并 4 份独立的视口计算
export function useAnchoredPosition(o: {
  open: boolean
  anchorRef: { current: HTMLElement | null }
  floatingRef: { current: HTMLElement | null }
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'left-start' | 'right-start'
  offset?: number
  viewportMargin?: number
  flip?: boolean; shift?: boolean; track?: boolean
}): { style: CSSProperties; placement: string; ready: boolean }
```

> **实现直接移植 `common/OpenWithMenu.tsx:36-75`**（测量翻转 + 夹取 + 排除 trigger + Esc + scroll 关闭），它是全项目最完整的浮层行为实现。**不需要 floating-ui。**
>
> 事件类型很关键：现状 `mousedown`(14) / `click`(3) / `pointerdown`(3)。**触屏上 `mousedown` 不可靠，这是 H5 上"点外面菜单不关"的根因类别** —— 统一到 `pointerdown`。

#### 13. `Menu` / `Popover` / `Tooltip` / `Dialog`

Tooltip 优先（5 处实现、5 种写法、4 种 z 值、3 种触发机制，纯展示、风险最低）。

Menu 覆盖 28 处手撸下拉 + 71 个菜单项（29 种内距配方，其中 20 组只出现 1 次）。现状：仅 4 处 a11y 合格、11 处无 Esc、13 处无外部点击关闭、仅 6 处有方向键、**仅 1 处关闭后归还焦点**、**没有任何一处在打开时把焦点移入菜单**。

Dialog 不是"合并三个重复实现" —— `Modal → ActionDialog → ConfirmDialog` 是干净的三层单向包装，没有重复。真正要补的是：

- `dismissible` 开关（现在 4 处各自 hack `onClose={busy ? () => {} : onClose}`）
- ConfirmDialog 的 `confirmLabel`/`cancelLabel` 给 i18n 默认值（13 处每处都在写 `t('common.cancel')`）
- **`mobileVariant='auto'`**：让 Dialog 按视口自动切 BottomSheet 形态，消灭 4 处 `useMobileViewport() && !isDesktopRuntime()` 的三元分叉

#### 14. z-index token

```css
@theme {
  --z-base: 0;      --z-raised: 10;   --z-sticky: 20;   --z-nav: 30;
  --z-scrim: 40;    --z-drawer: 50;   --z-dropdown: 60; --z-popover: 70;
  --z-dialog: 80;   --z-sheet: 80;    --z-toast: 90;    --z-tooltip: 100;
}
```

`--z-toast` 必须高于 `--z-sheet`，这是修 P0#3 的关键。迁移映射：`z-50`(20 处) 按语义拆到 dialog/dropdown/popover；内联 9999(5 处) 和 1000 → dropdown；`z-[10000]`(2 处) → sheet/dialog；5 处 tooltip 的 20/30/40/50 → tooltip。

### 明确不抽

| 组件 | 理由 |
|---|---|
| `Table` | 全库 **0 个 `<table>`**，表格状数据全用 CSS Grid。硬造会重演 `Spinner.tsx` 的死代码教训 |
| `Divider` | 只 9 处，`divide-y` 已够用，包组件反增 DOM |
| `Avatar` | `market/SkillAvatar.tsx` 已抽且仅 2 个调用点；`ActivitySettings` 的是不同语义（用户头像走上传 API） |
| 虚拟滚动库 | 当前 CV + 手写窗口化经 WebKit 实测（最差帧 279ms→18ms），引库会破坏"虚拟化项禁用 CV"的不变量 |
| 任何 UI 依赖 | 2026-07-25 刚回滚过 shadcn/ui（`e9b53f68`） |
| barrel `index.ts` | 项目零先例；`chunkSizeWarningLimit` 已提到 2200，barrel 阻碍 tree-shaking |

---

## 四、目录重组

### 目标结构

```
components/ui/         无业务语义原语。禁止 import stores/ 和 api/
components/composite/  业务复合件。可 import stores/api，但需 ≥2 调用方
components/<feature>/  功能目录。单调用方组件一律回归此处
```

### 迁移批次

**批次 1 — 零风险（无调用方变更）**
- 删 `shared/Spinner.tsx`（0 调用方）或按第 1 批复活它
- 删 `pages/NewTaskModal.tsx`（0 调用方死代码）
- `components/chat/clipboard.ts` → `lib/clipboard.ts`（解开层级倒挂，改 1 处 import）

**批次 2 — 私有子组件回归（各改 1 处 import）**

| 从 | 到 | 唯一调用方 |
|---|---|---|
| `controls/ReasoningEffortPopover.tsx` | 随 ModelSelector 或标记为内部 | `controls/ModelSelector.tsx` |
| `controls/AutoModeOptInDialog.tsx` | 同上 | `controls/PermissionModeSelector.tsx` |
| `shared/ConfirmPopover.tsx` | `components/tasks/` | `components/tasks/TaskRow.tsx` |

**批次 3 — 建立 `ui/`（纯移动，影响 74 处 import）**

`Button` `ConfirmDialog` `Modal` `CopyButton` `Input` `MobileBottomSheet` `ActionDialog` `Dropdown` → `components/ui/`

> **与别名迁移合并做** —— 反正都要改这 74 行，一步到位改成 `@/components/ui/Button`，避免二次触碰。

**批次 4 — 业务件出 shared**

| 从 | 到 | 调用方 |
|---|---|---:|
| `shared/Toast.tsx` | `components/layout/` | 1 |
| `shared/UpdateChecker.tsx` | `components/layout/` | 1 |
| `shared/ProjectContextChip.tsx` | `components/session/` | 1 |
| `shared/RepositoryLaunchControls.tsx` | `components/session/` | 2 |
| `shared/DirectoryPicker.tsx` | `components/composite/` | 5 |
| `common/OpenWithMenu.tsx` + `common/TargetIcon.tsx` | `components/composite/` | 3 + 3 |

**批次 5** — `shared/`、`common/` 清空后删除；`controls/` 保留（届时名副其实）。不动 `workbench/`、`hooks/`、`lib/`。

### 机器化守门（建议）

`theme/globals.test.ts` 已经开了"用测试守护约定"的先例。照抄加一个 `components/ui/layering.test.ts`：读 `ui/` 下所有源码，断言不含 `from '../../stores/` 和 `from '../../api/`。约 20 行，把"`ui/` 不得耦合业务"从文档约定变成 CI 红线 —— 比任何文档措辞都更能保证人和 AI 都遵守。

---

## 五、落地节奏

每步独立 PR，带单元测试（props 矩阵 + 被替换位置的行为回归）。

| 阶段 | 内容 | 风险 |
|---|---|---|
| 0 | 修 P0 缺陷（`@custom-variant dark` 一行、补 6 个幽灵 token、z 层级倒挂、删两个死文件） | 极低，纯 CSS + 删文件 |
| 1 | `Spinner` 复活 + `IconButton` + 强化 `Button` | 低，纯样式 |
| 2 | `Badge`/`StatusDot` + `Checkbox`/`Switch` | 低 |
| 3 | 三个 State 组件（顺带删 5 个同名局部定义） | 中低 |
| 4 | 目录批次 1–3 + `@/` 别名 | 中（影响 74 处 import，但纯机械） |
| 5 | 输入控件族 + `SegmentedControl` | 中，需逐个走查 |
| 6 | `useDismissable` + `useAnchoredPosition`（先替换那 59 行重复验证） | 中，可单测 |
| 7 | `Tooltip` → `Menu` → `Dialog` + z token | 高，需真机走查 |
| 8 | `Skeleton` / `Card` / `Progress`（只用于新代码，不批量替换） | 低 |

阶段 0 和 1 建议先做完并合入，让"有组件库可用"这件事尽快对后续开发生效 —— 否则新功能会继续按旧方式复制粘贴，债务增长快于偿还。

---

## 附：审计方法与可信度

5 个只读 agent 分域并行扫描，主控 agent 对关键结论做了独立复核。已复核成立的：`@custom-variant` 缺失、6 个幽灵 token、`animate-in` 死类、59 行逐字节重复、`pages/NewTaskModal.tsx` 零引用、`shared/Button` 内部私有 Spinner 与 `shared/Spinner.tsx` 逐字符相同、`@/` 别名 0 使用。

已复核**不成立**并剔除的两条：

1. `browser/BrowserAddressBar.tsx:27,28` 缺 `type="button"` 会触发表单提交 —— 那三个按钮是 `<form>` 的兄弟节点而非子节点（form 从 `:32` 才开始且只包住 input），不会提交。
2. "文档命名为 `AGENTS.md` 可以只触发秒级 `check:policy`" —— 实测 `evaluateChangePolicy(['desktop/src/components/AGENTS.md'])` 返回 `checks: desktop, policy`。原因是 `change-policy.ts:313-315` 的 `touchesDesktopWeb` 只判断 `file.startsWith('desktop/src/')`，**没有像相邻的 `server` 判定那样排除 `isAgentInstructionPath`**。所以本文件与 `components/AGENTS.md` 的改动都会触发 `check:desktop`，这是把文档放在代码旁边换取"就近命中"的合理代价，文档本身也是低频改动。

未复核、按原样保留的统计数字（各类重复次数、变体分布、配方种数）来自 agent 的脚本化统计，可用作优先级排序依据，但落地时应以当时实际代码为准。

---

## 附二：实施记录与对本文的偏离

2026-07-26 执行。基线 225 测试文件 / 2521 用例，完成后 **250 / 2893**，`check:desktop`（lint + test + build）全绿。

### 已落地

| 阶段 | 结果 |
|---|---|
| 0 | `@custom-variant dark`；6 个幽灵 token 清零；z 层级刻度；`animate-in` 死类替换为 4 个真实 keyframe；MCP 徽章映射合一；终端配色接入主题；删 `pages/NewTaskModal.tsx` 与 7 处死 CSS |
| 1 | `Spinner` / `IconButton` / `Button`（4 档固定高度 + focus ring + `type="button"` + 3 个新 variant）；`shared/Button` 与 `shared/Spinner` 删除，24 处 import 迁移 |
| 2 | `Badge` / `StatusDot` / `Checkbox` / `Switch`；替换 MCP 徽章 2 处、`animate-pulse` 误用 2 处、Switch 实现 2 套 |
| 3 | `EmptyState` / `ErrorState` / `LoadingState`；删除 5 个同名局部定义 |
| 4 | 建 `ui/` 与 `composite/`，`shared/` 与 `common/` 清空并删除；`chat/clipboard.ts` → `lib/clipboard.ts` 解开层级倒挂；两个目录各加契约测试 |
| 5 | `Input` 强化 + `TextArea` / `SelectField` / `SearchField` / `SegmentedControl` |
| 6 | `useDismissable` / `useAnchoredPosition`；替换 `ChatInput` 与 `EmptySession` 那 59 行逐字节重复 |
| 7 | `Tooltip`；`Dropdown` 补 listbox 语义、方向键、焦点管理 |
| 8 | `Skeleton` 族 / `Card` / `Progress` |

### 对本文计划的四处偏离

1. **z 层级顺序改了**。本文第 14 节把 `dropdown: 60` 排在 `dialog: 80` 之下，实际改成了 dropdown(70) > dialog(60)。理由：模态对话框挡住背景，打开的下拉必然属于最上层对话框；按原顺序，`AgentManager` 模态里的 `DirectoryPicker` 会被对话框盖住而不可用 —— 那正是它当初硬编码 `zIndex: 9999` 的原因。

2. **`Badge` 没有 `solid` variant**。清点后 45 个徽章全是 tinted，没有一个实色语义徽章；做 `solid` 需要为每个 tone × 每个主题定义可读前景（12 个 token），没有调用方。改为 `soft` / `outline` 两种，另加 `bordered` 开关。

3. **`Menu` 没有新建**。28 处手撸下拉行为各异，一次性统一风险过高。改为：`Dropdown` 补齐 listbox 语义，并交付 `useDismissable` + `useAnchoredPosition` 两个 hook —— 28 处可以逐个用这两个 hook 收敛，不需要一次性替换。

4. **`Spinner` 没有 `respectReducedMotion` prop**。reduced-motion 改为在 CSS 里全局处理，且是**减速**（1s → 2.4s）而非停止：spinner 的唯一功能就是表达"进行中"，停下来读起来像界面卡死。

### 真机走查（`gallery.html`）发现的三件事

单元测试全绿之后开 gallery 才发现的，都不是结构问题：

1. **`Button` / `IconButton` 没转发 ref** → `Tooltip` 定位不到锚点、`Dropdown` 关闭后焦点丢失。只有一条 console 警告，不报错。原测试全部用原生 `<button>` 做 trigger（DOM 元素原生接受 ref），所以测不出来。已加 `forwardRef` + 两条用函数组件做 trigger 的测试。

2. **light 主题的 warning 徽章对比度 2.66:1**（AA 需要 4.5）。根因是拿 `--color-warning` 直接当 `--color-warning-container` 上的前景。已补齐 `--color-on-success/warning/info-container` 三组共 9 个 token，`Badge` 改用它们；三主题最差对比度从 2.66 升到 5.48。新增 `theme/contrast.test.ts` 解析 token 并计算对比度守门（**反证过**：把值改回去，测试精确复现 2.66:1 后变红）。

3. **`Dropdown` 的 Escape 会连带关闭外层 `Modal`**。这是我在重写 `Dropdown` 时引入的回归 —— 原实现用 capture + `stopPropagation`，`useDismissable` 最初没有。已加 `stopEscapePropagation` 选项。

### 环境问题（既有，未处理）

`desktop/package.json` 声明 `"react": "^19.2.4"`，但 `bun.lock` 锁的是 `^18.3.1`，实际装的也是 18.3.1（仓库根目录的 node_modules 反而是 19.2.4）。本次因此使用 `forwardRef` 而非 React 19 的 ref-as-prop。**升级 React 超出本次范围，未改动。**

---

## 附三：多 agent 并行替换（同日第二轮）

组件库建成后，用 6 个并行 agent 把散落各处的手写 UI 收敛过来。

### 分区

worktree 是共享的，并发写同一文件会互相覆盖，所以**文件区隔离是硬约束而非建议**。每个 agent 的 prompt 都写死了「绝不要碰的目录」。

| Agent | 范围 |
|---|---|
| pages | `src/pages/**` |
| chat | `components/chat/**` |
| layout | `layout/` `workspace/` `workbench/` |
| market | `market/` `plugins/` `tasks/` `search/` `skills/` |
| settings | `settings/` `trace/` `browser/` `activity/` `controls/` `composite/` `teams/` `doctor/` `features/pets/` |
| i18n | `src/i18n/**` + 各处硬编码文案（前五个完成后才启动，避免冲突） |

同时要求：**不跑全量测试**（并行期间会看到别人改到一半的红，只跑自己范围）、**保守优先**（拿不准就跳过并写明理由）、**性能敏感区点名保护**（虚拟滚动、`content-visibility`、运行时注入 CSS 变量的文件只做最安全的替换）。

### 结果

组件采用 **349 处**，剩余原生 `<button>` **294 处** —— 复用率从审计时的 22% 到 **54%**。
手写 outside-click 从 21 处降到 **2 处**（`useDismissable` 采用 20 处）。
测试 250 文件/2893 用例 → **253/2919**，`check:desktop` 全绿。
i18n 新增 35 个 key × 5 个 locale，locale 文件达成 0 missing / 0 extra。

### 三件只有并行才暴露的事

1. **`Dropdown` 的 trigger 改造是破坏性变更，而它静默失效。** 把 trigger 从「渲染在 wrapper 里」改成 `cloneElement` 注入 ref/aria/onClick 之后，`market/FilterBar` 的筛选 chip 完全点不动了 —— `FilterTrigger` 是个不转发 props 的函数组件，注入的 onClick 落在空处。没有报错，测试也全绿，是 agent 在替换那个文件时手动点出来的。

   已加固：排查全部调用方（只此一处，其余是原生 `<button>`）；`Dropdown` 增加开发期断言，trigger 没转发 ref 就 `console.warn`；补两条测试（不转发的 trigger 确实打不开、正确的不告警）。**这与 `Button`/`IconButton` 的 forwardRef 缺失是同一个根因的两副面孔** —— 前者是组件自身不转发，后者是调用方自定义的 trigger 不转发。

2. **一个 agent 拒绝执行我的错误指令。** 我让它给 `teams/TeamStatusBar` 的进度条用 `tone="auto"`，它指出 `auto` 的语义是「100% 变绿」，而那个进度条是「没有在跑的就变绿」——1 个完成 + 1 个出错 = 50%，按 `auto` 就不会变绿。它写了显式条件并在报告里说明了偏离。

3. **组件缺口由多个独立来源交叉确认。** 三个 agent 分别在自己的范围里撞到「`IconButton` 缺 `secondary` tone」，各自给出具体文件和行号。同类还有：`2xs`(20px) 与 `xl`(40px) 尺寸、`bordered`、`hoverTone="danger"`（删除图标静止就红会被读成错误状态）、`pressed`、`surface="sidebar"`（侧边栏有自己的 hover token，三主题下都与 `--color-surface-hover` 不同），以及 `Button` 的 `base`(h-8)、`Badge` 的 `wrap`/`title`/rest props 透传。全部已补齐并配测试。

   这些都不是「agent 偷懒用 className 硬压」，而是它们按 AGENTS.md §3.6 的判断标准正确识别为「缺 variant」并上报。该条已扩写为 §3.7，把这个流程固化下来。

### 顺带清掉的死物

- `layout/TitleBar.tsx`（96 行）—— 零引用。审计点名的「设置入口对屏幕阅读器无名」其实**根本不渲染**。
- `scheduledPage.col*` 5 个 i18n key × 5 locale —— 表格布局早已被卡片布局取代。
- `RepositoryLaunchControls.test.tsx` 一处失效的 `vi.mock`（迁移后路径没跟上，隔离静默丢失）。新增 `__tests__/mockPaths.test.ts` 全仓守门。
- `SessionTaskBar` 与 `TeamStatusBar` 那对逐字节相同的进度条，现在都是 `Progress`。

### 新增守门

- `__tests__/mockPaths.test.ts` — 每个 `vi.mock` 路径都能解析
- `theme/paletteEscapes.test.ts` — 禁止新增绕过 token 的 Tailwind 原始调色板（`bg-amber-50` 这类不跟随 `data-theme`，且 `tokenUsage.test.ts` 看不见，因为不是 `var()`）。现有 4 个文件白名单允许保留，但不许增长、不许新文件加入。

---

## 附四：第二轮并行替换

第一轮的五份报告都记录了「因组件缺 X 而跳过」。把那些缺口补齐后，带着**各自的跳过清单**再跑一轮。

### 结果

| | 审计时 | 第一轮后 | 第二轮后 |
|---|---:|---:|---:|
| 组件采用 | 102 | 349 | **524** |
| 剩余原生 `<button>` | 362 | 294 | **179** |
| 组件化率 | 22% | 54% | **75%** |

测试 **253 文件 / 2929 用例**，`check:desktop` 全绿。

### 第二轮补的组件能力

`IconButton` 的 `2xl`(44px)、`solid`、`disabledStyle`，`Button` 的 `inverse`，`Badge`/`Progress` 的 rest props 透传，`SearchField` 的 `clearLabel`，以及 `--color-on-error` token。

### 一个假绿测试掩盖的无效功能

第二轮的 pages agent **实际编译了 Tailwind v4** 来验证类冲突，而不是猜测，结论是：**同名工具类的任意值按值的字母序排，最后一个赢，与传入顺序无关。**

于是：

- **`hoverTone="danger"` 配 `tone="muted"` 或 `secondary` 时完全无效** —— 这两个 tone 的 hover 已经带 `hover:text-[var(--color-text-primary)]`，它按字母序排在 `hover:text-[var(--color-error)]` 之后，永远赢。而这正是该功能被创造出来要服务的两种搭配。
- 同一机制也让调用方的 `disabled:opacity-0` 打不过组件的 `disabled:opacity-50`。

**原测试只断言 class 字符串「包含」红色类，从未断言中性类被移除，所以一路绿着。** 这恰好是 §3.6 警告别人的陷阱，组件库自己踩了。

修法是让两者**互斥**而非叠加：hover 背景与 hover 文字色拆成两张表，`hoverTone` 替换掉 tone 自带的文字色；`disabled` 透明度改为 `disabledStyle` 属性。新测试改为断言「`hover:text-*` 类**有且只有一个**」，并对全部 5 个 tone 参数化 —— 反证过：恢复旧实现后，正好 `secondary` 和 `muted` 两条变红，与编译结论完全吻合。

### 组件库自己违反自己的约定（两处，都已修）

1. **`SearchField` 拼英文** —— 内部用 `` `Clear ${label}` `` 组装 aria-label，导致任何已翻译清除按钮的调用方采用它反而是 i18n 退化。两个 agent 独立把它列为"无法采用"的原因。
   > 第一次修成 `clearLabel ?? label` 是错的：输入框和清除按钮拿到**相同**的可访问名，`getByLabelText` 直接抛"匹配到多个"。最终改为**必填** —— 与 `IconButton.label` 同一个设计，强制调用方提供翻译。
2. **`Badge` / `Progress` 不透传 rest props** —— 调用方一旦需要 `data-testid` 就只能退回手写 span，而那正是重复的源头。

### 又清掉的死代码

`pages/ToolInspection.tsx` 与 `pages/AgentTeams.tsx` —— agent 核实 `ContentRouter` 和 `AppShell` 导入的 9 个页面里都没有它们，只有测试引用。连同 `pages.test.tsx` 里的 5 处引用一并删除。

### 剩余 179 处，逐类说明

全部是**语义上就不该套通用组件**的：`role="tab"` / `menuitem"` / `option"` / `treeitem"` / `gridcell"` 元素、可点击的整行与整卡、文件树节点、拖拽把手、OS 标题栏按钮、`WorkspaceDiffSurface` 的 diff 单元格。五份报告逐条写明了理由。

几处例外，附实证：

- **`ChatInput` 的加号/发送按钮** — `ChatInput.test.tsx:1451` 钉死 `h-11 w-11`；即便加了 `2xl`(44px)，发送按钮还有「停止时 error-container / 否则 primary 渐变」的双填充，无变体可表达。
- **`Settings.tsx` 仅存的 2 处调色板** — 在一个硬编码白底的二维码框里（扫码需要对比度），换成主题 token 会在 dark 下变成白底浅字。agent 换了又自己退回来，并留了注释。
- **`activity/SessionActivityPanel` 的转圈** — 该文件有 `motion-safe:` / `motion-reduce:` 的减弱动效策略，且有测试断言行内**不得**出现裸 `animate-spin`；而 `Spinner` 有意发出裸 `animate-spin`（它是减速而非停止）。真冲突。
- **`ActivitySettings` 的热力图 tooltip** — 一个 tooltip 在 ~365 个格子间复用，`Tooltip` 克隆单个 trigger，套上去就是 365 个 portal。

### 仍然遗留

- `composite/OpenWithMenu` 未接 `useAnchoredPosition`（`anchor` 是 rect 而非 ref，改动要连着 `chat/` 的 3 个调用方一起）。
- `ConversationNavigator` 的侧向 tooltip —— `useAnchoredPosition` 只有 top/bottom 系 placement，没有 left/right。
- `Card` 仍只用于新代码，未批量替换容器组合。
- `MessageBlocks` 的 `ROLE_STYLES` 仍用 `/8` alpha 填充，需要新的 soft token。
