/**
 * Tool dispatch for the Codex-compatible computer-use face (blueprint §7).
 *
 * Ten semantic tools, dispatched to the native `cu-helper` AX engine
 * (`adapter.executor.engine`, a thin wrapper over the daemon's NDJSON
 * commands):
 *
 *   list_apps, get_app_state, click, perform_secondary_action, set_value,
 *   select_text, scroll, drag, press_key, type_text, paste
 *
 * ## Three properties this file exists to hold
 *
 * **1. Everything fails closed.** An element handle that isn't a well-formed
 * opaque handle is rejected, never coerced. A missing or malformed `app` is
 * rejected, never defaulted to the frontmost window — that default is how an
 * agent ends up driving the host's own UI. An unproven process is rejected
 * before any mutation, because a bare pid can be recycled between the moment
 * we resolved it and the moment we act on it.
 *
 * **2. Safety checks happen after resolution, on the resolved identity.**
 * The model names an app loosely ("Notes", a path, a pid). `resolveTarget` is
 * the single seam that turns that into one real running process; every policy
 * check then runs against *that* process's bundle id, not against the string
 * the model typed. Checking the string instead would let "friendly alias"
 * walk past a denylist that names the bundle id.
 *
 * **3. Mutating tools never take an implicit snapshot.** They return a fixed
 * receipt and the model calls `get_app_state` when it wants to see the result.
 * An implicit re-snapshot after every action doubles the AX traversals and the
 * window captures for a state the model often doesn't read.
 *
 * ## Enforcement order (every call)
 *
 *   1. Kill switch (`adapter.isDisabled()`).
 *   2. Static request parsing — argument shapes, bounds, alias conflicts, and
 *      the `systemKeyCombos` grant. Pure: no TCC probe, no lock, no daemon
 *      round-trip. A malformed request must not cost a permission prompt.
 *   3. TCC gate (`adapter.ensureOsPermissions()`).
 *   4. Global CU lock (`overrides.checkCuLock`).
 *   5. Engine presence.
 *   6. `resolveTarget` → one running process + its lifetime identity.
 *   7. Product/intrinsic denylists against the RESOLVED identity.
 *   8. Proven process lifetime — mutating tools only.
 *   9. Engine dispatch.
 *
 * The Codex `<app_state>` envelope is framed HERE, in TS, not in Swift
 * (blueprint §7). Swift renders the inner tree text (the format authority);
 * we wrap it in the version banner + optional <app_specific_instructions> +
 * <app_state> tags, and attach the window screenshot as a second content
 * block when one came back.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  getDeniedCategoryForApp,
  isIntrinsicAppDenied,
  isPolicyDenied,
} from "./deniedApps.js";
import type {
  AppStateResult,
  AppTarget,
  CodexComputerEngine,
  CodexMouseButton,
  ProcessIdentity,
  ResolvedAppTarget,
  ScreenshotResult,
} from "./executor.js";
import { isSystemKeyCombo } from "./keyBlocklist.js";
import type {
  ComputerUseHostAdapter,
  ComputerUseOverrides,
  CuGrantFlags,
} from "./types.js";

// ---------------------------------------------------------------------------
// Result + telemetry types (preserved public surface — re-exported by index.ts)
// ---------------------------------------------------------------------------

/**
 * Categorical error classes for the cu_tool_call telemetry event. Never free
 * text — error messages may contain file paths / app content (PII).
 */
export type CuErrorKind =
  | "allowlist_empty"
  | "tcc_not_granted"
  | "cu_lock_held"
  | "teach_mode_conflict"
  | "teach_mode_not_active"
  | "executor_threw"
  | "capture_failed"
  | "app_denied"
  | "bad_args"
  | "app_not_granted"
  | "tier_insufficient"
  | "feature_unavailable"
  | "state_conflict"
  | "grant_flag_required"
  | "display_error"
  | "other";

/**
 * Telemetry payload piggybacked on the result — populated here, consumed and
 * stripped by the host wrapper (`bindSessionContext` / `wrapper.tsx`) before the
 * result reaches the SDK.
 */
export interface CuCallTelemetry {
  granted_count?: number;
  denied_count?: number;
  denied_browser_count?: number;
  denied_terminal_count?: number;
  error_kind?: CuErrorKind;
}

