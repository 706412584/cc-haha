#!/usr/bin/env bun
/**
 * Regenerate the Skills Market curated catalog snapshot.
 *
 *   bun run scripts/market-catalog-refresh.ts           # rewrite skills.json
 *   bun run scripts/market-catalog-refresh.ts --check   # report only, write nothing
 *
 * Reads `src/server/services/market/catalog/curation.json` (the editorial
 * source) and re-reads what upstream owns for every entry. Upstream bases
 * follow `HAHA_MARKET_BASE_CLAWHUB` / `HAHA_MARKET_BASE_SKILLHUB`.
 *
 * This talks to the live registries, so it is a maintainer tool only: no test
 * or CI lane runs it, and it refuses to run when `CI` is set.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  buildCatalogSnapshot,
  clawhubLatestVersion,
  curationEntriesToRead,
  readClawhubEntry,
  readSkillhubEntry,
  type CatalogRead,
  type CurationEntry,
  type CurationFile,
} from '../src/server/services/market/catalog/catalogSnapshot.js'
import { getProviderBase } from '../src/server/services/market/providerFetch.js'

if (process.env.CI) {
  console.log('market-catalog-refresh: skipped (CI is set; this script reads live registries)')
  process.exit(0)
}

const CATALOG_DIR = join(import.meta.dir, '..', 'src', 'server', 'services', 'market', 'catalog')
const CURATION = join(CATALOG_DIR, 'curation.json')
const SNAPSHOT = join(CATALOG_DIR, 'skills.json')
const CONCURRENCY = 6
const checkOnly = process.argv.includes('--check')

type JsonResult = Record<string, any>

async function getJson(url: string): Promise<JsonResult> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'cc-haha-market-catalog' } })
      if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`)
      if (!response.ok) return { _status: response.status }
      return (await response.json()) as JsonResult
    } catch (error) {
      if (attempt === 3) return { _error: String(error) }
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
    }
  }
  return {}
}

async function readClawhub(entry: CurationEntry): Promise<CatalogRead> {
  const base = getProviderBase('clawhub')
  const owner = `?owner=${encodeURIComponent(entry.owner)}`
  const detail = await getJson(`${base}/api/v1/skills/${encodeURIComponent(entry.slug)}${owner}`)
  const version = clawhubLatestVersion(detail)
  const versionDetail = detail.skill && version
    ? await getJson(`${base}/api/v1/skills/${encodeURIComponent(entry.slug)}/versions/${encodeURIComponent(version)}${owner}`)
    : {}
  return readClawhubEntry(entry, detail, versionDetail)
}

async function readSkillhub(entry: CurationEntry): Promise<CatalogRead> {
  const base = getProviderBase('skillhub')
  return readSkillhubEntry(entry, await getJson(`${base}/api/v1/skills/${encodeURIComponent(entry.slug)}`))
}

async function pool<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index]!)
    }
  }))
  return results
}

const curation = JSON.parse(await readFile(CURATION, 'utf8')) as CurationFile
const toRead = curationEntriesToRead(curation)
const results = await pool(toRead, (entry) => entry.source === 'clawhub' ? readClawhub(entry) : readSkillhub(entry))
const reads = new Map<string, CatalogRead>(toRead.map((entry, index) => [`${entry.source}:${entry.slug}`, results[index]!]))

const { snapshot, problems } = buildCatalogSnapshot(curation, reads, Date.now())
console.log(`catalog: ${snapshot.skills.length}/${curation.skills.length} entries kept`)
for (const problem of problems) console.log(`  dropped ${problem}`)
if (!checkOnly) {
  await writeFile(SNAPSHOT, `${JSON.stringify(snapshot, null, 1)}\n`)
  console.log(`wrote ${SNAPSHOT}`)
}
