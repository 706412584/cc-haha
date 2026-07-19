#!/usr/bin/env bun

import { readFileSync } from 'node:fs'

export type PixelRect = {
  x: number
  y: number
  width: number
  height: number
}

export type SnapshotNode = {
  id: string | number
  type: string
  name?: string | null
  path: string
  visible: boolean
  actually_visible: boolean
  rect_px?: PixelRect | null
  children?: SnapshotNode[]
}

export type AuditIssue =
  | {
      rule: 'parent-overflow'
      severity: 'error'
      nodeId: string | number
      nodePath: string
      relatedPath: string
      rect: PixelRect
      relatedRect: PixelRect
      overflow: { left: number; top: number; right: number; bottom: number }
    }
  | {
      rule: 'sibling-overlap'
      severity: 'error'
      nodeId: string | number
      nodePath: string
      relatedId: string | number
      relatedPath: string
      rect: PixelRect
      relatedRect: PixelRect
      intersection: PixelRect
    }

export type AuditOptions = {
  checkSiblingOverlaps?: boolean
  overflowTolerancePx?: number
  allowOverflowPaths?: string[]
  allowOverlapPairs?: Array<[string, string]>
}

export type AuditException = {
  rule: AuditIssue['rule']
  nodePath: string
  relatedPath: string
}

export type ToleratedFinding = AuditException & {
  overflow: { left: number; top: number; right: number; bottom: number }
  tolerancePx: number
}

export type AuditReport = {
  checkedNodes: number
  issues: AuditIssue[]
  exceptions: AuditException[]
  tolerated: ToleratedFinding[]
}

function isAuditable(node: SnapshotNode): node is SnapshotNode & { rect_px: PixelRect } {
  const rect = node.rect_px
  return node.visible
    && node.actually_visible
    && !!rect
    && rect.width > 0
    && rect.height > 0
}

function overflow(child: PixelRect, parent: PixelRect) {
  return {
    left: Math.max(0, parent.x - child.x),
    top: Math.max(0, parent.y - child.y),
    right: Math.max(0, child.x + child.width - (parent.x + parent.width)),
    bottom: Math.max(0, child.y + child.height - (parent.y + parent.height)),
  }
}

function intersection(first: PixelRect, second: PixelRect): PixelRect | undefined {
  const x = Math.max(first.x, second.x)
  const y = Math.max(first.y, second.y)
  const right = Math.min(first.x + first.width, second.x + second.width)
  const bottom = Math.min(first.y + first.height, second.y + second.height)
  if (right <= x || bottom <= y) return undefined
  return { x, y, width: right - x, height: bottom - y }
}

function pairKey(firstPath: string, secondPath: string): string {
  return [firstPath, secondPath].sort().join('\u0000')
}

