import XCTest

@testable import cc_haha_computer_use

/// Guards the signal that tells the model to stop clicking element handles and
/// start using screenshot coordinates.
///
/// Both directions are costly. A false positive pushes the model onto pixel
/// hunting in an app where handles work perfectly. A false negative reproduces
/// the observed failure: the model clicks `g3:0`, `g4:3`, `g5:9` in turn, gets
/// "Action completed" every time, and never tries coordinates.
final class ShellTreeAdviceTests: XCTestCase {
    /// Recorded verbatim from a failing production session — NetEase Music, a
    /// CEF app. This exact string is why the check exists, and the first
    /// implementation returned false on it: the menu bar's children ("编辑",
    /// "控制", "帮助" …) are plain titles that matched no furniture keyword, so
    /// the "every line must be chrome" rule failed and the advice never fired
    /// on the one app it was written for.
    private let cefShell = """
        Window: "网易云音乐", App: 网易云音乐.
        g1:0 标准窗口 Secondary Actions: Raise
        \tg1:1 关闭按钮
        \tg1:2 全屏幕按钮 Help: 此按钮也可以执行缩放窗口的操作
        \tg1:3 最小化按钮
        g1:4 菜单栏
        \tg1:5 网易云音乐
        \tg1:6 编辑
        \tg1:7 控制
        \tg1:8 窗口
        \tg1:9 帮助
        """

    func testTheExactProductionShellIsRecognised() {
        XCTAssertTrue(
            ShellTreeAdvice.isShellOnly(cefShell),
            "this is the tree that shipped the bug; if it stops matching, the advice is dead again"
        )
        XCTAssertTrue(ShellTreeAdvice.annotate(cefShell).contains("x/y"))
    }

    func testEnglishChromeOnlyTreeIsRecognised() {
        let english = """
            Window: "Some App", App: Some App.
            g1:0 standard window Secondary Actions: Raise
            \tg1:1 close button
            \tg1:2 full screen button
            \tg1:3 minimize button
            g1:4 menu bar
            \tg1:5 Some App
            \tg1:6 Edit
            \tg1:7 Help
            """
        XCTAssertTrue(ShellTreeAdvice.isShellOnly(english))
    }

    /// An EMPTY container is the CEF shell's signature, not evidence of
    /// content. Suppressing on the mere presence of these role names is what
    /// the first version got wrong.
    func testEmptyContainersDoNotCountAsContent() {
        for container in ["web area", "scroll area", "group", "AXWebArea"] {
            let tree = cefShell + "\n\tg1:10 \(container)"
            XCTAssertTrue(
                ShellTreeAdvice.isShellOnly(tree),
                "an empty \(container) is exactly what a dead shell exposes"
            )
        }
    }

    /// Real, clickable content must silence the advice — wrongly abandoning
    /// element handles would push the model onto pixel hunting in an app where
    /// handles work fine.
    func testActionableContentSuppressesTheAdvice() {
        // Content lives under the WINDOW subtree, before the menu bar — that is
        // the shape a real tree has. (Appending it after the menu bar would be
        // indistinguishable from a menu item, and correctly ignored.)
        let content = """
            Window: "网易云音乐", App: 网易云音乐.
            g1:0 标准窗口 Secondary Actions: Raise
            \tg1:1 关闭按钮
            \tg1:2 全屏幕按钮
            \tg1:3 最小化按钮
            \tg1:10 按钮 播放
            \tg1:11 文本字段 搜索
            \tg1:12 链接 每日推荐
            g1:4 菜单栏
            \tg1:5 网易云音乐
            \tg1:6 编辑
            """
        XCTAssertFalse(ShellTreeAdvice.isShellOnly(content))
        XCTAssertEqual(ShellTreeAdvice.annotate(content), content, "must not be annotated")
    }

    /// The menu bar is addressable on every app, including dead shells, so its
    /// items must not be mistaken for content — otherwise no app with a menu
    /// ever trips the check.
    func testMenuBarItemsAreNotCountedAsContent() {
        let manyMenus = """
            Window: "App", App: App.
            g1:0 标准窗口
            g1:1 菜单栏
            \tg1:2 文件
            \tg1:3 编辑
            \tg1:4 显示
            \tg1:5 前往
            \tg1:6 窗口
            \tg1:7 帮助
            """
        XCTAssertTrue(ShellTreeAdvice.isShellOnly(manyMenus))
    }

    /// A large real tree is never a shell.
    func testLargeRealTreeIsNotAShell() {
        let big = (0..<40).map { "g1:\($0) 按钮 项目\($0)" }.joined(separator: "\n")
        XCTAssertFalse(ShellTreeAdvice.isShellOnly(big))
    }

    /// Empty or header-only input concludes nothing; a spurious note on every
    /// empty read would be noise.
    func testEmptyTreeProducesNoAdvice() {
        XCTAssertFalse(ShellTreeAdvice.isShellOnly(""))
        XCTAssertFalse(ShellTreeAdvice.isShellOnly("Window: \"x\", App: x."))
    }

    /// The advice must name the escape hatch concretely. "The tree is empty" on
    /// its own is a complaint the model cannot act on — the whole point is to
    /// list the tools that still work.
    func testAdviceNamesTheFourToolsThatStillWork() {
        let advice = ShellTreeAdvice.advice
        XCTAssertTrue(advice.contains("screenshot"))
        XCTAssertTrue(advice.contains("x/y"))
        XCTAssertTrue(advice.contains("press_key"))
        XCTAssertTrue(advice.contains("type_text"))
        XCTAssertTrue(advice.contains("drag"))
        // The menu bar remains reachable and is often the shortest route.
        XCTAssertTrue(advice.contains("menu bar"))
    }
}
