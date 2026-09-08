//
//  Geometry.swift
//  cu-helper
//
//  Codable result models for the Computer Use helper.
//
//  These types are the wire contract between this native helper and the
//  TypeScript bridge. They MUST stay byte-compatible with:
//
//    • src/vendor/computer-use-mcp/executor.ts   (the interface shapes)
//    • src/utils/computerUse/executor.ts          (how results are normalized)
//
//  Two normalization quirks on the TS side drive the field duplication here:
//
//    normalizeDisplayGeometry(display):
//        displayId: display.displayId ?? display.id
//        label:     display.label     ?? display.name
//
//  We always emit BOTH `id` and `displayId`, and BOTH `name` and `label`, so
//  the TS fallbacks are no-ops and the shape is identical no matter which
//  field the consumer reads. `DisplayGeometry.make(...)` keeps the mirrored
//  pairs in lockstep from a single source of truth so they can never drift.
//
//    resolvePrepareCapture(...):
//        display: normalizeDisplayGeometry(result.display)        // nested
//        resolvedDisplayId: result.resolvedDisplayId ?? result.displayId
//
//  So capture results carry the flat geometry fields AND a nested `display`
//  object (mirroring mac_helper.py's capture_display payload). `captureError`
//  is optional and MUST be ABSENT on success — Swift's JSONEncoder omits `nil`
//  optionals by default, so we simply leave it `nil`.
//
//  Every type is `Sendable` so decoded payloads can hop the isolation boundary
//  from the socket IO queue onto @MainActor under Swift 6 strict concurrency.
//

import CoreGraphics

// MARK: - DisplayGeometry

/// One physical display. Produced by `Displays` (CoreGraphics-only, TCC-free)
/// and embedded inside capture results.
///
/// Mirrors `DisplayGeometry` in executor.ts. We emit every field concretely;
/// the TS layer's `displayId ?? id` / `label ?? name` fallbacks therefore
/// never trigger.
public struct DisplayGeometry: Codable, Sendable, Equatable {
    /// `CGDirectDisplayID` as `Int`. Always equal to `displayId`.
    public let id: Int
    /// Same value as `id`; emitted so the TS `displayId ?? id` fallback is a no-op.
    public let displayId: Int
    /// Logical width in points (`CGDisplayBounds().width`).
    public let width: Int
    /// Logical height in points (`CGDisplayBounds().height`).
    public let height: Int
    /// `CGDisplayPixelsWide / boundsWidth` — Retina displays report `2.0`.
    /// Matches mac_helper.py's scaleFactor computation exactly.
    public let scaleFactor: Double
    /// `CGDisplayBounds().origin.x` in the global, top-left point space.
    public let originX: Int
    /// `CGDisplayBounds().origin.y` in the global, top-left point space.
    public let originY: Int
    /// True for `CGMainDisplayID()`.
    public let isPrimary: Bool
    /// Human-readable name, e.g. `"Display 1"`. Always equal to `label`.
    public let name: String
    /// Same value as `name`; emitted so the TS `label ?? name` fallback is a no-op.
    public let label: String

    public init(
        id: Int,
        displayId: Int,
        width: Int,
        height: Int,
        scaleFactor: Double,
        originX: Int,
        originY: Int,
        isPrimary: Bool,
        name: String,
        label: String
    ) {
        self.id = id
        self.displayId = displayId
        self.width = width
        self.height = height
        self.scaleFactor = scaleFactor
        self.originX = originX
        self.originY = originY
        self.isPrimary = isPrimary
        self.name = name
        self.label = label
    }

    /// Build a `DisplayGeometry` from a single source of truth, keeping the
    /// mirrored pairs (`id`/`displayId`, `name`/`label`) automatically in sync.
    ///
    /// Prefer this over the memberwise initializer in producers so the two
    /// duplicated fields can never accidentally diverge.
    ///
    /// - Parameter name: Optional override; defaults to `"Display \(displayId)"`,
    ///   matching mac_helper.py's `"Display N"` convention.
    public static func make(
        displayId: Int,
        width: Int,
        height: Int,
        scaleFactor: Double,
        originX: Int,
        originY: Int,
        isPrimary: Bool,
        name: String? = nil
    ) -> DisplayGeometry {
        let resolvedName = name ?? "Display \(displayId)"
        return DisplayGeometry(
            id: displayId,
            displayId: displayId,
            width: width,
            height: height,
            scaleFactor: scaleFactor,
            originX: originX,
            originY: originY,
            isPrimary: isPrimary,
            name: resolvedName,
            label: resolvedName
        )
    }

