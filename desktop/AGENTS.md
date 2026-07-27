# Desktop Instructions

These rules apply to `desktop/` changes in addition to the root instructions.

- Before adding or editing anything under `desktop/src/components/`, read `desktop/src/components/AGENTS.md`. It is the authoritative index of reusable components, the placement rules for new ones, and the required style/i18n/a11y/test conventions. Do not add a component that duplicates one listed there, and do not add new files to `components/shared/` or `components/common/`.
- Reuse the existing desktop store/API patterns. Use `lucide-react` for common icons and keep operational UI dense, stable, and readable.
- Add focused Vitest or Testing Library coverage for UI, store, or API behavior. Run it first, then follow `bun run check:impact`; desktop product changes normally select `bun run check:desktop`.
- Chat transport, WebSocket lifecycle, first-turn runtime selection, reconnect, or session changes also require the offline `bun run check:chat-contract` when selected.
- Electron host, sidecar, packaging, or version changes require `bun run check:native` when selected.
- Validate user-visible flows in a real browser/desktop session when unit tests cannot prove layout or cross-process behavior, and record the path exercised.
- `localStorage` or native settings shape changes require a migration, an old fixture, and `bun run check:persistence-upgrade`.
