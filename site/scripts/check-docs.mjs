import { promises as fs } from 'node:fs'
import path from 'node:path'

import { generateDocsManifest, paths } from './generate-docs-manifest.mjs'

const markdownTargetPattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
const htmlTargetPattern = /<(?:a|img)\b[^>]*?\b(?:href|src)=["']([^"']+)["'][^>]*>/gi

function withoutSuffix(target) {
  return target.split(/[?#]/, 1)[0]
}

function isExternal(target) {
  return /^(?:[a-z]+:|\/\/|#)/i.test(target)
}

function normalizeRoute(target) {
  const decoded = decodeURIComponent(withoutSuffix(target))
  const withoutExtension = decoded
    .replace(/(?:\/index)?\.html$/i, '')
    .replace(/\.md$/i, '')
  const normalized = `/${withoutExtension}`.replace(/\/+/g, '/').replace(/\/$/, '')
  return normalized || '/'
}

async function exists(targetPath) {
  return fs.access(targetPath).then(() => true, () => false)
}

function collectTargets(markdown) {
  const targets = []
  const prose = markdown.replace(/```[\s\S]*?```/g, '')

  for (const match of prose.matchAll(markdownTargetPattern)) {
    targets.push(match[1])
  }

  for (const match of prose.matchAll(htmlTargetPattern)) {
    targets.push(match[1])
  }

  return [...new Set(targets)]
}

function isImageTarget(target) {
  return /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(withoutSuffix(target))
}

/**
 * 语言分流的判定规则在两处各有一份：src/lib/locale.js（可测的模块）和 index.html 里的内联
 * 副本（首帧就要跳，等不到模块加载）。两处漂移不会报错，只会让首页悄悄按旧规则分流，所以
 * 在这里钉死：storage key 和中文判定正则必须逐字一致，且内联脚本必须只在根路径动手。
 */
async function checkLocaleRedirect() {
  const problems = []
  const moduleSource = await fs.readFile(path.join(paths.siteDir, 'src/lib/locale.js'), 'utf8')
  const shellSource = await fs.readFile(path.join(paths.siteDir, 'index.html'), 'utf8')

  const storageKey = moduleSource.match(/LOCALE_STORAGE_KEY\s*=\s*'([^']+)'/)?.[1]
  const chineseTag = moduleSource.match(/const CHINESE_TAG\s*=\s*(\/.+\/i)/)?.[1]

  if (!storageKey || !chineseTag) {
    problems.push('src/lib/locale.js: 读不出 LOCALE_STORAGE_KEY 或 CHINESE_TAG，防漂移校验失效')
    return problems
  }

  if (!shellSource.includes(`localStorage.getItem('${storageKey}')`)) {
    problems.push(`index.html: 内联语言脚本没有用 '${storageKey}'，与 src/lib/locale.js 不一致`)
  }

  if (!shellSource.includes(chineseTag)) {
    problems.push(`index.html: 内联语言脚本的中文判定与 src/lib/locale.js 的 ${chineseTag} 不一致`)
  }

  // 少了这道判断，/en/start 这类地址也会被卷进分流。
  if (!shellSource.includes("window.location.pathname.replace(/\\/+$/, '') !== ''")) {
    problems.push('index.html: 内联语言脚本缺少「只在根路径生效」的判断')
  }

  return problems
}

async function main() {
  const { records } = await generateDocsManifest()
  const routes = new Set([
    '/',
    '/docs',
    '/en',
    '/en/docs',
    ...records.map((record) => record.path),
  ])
  const problems = [...await checkLocaleRedirect()]
  let checkedTargets = 0

  for (const record of records) {
    const sourceAbsolutePath = path.join(paths.repoDir, record.sourcePath)
    const sourceDirectory = path.dirname(sourceAbsolutePath)

    for (const target of collectTargets(record.content)) {
      if (!target || isExternal(target)) {
        continue
      }

      checkedTargets += 1
      const pathname = withoutSuffix(target)
      const image = isImageTarget(pathname)

      if (pathname.startsWith('/')) {
        const publicFile = path.join(paths.docsDir, 'public', pathname.replace(/^\//, ''))
        const docsFile = path.join(paths.docsDir, pathname.replace(/^\//, ''))
        const valid = image
          ? await exists(publicFile) || await exists(docsFile)
          : routes.has(normalizeRoute(pathname)) || await exists(publicFile)

        if (!valid) {
          problems.push(`${record.sourcePath}: unresolved ${image ? 'image' : 'link'} ${target}`)
        }
        continue
      }

      const resolvedFile = path.resolve(sourceDirectory, pathname)
      const markdownRoute = normalizeRoute(path.relative(paths.docsDir, resolvedFile))
      const valid = image
        ? await exists(resolvedFile)
        : await exists(resolvedFile)
          || routes.has(markdownRoute)
          || routes.has(normalizeRoute(`${path.relative(paths.docsDir, resolvedFile)}.md`))

      if (!valid) {
        problems.push(`${record.sourcePath}: unresolved ${image ? 'image' : 'link'} ${target}`)
      }
    }
  }

  if (problems.length > 0) {
    console.error(`Documentation check found ${problems.length} problem(s):`)
    for (const problem of problems) {
      console.error(`- ${problem}`)
    }
    process.exitCode = 1
    return
  }

  console.log(`Documentation check passed: ${records.length} pages, ${checkedTargets} local links and images.`)
}

await main()
