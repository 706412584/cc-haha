// swift-tools-version: 6.0
//
// SwiftPM manifest for `cu-helper` — the native macOS Computer Use helper for
// claude-code-haha.
//
// One dual-mode executable target:
//   • `cu-helper <command> --payload '<json>'`  — one-shot CLI used by the
//     existing TS Python-bridge contract (src/utils/computerUse/pythonBridge.ts).
//     Writes exactly one `{ok,result?,error?}` line to stdout and exits.
//   • `cu-helper daemon --socket <path>`         — long-lived AppKit (.accessory)
//     process that owns the animated virtual-cursor + capture-glow overlays and
//     serves an AF_UNIX NDJSON request/response stream.
//
// swift-tools 6.0 => Swift 6 strict-concurrency is complete by default; the
// target is additionally pinned to language mode v6 below so the build host
// (Swift 6.3.2 / Xcode 26.5 / macOS 26.4.1, Apple Silicon arm64) compiles the
// `@MainActor` AppKit/ScreenCaptureKit code under full isolation checking.
//
// platforms .macOS("14.4"): match the reference Computer Use service's runtime
// floor. Keeping this subsystem floor above the desktop host's floor lets the
// app show a deterministic unsupported state instead of launching a helper the
// OS loader will reject.
import PackageDescription

let package = Package(
  name: "cu-helper",
  platforms: [.macOS("14.4")],
  targets: [
    // Tiny C shim exposing the private `responsibility_spawnattrs_setdisclaim`
    // self-re-exec (see Sources/CDisclaim/disclaim.c). Lets cu-helper become its
    // OWN TCC "responsible process" instead of inheriting the launching Electron
    // app's — without it, granting cu-helper its own Privacy row is ignored.
    .target(name: "CDisclaim"),
    .executableTarget(
      // Product/output binary name — this is the file name macOS shows in the
      // Privacy lists (Accessibility / Screen Recording) and that the user drags
      // in, so it carries the brand. The source dir stays `Sources/cu-helper`
      // (via `path`) to avoid churning the whole tree.
      name: "cc-haha-computer-use",
      dependencies: ["CDisclaim"],
      path: "Sources/cu-helper",
      // Optional click-ripple frames. The directory always exists in the repo
      // (so `.copy` is valid on a fresh checkout) but may contain only a marker;
      // VirtualCursor falls back to a procedural CAShapeLayer ring when no PNG
      // sequence is bundled. `.copy` preserves the directory verbatim in the
      // product bundle (no asset-catalog processing).
      resources: [.copy("Resources/LensSequence")],
      swiftSettings: [.swiftLanguageMode(.v6)],
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("CoreGraphics"),
        .linkedFramework("CoreMedia"),
        .linkedFramework("CoreVideo"),
        .linkedFramework("QuartzCore"),
        .linkedFramework("ApplicationServices"),
        .linkedFramework("ScreenCaptureKit"),
        .linkedFramework("ImageIO"),
        .linkedFramework("UniformTypeIdentifiers"),
        .linkedFramework("Carbon"),
        .linkedFramework("AudioToolbox"),
        .linkedFramework("Security")
      ]
    ),
    .testTarget(
      name: "CuHelperTests",
      dependencies: [.target(name: "cc-haha-computer-use")],
      path: "Tests/CuHelperTests",
      swiftSettings: [.swiftLanguageMode(.v6)]
    )
  ]
)
