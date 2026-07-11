# Documentation Instructions

These rules apply to `docs/` changes in addition to the root instructions.

- Keep Chinese pages and their `docs/en/` counterparts aligned when both versions exist.
- Preserve VitePress structure and existing terminology; do not replace reference screenshots or media unless the task requires it.
- Run `bun run check:docs` when selected by `bun run check:impact`.
- `check:docs` runs `npm ci` and may rebuild root `node_modules`; run it sequentially with other checks that use the root dependency tree.
- Release instructions must stay consistent with `scripts/release.ts`, `.github/workflows/release-desktop.yml`, and the versioned release-notes convention.
