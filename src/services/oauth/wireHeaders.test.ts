/**
 * What the OAuth endpoints actually see on the wire.
 *
 * Anthropic receives these requests from the Claude Code CLI's own axios code,
 * so they must look like the CLI's: axios' default User-Agent and Accept, and
 * `claude-code/<version>` on the profile call. Asserted against a loopback
 * server so the headers are the ones axios really sends, not the ones passed in.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { CLAUDE_CODE_COMPAT_VERSION } from '../../constants/claudeCodeCompatibility.js'
// Imported statically on purpose: these tests switch USER_TYPE to `ant` to reach
// the local OAuth config, and modules first loaded under that value would keep
// their ant-only module-level branches for the rest of a shared test process.
import { HahaOAuthService } from '../../server/services/hahaOAuthService.js'
import { exchangeCodeForTokens } from './client.js'
import { getOauthProfileFromOauthToken } from './getOauthProfile.js'

// The axios release the Claude Code CLI ships. Its default User-Agent is part of
// the wire identity, so a dependency bump has to be a deliberate decision.
const OFFICIAL_AXIOS_VERSION = '1.15.2'

type Recorded = {
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

const ENV_KEYS = [
  'USER_TYPE',
  'USE_LOCAL_OAUTH',
  'CLAUDE_LOCAL_OAUTH_API_BASE',
  'CLAUDE_CONFIG_DIR',
] as const

const originalEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

let server: ReturnType<typeof Bun.serve>
let configDir: string
const recorded: Recorded[] = []

beforeAll(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-wire-test-'))
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      recorded.push({
        method: req.method,
        path: url.pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body: await req.text(),
      })
      if (url.pathname === '/v1/oauth/token') {
        return Response.json({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          scope: 'user:inference user:profile',
        })
      }
      if (url.pathname === '/api/oauth/profile') {
        return Response.json({
          account: {
            uuid: 'account-uuid',
            email: 'user@example.com',
            display_name: 'User',
            created_at: '2026-01-01T00:00:00Z',
          },
          organization: {
            uuid: 'org-uuid',
            organization_type: 'claude_max',
            billing_type: 'stripe_subscription',
            has_extra_usage_enabled: false,
          },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })

  process.env.USER_TYPE = 'ant'
  process.env.USE_LOCAL_OAUTH = '1'
  process.env.CLAUDE_LOCAL_OAUTH_API_BASE = `http://127.0.0.1:${server.port}`
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterAll(async () => {
  server.stop(true)
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(configDir, { recursive: true, force: true })
})

function lastRequest(pathname: string): Recorded {
  const match = [...recorded].reverse().find(r => r.path === pathname)
  if (!match) throw new Error(`no request recorded for ${pathname}`)
  return match
}

describe('OAuth requests on the wire', () => {
  test('pins the axios version whose User-Agent the CLI sends', async () => {
    const pkg = JSON.parse(
      await fs.readFile(
        path.join(import.meta.dir, '../../../node_modules/axios/package.json'),
        'utf-8',
      ),
    ) as { version: string }
    expect(pkg.version).toBe(OFFICIAL_AXIOS_VERSION)
  })

  test('authorization-code exchange looks like the CLI axios call', async () => {
    await exchangeCodeForTokens('code', 'state', 'verifier', 54321, false, undefined, {
      proxyUrl: null,
    })

    const req = lastRequest('/v1/oauth/token')
    expect(req.method).toBe('POST')
    expect(req.headers['user-agent']).toBe(`axios/${OFFICIAL_AXIOS_VERSION}`)
    expect(req.headers.accept).toBe('application/json, text/plain, */*')
    expect(req.headers['content-type']).toBe('application/json')
    expect(JSON.parse(req.body)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code',
      redirect_uri: 'http://localhost:54321/callback',
      code_verifier: 'verifier',
      state: 'state',
    })
  })

  test('the desktop server exchange goes through the same CLI request', async () => {
    const service = new HahaOAuthService()
    const session = service.startSession({ serverPort: 54322 })

    await service.completeSession('code-2', session.state)

    const req = lastRequest('/v1/oauth/token')
    expect(req.headers['user-agent']).toBe(`axios/${OFFICIAL_AXIOS_VERSION}`)
    expect(req.headers.accept).toBe('application/json, text/plain, */*')
    expect(JSON.parse(req.body).redirect_uri).toBe('http://localhost:54322/callback')
  })

  test('profile lookup identifies as claude-code and bypasses caches', async () => {
    const profile = await getOauthProfileFromOauthToken('access-token', {
      proxyUrl: null,
    })

    expect(profile?.account.uuid).toBe('account-uuid')
    const req = lastRequest('/api/oauth/profile')
    expect(req.headers['user-agent']).toBe(`claude-code/${CLAUDE_CODE_COMPAT_VERSION}`)
    expect(req.headers.authorization).toBe('Bearer access-token')
    expect(req.headers['cache-control']).toBe('no-cache')
    expect(req.headers['content-type']).toBe('application/json')
  })
})
