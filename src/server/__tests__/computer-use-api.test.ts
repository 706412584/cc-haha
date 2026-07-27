import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
let configDir: string | null = null
let computerUseApi: typeof import('../api/computer-use.js') | null = null

async function importComputerUseApi() {
  if (!computerUseApi) throw new Error('Computer Use API module was not initialized')
  return computerUseApi
}

function makeRequest(method: string, body?: unknown): Request {
  return new Request('http://localhost/api/computer-use/authorized-apps', {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function callAuthorizedApps(method: string, body?: unknown): Promise<Response> {
  const { handleComputerUseApi } = await importComputerUseApi()
  return handleComputerUseApi(
    makeRequest(method, body),
    new URL('http://localhost/api/computer-use/authorized-apps'),
    ['api', 'computer-use', 'authorized-apps'],
  )
}

async function callComputerUseAction(
  action: string,
  method: string,
  body: string,
): Promise<Response> {
  const { handleComputerUseApi } = await importComputerUseApi()
  return handleComputerUseApi(
    new Request(`http://localhost/api/computer-use/${action}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
    new URL(`http://localhost/api/computer-use/${action}`),
    ['api', 'computer-use', action],
  )
}

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-computer-use-api-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  computerUseApi = await import('../api/computer-use.js')
})

beforeEach(async () => {
  if (!configDir) throw new Error('configDir was not initialized')
  process.env.CLAUDE_CONFIG_DIR = configDir
  await rm(join(configDir, 'cc-haha'), { recursive: true, force: true })
  await rm(join(configDir, '.runtime'), { recursive: true, force: true })
})

afterAll(async () => {
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  }

  if (configDir) {
    await rm(configDir, { recursive: true, force: true })
    configDir = null
  }
})

describe('Computer Use API authorized app config', () => {
  it('defaults Computer Use enabled for existing users without config', async () => {
    const res = await callAuthorizedApps('GET')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      enabled: true,
      authorizedApps: [],
    })
  })

  it('persists the Computer Use enabled flag independently', async () => {
    const putRes = await callAuthorizedApps('PUT', { enabled: false })
    expect(putRes.status).toBe(200)

    const getRes = await callAuthorizedApps('GET')
    expect(await getRes.json()).toMatchObject({ enabled: false })

    const raw = await readFile(
      join(configDir!, 'cc-haha', 'computer-use-config.json'),
      'utf8',
    )
    expect(JSON.parse(raw)).toMatchObject({ enabled: false })
  })

  it('persists and normalizes a custom Python interpreter path', async () => {
    const pythonPath = '  C:\\Users\\me\\miniconda3\\envs\\cu\\python.exe  '
    const putRes = await callAuthorizedApps('PUT', { pythonPath })
    expect(putRes.status).toBe(200)

    const getRes = await callAuthorizedApps('GET')
    expect(await getRes.json()).toMatchObject({
      pythonPath: 'C:\\Users\\me\\miniconda3\\envs\\cu\\python.exe',
    })

    const resetRes = await callAuthorizedApps('PUT', { pythonPath: '' })
    expect(resetRes.status).toBe(200)

    const resetGetRes = await callAuthorizedApps('GET')
    expect(await resetGetRes.json()).toMatchObject({ pythonPath: null })
  })

  it('preserves asymmetric clipboard permissions', async () => {
    const putRes = await callAuthorizedApps('PUT', {
      grantFlags: {
        clipboardRead: true,
        clipboardWrite: false,
        systemKeyCombos: true,
      },
    })
    expect(putRes.status).toBe(200)

    const getRes = await callAuthorizedApps('GET')
    expect(await getRes.json()).toMatchObject({
      grantFlags: {
        clipboardRead: true,
        clipboardWrite: false,
        systemKeyCombos: true,
      },
    })
  })

  it('rejects malformed config patches without writing them', async () => {
    const invalidBodies = [
      { enabled: 'false' },
      { grantFlags: { clipboardRead: 'yes' } },
      { authorizedApps: [{ bundleId: '', displayName: 'Preview' }] },
      {
        authorizedApps: [
          {
            bundleId: 'com.apple.Preview',
            displayName: 'Preview',
            authorizedAt: 42,
          },
        ],
      },
      { pythonPath: 42 },
      { enabled: false, unexpected: true },
    ]

    for (const body of invalidBodies) {
      const response = await callAuthorizedApps('PUT', body)
      expect(response.status).toBe(400)
    }

    await expect(
      readFile(join(configDir!, 'cc-haha', 'computer-use-config.json'), 'utf8'),
    ).rejects.toThrow()
  })

  it('fails closed on a corrupt stored config and refuses to overwrite it', async () => {
    const configPath = join(configDir!, 'cc-haha', 'computer-use-config.json')
    await mkdir(join(configDir!, 'cc-haha'), { recursive: true })
    await writeFile(configPath, '{"enabled":"yes"}', 'utf8')

    const getRes = await callAuthorizedApps('GET')
    expect(getRes.status).toBe(500)
    const getBody = await getRes.json() as any
    expect(getBody.error).toBe('COMPUTER_USE_CONFIG_INVALID')
    expect(getBody.configPath).toBe(configPath)
    expect(getBody.recoveryHint).toContain('删除或修复')

    const putRes = await callAuthorizedApps('PUT', { enabled: false })
    expect(putRes.status).toBe(409)
    const putBody = await putRes.json() as any
    expect(putBody.error).toBe('COMPUTER_USE_CONFIG_INVALID')
    expect(putBody.configPath).toBe(configPath)
    expect(putBody.recoveryHint).toContain('删除或修复')
    expect(await readFile(configPath, 'utf8')).toBe('{"enabled":"yes"}')
  })

  it('preserves old and future config fields while changing a known field', async () => {
    const configPath = join(configDir!, 'cc-haha', 'computer-use-config.json')
    await mkdir(join(configDir!, 'cc-haha'), { recursive: true })
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      authorizedApps: [
        {
          bundleId: 'com.google.Chrome',
          displayName: 'Google Chrome',
          authorizedAt: 'legacy timestamp',
          tier: 'full',
          futureAppField: { keep: true },
        },
      ],
      grantFlags: {
        clipboardRead: true,
        clipboardWrite: false,
        systemKeyCombos: true,
        futureGrantFlag: 'keep',
      },
      pythonPath: null,
      futureTopLevel: { keep: true },
    }), 'utf8')

    const putRes = await callAuthorizedApps('PUT', { enabled: false })
    expect(putRes.status).toBe(200)

    const saved = JSON.parse(await readFile(configPath, 'utf8'))
    expect(saved).toMatchObject({
      enabled: false,
      authorizedApps: [
        {
          bundleId: 'com.google.Chrome',
          authorizedAt: 'legacy timestamp',
          tier: 'full',
          futureAppField: { keep: true },
        },
      ],
      grantFlags: {
        clipboardRead: true,
        clipboardWrite: false,
        systemKeyCombos: true,
        futureGrantFlag: 'keep',
      },
      futureTopLevel: { keep: true },
    })
  })

  it('rejects malformed open-settings JSON without performing a fallback action', async () => {
    const malformed = await callComputerUseAction('open-settings', 'POST', '{')
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({
      error: 'INVALID_OPEN_SETTINGS_REQUEST',
    })

    for (const body of ['null', '[]']) {
      const response = await callComputerUseAction('open-settings', 'POST', body)
      expect(response.status).toBe(400)
    }
  })
})

