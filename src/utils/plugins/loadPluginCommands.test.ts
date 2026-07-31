import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { setInlinePlugins } from '../../bootstrap/state.js'
import { getCommandName } from '../../types/command.js'
import { clearPluginCache } from './pluginLoader.js'
import { getPluginSkills } from './loadPluginCommands.js'

let pluginDir: string | null = null

afterEach(async () => {
  setInlinePlugins([])
  getPluginSkills.cache?.clear?.()
  clearPluginCache('load-plugin-commands-test')
  if (pluginDir) {
    await rm(pluginDir, { recursive: true, force: true })
    pluginDir = null
  }
})

describe('plugin skill display names', () => {
  test('keeps the plugin prefix when frontmatter overrides the skill name', async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'cc-haha-plugin-skill-'))
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await mkdir(join(pluginDir, 'skills', 'review'), { recursive: true })
    await writeFile(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'acme',
        version: '1.0.0',
        description: 'Test plugin',
      }),
    )
    await writeFile(
      join(pluginDir, 'skills', 'review', 'SKILL.md'),
      [
        '---',
        'name: custom-review',
        'description: Review a change',
        '---',
        'Review the requested change.',
      ].join('\n'),
    )

    setInlinePlugins([pluginDir])
    getPluginSkills.cache?.clear?.()
    clearPluginCache('load-plugin-commands-test-setup')

    const skills = await getPluginSkills()
    const skill = skills.find(command => command.name === 'acme:review')

    expect(skill).toBeDefined()
    expect(getCommandName(skill!)).toBe('acme:custom-review')
    expect(skill?.aliases).toContain('custom-review')
  })

  test('keeps the complete prefix when the plugin name contains a colon', async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'cc-haha-plugin-skill-'))
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await mkdir(join(pluginDir, 'skills', 'review'), { recursive: true })
    await writeFile(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'foo:bar',
        version: '1.0.0',
        description: 'Test plugin',
      }),
    )
    await writeFile(
      join(pluginDir, 'skills', 'review', 'SKILL.md'),
      [
        '---',
        'name: custom-review',
        'description: Review a change',
        '---',
        'Review the requested change.',
      ].join('\n'),
    )

    setInlinePlugins([pluginDir])
    getPluginSkills.cache?.clear?.()
    clearPluginCache('load-plugin-commands-colon-test')

    const skills = await getPluginSkills()
    const skill = skills.find(command => command.name === 'foo:bar:review')

    expect(skill).toBeDefined()
    expect(getCommandName(skill!)).toBe('foo:bar:custom-review')
  })
})
