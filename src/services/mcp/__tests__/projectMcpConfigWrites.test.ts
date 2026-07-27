import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { runWithCwdOverride } from '../../../utils/cwd.js'
import { addMcpConfig, findProjectMcpConfigPath, removeMcpConfig } from '../config.js'

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

describe('project-scoped MCP config writes', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-project-removal-'))
  })

  afterEach(async () => {
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
  })
})