/**
 * `CallToolResult` augmented with piggybacked telemetry. The Codex face attaches
 * its window screenshot as a normal `image` content block inside `content`, NOT
 * via this out-of-band `screenshot` stash — that field is retained only so the
 * host wrapper's screenshot-stash plumbing (`bindSessionContext` in mcpServer.ts)
 * keeps type-checking; the semantic engine never populates it, so that branch is
 * inert (no pixel-compare consumer remains).
 */
export type CuCallToolResult = CallToolResult & {
  screenshot?: ScreenshotResult;
  telemetry?: CuCallTelemetry;
};

// ---------------------------------------------------------------------------
// Codex envelope framing (blueprint §7)
// ---------------------------------------------------------------------------

/**
 * Our Computer Use "CUA App Version", surfaced in the `get_app_state` banner.
 * Codex prints a monotonic build number here (observed 750 / 770). This is our
 * own product's value; it only needs to be stable and present so harnesses that
 * key off the banner have something to read.
 */
export const CUA_APP_VERSION = "1";

const FOCUS_PREFIX = "The focused UI element is ";

/**
 * What a mutating tool returns. Deliberately fixed text with no state: the
 * model asks for the new state when it needs it (see property 3 above).
 */
const MUTATION_RECEIPT =
  "Action completed. Call `get_app_state` to fetch the updated UI state.";

/**
 * Frame a daemon `AppStateResult` into the Codex content blocks.
 *
 * Text block:
 *   Computer Use state (CUA App Version: <v>)
 *   <app_specific_instructions>            ← only when appInstructions is non-empty
 *   …
 *   </app_specific_instructions>
 *   <app_state>
 *   <Swift axText: App=… / Window: … / indented tree / optional focus tail>
 *   </app_state>
 *
 * The Swift `axText` already carries the trailing "The focused UI element is …"
 * line when there is focus; we keep it INSIDE the <app_state> block (it is part
 * of the rendered tree text). A second `image` block carries the window
 * screenshot when the daemon returned one (`try?` on the Swift side — absent on
 * capture failure, and we still return the text).
 */
export function frameAppStateEnvelope(state: AppStateResult): CuCallToolResult {
  const lines: string[] = [];
  lines.push(`Computer Use state (CUA App Version: ${CUA_APP_VERSION})`);

  const instructions = state.appInstructions?.trim();
  if (instructions) {
    lines.push("<app_specific_instructions>");
    lines.push(instructions);
    lines.push("</app_specific_instructions>");
  }

  lines.push("<app_state>");
  // axText is the authoritative inner tree; trim only trailing whitespace so we
  // don't introduce a blank line before </app_state>.
  lines.push(state.axText.replace(/\s+$/u, ""));
  lines.push("</app_state>");

  const content: CallToolResult["content"] = [
    { type: "text", text: lines.join("\n") },
  ];

  if (state.screenshot && state.screenshot.base64) {
    content.push({
      type: "image",
      data: state.screenshot.base64,
      mimeType: "image/png",
    });
  }

  return { content };
}

// ---------------------------------------------------------------------------
// Small result helpers
// ---------------------------------------------------------------------------

function errorResult(text: string, errorKind?: CuErrorKind): CuCallToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    telemetry: errorKind ? { error_kind: errorKind } : undefined,
  };
}

function okText(text: string): CuCallToolResult {
  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Arg parsing — lightweight, no zod (cast-and-check)
// ---------------------------------------------------------------------------

/** Marker error → dispatcher maps to a `bad_args` tool error. */
class BadArgs extends Error {}

/** Marker error → dispatcher maps to a `grant_flag_required` tool error. */
class GrantRequired extends Error {}

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args === "object" && args !== null) {
    return args as Record<string, unknown>;
  }
  return {};
}

/**
 * The shape the daemon mints: `g<epoch>:<id>`, both plain decimal integers
 * with no leading zeros.
 *
 * Strict on purpose. The handle is opaque — callers copy it, they don't build
 * it — so any deviation means the value did not come from a get_app_state we
 * served, and guessing at what it meant is how a stale integer ends up
 * addressing whatever now occupies that slot.
 */
const ELEMENT_HANDLE_RE = /^g(?:0|[1-9]\d*):(?:0|[1-9]\d*)$/u;

