import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { _setGlobalConfigCacheForTesting, enableConfigs, getProjectPathForConfig } from '../../../utils/config.js'
import { runWithCwdOverride } from '../../../utils/cwd.js'
import { getGlobalClaudeFile } from '../../../utils/env.js'
import { normalizePathForConfigKey } from '../../../utils/path.js'
import {
  addMcpConfig,
  findProjectMcpConfigPath,
  parseMcpConfigFromFilePath,
  projectDirDeclaresMcpServers,
  removeMcpConfig,
} from '../config.js'

let tmpDir: string

async function writeMcpJson(dir: string, config: unknown) {
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, '.mcp.json')
  await fs.writeFile(filePath, JSON.stringify(config, null, 2))
  return filePath
}

function readMcpJson(filePath: string) {
  return fs.readFile(filePath, 'utf8').then(contents => JSON.parse(contents))
}

const STDIO_SERVER = { type: 'stdio', command: 'npx', args: ['some-mcp'] }

let originalConfigDir: string | undefined

// addMcpConfig('project') also registers the target directory in the global
// config (see GH #1126), so every test needs an isolated CLAUDE_CONFIG_DIR or
// that side effect would land in the developer's real ~/.claude.json.
function clearConfigPathCaches() {
  getGlobalClaudeFile.cache.clear?.()
  getProjectPathForConfig.cache.clear?.()
  _setGlobalConfigCacheForTesting(null)
}

