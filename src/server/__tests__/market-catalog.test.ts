import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  catalogCategories,
  catalogClawhubOwners,
  catalogEntryFor,
  catalogEntryToSkill,
  filterCatalog,
  getCatalog,
  type CatalogEntry,
} from '../services/market/catalog/catalog.js'
import type { CurationFile } from '../services/market/catalog/catalogSnapshot.js'
import { sanitizeDirName, skillId } from '../services/market/types.js'

const catalog = getCatalog()
const CATALOG_DIR = path.join(import.meta.dir, '..', 'services', 'market', 'catalog')

function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

function nameHit(entry: CatalogEntry, term: string): boolean {
  return fold(`${entry.name} ${entry.slug}`).includes(fold(term))
}

describe('catalog snapshot invariants', () => {
  it('has a generation time and the editorial categories', () => {
    expect(catalog.version).toBe(1)
    expect(Number.isInteger(catalog.generatedAt)).toBe(true)
    expect(catalog.categories.length).toBeGreaterThan(0)
    expect(new Set(catalog.categories.map((category) => category.key)).size).toBe(catalog.categories.length)
    for (const category of catalog.categories) {
      expect(category.name.length).toBeGreaterThan(0)
      expect(category.nameEn.length).toBeGreaterThan(0)
    }
  })

  it('lists every source:slug once, each in a known category with an owner and a zh summary', () => {
    const keys = new Set(catalog.categories.map((category) => category.key))
    const ids = catalog.skills.map((entry) => skillId(entry.source, entry.slug))
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of catalog.skills) {
      expect(['clawhub', 'skillhub']).toContain(entry.source)
      expect(keys.has(entry.category)).toBe(true)
      expect(entry.owner.length).toBeGreaterThan(0)
      expect(entry.summary.length).toBeGreaterThan(0)
      expect(entry.tags.length).toBeGreaterThan(0)
      expect(typeof entry.stats.downloads).toBe('number')
    }
  })

  it('ships no malicious entry, and every flagged entry explains itself', () => {
    for (const entry of catalog.skills) {
      expect(['verified', 'benign', 'unknown', 'flagged']).toContain(entry.security)
      if (entry.security === 'flagged') expect(entry.securityNote?.trim().length ?? 0).toBeGreaterThan(0)
      else expect(entry.securityNote).toBeUndefined()
    }
  })

  it('installs every entry into a distinct, valid directory name', () => {
    const dirNames = catalog.skills.map((entry) => sanitizeDirName(entry.slug))
    expect(dirNames.every((name) => name !== null)).toBe(true)
    expect(new Set(dirNames).size).toBe(dirNames.length)
  })

  it('matches its editorial source: same selection, owners, categories, summaries, tags and picks', async () => {
    const curation = JSON.parse(await fs.readFile(path.join(CATALOG_DIR, 'curation.json'), 'utf-8')) as CurationFile
    expect(typeof curation._source).toBe('string')
    expect(curation.categories).toEqual(catalog.categories)
    const curated = new Map(curation.skills.map((entry) => [skillId(entry.source, entry.slug), entry]))
    for (const entry of catalog.skills) {
      const source = curated.get(skillId(entry.source, entry.slug))
      expect(source).toBeDefined()
      expect(entry.owner).toBe(source!.owner)
      expect(entry.category).toBe(source!.category)
      expect(entry.summary).toBe(source!.summary)
      expect(entry.tags).toEqual(source!.tags ?? [])
      expect(entry.featured === true).toBe(source!.featured === true)
      // Only an explicit editorial reason lets a suspicious verdict ship.
      if (entry.security === 'flagged') expect(source!.allowSuspicious).toBeTruthy()
    }
  })

  it('leads with the editor\'s picks', () => {
    const featured = catalog.skills.filter((entry) => entry.featured).length
    expect(featured).toBeGreaterThan(0)
    expect(catalog.skills.slice(0, featured).every((entry) => entry.featured)).toBe(true)
  })
})