/**
 * Parse an `element_index` into the opaque handle the daemon issued.
 *
 * Absent (or empty) → undefined, for the tools where the handle is optional.
 * Everything else must match the canonical form exactly: a bare number is
 * rejected rather than treated as a tree line number, and a number type is
 * rejected outright.
 */
function parseElementHandle(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new BadArgs(
      `element_index must be an opaque handle string from get_app_state (e.g. "g17:4")`,
    );
  }
  if (value === "") return undefined;
  if (!ELEMENT_HANDLE_RE.test(value)) {
    throw new BadArgs(
      `element_index must be an opaque handle from get_app_state (e.g. "g17:4"), got "${value}"`,
    );
  }
  return value;
}

function optionalNumber(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new BadArgs(`${key} must be a number`);
}

/** A screenshot-space coordinate: finite and never negative. */
function optionalCoordinate(value: unknown, key: string): number | undefined {
  const n = optionalNumber(value, key);
  if (n === undefined) return undefined;
  if (n < 0) {
    throw new BadArgs(`${key} must be within the screenshot (>= 0), got ${n}`);
  }
  return n;
}

function requiredString(
  args: Record<string, unknown>,
  key: string,
): string {
  const v = args[key];
  if (typeof v !== "string" || v === "") {
    throw new BadArgs(`Missing or empty required string "${key}"`);
  }
  return v;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return undefined;
}

/** Reject a request that spells the same parameter two ways at once. */
function rejectAliasConflict(
  present: boolean,
  aliasPresent: boolean,
  officialKey: string,
  aliasKey: string,
): void {
  if (present && aliasPresent) {
    throw new BadArgs(
      `Pass either "${officialKey}" or "${aliasKey}", not both`,
    );
  }
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new BadArgs(`${key} must be a boolean`);
}

/** Parse `{x, y}` from either a nested object `{from:{x,y}}` or flat
 *  `from_x/from_y` (Codex's drag sample uses the flat form). */
function parsePoint(
  args: Record<string, unknown>,
  nestedKey: string,
  flatXKey: string,
  flatYKey: string,
): { x: number; y: number } {
  const nested = args[nestedKey];
  if (nested && typeof nested === "object") {
    const o = nested as Record<string, unknown>;
    const x = optionalCoordinate(o.x, `${nestedKey}.x`);
    const y = optionalCoordinate(o.y, `${nestedKey}.y`);
    if (x !== undefined && y !== undefined) return { x, y };
  }
  const fx = optionalCoordinate(args[flatXKey], flatXKey);
  const fy = optionalCoordinate(args[flatYKey], flatYKey);
  if (fx !== undefined && fy !== undefined) return { x: fx, y: fy };
  throw new BadArgs(
    `Expected ${nestedKey}{x,y} or ${flatXKey}/${flatYKey}`,
  );
}

/**
 * Mouse buttons, in Codex's vocabulary plus the single-letter aliases the
 * official face accepts and the 1..5 numeric convention.
 */
const MOUSE_BUTTON_ALIASES: Readonly<Record<string, CodexMouseButton>> = {
  left: "left",
  middle: "middle",
  right: "right",
  back: "back",
  forward: "forward",
  l: "left",
  m: "middle",
  r: "right",
};

/** Map mouse_button (string name, short alias, or Codex's numeric 1..5). */
function parseMouseButton(value: unknown): CodexMouseButton | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const mapped = MOUSE_BUTTON_ALIASES[value.toLowerCase()];
    if (mapped) return mapped;
    throw new BadArgs(`Unknown mouse_button "${value}"`);
  }
  if (typeof value === "number") {
    const byNumber: Record<number, CodexMouseButton> = {
      1: "left",
      2: "middle",
      3: "right",
      4: "back",
      5: "forward",
    };
    const mapped = byNumber[value];
    if (mapped) return mapped;
    throw new BadArgs(`mouse_button ${value} is out of range (1..5)`);
  }
  throw new BadArgs(`mouse_button must be a string or 1..5`);
}

type ScrollDirection = "up" | "down" | "left" | "right";

const DIRECTION_ALIASES: Readonly<Record<string, ScrollDirection>> = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  u: "up",
  d: "down",
  l: "left",
  r: "right",
};