describe('project-scoped MCP config writes', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-project-removal-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    clearConfigPathCaches()
  })

  afterEach(async () => {
    if (originalConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    clearConfigPathCaches()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('findProjectMcpConfigPath', () => {
    it('resolves the nearest .mcp.json that declares the server', async () => {
      const parent = path.join(tmpDir, 'workspace')
      const child = path.join(parent, 'project')
      await writeMcpJson(parent, { mcpServers: { shared: STDIO_SERVER } })
      const childPath = await writeMcpJson(child, { mcpServers: { shared: STDIO_SERVER } })

      expect(runWithCwdOverride(child, () => findProjectMcpConfigPath('shared'))).toBe(childPath)
    })

    it('walks up to a parent declaration when the cwd has no .mcp.json', async () => {
      const parent = path.join(tmpDir, 'workspace')
      const child = path.join(parent, 'nested', 'deep')
      const parentPath = await writeMcpJson(parent, { mcpServers: { inherited: STDIO_SERVER } })
      await fs.mkdir(child, { recursive: true })

      expect(runWithCwdOverride(child, () => findProjectMcpConfigPath('inherited'))).toBe(parentPath)
    })

    it('returns null when no ancestor declares the server', async () => {
      const proj = path.join(tmpDir, 'project')
      await writeMcpJson(proj, { mcpServers: { other: STDIO_SERVER } })

      expect(runWithCwdOverride(proj, () => findProjectMcpConfigPath('missing'))).toBeNull()
    })

    it('still resolves a server declared alongside an invalid entry', async () => {
      const proj = path.join(tmpDir, 'project')
      // `broken` has no command, so schema validation rejects the whole file.
      const projPath = await writeMcpJson(proj, {
        mcpServers: { broken: { type: 'stdio' }, target: STDIO_SERVER },
      })

      expect(runWithCwdOverride(proj, () => findProjectMcpConfigPath('target'))).toBe(projPath)
    })
  })

  describe('removeMcpConfig with project scope', () => {
    it('removes the entry from the declaring parent file', async () => {
      const parent = path.join(tmpDir, 'workspace')
      const child = path.join(parent, 'project')
      const parentPath = await writeMcpJson(parent, {
        mcpServers: { inherited: STDIO_SERVER, sibling: STDIO_SERVER },
      })
      await fs.mkdir(child, { recursive: true })

      await runWithCwdOverride(child, () => removeMcpConfig('inherited', 'project'))

      const parentConfig = await readMcpJson(parentPath)
      expect(parentConfig.mcpServers.inherited).toBeUndefined()
      expect(parentConfig.mcpServers.sibling).toEqual(STDIO_SERVER)
      // The cwd must not gain a .mcp.json as a side effect of the removal.
      await expect(fs.stat(path.join(child, '.mcp.json'))).rejects.toThrow()
    })

    it('keeps unrelated top-level keys and unexpanded variables intact', async () => {
      const proj = path.join(tmpDir, 'project')
      const projPath = await writeMcpJson(proj, {
        $schema: 'https://example.com/mcp.schema.json',
        inputs: [{ id: 'token', type: 'promptString' }],
        mcpServers: {
          doomed: STDIO_SERVER,
          kept: {
            type: 'http',
            url: 'https://mcp.example.com/mcp',
            headers: { Authorization: 'Bearer ${MY_MCP_TOKEN}' },
          },
        },
      })

      await runWithCwdOverride(proj, () => removeMcpConfig('doomed', 'project'))

      const config = await readMcpJson(projPath)
      expect(config.mcpServers.doomed).toBeUndefined()
      expect(config.$schema).toBe('https://example.com/mcp.schema.json')
      expect(config.inputs).toEqual([{ id: 'token', type: 'promptString' }])
      expect(config.mcpServers.kept.headers.Authorization).toBe('Bearer ${MY_MCP_TOKEN}')
    })

    it('leaves invalid sibling entries in place instead of dropping them', async () => {
      const proj = path.join(tmpDir, 'project')
      const projPath = await writeMcpJson(proj, {
        mcpServers: { broken: { type: 'stdio' }, target: STDIO_SERVER },
      })

      await runWithCwdOverride(proj, () => removeMcpConfig('target', 'project'))

      const config = await readMcpJson(projPath)
      expect(config.mcpServers.target).toBeUndefined()
      expect(config.mcpServers.broken).toEqual({ type: 'stdio' })
    })

    it('throws when no ancestor .mcp.json declares the server', async () => {
      const proj = path.join(tmpDir, 'project')
      await writeMcpJson(proj, { mcpServers: { other: STDIO_SERVER } })

      await expect(
        runWithCwdOverride(proj, () => removeMcpConfig('missing', 'project')),
      ).rejects.toThrow('No MCP server found with name: missing in .mcp.json')
    })
  })

  describe('addMcpConfig with project scope', () => {
    const previousToken = process.env.MY_MCP_TOKEN

    beforeEach(() => {
      process.env.MY_MCP_TOKEN = 'super-secret-value'
    })

    afterEach(() => {
      if (previousToken === undefined) delete process.env.MY_MCP_TOKEN
      else process.env.MY_MCP_TOKEN = previousToken
    })

    it('never writes a resolved ${VAR} value back over a sibling entry', async () => {
      const proj = path.join(tmpDir, 'project')
      const projPath = await writeMcpJson(proj, {
        mcpServers: {
          existing: {
            type: 'http',
            url: 'https://mcp.example.com/mcp',
            headers: { Authorization: 'Bearer ${MY_MCP_TOKEN}' },
          },
        },
      })

      await runWithCwdOverride(proj, () => addMcpConfig('added', STDIO_SERVER, 'project'))

      const config = await readMcpJson(projPath)
      expect(config.mcpServers.added).toEqual(STDIO_SERVER)
      expect(config.mcpServers.existing.headers.Authorization).toBe('Bearer ${MY_MCP_TOKEN}')
      expect(JSON.stringify(config)).not.toContain('super-secret-value')
    })

    it('keeps unrelated top-level keys when inserting a server', async () => {
      const proj = path.join(tmpDir, 'project')
      const projPath = await writeMcpJson(proj, {
        $schema: 'https://example.com/mcp.schema.json',
        inputs: [{ id: 'token', type: 'promptString' }],
        mcpServers: { existing: STDIO_SERVER },
      })

      await runWithCwdOverride(proj, () => addMcpConfig('added', STDIO_SERVER, 'project'))

      const config = await readMcpJson(projPath)
      expect(config.$schema).toBe('https://example.com/mcp.schema.json')
      expect(config.inputs).toEqual([{ id: 'token', type: 'promptString' }])
      expect(Object.keys(config.mcpServers).sort()).toEqual(['added', 'existing'])
    })

    it('creates .mcp.json when the cwd has none', async () => {
      const proj = path.join(tmpDir, 'fresh')
      await fs.mkdir(proj, { recursive: true })

      await runWithCwdOverride(proj, () => addMcpConfig('added', STDIO_SERVER, 'project'))

      const config = await readMcpJson(path.join(proj, '.mcp.json'))
      expect(config).toEqual({ mcpServers: { added: STDIO_SERVER } })
    })

    it('reports a conflict for a name declared in an otherwise invalid file', async () => {
      const proj = path.join(tmpDir, 'project')
      await writeMcpJson(proj, {
        mcpServers: { broken: { type: 'stdio' }, taken: STDIO_SERVER },
      })

      await expect(
        runWithCwdOverride(proj, () => addMcpConfig('taken', STDIO_SERVER, 'project')),
      ).rejects.toThrow('MCP server taken already exists in .mcp.json')
    })

    it('registers a fresh target directory in the global project registry (GH #1126)', async () => {
      const previousNodeEnv = process.env.NODE_ENV
      // development: getGlobalConfig() must read the sandboxed file, not the
      // in-memory test stub, so the check and the write see the same state.
      process.env.NODE_ENV = 'development'
      clearConfigPathCaches()
      enableConfigs()

      try {
        const proj = path.join(tmpDir, 'never-seen-before')
        await fs.mkdir(proj, { recursive: true })

        await runWithCwdOverride(proj, () => addMcpConfig('shared', STDIO_SERVER, 'project'))

        const globalConfig = JSON.parse(await fs.readFile(getGlobalClaudeFile(), 'utf8'))
        expect(Object.keys(globalConfig.projects ?? {})).toContain(
          normalizePathForConfigKey(proj),
        )
      } finally {
        if (previousNodeEnv === undefined) {
          delete process.env.NODE_ENV
        } else {
          process.env.NODE_ENV = previousNodeEnv
        }
        clearConfigPathCaches()
      }
    })
  })

  describe('shared JSON parse cache isolation', () => {
    it('removing a server never poisons parses of byte-identical .mcp.json files (GH #1126)', async () => {
      const projA = path.join(tmpDir, 'poison-a')
      const projB = path.join(tmpDir, 'poison-b')
      const content = { mcpServers: { shared: STDIO_SERVER } }
      await writeMcpJson(projA, content)
      await writeMcpJson(projB, content) // byte-identical to A

      // Warm the shared safeParseJSON cache with A's content. The removal
      // below used to receive this exact cached object and delete the server
      // from it in place, so every byte-identical file then parsed as empty.
      const warm = parseMcpConfigFromFilePath({
        filePath: path.join(projA, '.mcp.json'),
        expandVars: false,
        scope: 'project',
      })
      expect(Object.keys(warm.config?.mcpServers ?? {})).toEqual(['shared'])

      await runWithCwdOverride(projA, () => removeMcpConfig('shared', 'project'))

      // B is untouched on disk and must still parse with its server present.
      const afterRemove = parseMcpConfigFromFilePath({
        filePath: path.join(projB, '.mcp.json'),
        expandVars: false,
        scope: 'project',
      })
      expect(Object.keys(afterRemove.config?.mcpServers ?? {})).toEqual(['shared'])
    })
  })

  describe('projectDirDeclaresMcpServers', () => {
    it('is true only for a directory whose .mcp.json declares servers', async () => {
      const withServers = path.join(tmpDir, 'with-servers')
      const emptyServers = path.join(tmpDir, 'empty-servers')
      const noFile = path.join(tmpDir, 'no-file')
      await writeMcpJson(withServers, { mcpServers: { shared: STDIO_SERVER } })
      await writeMcpJson(emptyServers, { mcpServers: {} })
      await fs.mkdir(noFile, { recursive: true })

      expect(projectDirDeclaresMcpServers(withServers)).toBe(true)
      expect(projectDirDeclaresMcpServers(emptyServers)).toBe(false)
      expect(projectDirDeclaresMcpServers(noFile)).toBe(false)
    })

    it('counts schema-invalid entries so the UI can still surface them', async () => {
      const proj = path.join(tmpDir, 'invalid-entry')
      // No command: fails validation, but the raw file still declares it.
      await writeMcpJson(proj, { mcpServers: { broken: { type: 'stdio' } } })

      expect(projectDirDeclaresMcpServers(proj)).toBe(true)
    })
  })
})
