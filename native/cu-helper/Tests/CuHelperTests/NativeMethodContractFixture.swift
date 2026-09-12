import AppKit
#if !NATIVE_CONTRACT_STANDALONE
@testable import cc_haha_computer_use
#endif

/// The same disposable receiver is compiled standalone for official CUA and
/// hosted by the XCTest fixture child for the local native router.
@MainActor
enum NativeMethodContractFixture {
    static func run(root: URL) throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        // Native paste is delivered through the normal Command-V responder
        // chain. A standalone NSApplication has no nib-provided Edit menu.
        let mainMenu = NSMenu()
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "Edit")
        editMenu.autoenablesItems = false
        for (title, selector, key) in [
            ("Cut", #selector(NSText.cut(_:)), "x"),
            ("Copy", #selector(NSText.copy(_:)), "c"),
            ("Paste", #selector(NSText.paste(_:)), "v"),
            ("Select All", #selector(NSText.selectAll(_:)), "a"),
        ] { editMenu.addItem(withTitle: title, action: selector, keyEquivalent: key) }
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)
        app.mainMenu = mainMenu
        app.finishLaunching()
        let window = ContractWindow(contentRect: NSRect(x: 120, y: 160, width: 760, height: 520), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.delegate = window
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .canJoinAllApplications]
        window.title = "Native method contract fixture"
        let content = NSView(frame: window.contentView!.bounds)
        let editor = ContractEditor(frame: NSRect(x: 20, y: 310, width: 720, height: 170))
        editor.isRichText = true
        editor.font = NSFont.systemFont(ofSize: 18)
        editor.string = "alpha beta gamma"
        editor.setAccessibilityLabel("Contract editor")
        content.addSubview(editor)
        let scroll = ContractScrollView(frame: NSRect(x: 20, y: 70, width: 720, height: 210))
        // Native AX page increments depend on the visible clip size. Pin the
        // receiver geometry instead of inheriting dynamic system scrollbar style.
        scroll.scrollerStyle = .legacy
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.setAccessibilityLabel("Contract scroll")
        let document = NSTextView(frame: NSRect(x: 0, y: 0, width: 1400, height: 1800))
        document.isEditable = false
        document.font = NSFont.systemFont(ofSize: 18)
        document.string = (1...70).map { "Disposable row \($0)" }.joined(separator: "\n")
        document.setAccessibilityLabel("Contract rows")
        scroll.documentView = document
        content.addSubview(scroll)
        let action = ContractSecondaryView(frame: NSRect(x: 20, y: 15, width: 400, height: 40))
        action.setAccessibilityElement(true)
        action.setAccessibilityRole(.button)
        action.setAccessibilityLabel("Contract secondary action")
        content.addSubview(action)
        window.contentView = content
        window.orderFrontRegardless()
        window.makeMain()
        window.makeFirstResponder(editor)
        let ready = root.appendingPathComponent("ready")
        let receipt = root.appendingPathComponent("contract.json")
        var previous: Data?
        let timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
            MainActor.assumeIsolated {
                let selection = editor.selectedRange()
                let value: [String: Any] = [
                    "text": editor.string,
                    "selectionLocation": selection.location,
                    "selectionLength": selection.length,
                    "scrollY": scroll.contentView.bounds.origin.y,
                    "scrollX": scroll.contentView.bounds.origin.x,
                    "wheel": scroll.events,
                    "secondaryCount": action.count,
                    "visible": window.isVisible,
                    "hidden": app.isHidden,
                    "windowNumber": window.windowNumber,
                    "windowFrame": NSStringFromRect(window.frame),
                    "onActiveSpace": window.isOnActiveSpace,
                    "miniaturized": window.isMiniaturized,
                    "occlusionState": window.occlusionState.rawValue,
                    "windowEvents": window.events,
                    "clipSize": NSStringFromSize(scroll.contentView.bounds.size),
                    "scrollerStyle": scroll.scrollerStyle.rawValue,
                    "editorEvents": editor.events,
                ]
                if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), data != previous {
                    try? data.write(to: receipt, options: .atomic)
                    previous = data
                }
                if FileManager.default.fileExists(atPath: root.appendingPathComponent("stop").path) { exit(0) }
            }
        }
        defer { timer.invalidate() }
        // NSWorkspace/open -g finishes its background-launch policy after
        // main() starts. Publish readiness only after that launch boundary.
        Timer.scheduledTimer(withTimeInterval: 0.2, repeats: false) { _ in
            MainActor.assumeIsolated {
                window.orderFrontRegardless()
                try? Data(String(ProcessInfo.processInfo.processIdentifier).utf8).write(to: ready)
            }
        }
        // A bounded receiver process never survives a failed parent test.
        Timer.scheduledTimer(withTimeInterval: 600, repeats: false) { _ in exit(0) }
        app.run()
    }
}

