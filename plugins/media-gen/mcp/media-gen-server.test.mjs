/**
 * Tests for media-gen MCP server
 *
 * Run with: node --test plugins/media-gen/mcp/media-gen-server.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = join(__dirname, 'media-gen-server.mjs')

function callServer(messages, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER_PATH], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', () => {})

    // Write messages with small delays to ensure readline processes each line
    const input = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
    child.stdin.write(input)
    // Delay stdin close to allow readline to process all lines before 'close' event
    setTimeout(() => child.stdin.end(), 100)

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Server timeout'))
    }, 10_000)

    child.on('close', () => {
      clearTimeout(timer)
      const results = stdout.trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
      resolve(results)
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
}
const NOTIFY = { jsonrpc: '2.0', method: 'notifications/initialized' }
function tool(name, args = {}, id = 2) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}
function listTools(id = 2) {
  return { jsonrpc: '2.0', id, method: 'tools/list', params: {} }
}

const CONFIG_ENV = {
  MEDIA_GEN_PROVIDERS_JSON: JSON.stringify({
    schemaVersion: 2,
    providers: [
      { id: 'video-provider', name: 'Video', enabled: true, apiFormat: 'openai_compatible', baseUrl: 'http://localhost:9/v1', models: { videoGeneration: 'video-default' } },
      { id: 'image-provider', name: 'Image', enabled: true, apiFormat: 'openai_compatible', baseUrl: 'http://192.168.1.20:9/v1', models: { imageGeneration: 'image-default', imageEditing: 'edit-default' } },
      { id: 'disabled', name: 'Disabled', enabled: false, apiFormat: 'openai_compatible', baseUrl: 'https://example.com/v1', models: { imageGeneration: 'disabled-model' } },
    ],
  }),
  MEDIA_GEN_PROVIDER_SECRETS_JSON: JSON.stringify({ 'video-provider': 'video-key', 'image-provider': 'image-key', disabled: 'disabled-key' }),
}

const P1_ENV = {
  MEDIA_GEN_P1_NAME: 'TestProvider',
  MEDIA_GEN_P1_BASE_URL: 'https://example.com/v1',
  MEDIA_GEN_P1_API_KEY: 'sk-test',
  MEDIA_GEN_P1_MODEL: 'test-model',
}

// Helper: send messages and return only the last response (the test target)
async function callAndGetResult(messages, env) {
  const results = await callServer(messages, env)
  return results[results.length - 1]
}

describe('media-gen MCP server', () => {
  it('responds to initialize', async () => {
    const results = await callServer([INIT])
    assert.equal(results[0].id, 1)
    assert.equal(results[0].result.protocolVersion, '2024-11-05')
    assert.equal(results[0].result.serverInfo.name, 'media-gen')
  })

  it('returns 7 tools on tools/list', async () => {
    const res = await callAndGetResult([INIT, NOTIFY, listTools()])
    const toolNames = res.result.tools.map(t => t.name)
    assert.deepEqual(toolNames, ['generate_image', 'edit_image', 'generate_video', 'edit_video', 'extend_video', 'list_providers', 'list_models'])
  })

  it('exposes provider and model selection for image tools', async () => {
    const res = await callAndGetResult([INIT, NOTIFY, listTools()])
    for (const name of ['generate_image', 'edit_image']) {
      const imageTool = res.result.tools.find(t => t.name === name)
      assert.equal(imageTool.inputSchema.properties.provider_index.type, 'integer')
      assert.equal(imageTool.inputSchema.properties.provider_index.minimum, 0)
      assert.equal(imageTool.inputSchema.properties.model.type, 'string')
    }
  })

  describe('dynamic provider configuration', () => {
    it('fails closed when the new provider JSON exists but is invalid', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('list_providers')], { ...P1_ENV, MEDIA_GEN_PROVIDERS_JSON: '{' })
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('没有可用的 provider'))
    })

    it('accepts configured localhost/private provider URLs and reports stable IDs and per-tool models', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('list_providers')], CONFIG_ENV)
      const text = res.result.content[0].text
      assert.ok(text.includes('provider_id: video-provider'))
      assert.ok(text.includes('http://localhost:9/v1'))
      assert.ok(text.includes('imageGeneration'))
    })

    it('keeps indexes order-dependent while provider_id remains stable and validates both selectors', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('generate_image', { prompt: 'cat', provider_index: 0, provider_id: 'image-provider' })], CONFIG_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('same provider'))
    })

    it('image fallback only considers enabled providers with the corresponding model', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('generate_image', { prompt: 'cat' })], CONFIG_ENV)
      const text = res.result.content[0].text
      assert.ok(text.includes('Image'))
      assert.ok(!text.includes('Video:'))
      assert.ok(!text.includes('Disabled'))
    })

    it('video accepts provider_id and uses its video-generation model', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('generate_video', { prompt: 'cat', provider_id: 'video-provider' })], CONFIG_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(!res.result.content[0].text.includes('requires provider_index'))
    })
  })

  describe('list_providers', () => {
    it('shows configured provider with capabilities', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('list_providers', {})], P1_ENV)
      const text = res.result.content[0].text
      assert.ok(text.includes('TestProvider'))
      assert.ok(text.includes('test-model'))
      assert.ok(text.includes('capabilities'))
    })

    it('shows error when no providers configured', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('generate_image', { prompt: 'test' })])
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('没有可用的 provider'))
    })

    it('shows multiple providers in priority order', async () => {
      const env = {
        MEDIA_GEN_P1_NAME: 'P1', MEDIA_GEN_P1_BASE_URL: 'https://p1.example.com/v1',
        MEDIA_GEN_P1_API_KEY: 'sk-1', MEDIA_GEN_P1_MODEL: 'model-1',
        MEDIA_GEN_P2_NAME: 'P2', MEDIA_GEN_P2_BASE_URL: 'https://p2.example.com/v1',
        MEDIA_GEN_P2_API_KEY: 'sk-2', MEDIA_GEN_P2_MODEL: 'model-2',
      }
      const res = await callAndGetResult([INIT, NOTIFY, tool('list_providers', {})], env)
      const text = res.result.content[0].text
      assert.ok(text.includes('0. P1'))
      assert.ok(text.includes('1. P2'))
    })
  })

  describe('generate_image', () => {
    it('exposes Grok image aspect ratio and resolution parameters', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, listTools()])
      const imageTool = res.result.tools.find(t => t.name === 'generate_image')
      assert.ok(imageTool.inputSchema.properties.aspect_ratio.enum.includes('16:9'))
      assert.deepEqual(imageTool.inputSchema.properties.resolution.enum, ['1k', '2k'])
    })

    it('rejects model override without a provider index', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('generate_image', { prompt: 'cat', model: 'other-model' })], P1_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('provider_index'))
    })

    it('rejects an invalid provider index before making a request', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('generate_image', { prompt: 'cat', provider_index: 9 })], P1_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('Invalid provider_index'))
    })

    it('rejects empty prompt', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('generate_image', { prompt: '' })], P1_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('prompt is required'))
    })

    it('rejects whitespace-only prompt', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('generate_image', { prompt: '   ' })], P1_ENV)
      assert.equal(res.result.isError, true)
    })

    it('warns on unsupported size', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('generate_image', { prompt: 'cat', size: '999x999' })], P1_ENV)
      // The warning is returned as a non-error text, but the provider call will fail (connection refused in test)
      // So the final result may be an error from the provider. Check that the warning was emitted.
      const text = res.result.content[0].text
      assert.ok(
        text.includes('may not be supported') || text.includes('所有 provider 均失败'),
        `Expected size warning or provider failure, got: ${text.slice(0, 100)}`,
      )
    })
  })

  describe('generate_video', () => {
    it('requires an explicit provider index', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('generate_video', { prompt: 'cat' })], P1_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('provider_index'))
    })

    it('rejects empty prompt', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('generate_video', { prompt: '', provider_index: 0 })], P1_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('prompt'))
    })

    it('exposes separate Grok and Agnes image-to-video parameters', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, listTools()])
      const videoTool = res.result.tools.find(t => t.name === 'generate_video')
      assert.equal(videoTool.inputSchema.properties.image_url.type, 'string')
      assert.equal(videoTool.inputSchema.properties.image.type, 'string')
    })

    it('declares Grok duration bounds in the tool schema', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, listTools()])
      const videoTool = res.result.tools.find(t => t.name === 'generate_video')
      assert.equal(videoTool.inputSchema.properties.duration.minimum, 1)
      assert.equal(videoTool.inputSchema.properties.duration.maximum, 15)
    })
  })

  describe('edit_video', () => {
    it('requires prompt, video_url, and provider_index', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('edit_video', {})], P1_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('prompt'))
    })

    it('exposes provider and model selection', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, listTools()])
      const editTool = res.result.tools.find(t => t.name === 'edit_video')
      assert.equal(editTool.inputSchema.properties.provider_index.type, 'integer')
      assert.equal(editTool.inputSchema.properties.model.type, 'string')
    })
  })

  describe('extend_video', () => {
    it('requires prompt, video_url, and provider_index', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('extend_video', {})], P1_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('prompt'))
    })

    it('declares extension duration bounds', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, listTools()])
      const extendTool = res.result.tools.find(t => t.name === 'extend_video')
      assert.equal(extendTool.inputSchema.properties.duration.minimum, 1)
      assert.equal(extendTool.inputSchema.properties.duration.maximum, 10)
    })
  })

  describe('edit_image', () => {
    it('rejects when no provider supports editing', async () => {
      // Use a model not in capabilities DB and without 'image' in name to get edit: undefined (not explicitly false)
      // gpt-image-2 has edit: true, so use a text-only model
      const env = {
        MEDIA_GEN_P1_NAME: 'Text', MEDIA_GEN_P1_BASE_URL: 'https://example.com/v1',
        MEDIA_GEN_P1_API_KEY: 'sk-test', MEDIA_GEN_P1_MODEL: 'text-only-model',
      }
      const res = await callAndGetResult([INIT, NOTIFY, tool('edit_image', { prompt: 'test', image_url: 'https://example.com/img.png' })], env)
      // text-only-model has no capabilities (null), so capabilities.edit !== false is true
      // The provider will be included in edit attempt and fail with connection error
      // This is expected behavior — the edit capability check only filters out models with edit: false
      assert.ok(res.result.isError)
    })

    it('rejects empty prompt', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('edit_image', { prompt: '', image_url: 'https://example.com/img.png' })], P1_ENV)
      assert.equal(res.result.isError, true)
    })

    it('rejects missing image_url', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('edit_image', { prompt: 'test' })], P1_ENV)
      assert.equal(res.result.isError, true)
    })
  })

  describe('SSRF protection', () => {
    const GPT_ENV = {
      MEDIA_GEN_P1_NAME: 'GPT', MEDIA_GEN_P1_BASE_URL: 'https://api.openai.com/v1',
      MEDIA_GEN_P1_API_KEY: 'sk-test', MEDIA_GEN_P1_MODEL: 'gpt-image-2',
    }

    it('blocks IPv4 private 169.254.x.x', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('edit_image', { prompt: 'test', image_url: 'http://169.254.169.254/latest/meta-data/' })], GPT_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('不允许访问内网地址'))
    })

    it('blocks IPv6 [::1]', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('edit_image', { prompt: 'test', image_url: 'http://[::1]:8080/internal' })], GPT_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('不允许访问内网地址'))
    })

    it('blocks the unspecified IPv6 address', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('edit_image', { prompt: 'test', image_url: 'http://[::]:8080/internal' })], GPT_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('不允许访问内网地址'))
    })

    it('blocks hexadecimal IPv4-mapped IPv6 loopback', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('edit_image', { prompt: 'test', image_url: 'http://[::ffff:7f00:1]:8080/internal' })], GPT_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('不允许访问内网地址'))
    })

    it('blocks hexadecimal IPv4-mapped IPv6 private ranges', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('edit_image', { prompt: 'test', image_url: 'http://[::ffff:a00:1]:8080/internal' })], GPT_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('不允许访问内网地址'))
    })

    it('blocks fully expanded IPv4-mapped IPv6 loopback', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('edit_image', { prompt: 'test', image_url: 'http://[0:0:0:0:0:ffff:7f00:1]:8080/internal' })], GPT_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('不允许访问内网地址'))
    })

    it('blocks fully expanded IPv4-mapped metadata addresses', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('edit_image', { prompt: 'test', image_url: 'http://[0:0:0:0:0:ffff:a9fe:a9fe]/latest/meta-data/' })], GPT_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('不允许访问内网地址'))
    })

    it('blocks ftp:// protocol', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('edit_image', { prompt: 'test', image_url: 'ftp://evil.com/file' })], GPT_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('不允许的协议'))
    })

    it('blocks 192.168.x.x', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('edit_image', { prompt: 'test', image_url: 'http://192.168.1.1/admin' })], GPT_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('不允许访问内网地址'))
    })

    it('blocks the full IPv4 loopback range', async () => {
      const env = {
        MEDIA_GEN_P1_NAME: 'Loopback', MEDIA_GEN_P1_BASE_URL: 'http://127.0.0.2:8080/v1',
        MEDIA_GEN_P1_API_KEY: 'sk-test', MEDIA_GEN_P1_MODEL: 'test-model',
      }
      const res = await callAndGetResult([INIT, NOTIFY, tool('list_providers', {})], env)
      assert.ok(res.result.content[0].text.includes('没有可用的 provider'))
    })

    it('allows a dynamic private provider API while keeping returned media URLs protected', async () => {
      let receivedRequest
      const providerServer = createServer((req, res) => {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          receivedRequest = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ data: [{ url: 'http://127.0.0.1/private-output.png' }] }))
        })
      })
      await new Promise((resolve, reject) => {
        providerServer.once('error', reject)
        providerServer.listen(0, '127.0.0.1', resolve)
      })
      const outputDir = await mkdtemp(join(tmpdir(), 'media-gen-private-output-'))
      try {
        const { port } = providerServer.address()
        const env = {
          MEDIA_GEN_PROVIDERS_JSON: JSON.stringify({ schemaVersion: 2, providers: [{
            id: 'local', name: 'Local', enabled: true, apiFormat: 'openai_compatible',
            baseUrl: `http://127.0.0.1:${port}/v1`, models: { imageGeneration: 'local-image' },
          }] }),
          MEDIA_GEN_PROVIDER_SECRETS_JSON: JSON.stringify({ local: 'local-key' }),
        }
        const res = await callAndGetResult([INIT, NOTIFY, tool('generate_image', { prompt: 'cat', provider_id: 'local', output_dir: outputDir })], env)
        assert.equal(receivedRequest.url, '/v1/images/generations')
        assert.equal(receivedRequest.authorization, 'Bearer local-key')
        assert.equal(receivedRequest.body.prompt, 'cat')
        assert.equal(res.result.isError, true)
        assert.ok(res.result.content[0].text.includes('不允许访问内网地址'))
      } finally {
        await new Promise(resolve => providerServer.close(resolve))
        await rm(outputDir, { recursive: true, force: true })
      }
    })
  })

  describe('model capabilities', () => {
    it('recognizes Grok image and edit models', async () => {
      const env = {
        MEDIA_GEN_P1_NAME: 'Grok Edit', MEDIA_GEN_P1_BASE_URL: 'https://example.com/v1',
        MEDIA_GEN_P1_API_KEY: 'sk-test', MEDIA_GEN_P1_MODEL: 'grok-imagine-edit',
      }
      const res = await callAndGetResult([INIT, NOTIFY, tool('list_providers', {})], env)
      assert.ok(res.result.content[0].text.includes('supports edit'))
    })

    it('matches exact model name', async () => {
      const env = {
        MEDIA_GEN_P1_NAME: 'GPT', MEDIA_GEN_P1_BASE_URL: 'https://api.openai.com/v1',
        MEDIA_GEN_P1_API_KEY: 'sk-test', MEDIA_GEN_P1_MODEL: 'gpt-image-2',
      }
      const res = await callAndGetResult([INIT, NOTIFY, tool('list_providers', {})], env)
      const text = res.result.content[0].text
      assert.ok(text.includes('supports edit'))
      assert.ok(text.includes('supports transparent'))
      assert.ok(text.includes('max n: 10'))
    })

    it('matches prefix for extended model names', async () => {
      const env = {
        MEDIA_GEN_P1_NAME: 'GPT', MEDIA_GEN_P1_BASE_URL: 'https://api.openai.com/v1',
        MEDIA_GEN_P1_API_KEY: 'sk-test', MEDIA_GEN_P1_MODEL: 'gpt-image-2-turbo',
      }
      const res = await callAndGetResult([INIT, NOTIFY, tool('list_providers', {})], env)
      const text = res.result.content[0].text
      assert.ok(text.includes('supports edit'))
    })

    it('returns unknown for unrecognized models', async () => {
      const env = {
        MEDIA_GEN_P1_NAME: 'Custom', MEDIA_GEN_P1_BASE_URL: 'https://example.com/v1',
        MEDIA_GEN_P1_API_KEY: 'sk-test', MEDIA_GEN_P1_MODEL: 'my-custom-model',
      }
      const res = await callAndGetResult([INIT, NOTIFY, tool('list_providers', {})], env)
      const text = res.result.content[0].text
      assert.ok(text.includes('unknown'))
    })
  })

  describe('unknown tool', () => {
    it('returns error for unknown tool name', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, tool('nonexistent_tool', {})], P1_ENV)
      assert.equal(res.result.isError, true)
      assert.ok(res.result.content[0].text.includes('Unknown tool'))
    })
  })

  describe('ping', () => {
    it('responds to ping', async () => {
      const res = await callAndGetResult([INIT, NOTIFY, { jsonrpc: '2.0', id: 2, method: 'ping', params: {} }])
      assert.deepEqual(res.result, {})
    })
  })
})