    /// The display's bounds in the global top-left point space, as a `CGRect`.
    /// Convenience for `find_window_displays` rect-intersection and for the
    /// capture `sourceRect` translation to display-local coordinates.
    public var boundsRect: CGRect {
        CGRect(
            x: CGFloat(originX),
            y: CGFloat(originY),
            width: CGFloat(width),
            height: CGFloat(height)
        )
    }
}

// MARK: - ScreenshotResult

/// Result of `screenshot`. Mirrors `ScreenshotResult` in executor.ts plus the
/// nested `display` object that mac_helper.py's capture path returns.
///
/// `width`/`height` are the ACTUAL produced JPEG pixel dimensions (read back
/// from the encoded `CGImage`), while `displayWidth`/`displayHeight` are the
/// source display's logical size in points.
public struct ScreenshotResult: Codable, Sendable {
    /// Base64-encoded JPEG (no data-URL prefix; the TS layer adds one if needed).
    public let base64: String
    /// Actual output JPEG width in pixels.
    public let width: Int
    /// Actual output JPEG height in pixels.
    public let height: Int
    /// Source display logical width in points.
    public let displayWidth: Int
    /// Source display logical height in points.
    public let displayHeight: Int
    /// Captured display's `CGDirectDisplayID` as `Int`.
    public let displayId: Int
    /// Captured display's global top-left origin X (points).
    public let originX: Int
    /// Captured display's global top-left origin Y (points).
    public let originY: Int
    /// Full geometry of the captured display, mirroring mac_helper's payload.
    public let display: DisplayGeometry

    public init(
        base64: String,
        width: Int,
        height: Int,
        displayWidth: Int,
        displayHeight: Int,
        displayId: Int,
        originX: Int,
        originY: Int,
        display: DisplayGeometry
    ) {
        self.base64 = base64
        self.width = width
        self.height = height
        self.displayWidth = displayWidth
        self.displayHeight = displayHeight
        self.displayId = displayId
        self.originX = originX
        self.originY = originY
        self.display = display
    }

    /// Build a `ScreenshotResult` from the produced JPEG's pixel dimensions and
    /// the source display geometry, deriving the flat display-mirroring fields
    /// from `display` so they cannot diverge from the nested object.
    public static func make(
        base64: String,
        outputWidth: Int,
        outputHeight: Int,
        display: DisplayGeometry
    ) -> ScreenshotResult {
        ScreenshotResult(
            base64: base64,
            width: outputWidth,
            height: outputHeight,
            displayWidth: display.width,
            displayHeight: display.height,
            displayId: display.displayId,
            originX: display.originX,
            originY: display.originY,
            display: display
        )
    }
}

// MARK: - ResolvePrepareCaptureResult

/// Result of `resolve_prepare_capture`. Extends `ScreenshotResult` (in TS via
/// interface extension; here by carrying the same fields) with the resolver's
/// metadata.
///
/// v1 semantics (matching the existing Python parity):
///   • `hidden` is always `[]` — v1 does not hide non-allowlisted apps.
///   • `resolvedDisplayId == displayId` — v1 does not chase displays.
///   • `captureError` is `nil` on success (omitted from JSON) and carries the
///     failure message only when capture failed but the caller still wants a
///     structured (non-throwing) result.
public struct ResolvePrepareCaptureResult: Codable, Sendable {
    public let base64: String
    public let width: Int
    public let height: Int
    public let displayWidth: Int
    public let displayHeight: Int
    public let displayId: Int
    public let originX: Int
    public let originY: Int
    public let display: DisplayGeometry
    /// Bundle IDs hidden before capture. v1: always empty.
    public let hidden: [String]
    /// The display the resolver settled on. v1: always `== displayId`.
    public let resolvedDisplayId: Int
    /// Present only on failure; ABSENT (nil) on success — do not encode as null.
    public let captureError: String?