export function auditSnapshot(
  roots: SnapshotNode[],
  options: AuditOptions = {},
): AuditReport {
  const issues: AuditIssue[] = []
  const exceptions: AuditException[] = []
  const tolerated: ToleratedFinding[] = []
  const overflowTolerancePx = options.overflowTolerancePx ?? 1
  const allowedOverflowPaths = new Set(options.allowOverflowPaths ?? [])
  const allowedOverlapPairs = new Set(
    (options.allowOverlapPairs ?? []).map(([first, second]) => pairKey(first, second)),
  )
  let checkedNodes = 0

  const visit = (node: SnapshotNode, parent?: SnapshotNode) => {
    checkedNodes += 1

    if (parent && isAuditable(parent) && isAuditable(node)) {
      const amount = overflow(node.rect_px, parent.rect_px)
      const maxOverflow = Math.max(...Object.values(amount))
      if (maxOverflow > 0) {
        if (maxOverflow <= overflowTolerancePx) {
          tolerated.push({
            rule: 'parent-overflow',
            nodePath: node.path,
            relatedPath: parent.path,
            overflow: amount,
            tolerancePx: overflowTolerancePx,
          })
        } else if (allowedOverflowPaths.has(node.path)) {
          exceptions.push({
            rule: 'parent-overflow',
            nodePath: node.path,
            relatedPath: parent.path,
          })
        } else {
          issues.push({
            rule: 'parent-overflow',
            severity: 'error',
            nodeId: node.id,
            nodePath: node.path,
            relatedPath: parent.path,
            rect: node.rect_px,
            relatedRect: parent.rect_px,
            overflow: amount,
          })
        }
      }
    }

    const children = node.children ?? []
    if (options.checkSiblingOverlaps) {
      const visibleChildren = children.filter(isAuditable)
      for (let firstIndex = 0; firstIndex < visibleChildren.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < visibleChildren.length; secondIndex += 1) {
          const first = visibleChildren[firstIndex]
          const second = visibleChildren[secondIndex]
          const overlap = intersection(first.rect_px, second.rect_px)
          if (!overlap) continue
          if (allowedOverlapPairs.has(pairKey(first.path, second.path))) {
            exceptions.push({
              rule: 'sibling-overlap',
              nodePath: first.path,
              relatedPath: second.path,
            })
          } else {
            issues.push({
              rule: 'sibling-overlap',
              severity: 'error',
              nodeId: first.id,
              nodePath: first.path,
              relatedId: second.id,
              relatedPath: second.path,
              rect: first.rect_px,
              relatedRect: second.rect_px,
              intersection: overlap,
            })
          }
        }
      }
    }

    for (const child of children) {
      visit(child, node)
    }
  }

  for (const root of roots) {
    visit(root)
  }

  return { checkedNodes, issues, exceptions, tolerated }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function snapshotRoots(value: unknown): SnapshotNode[] {
  if (!isRecord(value) || value.success !== true) {
    throw new Error('ui.snapshot 调用失败或输入缺少 success=true')
  }
  if (!isRecord(value.result) || value.result.tool !== 'ui.snapshot') {
    throw new Error('输入不是完整的 ui.snapshot 结果包络')
  }
  if (value.result.truncated === true) {
    throw new Error('ui.snapshot 已截断；请提高 max_nodes/max_depth 后重新采集')
  }
  if (!Array.isArray(value.result.roots)) {
    throw new Error('ui.snapshot 结果不包含 result.roots 数组')
  }
  return value.result.roots as SnapshotNode[]
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${field} 必须是非空字符串数组`)
  }
  return [...value]
}

export function parseAuditOptions(value: unknown): AuditOptions {
  if (!isRecord(value)) {
    throw new Error('审计配置必须是 JSON 对象')
  }

  const allowedFields = new Set([
    'checkSiblingOverlaps',
    'overflowTolerancePx',
    'allowOverflowPaths',
    'allowOverlapPairs',
  ])
  const unknownFields = Object.keys(value).filter((field) => !allowedFields.has(field))
  if (unknownFields.length > 0) {
    throw new Error(`审计配置包含未知字段: ${unknownFields.join(', ')}`)
  }

  const options: AuditOptions = {}
  if (value.checkSiblingOverlaps !== undefined) {
    if (typeof value.checkSiblingOverlaps !== 'boolean') {
      throw new Error('checkSiblingOverlaps 必须是布尔值')
    }
    options.checkSiblingOverlaps = value.checkSiblingOverlaps
  }
  if (value.overflowTolerancePx !== undefined) {
    if (
      typeof value.overflowTolerancePx !== 'number'
      || !Number.isFinite(value.overflowTolerancePx)
      || value.overflowTolerancePx < 0
    ) {
      throw new Error('overflowTolerancePx 必须是非负有限数字')
    }
    options.overflowTolerancePx = value.overflowTolerancePx
  }
  if (value.allowOverflowPaths !== undefined) {
    options.allowOverflowPaths = stringArray(value.allowOverflowPaths, 'allowOverflowPaths')
  }
  if (value.allowOverlapPairs !== undefined) {
    if (!Array.isArray(value.allowOverlapPairs)) {
      throw new Error('allowOverlapPairs 必须是路径对数组')
    }
    options.allowOverlapPairs = value.allowOverlapPairs.map((pair) => {
      if (
        !Array.isArray(pair)
        || pair.length !== 2
        || pair.some((path) => typeof path !== 'string' || path.length === 0)
      ) {
        throw new Error('allowOverlapPairs 的每一项必须包含两个路径')
      }
      return [pair[0], pair[1]] as [string, string]
    })
  }
  return options
}

if (import.meta.main) {
  const inputPath = process.argv[2]
  const optionsPath = process.argv[3]
  if (!inputPath) {
    console.error('用法: bun run audit-ui-snapshot.ts <ui.snapshot.json> [audit-options.json]')
    process.exit(2)
  }

  try {
    const input = JSON.parse(readFileSync(inputPath, 'utf-8'))
    const options = optionsPath
      ? parseAuditOptions(JSON.parse(readFileSync(optionsPath, 'utf-8')))
      : {}
    const report = auditSnapshot(snapshotRoots(input), options)
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.issues.length > 0 ? 1 : 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}
