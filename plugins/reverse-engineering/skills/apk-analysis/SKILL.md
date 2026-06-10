---
name: apk-analysis
description: Static analysis of Android APKs using JADX (decompilation) and apktool (resources). Extracts the manifest, exported components, permissions, hardcoded secrets, and routes embedded native libs back to native binary analysis.
whenToUse: After triage detects an APK (zip with AndroidManifest.xml). For embedded `.so` files, complete this skill first, then chain to pe-elf-macho.
allowedTools: Bash, Read, Grep, Glob
---

# apk-analysis skill

Goal: turn an opaque APK into a structured picture of (a) the Android attack
surface (manifest, exported components, permissions), (b) the Java/Kotlin code
the developer wrote, and (c) any native code that takes over from there.

## Tool selection

- **JADX MCP** (`jadx` server) — Java/Kotlin decompilation, class browsing,
  string search, xrefs. Required.
- **apktool MCP** (`apktool` server) — resource decoding (manifest in XML form,
  string resources, layouts). Optional; fall back to `aapt2 dump` or
  `unzip + binary plist` if apktool isn't enabled.

If JADX isn't enabled and the user wants Java analysis, tell them to flip
`ENABLE_JADX=true` and stop. Don't try to read DEX bytecode by hand for a real
analysis.

## Procedure

### Step 1 — Manifest and structure

```text
apktool: decode_manifest path=$SAMPLE
# or fallback:
unzip -p "$SAMPLE" AndroidManifest.xml | xxd | head -200   # binary; needs decoding
```

Extract:

- **package name** and **version**
- **min/target SDK**
- **permissions** — flag dangerous ones: `READ_SMS`, `RECEIVE_SMS`, `READ_CONTACTS`,
  `ACCESS_FINE_LOCATION`, `RECORD_AUDIO`, `CAMERA`, `SYSTEM_ALERT_WINDOW`,
  `BIND_ACCESSIBILITY_SERVICE`, `BIND_DEVICE_ADMIN`, `REQUEST_INSTALL_PACKAGES`.
- **exported components** — activities, services, receivers, providers with
  `android:exported="true"` or implicit-export via intent filter on pre-API-31.
  These are reachable from other apps and worth special attention.
- **`debuggable`** flag — if true on a release APK, that's a finding by itself.
- **network security config** — does it allow cleartext, custom CAs?

### Step 2 — Java / Kotlin code

```text
jadx: open path=$SAMPLE
jadx: list_classes
jadx: get_android_manifest          # JADX has its own manifest view
```

Map the goal to a class search (mirror of pe-elf-macho's table):

| Goal | Search |
|---|---|
| Find auth / login | classes/methods named `*login*`, `*signin*`, `*auth*` |
| Find network endpoints | string search for `http://`, `https://`, `wss://`; class search for `Retrofit`, `OkHttp`, `Volley` |
| Find hardcoded secrets | string search for `BEGIN PRIVATE`, `Bearer `, base64 blobs ≥ 40 chars in static fields |
| Find crypto | xrefs to `Cipher.getInstance`, `MessageDigest.getInstance`, `SecretKeySpec` |
| Find native bridge | classes with `loadLibrary` calls; `external` Kotlin functions; JNI methods |

For each interesting method:

```text
jadx: get_method_source class=com.example.X method=Y
jadx: get_method_xrefs class=com.example.X method=Y
```

### Step 3 — Native libraries

If the manifest or `lib/` lists `.so` files:

```bash
unzip -d "$SAMPLE_ID-unpacked" "$SAMPLE" "lib/*"
```

For each `.so`:

1. Note the architecture (`arm64-v8a`, `armeabi-v7a`, `x86_64`).
2. Hand off to the **`pe-elf-macho`** skill — `.so` is ELF.
3. Specifically check JNI registration: search for `JNI_OnLoad` and
   `RegisterNatives` to map Java native methods to native function names (which
   may differ from the Java method name when registered dynamically).

### Step 4 — Resources and assets

```text
apktool: decode_resources path=$SAMPLE
# or:
unzip -d "$SAMPLE_ID-unpacked" "$SAMPLE" "res/*" "assets/*"
```

Look for:

- `assets/` — frequently contains additional payloads, JS bundles (Cordova/React
  Native), embedded models, encrypted blobs.
- `res/raw/` — same.
- `strings.xml` — sometimes contains API URLs not present in code.

### Step 5 — Quick obfuscation check

If most class names are 1–3 characters and look like `a.a.a.b`, the app has
ProGuard/R8 obfuscation. Note this in the report; analysis will focus on
resources, manifest, and native code rather than reading every Java class.

## Outputs

Write to `ARTIFACT_DIR/<sample-id>/static-android.md`:

```markdown
# Static APK analysis — <sample-id>

## Manifest summary
- Package: com.example.x
- Version: 1.2.3 (3014)
- min/target SDK: 21 / 33
- debuggable: false
- Network: cleartext disallowed

## Permissions of interest
| Permission | Risk | Justified by code? |

## Exported components
| Type | Class | Note |

## Hardcoded findings
| Where | Type | Value | Confidence |

## Native libraries
| ABI | File | Routed to |

## Open questions
- ...
```

## Hard rules

- **Don't install the APK on a real device** to extract files. Use static unzip;
  if you need a runtime view, that's `frida-dynamic` on a controlled emulator.
- **Don't expand resource decoding into a full decompilation.** APKs can have
  thousands of resource files. Decode the manifest and grep `assets/`/`res/raw/`;
  don't dump everything to disk.
