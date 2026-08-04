import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  auditSnapshot,
  parseAuditOptions,
  snapshotRoots,
  type SnapshotNode,
} from './audit-ui-snapshot.js'

function node(
  path: string,
  rect: { x: number; y: number; width: number; height: number },
  children: SnapshotNode[] = [],
  type = 'Panel',
): SnapshotNode {
  return {
    id: path,
    type,
    path,
    visible: true,
    actually_visible: true,
    rect_px: rect,
    children,
  }
}

describe('auditSnapshot', () => {
  it('reports a visible child outside its parent bounds beyond the default tolerance', () => {
    const child = node('root.children[0]', { x: 90, y: 10, width: 20, height: 20 })
    const root = node('root', { x: 0, y: 0, width: 100, height: 100 }, [child])

    const report = auditSnapshot([root])

    expect(report.issues).toEqual([
      expect.objectContaining({
        rule: 'parent-overflow',
        severity: 'error',
        nodePath: child.path,
        relatedPath: root.path,
      }),
    ])
  })

  it('records one-pixel scaling overflow as tolerated rounding', () => {
    const child = node('root.children[0]', { x: 50, y: 10, width: 51, height: 20 })
    const root = node('root', { x: 0, y: 0, width: 100, height: 100 }, [child])

    const report = auditSnapshot([root])

    expect(report.issues).toEqual([])
    expect(report.tolerated).toEqual([expect.objectContaining({
      rule: 'parent-overflow',
      nodePath: child.path,
      overflow: { left: 0, top: 0, right: 1, bottom: 0 },
    })])
  })

  it('honors a configured overflow tolerance', () => {
    const child = node('root.children[0]', { x: 90, y: 10, width: 12, height: 20 })
    const root = node('root', { x: 0, y: 0, width: 100, height: 100 }, [child])

    expect(auditSnapshot([root], { overflowTolerancePx: 2 }).issues).toEqual([])
    expect(auditSnapshot([root], { overflowTolerancePx: 1 }).issues).toHaveLength(1)
  })

  it('reports overlapping visible siblings when overlap auditing is enabled', () => {
    const first = node('root.children[0]', { x: 10, y: 10, width: 40, height: 40 })
    const second = node('root.children[1]', { x: 30, y: 30, width: 40, height: 40 })
    const root = node('root', { x: 0, y: 0, width: 100, height: 100 }, [first, second])

    const report = auditSnapshot([root], { checkSiblingOverlaps: true })

    expect(report.issues).toContainEqual(expect.objectContaining({
      rule: 'sibling-overlap',
      nodePath: first.path,
      relatedPath: second.path,
      intersection: { x: 30, y: 30, width: 20, height: 20 },
    }))
  })

  it('leaves sibling overlap auditing opt-in for intentional overlays', () => {
    const first = node('root.children[0]', { x: 10, y: 10, width: 40, height: 40 })
    const second = node('root.children[1]', { x: 30, y: 30, width: 40, height: 40 })
    const root = node('root', { x: 0, y: 0, width: 100, height: 100 }, [first, second])

    expect(auditSnapshot([root]).issues).toEqual([])
  })

  it('ignores hidden children outside their parent', () => {
    const child = node('root.children[0]', { x: 90, y: 10, width: 20, height: 20 })
    child.actually_visible = false
    const root = node('root', { x: 0, y: 0, width: 100, height: 100 }, [child])

    expect(auditSnapshot([root]).issues).toEqual([])
  })

  it('records a named parent-overflow exception instead of reporting an issue', () => {
    const child = node('root.children[0]', { x: 90, y: 10, width: 20, height: 20 })
    const root = node('root', { x: 0, y: 0, width: 100, height: 100 }, [child])

    const report = auditSnapshot([root], { allowOverflowPaths: [child.path] })

    expect(report.issues).toEqual([])
    expect(report.exceptions).toEqual([{
      rule: 'parent-overflow',
      nodePath: child.path,
      relatedPath: root.path,
    }])
  })

  it('records a named sibling-overlap exception regardless of pair order', () => {
    const first = node('root.children[0]', { x: 10, y: 10, width: 40, height: 40 })
    const second = node('root.children[1]', { x: 30, y: 30, width: 40, height: 40 })
    const root = node('root', { x: 0, y: 0, width: 100, height: 100 }, [first, second])

    const report = auditSnapshot([root], {
      checkSiblingOverlaps: true,
      allowOverlapPairs: [[second.path, first.path]],
    })

    expect(report.issues).toEqual([])
    expect(report.exceptions).toEqual([{
      rule: 'sibling-overlap',
      nodePath: first.path,
      relatedPath: second.path,
    }])
  })
})

describe('snapshotRoots', () => {
  it('accepts a complete ui.snapshot envelope', () => {
    expect(snapshotRoots({
      success: true,
      result: {
        tool: 'ui.snapshot',
        truncated: false,
        roots: [node('root', { x: 0, y: 0, width: 100, height: 100 })],
      },
    })).toHaveLength(1)
  })

  it('rejects failed, truncated, or wrong-tool snapshot envelopes', () => {
    expect(() => snapshotRoots({ success: false, result: { roots: [] } })).toThrow('失败')
    expect(() => snapshotRoots({
      success: true,
      result: { tool: 'ui.snapshot', truncated: true, roots: [] },
    })).toThrow('截断')
    expect(() => snapshotRoots({
      success: true,
      result: { tool: 'ui.get_rect', truncated: false, roots: [] },
    })).toThrow('ui.snapshot')
  })
})

describe('parseAuditOptions', () => {
  it('parses supported options', () => {
    expect(parseAuditOptions({
      checkSiblingOverlaps: true,
      overflowTolerancePx: 2,
      allowOverflowPaths: ['root.children[0]'],
      allowOverlapPairs: [['a', 'b']],
    })).toEqual({
      checkSiblingOverlaps: true,
      overflowTolerancePx: 2,
      allowOverflowPaths: ['root.children[0]'],
      allowOverlapPairs: [['a', 'b']],
    })
  })

  it('rejects unknown fields, string booleans, and malformed pairs', () => {
    expect(() => parseAuditOptions({ typo: true })).toThrow('未知字段')
    expect(() => parseAuditOptions({ checkSiblingOverlaps: 'false' })).toThrow('布尔值')
    expect(() => parseAuditOptions({ allowOverlapPairs: [['a']] })).toThrow('两个路径')
    expect(() => parseAuditOptions({ overflowTolerancePx: -1 })).toThrow('非负有限数字')
  })
})

describe('audit-ui-snapshot CLI', () => {
  it('runs from outside the plugin directory using an absolute script path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'spark2-ui-audit-'))
    const snapshotPath = join(directory, 'snapshot.json')
    writeFileSync(snapshotPath, JSON.stringify({
      success: true,
      result: {
        tool: 'ui.snapshot',
        truncated: false,
        roots: [node('root', { x: 0, y: 0, width: 100, height: 100 })],
      },
    }))

    try {
      const process = Bun.spawn([
        'bun',
        import.meta.dir + '/audit-ui-snapshot.ts',
        snapshotPath,
      ], { cwd: directory, stdout: 'pipe', stderr: 'pipe' })
      const [exitCode, stdout] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
      ])

      expect(exitCode).toBe(0)
      expect(JSON.parse(stdout)).toEqual(expect.objectContaining({ checkedNodes: 1, issues: [] }))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
