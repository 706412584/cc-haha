/**
 * Shared code-signing identity resolution for the macOS build.
 *
 * WHY THIS EXISTS
 * ---------------
 * The native Computer Use helper refuses commands unless its caller chain is
 * cryptographically the desktop app: `ClientAttestation.swift` requires the
 * host (`com.claude-code-haha.desktop`), the sidecar
 * (`com.claude-code-haha.desktop.sidecar`) and the helper
 * (`dev.cchaha.cu-helper`) to share one signing certificate — same team, same
 * leaf. If any link is ad-hoc or signed by a different cert, every helper call
 * returns `unauthorized_client` and Computer Use is dead in the water.
 *
 * Three separate build steps produce those three binaries (electron-builder,
 * `build-sidecars.ts`, `native/cu-helper/build.sh`), so they need one shared
 * answer to "which certificate?". That answer lives here.
 *
 * Preference order — Developer ID FIRST, deliberately:
 *   1. `CC_HAHA_SIGN_IDENTITY` — explicit override, trusted verbatim.
 *   2. `Developer ID Application: …` — long-lived, notarizable, distributable.
 *      TCC grants are keyed to the signing identity, so a cert that does not
 *      expire yearly is what keeps the user's Accessibility + Screen Recording
 *      grants alive across rebuilds.
 *   3. `Apple Development: …` — works, but expires in about a year, and the
 *      replacement cert silently invalidates every TCC grant.
 *   4. none → caller decides (ad-hoc for local unsigned builds).
 *
 * `native/cu-helper/build.sh` mirrors this order in shell; keep the two in sync.
 */

/** A code-signing identity's full common name, as `codesign --sign` wants it. */
export type SigningIdentity = string

export function codesignTimestampArgument(identity: SigningIdentity | null): '--timestamp' | '--timestamp=none' {
  return identity?.startsWith('Developer ID Application:')
    ? '--timestamp'
    : '--timestamp=none'
}

/** The fixed code-signing identifier the helper's attestation policy expects. */
export const SIDECAR_SIGNING_IDENTIFIER = 'com.claude-code-haha.desktop.sidecar'

/**
 * Pick a stable signing identity out of `security find-identity -v -p codesigning`
 * output. Pure so the preference order is unit-testable without a keychain.
 *
 * @param securityOutput raw stdout of `security find-identity -v -p codesigning`
 * @param override value of `CC_HAHA_SIGN_IDENTITY`, if set
 * @returns the identity's common name, or null when nothing stable is available
 */
export function resolveStableSigningIdentity(
  securityOutput: string,
  override?: string | null,
): SigningIdentity | null {
  const rows: Array<{ hash: string; name: string }> = []
  for (const line of securityOutput.split('\n')) {
    const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/i.exec(line)
    if (match) rows.push({ hash: match[1].toUpperCase(), name: match[2] })
  }

  const explicit = override?.trim()
  if (explicit) {
    // `codesign --sign` accepts a SHA-1 fingerprint, but downstream timestamp
    // policy needs the certificate kind. Resolve a matching hash to its common
    // name so Developer ID sidecars cannot accidentally ship without a secure
    // timestamp. Unknown overrides remain trusted verbatim and will fail at
    // codesign if they truly do not exist.
    if (/^[0-9A-F]{40}$/i.test(explicit)) {
      return rows.find(row => row.hash === explicit.toUpperCase())?.name ?? explicit
    }
    return explicit
  }

  // Rows look like:  1) <40-hex-sha> "Developer ID Application: Name (TEAMID)"
  // Only the quoted common name is meaningful to `codesign --sign`.
  const names = rows.map(row => row.name)

  return (
    names.find(name => name.startsWith('Developer ID Application:')) ??
    names.find(name => name.startsWith('Apple Development:')) ??
    null
  )
}

/**
 * Read the keychain and resolve the identity the whole build should use.
 * Returns null when no stable identity exists (the machine can still produce an
 * ad-hoc build; Computer Use just will not pass attestation on it).
 */
export async function detectStableSigningIdentity(): Promise<SigningIdentity | null> {
  if (process.platform !== 'darwin') return null
  try {
    const proc = Bun.spawn(
      ['security', 'find-identity', '-v', '-p', 'codesigning'],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return resolveStableSigningIdentity(
      stdout,
      process.env.CC_HAHA_SIGN_IDENTITY,
    )
  } catch {
    return null
  }
}