@MainActor
private final class ContractWindow: NSWindow, NSWindowDelegate {
    var events: [[String: Any]] = []
    private func record(_ kind: String, includeStack: Bool = false) {
        var event: [String: Any] = [
            "kind": kind, "uptime": ProcessInfo.processInfo.systemUptime,
            "visible": isVisible, "miniaturized": isMiniaturized,
            "onActiveSpace": isOnActiveSpace,
        ]
        if let current = NSApplication.shared.currentEvent {
            event["eventType"] = current.type.rawValue
            if [.keyDown, .keyUp, .flagsChanged].contains(current.type) {
                event["keyCode"] = current.keyCode
            }
            event["eventMarker"] = current.cgEvent?.getIntegerValueField(.eventSourceUserData)
        }
        if includeStack { event["stack"] = Array(Thread.callStackSymbols.prefix(12)) }
        events.append(event)
        if events.count > 40 { events.removeFirst(events.count - 40) }
    }
    override func orderOut(_ sender: Any?) {
        record("orderOut", includeStack: true)
        super.orderOut(sender)
    }
    override func close() {
        record("close", includeStack: true)
        super.close()
    }
    override func miniaturize(_ sender: Any?) {
        record("miniaturize", includeStack: true)
        super.miniaturize(sender)
    }
    func windowWillClose(_ notification: Notification) { record("willClose") }
    func windowDidMiniaturize(_ notification: Notification) { record("didMiniaturize") }
    func windowDidDeminiaturize(_ notification: Notification) { record("didDeminiaturize") }
    func windowDidChangeOcclusionState(_ notification: Notification) { record("occlusionChanged") }
    func windowDidBecomeKey(_ notification: Notification) { record("becameKey") }
    func windowDidResignKey(_ notification: Notification) { record("resignedKey") }
}

@MainActor
private final class ContractScrollView: NSScrollView {
    var events: [[String: Any]] = []
    override func scrollWheel(with event: NSEvent) {
        events.append(["x": event.scrollingDeltaX, "y": event.scrollingDeltaY, "precise": event.hasPreciseScrollingDeltas])
        super.scrollWheel(with: event)
    }
}

@MainActor
private final class ContractEditor: NSTextView {
    var events: [[String: Any]] = []
    override func paste(_ sender: Any?) {
        if let name = ProcessInfo.processInfo.environment["CC_HAHA_METHOD_FIXTURE_PASTEBOARD"] {
            // The real menu/responder chain consumes promised data from the
            // test-owned pasteboard, without consulting the user's clipboard.
            _ = readSelection(from: NSPasteboard(name: NSPasteboard.Name(name)))
        } else {
            super.paste(sender)
        }
    }
    override func keyDown(with event: NSEvent) {
        #if !NATIVE_CONTRACT_STANDALONE
        // The test app is a receiver, never a destination for physical typing.
        // Native generated keys are marked; AX writes need no keyboard event.
        guard event.cgEvent?.getIntegerValueField(.eventSourceUserData) == HelperEventMarker.value else { return }
        #endif
        events.append(["kind": "keyDown", "keyCode": Int(event.keyCode), "flags": event.modifierFlags.rawValue])
        super.keyDown(with: event)
    }
    override func didChangeText() {
        super.didChangeText()
        events.append(["kind": "changed", "text": string])
    }
}

@MainActor
private final class ContractSecondaryView: NSView {
    var count = 0
    override func accessibilityPerformShowMenu() -> Bool {
        count += 1
        needsDisplay = true
        return true
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        dirtyRect.fill()
        ("Secondary actions received: \(count)" as NSString).draw(at: NSPoint(x: 5, y: 8), withAttributes: [.font: NSFont.systemFont(ofSize: 16)])
    }
}

#if NATIVE_CONTRACT_STANDALONE
@main
struct NativeContractMain {
    @MainActor static func main() throws {
        try NativeMethodContractFixture.run(root: URL(fileURLWithPath: CommandLine.arguments[1]))
    }
}
#endif
