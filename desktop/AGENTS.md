# Desktop Instructions

These rules apply to `desktop/` changes in addition to the root instructions.

- Reuse the existing desktop design system and component/store/API patterns. Use `lucide-react` for common icons and keep operational UI dense, stable, and readable.
- Add focused Vitest or Testing Library coverage for UI, store, or API behavior. Run it first, then follow `bun run check:impact`; desktop product changes normally select `bun run check:desktop`.
- Chat transport, WebSocket lifecycle, first-turn runtime selection, reconnect, or session changes also require the offline `bun run check:chat-contract` when selected.
- Electron host, sidecar, packaging, or version changes require `bun run check:native` when selected.
- Validate user-visible flows in a real browser/desktop session when unit tests cannot prove layout or cross-process behavior, and record the path exercised.
- `localStorage` or native settings shape changes require a migration, an old fixture, and `bun run check:persistence-upgrade`.