    public init(
        base64: String,
        width: Int,
        height: Int,
        displayWidth: Int,
        displayHeight: Int,
        displayId: Int,
        originX: Int,
        originY: Int,
        display: DisplayGeometry,
        hidden: [String],
        resolvedDisplayId: Int,
        captureError: String?
    ) {
        self.base64 = base64
        self.width = width
        self.height = height
        self.displayWidth = displayWidth
        self.displayHeight = displayHeight
        self.displayId = displayId
        self.originX = originX
        self.originY = originY
        self.display = display
        self.hidden = hidden
        self.resolvedDisplayId = resolvedDisplayId
        self.captureError = captureError
    }

    /// Promote a `ScreenshotResult` into a v1 resolve-prepare-capture result:
    /// `hidden = []`, `resolvedDisplayId = displayId`, no `captureError`.
    public static func fromScreenshot(
        _ shot: ScreenshotResult,
        hidden: [String] = [],
        resolvedDisplayId: Int? = nil,
        captureError: String? = nil
    ) -> ResolvePrepareCaptureResult {
        ResolvePrepareCaptureResult(
            base64: shot.base64,
            width: shot.width,
            height: shot.height,
            displayWidth: shot.displayWidth,
            displayHeight: shot.displayHeight,
            displayId: shot.displayId,
            originX: shot.originX,
            originY: shot.originY,
            display: shot.display,
            hidden: hidden,
            resolvedDisplayId: resolvedDisplayId ?? shot.displayId,
            captureError: captureError
        )
    }
}

// MARK: - ZoomResult

/// Result of `zoom`. Mirrors the TS `{ base64, width, height }` return.
public struct ZoomResult: Codable, Sendable {
    /// Base64-encoded JPEG of the cropped/zoomed region.
    public let base64: String
    /// Actual output JPEG width in pixels.
    public let width: Int
    /// Actual output JPEG height in pixels.
    public let height: Int

    public init(base64: String, width: Int, height: Int) {
        self.base64 = base64
        self.width = width
        self.height = height
    }
}

// MARK: - App models

/// `{ bundleId, displayName }` — the shape returned by `frontmost_app`,
/// `app_under_point`, and each element of `list_running_apps`. Covers both
/// `FrontmostApp` and `RunningApp` in executor.ts (identical structures).
public struct AppRef: Codable, Sendable, Equatable {
    public let bundleId: String
    public let displayName: String

    public init(bundleId: String, displayName: String) {
        self.bundleId = bundleId
        self.displayName = displayName
    }
}

/// One element of `list_installed_apps`. Mirrors `InstalledApp` in executor.ts.
///
/// `iconDataUrl` is an optional PNG `data:` URL; it's omitted (nil) when the
/// icon could not be encoded, matching the optional TS field.
public struct InstalledApp: Codable, Sendable {
    public let bundleId: String
    public let displayName: String
    /// Absolute filesystem path to the `.app` bundle.
    public let path: String
    /// Optional `data:image/png;base64,...` URL for the app icon.
    public let iconDataUrl: String?

    public init(
        bundleId: String,
        displayName: String,
        path: String,
        iconDataUrl: String?
    ) {
        self.bundleId = bundleId
        self.displayName = displayName
        self.path = path
        self.iconDataUrl = iconDataUrl
    }
}

/// One element of `find_window_displays`. Mirrors the TS
/// `{ bundleId, displayIds: number[] }` shape.
public struct WindowDisplays: Codable, Sendable, Equatable {
    public let bundleId: String
    /// `CGDirectDisplayID`s (as `Int`) on which this app has on-screen windows.
    public let displayIds: [Int]

    public init(bundleId: String, displayIds: [Int]) {
        self.bundleId = bundleId
        self.displayIds = displayIds
    }
}

// MARK: - Point

/// `{ x, y }` logical point. Returned by `cursor_position` and used for
/// coordinate payloads. These are LOGICAL top-left points — never the real OS
/// cursor; the helper exposes only the virtual cursor's position here.
public struct Point: Codable, Sendable, Equatable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    /// Bridge from a `CGPoint` (the virtual cursor's in-memory position).
    public init(_ cgPoint: CGPoint) {
        self.x = Double(cgPoint.x)
        self.y = Double(cgPoint.y)
    }

    /// The point as a `CGPoint`, for handing back to event-posting code.
    public var cgPoint: CGPoint {
        CGPoint(x: CGFloat(x), y: CGFloat(y))
    }
}
