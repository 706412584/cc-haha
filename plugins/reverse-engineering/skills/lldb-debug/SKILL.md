---
name: lldb-debug
description: Real single-step debugging via LLDB MCP. macOS / iOS (debugserver) / Linux. Set breakpoints, step, read/write registers and memory, walk the call stack, watchpoints, disassemble. Stronger than GDB for ObjC/Swift symbol handling, dyld shared cache, and Apple platform internals.
whenToUse: When the target is on macOS or an iOS device (jailbroken or developer-signed), or when you need LLDB's superior ObjC/Swift handling on Linux. Particularly important for analysing iOS apps post-FairPlay-decryption.
allowedTools: Bash, Read
---

# lldb-debug skill

Goal: same goal as `gdb-debug` — single-step, set breakpoints, read state —
but on Apple platforms or wherever LLDB's symbol handling beats GDB.

## When this skill is the right pick

| Question | This skill | Pick something else |
|---|---|---|
| "Step through an ObjC `-[NSString componentsSeparatedByString:]`" | ✅ lldb-debug | LLDB knows ObjC method signatures natively |
| "Inspect a Swift `Array<T>` at runtime" | ✅ lldb-debug | LLDB has a Swift formatter; GDB doesn't |
| "Debug an iOS app on a jailbroken device" | ✅ lldb-debug + debugserver | — |
| "Debug a macOS framework's dyld load order" | ✅ lldb-debug (`image list`, `image dump line-table`) | — |
| "Embedded MIPS firmware in QEMU" | ❌ — use gdb-debug | LLDB's cross-arch is weaker than gdb-multiarch |
| "PowerPC e200 ECU dump" | ❌ — use gdb-debug | LLDB doesn't ship PPC32 by default |
| "Hook every NSURLSession on iOS for an hour" | ❌ — use frida-dynamic | LLDB single-step is too slow for broad surveys |

## Tool selection

- **`lldb` MCP** (`lldb` server in this plugin) — wraps `stass/lldb-mcp`
  via uvx. Provides `lldb_start`, `lldb_load`, `lldb_attach`, `lldb_run`,
  `lldb_continue`, `lldb_step`, `lldb_next`, `lldb_finish`, `lldb_kill`,
  `lldb_set_breakpoint`, `lldb_breakpoint_list`, `lldb_breakpoint_delete`,
  `lldb_watchpoint`, `lldb_backtrace`, `lldb_print`, `lldb_examine`,
  `lldb_info_registers`, `lldb_frame_info`, `lldb_disassemble`,
  `lldb_thread_list`, `lldb_thread_select`, plus `lldb_command` for
  arbitrary LLDB commands.

The MCP just wraps a real LLDB. If a workflow is documented for LLDB
proper, it works here through `lldb_command`.

## Setup paths

### Path A — local macOS or Linux binary

Easiest case. LLDB is on PATH (`xcrun lldb` on macOS, `apt install lldb` on
Debian, `dnf install lldb` on Fedora).

```text
lldb: lldb_start                                          # spawn session, returns sessionId
lldb: lldb_load path=/path/to/binary sessionId=<id>
lldb: lldb_set_breakpoint location=main sessionId=<id>
lldb: lldb_run sessionId=<id>
```

### Path B — attach to a running PID

macOS / Linux:

```text
lldb: lldb_attach sessionId=<id> pid=12345
```

macOS requires either Apple developer signing on your `lldb` binary, or
running as root. iOS in this mode is **only** for the simulator — for a
real device, see Path C.

### Path C — iOS device (jailbroken, with debugserver)

On the device:

```bash
# Push debugserver to /usr/bin (jailbroken; one-time setup)
debugserver *:1234 -a <pid>           # attach mode
# OR
debugserver *:1234 /Applications/Foo.app/Foo   # spawn mode
```

On your Mac:

```text
lldb: lldb_start
lldb: lldb_command command="platform select remote-ios"
lldb: lldb_command command="process connect connect://<device-ip>:1234"
```

Note iOS apps from the App Store arrive **FairPlay-encrypted** — the
`__TEXT` segment is unreadable until you've dumped the decrypted binary
(via `frida-ios-dump` / `bagbak`). Without that, breakpoints in app code
won't resolve to anything meaningful. State this in the report.

### Path D — Linux gdbserver-style remote (lldb-server)

LLDB has its own remote daemon, `lldb-server`:

```bash
# On target:
lldb-server platform --listen *:1234
# OR for a specific binary:
lldb-server gdbserver *:1234 -- ./binary
```

On your host:

```text
lldb: lldb_command command="platform select remote-linux"
lldb: lldb_command command="platform connect connect://<ip>:1234"
lldb: lldb_load path=/local/path/to/binary
```

## Procedure — once you're connected

### Step 1 — Symbols

LLDB picks up symbols automatically if dSYM bundles are next to the
binary or in the dyld shared cache. For stripped binaries:

```text
lldb: lldb_command command="image list"                   # what's loaded
lldb: lldb_command command="add-dsym /path/to/Foo.app.dSYM"
lldb: lldb_command command="image lookup -n <SymbolName>"
```

For ObjC, classes/methods come from the `__objc_*` sections in the binary
itself — no separate `.dSYM` needed. `lldb_command command="image lookup
-n -[NSString componentsSeparatedByString:]"` works on stripped binaries.

### Step 2 — Set breakpoints

```text
lldb: lldb_set_breakpoint location=main
lldb: lldb_set_breakpoint location="-[ViewController viewDidAppear:]"
lldb: lldb_set_breakpoint location="0x100001a30"           # by address
lldb: lldb_command command="breakpoint set --regex '^cleartext_.*'"
                                                           # all funcs starting with cleartext_

# Conditional + commands on hit:
lldb: lldb_command command="breakpoint set -n send -c '$arg2 != 0'"
lldb: lldb_command command="breakpoint command add 1
> bt 5
> register read x0 x1
> continue
> DONE"
```

Watchpoints (break on memory access):

```text
lldb: lldb_watchpoint variable="g_state" type=write
lldb: lldb_command command="watchpoint set expression -- 0x100008020"
lldb: lldb_command command="watchpoint modify -c '*((int*)0x100008020) > 0'"
```

### Step 3 — Step / continue

```text
lldb: lldb_continue
lldb: lldb_step                                            # step into (source-line if symbols, instruction otherwise)
lldb: lldb_next                                            # step over
lldb: lldb_finish                                          # run to current function return

# Single-instruction stepping:
lldb: lldb_command command="thread step-inst"              # stepi equiv
lldb: lldb_command command="thread step-inst-over"         # nexti equiv
lldb: lldb_disassemble count=10                            # disasm at PC
```

### Step 4 — Read state

```text
lldb: lldb_info_registers                                  # all GP regs
lldb: lldb_command command="register read --all"           # incl. FP/NEON/SVE
lldb: lldb_print expression="argv[1]"
lldb: lldb_print expression="*(unsigned int*)0x100008020"
lldb: lldb_examine expression="0x100008000" format="x" size="word" count=64
lldb: lldb_backtrace
lldb: lldb_thread_list
lldb: lldb_thread_select id=2

# ObjC-specific:
lldb: lldb_command command="po self"                      # describe current ObjC instance
lldb: lldb_command command="po (id)$x0"                   # treat register as ObjC id
lldb: lldb_command command="expression -l objc -- (id)NSStringFromClass([self class])"

# Swift-specific (when LLDB is Swift-aware):
lldb: lldb_command command="frame variable"
lldb: lldb_command command="expression -l swift -- self.someProperty"
```

### Step 5 — Modify state

```text
lldb: lldb_command command="register write x0 0x0"
lldb: lldb_command command="memory write -s 4 0x100008020 0x0000dead"
lldb: lldb_command command="thread jump --by 8"            # skip 8 bytes ahead
```

Same caveat as in `gdb-debug`: in-memory patches don't change the
binary on disk, but they DO change what the process sees. Document.

### Step 6 — Disassemble around a stuck point

```text
lldb: lldb_disassemble                                     # disasm current frame
lldb: lldb_command command="disassemble -a 0x100001a30 -c 32"
lldb: lldb_command command="disassemble -n -[NSString length]"
                                                           # by symbol name
```

## Outputs

Write to `ARTIFACT_DIR/<sample-id>/dynamic-lldb.md`:

```markdown
# Dynamic (LLDB) — <sample-id>

## Question
<the one runtime question>

## Setup
- Platform: macOS / iOS-device / iOS-simulator / Linux
- Architecture: <x86_64 / arm64>
- Binary: <path>
- FairPlay status (iOS only): encrypted / decrypted dump
- LLDB version: <output of `lldb --version`>
- Auth: <user-authorised, device X owned by user, etc.>

## Breakpoints / watchpoints
| Where | Type | Hit count | Note |

## Captures
| Time | Location | Register/Memory/ObjC | Value | Comment |

## Verdict
<the answer, citing captures>

## What we did NOT cover
- ...
```

## Hard rules

- **iOS App Store binaries are FairPlay-encrypted.** Breakpoints in
  app code resolve to garbage until you've debugged a decrypted dump.
  State the encryption status before any other claim.
- **macOS SIP and notarisation gates.** Some processes can't be
  debugged even by root without disabling SIP or signing your `lldb`
  with the right entitlements (`com.apple.security.cs.debugger`).
  Don't disable SIP on a production machine.
- **Don't reverse-engineer commercial DRM via LLDB on a target you
  don't own.** Same rule as gdb-debug.
- **Don't dump the dyld shared cache** to the report. It's huge and
  sample-specific. Excerpt the symbol/section you need.
- **Confidence is high** for direct LLDB observations.