function parseDirection(value: unknown): ScrollDirection {
  if (typeof value === "string") {
    const mapped = DIRECTION_ALIASES[value.toLowerCase()];
    if (mapped) return mapped;
  }
  throw new BadArgs(`direction must be one of up/down/left/right`);
}

const VALID_SELECT_MODES: ReadonlySet<string> = new Set([
  "text",
  "cursor_before",
  "cursor_after",
]);

type SelectionMode = "text" | "cursor_before" | "cursor_after";

/** Parse the select_text `selection_type`, defaulting to "text". */
function parseSelectionType(value: unknown): SelectionMode {
  if (value === undefined || value === null) return "text";
  if (typeof value === "string" && VALID_SELECT_MODES.has(value)) {
    return value as SelectionMode;
  }
  throw new BadArgs(`Invalid text selection mode: ${String(value)}`);
}

/**
 * Build the `AppTarget` from the `app` arg (name | bundle id | path | numeric
 * pid string).
 *
 * Fails closed on anything missing or malformed. There is deliberately no
 * "empty target means frontmost" branch: that fallback turns a typo into an
 * action against whatever window happens to be in front — including our own.
 */
function parseTarget(args: Record<string, unknown>): AppTarget {
  const raw = args.app;
  if (typeof raw !== "string") {
    throw new BadArgs(
      `Missing required string "app" — name the application to target`,
    );
  }
  const app = raw.trim();
  if (app === "") {
    throw new BadArgs(
      `Missing required string "app" — name the application to target`,
    );
  }
  if (/^\d+$/.test(app)) return { pid: Number(app) };
  return { app };
}

// ---------------------------------------------------------------------------
// Lock-acquire deferral (preserved contract for bindSessionContext)
// ---------------------------------------------------------------------------

/**
 * Tools that check the global CU lock but don't acquire it. Read-only probes
 * shouldn't fire the "Claude is using your computer" overlay/notification — the
 * lock is taken on the first state-changing or state-reading-of-an-app tool.
 *
 * `list_apps` defers (a bare enumeration is not "using" any app). Everything
 * else — including `get_app_state` — acquires, because reading an app's tree is
 * the start of a real CU interaction and the overlay should appear.
 *
 * Exported for `bindSessionContext` (mcpServer.ts) so its async lock gate uses
 * the same set as the sync gate here.
 */
export function defersLockAcquire(toolName: string): boolean {
  return toolName === "list_apps";
}

/** Preserved no-op export (mcpServer.ts + the old lock path call it on a fresh
 *  lock holder). The Codex face holds no cross-call mouse-button state, so there
 *  is nothing to clear — kept for call-site compatibility. */
export function resetMouseButtonHeld(): void {
  /* no cross-call mouse state in the semantic engine */
}

// ---------------------------------------------------------------------------
// Safety denylist (Codex's exact refusal text)
// ---------------------------------------------------------------------------

/**
 * Refusal check against a RESOLVED target — the real bundle id and display
 * name of the process we are about to drive, not the string the model typed.
 *
 * "Denied" spans three lists:
 *   • the intrinsic set (our own app and helper) — permanent, ungrantable;
 *   • the category denylist (browsers, terminals/IDEs, trading apps), matching
 *     Codex's behavior of refusing iTerm/Chrome;
 *   • the media/DRM policy list (Netflix, Spotify, Kindle, …).
 *
 * `requestedApp` only shapes the message — the model should see the name it
 * used. `hostBundleId` extends the intrinsic set for builds whose bundle id
 * differs from the shipped default.
 */
function policyDenyMessage(
  resolved: { bundleId?: string; displayName?: string },
  requestedApp?: string,
  hostBundleId?: string,
): string | undefined {
  const bundleId = resolved.bundleId;
  const displayName = resolved.displayName ?? bundleId ?? requestedApp ?? "";
  const denied =
    isIntrinsicAppDenied(bundleId, hostBundleId) ||
    getDeniedCategoryForApp(bundleId, displayName) !== null ||
    isPolicyDenied(bundleId, displayName);
  if (!denied) return undefined;
  const shown = requestedApp ?? displayName ?? bundleId ?? "";
  // Matches Codex: "Computer Use is not allowed to use the app '<app>' for
  // safety reasons."
  return `Computer Use is not allowed to use the app '${shown}' for safety reasons.`;
}

