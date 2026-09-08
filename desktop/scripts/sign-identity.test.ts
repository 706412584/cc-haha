import { describe, expect, it } from 'vitest'

import {
  SIDECAR_SIGNING_IDENTIFIER,
  codesignTimestampArgument,
  resolveStableSigningIdentity,
} from './sign-identity'

/** Realistic `security find-identity -v -p codesigning` output. */
const BOTH_IDENTITIES = `  1) 6AB17527A9E2AEB0C596F8D9F7728D215A5C0E57 "Apple Development: dev@example.com (F8ZSJJ78S7)"
  2) 5145958D6E31AD0CD6BBACD804A0B357E3CEDEA7 "Developer ID Application: Example Co., Ltd (D3RS24869F)"
     2 valid identities found`

describe('resolveStableSigningIdentity', () => {
  it('prefers Developer ID even when Apple Development is listed first', () => {
    // TCC grants are keyed to the signing identity. Apple Development certs
    // expire in about a year, and the replacement silently drops the user's
    // Accessibility + Screen Recording grants — so listing order must not
    // decide this.
    expect(resolveStableSigningIdentity(BOTH_IDENTITIES)).toBe(
      'Developer ID Application: Example Co., Ltd (D3RS24869F)',
    )
  })

  it('falls back to Apple Development when no Developer ID exists', () => {
    const onlyDev = `  1) 6AB17527A9E2AEB0C596F8D9F7728D215A5C0E57 "Apple Development: dev@example.com (F8ZSJJ78S7)"
     1 valid identities found`
    expect(resolveStableSigningIdentity(onlyDev)).toBe(
      'Apple Development: dev@example.com (F8ZSJJ78S7)',
    )
  })

  it('returns null when the keychain has no code-signing identity', () => {
    expect(resolveStableSigningIdentity('     0 valid identities found')).toBeNull()
    expect(resolveStableSigningIdentity('')).toBeNull()
  })

  it('honours an explicit override verbatim, ahead of auto-detection', () => {
    // The override is how CI pins a specific cert, and how build-macos-arm64.sh
    // hands the SAME identity to the sidecar and the helper.
    expect(
      resolveStableSigningIdentity(BOTH_IDENTITIES, 'Developer ID Application: Other (AAAAAAAAAA)'),
    ).toBe('Developer ID Application: Other (AAAAAAAAAA)')
  })

  it('resolves a SHA-1 override to its Developer ID common name', () => {
    expect(
      resolveStableSigningIdentity(
        BOTH_IDENTITIES,
        '5145958D6E31AD0CD6BBACD804A0B357E3CEDEA7',
      ),
    ).toBe('Developer ID Application: Example Co., Ltd (D3RS24869F)')
  })

  it('ignores a blank override rather than treating it as "no identity"', () => {
    // An unset env var arrives as '' or a stray space; that must not suppress
    // auto-detection and silently produce an ad-hoc build.
    expect(resolveStableSigningIdentity(BOTH_IDENTITIES, '')).toBe(
      'Developer ID Application: Example Co., Ltd (D3RS24869F)',
    )
    expect(resolveStableSigningIdentity(BOTH_IDENTITIES, '   ')).toBe(
      'Developer ID Application: Example Co., Ltd (D3RS24869F)',
    )
    expect(resolveStableSigningIdentity(BOTH_IDENTITIES, null)).toBe(
      'Developer ID Application: Example Co., Ltd (D3RS24869F)',
    )
  })

  it('ignores identity types that cannot satisfy the helper attestation', () => {
    // A self-signed cert has no team identifier, so the helper's
    // validSignerChain() can never match it against the host and sidecar.
    const selfSigned = `  1) 1111111111111111111111111111111111111111 "cu-helper-dev"
     1 valid identities found`
    expect(resolveStableSigningIdentity(selfSigned)).toBeNull()
  })

  it('does not mistake certificate names for the quoted-name column', () => {
    // Defensive: a cert whose name merely contains a quote-like fragment must
    // not shift which text is treated as the identity.
    const odd = `  1) 2222222222222222222222222222222222222222 "Developer ID Application: A "B" Co (TEAMID1234)"
     1 valid identities found`
    expect(resolveStableSigningIdentity(odd)).toBe(
      'Developer ID Application: A "B" Co (TEAMID1234)',
    )
  })
})

describe('SIDECAR_SIGNING_IDENTIFIER', () => {
  it('matches the identifier ClientAttestation.swift compares against', () => {
    // These two constants are a cross-language contract with no compiler to
    // enforce it: ClientAttestation.swift:26 and cuHelperInstall.ts:46 both
    // hard-code this exact string, and the helper rejects every Computer Use
    // call when the sidecar's real identifier differs.
    expect(SIDECAR_SIGNING_IDENTIFIER).toBe('com.claude-code-haha.desktop.sidecar')
  })
})

describe('codesignTimestampArgument', () => {
  it('requires a secure timestamp for Developer ID distribution', () => {
    expect(codesignTimestampArgument('Developer ID Application: Example (TEAMID1234)'))
      .toBe('--timestamp')
  })

  it('keeps local development and ad-hoc signing offline', () => {
    expect(codesignTimestampArgument('Apple Development: Example (TEAMID1234)'))
      .toBe('--timestamp=none')
    expect(codesignTimestampArgument(null)).toBe('--timestamp=none')
  })
})
