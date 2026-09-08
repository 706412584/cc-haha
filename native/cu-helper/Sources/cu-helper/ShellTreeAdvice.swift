import Foundation

/// Tells the model to switch to screenshot coordinates when an app exposes no
/// usable accessibility tree.
///
/// WHY THIS EXISTS
/// ---------------
/// Chromium/CEF apps (NetEase Music, and any Electron build that does not honour
/// `AXManualAccessibility`) expose only the window chrome: the close/zoom/
/// minimise buttons and the menu bar. Nothing inside the app is addressable by
/// element handle.
///
/// The tool description tells the model `element_index` is *preferred*, which is
/// right for the 95% case — and catastrophic here. Observed in a real session:
/// the model kept clicking `g3:0` (the window), `g4:3`, `g5:9`, narrating
/// "无障碍树几乎为空" each round, and never once tried coordinates. Every action
/// returned "Action completed"; nothing happened. It had the screenshot the
/// whole time and could not tell that the shell tree was a dead end rather than
/// a slow-loading one.
///
/// So the tree itself has to say so. This is the only signal the model gets
/// before choosing how to click.
enum ShellTreeAdvice {
    /// What the model is told when the tree turns out to be a dead end.
    ///
    /// It must name the escape hatch concretely — "the tree is empty" alone is
    /// a complaint the model cannot act on. The four tools listed are exactly
    /// the ones that do not need an element handle; every other tool is
    /// unreachable here, and saying so stops the model cycling through them.
    static let advice = """
        NOTE: This app exposes no usable accessibility tree — only its window \
        frame and menu bar. Element handles cannot reach anything inside it, and \
        retrying them will keep reporting success while changing nothing. Only \
        four tools still work here: `click` with x/y, `drag` with x/y, \
        `press_key`, and `type_text`. Read the pixel coordinates you need off \
        the screenshot returned with this state. The menu bar IS still fully \
        addressable, so a menu path is often the shortest route.
        """

    /// Roles that mean there is something in the CONTENT area worth clicking.
    ///
    /// Deliberately excludes bare container roles (`web area`, `scroll area`):
    /// a CEF shell typically exposes an empty one of those, so treating their
    /// mere presence as "real content" is what made the first version of this
    /// check never fire.
    private static let actionableRoles = [
        "button", "link", "text field", "text area", "checkbox", "radio",
        "menu item", "row", "cell", "tab", "slider", "pop up button",
        "按钮", "链接", "文本字段", "文本区域", "复选框", "单选按钮",
        "行", "单元格", "标签", "滑块", "弹出按钮",
    ]

    /// Window furniture and the menu bar. Present on every app, addressable
    /// even when the content area is not, and therefore no evidence at all
    /// that the tree is usable.
    private static let chromeRoles = [
        "标准窗口", "关闭按钮", "全屏幕按钮", "最小化按钮", "菜单栏",
        "standard window", "close button", "full screen button",
        "minimize button", "menu bar",
    ]

    /// Does this tree describe nothing but window chrome?
    ///
    /// Counts ACTIONABLE elements in the content area rather than matching
    /// every line against a whitelist. The whitelist version failed on the
    /// first app it met: the menu bar's own children ("编辑", "控制", "帮助" …)
    /// are ordinary titles that match no furniture keyword, so the
    /// "every line must be chrome" test was false and the advice never fired
    /// — on precisely the app it was written for.
    static func isShellOnly(_ treeText: String) -> Bool {
        let lines = treeText
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("Window:") && !$0.hasPrefix("App=") }
        guard !lines.isEmpty else { return false }

        // Menu-bar descendants are indented under the menu bar and are always
        // addressable; they say nothing about the content area.
        var insideMenuBar = false
        var actionable = 0
        for raw in treeText.split(separator: "\n") {
            let line = String(raw)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("Window:") || trimmed.hasPrefix("App=") {
                continue
            }
            let indented = line.hasPrefix("\t") || line.hasPrefix("  ")
            let lower = trimmed.lowercased()
            if chromeRoles.contains(where: { lower.contains($0.lowercased()) }) {
                insideMenuBar = lower.contains("菜单栏") || lower.contains("menu bar")
                continue
            }
            if insideMenuBar, indented { continue }
            insideMenuBar = false
            if actionableRoles.contains(where: { lower.contains($0.lowercased()) }) {
                actionable += 1
            }
        }

        // A couple of stray controls can appear on a shell (a lone toolbar
        // button); more than that means the renderer really did attach a tree.
        return actionable <= 2
    }

    /// Append the advice when — and only when — the tree is chrome-only.
    static func annotate(_ treeText: String) -> String {
        guard isShellOnly(treeText) else { return treeText }
        return treeText + "\n\n" + advice
    }
}