/**
 * Apps whose `<app_specific_instructions>` block has already been delivered.
 *
 * The guidance is static per app, so re-sending it on every `get_app_state`
 * spends tokens to restate something the model already has — and in a long
 * session it crowds out the state the model actually asked for. Codex tracks
 * the same thing per client session and only ever emits the block once.
 *
 * Keyed by bundle id where the daemon resolved one, else by what the model
 * asked for, mirroring Codex's own fallback.
 */
const deliveredAppInstructions = new Set<string>();

/** Strip the instructions block if this app has already received it. */
function instructionsOncePerApp(
  state: AppStateResult,
  requestedApp: string,
): AppStateResult {
  if (!state.appInstructions?.trim()) return state;
  const key = state.bundleId ?? requestedApp;
  if (deliveredAppInstructions.has(key)) {
    return { ...state, appInstructions: undefined };
  }
  deliveredAppInstructions.add(key);
  return state;
}

// ---------------------------------------------------------------------------
// Static request parsing — everything that can be decided without any IO
// ---------------------------------------------------------------------------

/**
 * A fully-validated request. Producing one costs nothing (no TCC probe, no
 * lock, no daemon round-trip), so a malformed call is rejected before it can
 * pop a permission dialog or wake the daemon.
 *
 * `run` receives the dispatch target — the resolved process, once resolution
 * and authorization have happened.
 */
interface ParsedRequest {
  /** Undefined for `list_apps`, which targets nothing. */
  target?: AppTarget;
  /** What the model typed, for messages and the approval dialog. */
  requestedApp?: string;
  mutating: boolean;
  run(engine: CodexComputerEngine, target: AppTarget): Promise<CuCallToolResult>;
}

const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "click",
  "perform_secondary_action",
  "set_value",
  "select_text",
  "scroll",
  "drag",
  "press_key",
  "type_text",
  "paste",
]);

const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  "list_apps",
  "get_app_state",
  ...MUTATING_TOOLS,
]);

