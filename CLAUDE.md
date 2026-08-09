# Code Council — Project Rules

## Upstream Merge Policy

When merging upstream Claude Code releases:

- **Never overwrite README.md or README.zh-CN.md.** These files contain Code Council branding, the customizations section, and fork-specific links. Always keep the local version intact. If upstream changes conflict, discard the upstream side.
- Preserve all local provider preset customizations (`deprecated` tombstones for TeamoRouter, 玄枢API, FennoAI, 七牛云AI; 接口AI as optional without ads).
- Preserve `xhigh` reasoning tier for K3/compatible models — never let an upstream merge silently downgrade it.
- Preserve relay-provider retry logic (`get_channel_failed`, `api_error` 5xx) in `src/services/api/withRetry.ts`.
- Preserve `thinking` passthrough in the proxy layer.
- Keep the `Code Council` wordmark in `desktop/src/components/layout/Sidebar.tsx` and `AppShell.tsx`.
- All GitHub links in docs and source must point to `706412584/cc-haha`, not `NanmiCoder/cc-haha` or `anthropics/claude-code`.

## Release

- Windows builds use `powershell -ExecutionPolicy Bypass -File ./desktop/scripts/build-windows-x64.ps1` with `ELECTRON_MIRROR` and `ELECTRON_BUILDER_BINARIES_MIRROR` set to `https://npmmirror.com/mirrors/electron/` and `https://npmmirror.com/mirrors/electron-builder-binaries/` respectively (GitHub is blocked).
- macOS releases do not require notarization for internal/draft builds — use `notarize_macos=false`.
- Release notes go in `release-notes/vX.Y.Z.md` before tagging.