describe('catalog accessors', () => {
  it('looks entries up by source and slug', () => {
    const entry = catalog.skills[0]!
    expect(catalogEntryFor(entry.source, entry.slug)).toBe(entry)
    expect(catalogEntryFor(entry.source === 'clawhub' ? 'skillhub' : 'clawhub', `${entry.slug}-nope`)).toBeUndefined()
  })

  it('counts categories over the whole catalog, in editorial order', () => {
    const categories = catalogCategories()
    expect(categories.map((category) => category.key)).toEqual(catalog.categories.map((category) => category.key))
    for (const category of categories) {
      expect(category.count).toBe(catalog.skills.filter((entry) => entry.category === category.key).length)
    }
  })

  it('pins an owner for every ClawHub entry', () => {
    const owners = new Map(catalogClawhubOwners())
    const clawhub = catalog.skills.filter((entry) => entry.source === 'clawhub')
    expect(owners.size).toBe(clawhub.length)
    for (const entry of clawhub) expect(owners.get(entry.slug)).toBe(entry.owner)
  })

  it('turns an entry into a curated card', () => {
    const flagged = catalog.skills.find((entry) => entry.security === 'flagged')!
    const skill = catalogEntryToSkill(flagged)

    expect(skill).toMatchObject({
      id: skillId(flagged.source, flagged.slug),
      name: flagged.name,
      summary: flagged.summary,
      summaryEn: flagged.summaryEn,
      author: { handle: flagged.owner },
      category: flagged.category,
      securityStatus: 'flagged',
      securityNote: flagged.securityNote,
      curated: true,
      installState: 'installable',
    })
    // The card owns copies: annotating it never edits the shared snapshot.
    skill.tags.push('mutated')
    skill.stats.downloads = -1
    expect(flagged.tags).not.toContain('mutated')
    expect(flagged.stats.downloads).not.toBe(-1)
    expect(catalogEntryToSkill(catalog.skills.find((entry) => entry.featured)!).featured).toBe(true)
    expect(catalogEntryToSkill(catalog.skills.find((entry) => !entry.featured)!).featured).toBeUndefined()
  })
})

describe('filterCatalog', () => {
  it('returns the whole catalog in order without filters', () => {
    expect(filterCatalog({})).toEqual(catalog.skills)
    expect(filterCatalog({ q: '   ', source: 'all' })).toEqual(catalog.skills)
  })

  it('ranks name/slug hits above summary, tag or owner hits', () => {
    const term = 'mcp'
    const result = filterCatalog({ q: term })
    const firstWeak = result.findIndex((entry) => !nameHit(entry, term))
    expect(firstWeak).toBeGreaterThan(0)
    expect(result.slice(0, firstWeak).every((entry) => nameHit(entry, term))).toBe(true)
    expect(result.slice(firstWeak).some((entry) => nameHit(entry, term))).toBe(false)
    // Within each band the catalog order is kept.
    const order = new Map(catalog.skills.map((entry, index) => [entry, index]))
    const strongIdx = result.slice(0, firstWeak).map((entry) => order.get(entry)!)
    expect([...strongIdx].sort((a, b) => a - b)).toEqual(strongIdx)
  })

  it('folds case and full-width input', () => {
    const plain = filterCatalog({ q: 'pdf' })
    expect(plain.length).toBeGreaterThan(0)
    expect(filterCatalog({ q: 'ＰＤＦ' })).toEqual(plain)
    expect(filterCatalog({ q: 'PdF' })).toEqual(plain)
  })

  it('requires every term to match', () => {
    const both = filterCatalog({ q: 'pdf word' })
    expect(both.length).toBeGreaterThan(0)
    expect(both.length).toBeLessThan(filterCatalog({ q: 'pdf' }).length)
    for (const entry of both) {
      const text = fold(`${entry.name} ${entry.slug} ${entry.summary} ${entry.summaryEn ?? ''} ${entry.tags.join(' ')} ${entry.owner}`)
      expect(text.includes('pdf') && text.includes('word')).toBe(true)
    }
  })

  it('matches owners and Chinese summaries', () => {
    const owner = catalog.skills.find((entry) => entry.source === 'clawhub')!.owner
    expect(filterCatalog({ q: owner }).some((entry) => entry.owner === owner)).toBe(true)
    expect(filterCatalog({ q: '浏览器' }).length).toBeGreaterThan(0)
  })

  it('filters by category and source', () => {
    const category = catalog.categories[0]!.key
    const inCategory = filterCatalog({ category })
    expect(inCategory.length).toBeGreaterThan(0)
    expect(inCategory.every((entry) => entry.category === category)).toBe(true)

    const skillhub = filterCatalog({ source: 'skillhub' })
    expect(skillhub.length).toBeGreaterThan(0)
    expect(skillhub.every((entry) => entry.source === 'skillhub')).toBe(true)
    expect(skillhub.length + filterCatalog({ source: 'clawhub' }).length).toBe(catalog.skills.length)

    expect(filterCatalog({ category: 'no-such-category' })).toEqual([])
  })
})
