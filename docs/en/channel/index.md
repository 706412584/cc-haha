# Channel System Research

This section documents the upstream Claude Code Channel/MCP architecture. It is not the recommended setup path for the IM integrations shipped by this repository.

To connect WeChat, DingTalk, WhatsApp, Telegram, or Feishu to the current Desktop app, start with [IM Integrations](../im/).

## Current product path

The working integration in this repository is:

```text
Desktop settings
  → /api/adapters
  → ~/.claude/adapters.json
  → adapters/*
  → pairing and allowlist
  → HTTP session creation
  → /ws/:sessionId
  → Claude Code session
```

This adapter path is smaller and separate from the upstream Channel mechanism. It matches the Desktop server’s REST and WebSocket architecture and keeps platform authorization in dedicated sidecar processes.

## Documents

### [Channel System Architecture](./01-channel-system.md)

A source-level analysis of the upstream system, including:

- MCP Channel capability and notification flow;
- inbound XML wrapping and outbound tool calls;
- runtime, OAuth, organization, session, and plugin gates;
- permission relay and short request IDs;
- plugin registration and trust boundaries.

### Historical IM Gateway proposal

The Chinese documentation retains an early IM Gateway proposal as architecture history. It explains why the implementation moved toward independent adapters and `/ws/:sessionId`. It is not a current setup guide and is intentionally not presented as an English user workflow.

## When to read this section

Use these pages when you are:

- studying the upstream Claude Code Channel design;
- comparing Channel plugins with the repository’s adapter implementation;
- designing a future protocol or plugin integration;
- reviewing the security boundaries of remote Agent control.

For a working bot or linked account, use:

- [IM Integration overview](../im/)
- [Telegram](../im/telegram.md)
- [Feishu](../im/feishu.md)
- [WeChat](../im/wechat.md)
- [DingTalk](../im/dingtalk.md)
- [WhatsApp](../im/whatsapp.md)

## Channel implementation reference

- Read the [Plugin Architecture](./01-channel-system.md#7-plugin-channel-architecture) section.
- Channel plugins declare their capability in `plugin.json` and use the MCP Server `notifications/claude/channel` protocol.
- Core implementation lives in `src/services/mcp/channelNotification.ts`, `src/services/mcp/channelPermissions.ts`, `src/services/mcp/channelAllowlist.ts`, `src/utils/plugins/mcpPluginIntegration.ts`, and `src/utils/plugins/schemas.ts`.

## Related resources

- [Agent Framework Deep Dive](../agent/03-agent-framework.md)
- [Skills System Documentation](../skills/01-usage-guide.md)
- [GitHub Issues](https://github.com/706412584/cc-haha/issues)