function parseRequest(
  name: string,
  args: Record<string, unknown>,
  grantFlags: CuGrantFlags | undefined,
  platform: "darwin" | "win32",
): ParsedRequest {
  if (name === "list_apps") {
    return {
      mutating: false,
      run: async engine => okText(await engine.listApps()),
    };
  }

  const target = parseTarget(args);
  const requestedApp = (args.app as string).trim();
  const mutating = MUTATING_TOOLS.has(name);
  const base = { target, requestedApp, mutating };

  switch (name) {
    case "get_app_state": {
      rejectAliasConflict(
        args.disableDiff !== undefined,
        args.disable_diff !== undefined,
        "disableDiff",
        "disable_diff",
      );
      const disableDiff =
        optionalBoolean(args.disableDiff, "disableDiff") ??
        optionalBoolean(args.disable_diff, "disable_diff");
      return {
        ...base,
        run: async (engine, t) =>
          frameAppStateEnvelope(
            instructionsOncePerApp(
              disableDiff === undefined
                ? await engine.getAppState(t)
                : await engine.getAppState(t, { disableDiff }),
              requestedApp,
            ),
          ),
      };
    }

    case "click": {
      const index = parseElementHandle(args.element_index);
      const x = optionalCoordinate(args.x, "x");
      const y = optionalCoordinate(args.y, "y");
      // A half-given point is its own mistake, and worth saying so: silently
      // falling back to the handle (or to nothing) hides the typo.
      if ((x === undefined) !== (y === undefined)) {
        throw new BadArgs("click x and y must be provided together");
      }
      if (index === undefined && x === undefined) {
        throw new BadArgs("click requires element_index, or both x and y");
      }
      const rawCount = optionalNumber(args.click_count, "click_count");
      if (
        rawCount !== undefined &&
        (!Number.isInteger(rawCount) || rawCount < 1 || rawCount > 3)
      ) {
        throw new BadArgs(`click_count must be an integer from 1 to 3`);
      }
      const button = parseMouseButton(args.mouse_button);
      return {
        ...base,
        run: async (engine, t) => {
          await engine.click({
            target: t,
            index,
            x,
            y,
            clickCount: rawCount,
            button,
          });
          return okText(MUTATION_RECEIPT);
        },
      };
    }

    case "perform_secondary_action": {
      const index = parseElementHandle(args.element_index);
      if (index === undefined) {
        throw new BadArgs("perform_secondary_action requires element_index");
      }
      const action = requiredString(args, "action");
      return {
        ...base,
        run: async (engine, t) => {
          await engine.performSecondaryAction({ target: t, index, action });
          return okText(MUTATION_RECEIPT);
        },
      };
    }

    case "set_value": {
      const index = parseElementHandle(args.element_index);
      if (index === undefined) {
        throw new BadArgs("set_value requires element_index");
      }
      // value is required but may legitimately be the empty string (clear a field).
      const value = args.value;
      if (typeof value !== "string") {
        throw new BadArgs('Missing required string "value"');
      }
      return {
        ...base,
        run: async (engine, t) => {
          await engine.setValue({ target: t, index, value });
          return okText(MUTATION_RECEIPT);
        },
      };
    }

    case "select_text": {
      const index = parseElementHandle(args.element_index);
      if (index === undefined) {
        throw new BadArgs("select_text requires element_index");
      }
      const text = requiredString(args, "text");
      const prefix = optionalString(args.prefix);
      const suffix = optionalString(args.suffix);
      rejectAliasConflict(
        args.selection !== undefined,
        args.selection_type !== undefined,
        "selection",
        "selection_type",
      );
      const selection = parseSelectionType(args.selection ?? args.selection_type);
      return {
        ...base,
        run: async (engine, t) => {
          await engine.selectText({
            target: t,
            index,
            text,
            prefix,
            suffix,
            selection,
          });
          return okText(MUTATION_RECEIPT);
        },
      };
    }

    case "scroll": {
      const index = parseElementHandle(args.element_index);
      const x = optionalCoordinate(args.x, "x");
      const y = optionalCoordinate(args.y, "y");
      if (index === undefined && (x === undefined || y === undefined)) {
        throw new BadArgs("scroll requires element_index, or both x and y");
      }
      const direction = parseDirection(args.direction);
      rejectAliasConflict(
        args.pages !== undefined,
        args.amount !== undefined,
        "pages",
        "amount",
      );
      const pages =
        optionalNumber(args.pages, "pages") ??
        optionalNumber(args.amount, "amount");
      if (pages !== undefined && (pages <= 0 || pages > 10)) {
        throw new BadArgs(`pages must be greater than 0 and at most 10`);
      }
      return {
        ...base,
        run: async (engine, t) => {
          await engine.scroll({ target: t, index, x, y, direction, pages });
          return okText(MUTATION_RECEIPT);
        },
      };
    }

    case "drag": {
      const hasNested = args.from !== undefined || args.to !== undefined;
      const hasFlat =
        args.from_x !== undefined ||
        args.from_y !== undefined ||
        args.to_x !== undefined ||
        args.to_y !== undefined;
      rejectAliasConflict(hasFlat, hasNested, "from_x/from_y/to_x/to_y", "from/to");
      const from = parsePoint(args, "from", "from_x", "from_y");
      const to = parsePoint(args, "to", "to_x", "to_y");
      const button = parseMouseButton(args.mouse_button);
      return {
        ...base,
        run: async (engine, t) => {
          await engine.drag({ target: t, from, to, button });
          return okText(MUTATION_RECEIPT);
        },
      };
    }

    case "press_key": {
      const key = requiredString(args, "key");
      // The grant bit comes from the SESSION, never from the model's arguments —
      // otherwise the model could authorize its own cmd+q by passing a flag.
      const systemKeyCombos = grantFlags?.systemKeyCombos === true;
      if (!systemKeyCombos && isSystemKeyCombo(key, platform)) {
        throw new GrantRequired(
          `"${key}" crosses application boundaries or can terminate apps. ` +
            "Enable system key combinations in Computer Use settings, then retry.",
        );
      }
      return {
        ...base,
        run: async (engine, t) => {
          await engine.pressKey({ target: t, key, systemKeyCombos });
          return okText(MUTATION_RECEIPT);
        },
      };
    }

    case "type_text": {
      // text is required but the empty string is a valid (no-op) request.
      const text = args.text;
      if (typeof text !== "string") {
        throw new BadArgs('Missing required string "text"');
      }
      return {
        ...base,
        run: async (engine, t) => {
          await engine.typeText({ target: t, text });
          return okText(MUTATION_RECEIPT);
        },
      };
    }

    case "paste": {
      const text = args.text;
      if (typeof text !== "string") {
        throw new BadArgs('Missing required string "text"');
      }
      const format = requiredString(args, "format");
      if (format !== "text" && format !== "md" && format !== "html") {
        throw new BadArgs('paste format must be "text", "md", or "html"');
      }
      return {
        ...base,
        run: async (engine, t) => {
          await engine.paste({ target: t, text, format });
          return okText(MUTATION_RECEIPT);
        },
      };
    }

    default:
      throw new BadArgs(`Unknown computer-use tool "${name}".`);
  }
}

