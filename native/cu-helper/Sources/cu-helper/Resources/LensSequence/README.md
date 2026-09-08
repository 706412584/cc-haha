# LensSequence (optional click-ripple frames)

This directory is referenced by `Package.swift` via `resources: [.copy("Resources/LensSequence")]`.

It is **optional**. If it contains a numbered PNG sequence (e.g. `lens_000.png`,
`lens_001.png`, …), `VirtualCursor.swift` loads and plays those raster frames as
the click-ripple animation. If it contains only this marker (no PNGs),
`VirtualCursor` falls back to a procedural `CAShapeLayer` ring — no PNGs are
required for a correct build or runtime.

The directory itself must exist in the repository so SwiftPM's `.copy(...)`
resource rule resolves on a fresh checkout (an absent path makes `swift build`
fail). This marker file guarantees git tracks the directory even when empty of
frames.