describe('runPipInstallWithFallback', () => {
  it('rejects setup on unsupported platforms before writing runtime files', async () => {
    const { getUnsupportedComputerUsePlatformStep } = await importComputerUseApi()

    expect(getUnsupportedComputerUsePlatformStep('linux')).toEqual({
      name: 'platform',
      ok: false,
      message: 'Computer Use does not support platform: linux',
    })
    expect(getUnsupportedComputerUsePlatformStep('darwin')).toBeNull()
    expect(getUnsupportedComputerUsePlatformStep('win32')).toBeNull()
  })

  it('builds a clear unsupported Python version step for setup', async () => {
    const { getUnsupportedPythonVersionStep } = await importComputerUseApi()

    expect(getUnsupportedPythonVersionStep('3.8.18')).toEqual({
      name: 'python_version',
      ok: false,
      message: 'Computer Use 需要 Python >= 3.9，当前版本为 3.8.18',
    })
    expect(getUnsupportedPythonVersionStep('3.9.19')).toBeNull()
  })

  it('installs setup dependencies by upgrading pip before requirements', async () => {
    const { installSetupDependencies } = await importComputerUseApi()
    const calls: string[] = []

    const result = await installSetupDependencies(
      'python',
      '/tmp/requirements.txt',
      async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`)
        return { ok: true, stdout: args.includes('-r') ? 'deps' : 'pip', stderr: '', code: 0 }
      },
    )

    expect(result.stdout).toBe('deps')
    expect(calls).toEqual([
      'python -m pip install --upgrade pip',
      'python -m pip install -r /tmp/requirements.txt',
    ])
  })

  it('tries the mirror first and falls back to the default PyPI index', async () => {
    const { runPipInstallWithFallback } = await importComputerUseApi()
    const calls: string[] = []
    const result = await runPipInstallWithFallback(
      'python',
      ['-m', 'pip', 'install', '-r', 'requirements.txt'],
      async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`)
        if (args.includes('-i')) {
          return { ok: false, stdout: '', stderr: 'mirror unavailable', code: 1 }
        }
        return { ok: true, stdout: 'installed', stderr: '', code: 0 }
      },
    )

    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('installed')
    expect(calls).toEqual([
      'python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple/ --trusted-host pypi.tuna.tsinghua.edu.cn',
      'python -m pip install -r requirements.txt',
    ])
  })

  it('returns the first failure when every pip index attempt fails', async () => {
    const { runPipInstallWithFallback } = await importComputerUseApi()
    const result = await runPipInstallWithFallback(
      'python',
      ['-m', 'pip', 'install', '-r', 'requirements.txt'],
      async (_cmd, args) => ({
        ok: false,
        stdout: '',
        stderr: args.includes('-i') ? 'mirror failed' : 'default failed',
        code: args.includes('-i') ? 1 : 2,
      }),
    )

    expect(result).toEqual({ ok: false, stdout: '', stderr: 'mirror failed', code: 1 })
  })

  it('reports OS settings launch failures instead of returning success', async () => {
    const { openComputerUseSettings } = await importComputerUseApi()
    const calls: string[] = []

    const failed = await openComputerUseSettings(
      'darwin',
      'Privacy_Accessibility',
      async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`)
        return { ok: false, stdout: '', stderr: 'open failed', code: 1 }
      },
    )
    expect(failed).toEqual({ ok: false, message: 'open failed' })
    expect(calls).toEqual([
      'open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    ])

    expect(
      await openComputerUseSettings(
        'linux',
        'Privacy_ScreenCapture',
        async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
      ),
    ).toEqual({ ok: false, message: 'Unsupported platform' })
  })
})