/**
 * Run only the static half of the pipeline and report the error it would
 * produce, if any.
 *
 * `bindSessionContext` calls this before its own asynchronous lock gate so a
 * malformed request costs nothing: no TCC probe, no cross-process lock, no
 * approval dialog. Parsing is pure, so doing it here and again inside
 * `handleToolCall` is free of side effects.
 */
export function staticRequestError(
  name: string,
  args: unknown,
  grantFlags: CuGrantFlags | undefined,
  platform: "darwin" | "win32",
): CuCallToolResult | undefined {
  if (!KNOWN_TOOLS.has(name)) {
    return errorResult(`Unknown computer-use tool "${name}".`, "bad_args");
  }
  try {
    parseRequest(name, asRecord(args), grantFlags, platform);
    return undefined;
  } catch (err) {
    if (err instanceof GrantRequired) {
      return errorResult(err.message, "grant_flag_required");
    }
    if (err instanceof BadArgs) {
      return errorResult(`Tool "${name}": ${err.message}`, "bad_args");
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Resolved-target authorization
// ---------------------------------------------------------------------------

/**
 * The lifetime identity that proves this pid is still the process we resolved.
 *
 * A pid alone is not proof: pids are recycled, so acting on one we resolved a
 * moment ago can land on whatever inherited the number. `launchTime` is the
 * discriminator, so a resolution that lacks it cannot authorize a mutation.
 */
function provenIdentity(
  resolved: ResolvedAppTarget,
): ProcessIdentity | undefined {
  if (resolved.processIdentity) return resolved.processIdentity;
  const pid = resolved.pid;
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
    return undefined;
  }
  if (typeof resolved.launchTime !== "number") return undefined;
  return {
    pid,
    bundleId: resolved.bundleId,
    executablePath: resolved.executablePath,
    launchTime: resolved.launchTime,
  };
}

/**
 * The target the engine is actually told to act on. Prefer the canonical pid
 * plus its lifetime identity so the daemon re-checks the process before acting;
 * fall back to the original selector when resolution produced no running pid
 * (an installed-but-not-running app, which `get_app_state` may still address).
 */
function dispatchTarget(
  resolved: ResolvedAppTarget,
  original: AppTarget,
): AppTarget {
  const pid = resolved.pid;
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
    return original;
  }
  const identity = provenIdentity(resolved);
  return identity ? { pid, expectedProcessIdentity: identity } : { pid };
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

function getEngine(adapter: ComputerUseHostAdapter): CodexComputerEngine | undefined {
  return adapter.executor.engine;
}

/**
 * Entry point used by `bindSessionContext` (MCP) and `wrapper.tsx` (CLI host).
 * Runs the gates in the order documented at the top of this file, then
 * dispatches to the engine.
 */
export async function handleToolCall(
  adapter: ComputerUseHostAdapter,
  name: string,
  args: unknown,
  rawOverrides: ComputerUseOverrides,
): Promise<CuCallToolResult> {
  const { logger, serverName } = adapter;
  const overrides = rawOverrides;

  // ─── Gate 1: kill switch ─────────────────────────────────────────────
  if (adapter.isDisabled()) {
    return errorResult(
      "Computer control is disabled in Settings. Enable it and try again.",
      "other",
    );
  }

  // Unknown tool → clean error (defensive; ListTools only advertises the ten).
  if (!KNOWN_TOOLS.has(name)) {
    return errorResult(`Unknown computer-use tool "${name}".`, "bad_args");
  }

  const a = asRecord(args);
  logger.silly(
    `[${serverName}] tool=${name} args=${JSON.stringify(a).slice(0, 200)}`,
  );

  // ─── Gate 2: static request validation (pure — no IO, no prompts) ────
  let request: ParsedRequest;
  try {
    request = parseRequest(
      name,
      a,
      overrides.grantFlags,
      adapter.executor.capabilities.platform,
    );
  } catch (err) {
    if (err instanceof GrantRequired) {
      return errorResult(err.message, "grant_flag_required");
    }
    if (err instanceof BadArgs) {
      return errorResult(`Tool "${name}": ${err.message}`, "bad_args");
    }
    throw err;
  }

  // ─── Gate 3: TCC (Accessibility + Screen Recording) ──────────────────
  // The daemon re-checks AX-trusted authoritatively; this is the early bail
  // that lets the host pop its guided permission card.
  const osPerms = await adapter.ensureOsPermissions();
  if (!osPerms.granted) {
    return errorResult(
      "Accessibility and Screen Recording permissions are required for " +
        "Computer Use. Grant them in System Settings and try again.",
      "tcc_not_granted",
    );
  }

  // ─── Gate 4: global CU lock ──────────────────────────────────────────
  const deferAcquire = defersLockAcquire(name);
  const lock = overrides.checkCuLock?.();
  if (lock) {
    if (lock.holder !== undefined && !lock.isSelf) {
      return errorResult(
        "Another Claude session is currently using the computer. Wait for " +
          "the user to acknowledge it is finished (stop button in the Claude " +
          "window), or find a non-computer-use approach if one is readily " +
          "apparent.",
        "cu_lock_held",
      );
    }
    if (lock.holder === undefined && !deferAcquire) {
      overrides.acquireCuLock?.();
    }
  }

  // ─── Gate 5: engine present ──────────────────────────────────────────
  const engine = getEngine(adapter);
  if (!engine) {
    return errorResult(
      "Computer Use is not available on this platform (the native " +
        "accessibility engine is not wired).",
      "feature_unavailable",
    );
  }

  try {
    // list_apps targets nothing — no resolution, no authorization.
    if (!request.target) {
      return await request.run(engine, {});
    }

    // ─── Gate 6: resolve the selector to one running process ───────────
    const resolved = await engine.resolveTarget(request.target);
    const requestedApp = request.requestedApp ?? "";

    // ─── Gate 7: denylists, against the RESOLVED identity ──────────────
    const denied = policyDenyMessage(
      resolved,
      requestedApp,
      adapter.executor.capabilities.hostBundleId,
    );
    if (denied) return errorResult(denied, "app_denied");

    // ─── Gate 8: proven process lifetime (mutations only) ──────────────
    if (request.mutating && !provenIdentity(resolved)) {
      return errorResult(
        `Resolving '${requestedApp}' did not prove the running process ` +
          "lifetime, so the action was not performed. Call get_app_state to " +
          "re-establish the target, then retry.",
        "executor_threw",
      );
    }

    // ─── Dispatch ──────────────────────────────────────────────────────
    return await request.run(engine, dispatchTarget(resolved, request.target));
  } catch (err) {
    // A daemon-level error (staleness warning, not_trusted, invalid action,
    // not-settable, …). Surface its message verbatim — these strings are part
    // of the Codex-compatible protocol (e.g. the §6 "user changed '<app>'"
    // warning, "Element handle g17:99 not found in snapshot (has M elements).",
    // "<action> is not a valid secondary action for <handle>").
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[${serverName}] tool=${name} failed: ${msg}`, err);
    return errorResult(msg, "executor_threw");
  }
}

// ---------------------------------------------------------------------------
// Test surface (mirrors the old `_test` export shape; unit tests import this)
// ---------------------------------------------------------------------------

export const _test = {
  frameAppStateEnvelope,
  /** Clear the per-app instruction delivery ledger between tests. */
  resetDeliveredAppInstructions: () => deliveredAppInstructions.clear(),
  parseElementHandle,
  parseMouseButton,
  parseDirection,
  parseTarget,
  parsePoint,
  policyDenyMessage,
  provenIdentity,
  dispatchTarget,
  CUA_APP_VERSION,
  FOCUS_PREFIX,
  MUTATING_TOOLS,
};
