/**
 * Curated catalog of recommended plugins surfaced in the desktop
 * Settings → Plugins "Recommended" section for one-click install.
 *
 * Each entry pairs a plugin id with the marketplace source it lives in. On
 * install, the server calls addMarketplaceSource (idempotent) to register
 * the marketplace, then enablePluginOp to flip the user-scope settings entry.
 *
 * Descriptions are intentionally short and paraphrased; richer marketplace
 * metadata is fetched from marketplace.json after registration.
 */

import {
  OFFICIAL_MARKETPLACE_NAME,
  OFFICIAL_MARKETPLACE_SOURCE,
} from './officialMarketplace.js'
import type { MarketplaceSource } from './schemas.js'

export type CatalogPluginCategory =
  | 'official'
  | 'devops'
  | 'codeReview'
  | 'observability'
  | 'database'
  | 'frontend'
  | 'payments'
  | 'productivity'
  | 'browser'

export type CatalogPlugin = {
  /** Plugin name within its marketplace. */
  id: string
  /** Marketplace identifier the plugin lives in. */
  marketplace: string
  /** Source spec used to register the marketplace if not yet registered. */
  marketplaceSource: MarketplaceSource
  /** Human-friendly label for the UI card. */
  displayName: string
  /** Default English description (i18n keys override per locale). */
  description: string
  /** Grouping category for the UI. */
  category: CatalogPluginCategory
}

/**
 * Public API shape returned by GET /api/plugins/catalog. The `installed` flag
 * is computed per request from the user's installed_plugins.json.
 */
export type CatalogPluginMeta = CatalogPlugin & { installed: boolean }

/**
 * Initial recommendation set — all from the official Anthropic marketplace.
 * Picked for breadth (each is a different surface) and cross-platform usability.
 */
export const PLUGIN_CATALOG: CatalogPlugin[] = [
  {
    id: 'superpowers',
    marketplace: OFFICIAL_MARKETPLACE_NAME,
    marketplaceSource: OFFICIAL_MARKETPLACE_SOURCE,
    displayName: 'Superpowers',
    description:
      'Anthropic skill bundle: practical workflows for everyday Claude Code work.',
    category: 'official',
  },
  {
    id: 'github',
    marketplace: OFFICIAL_MARKETPLACE_NAME,
    marketplaceSource: OFFICIAL_MARKETPLACE_SOURCE,
    displayName: 'GitHub',
    description:
      'Inspect repositories, triage PRs and issues, debug CI, and prepare changes for review.',
    category: 'devops',
  },
  {
    id: 'linear',
    marketplace: OFFICIAL_MARKETPLACE_NAME,
    marketplaceSource: OFFICIAL_MARKETPLACE_SOURCE,
    displayName: 'Linear',
    description: 'Plan and track issues, projects, and cycles in Linear.',
    category: 'productivity',
  },
  {
    id: 'coderabbit',
    marketplace: OFFICIAL_MARKETPLACE_NAME,
    marketplaceSource: OFFICIAL_MARKETPLACE_SOURCE,
    displayName: 'CodeRabbit',
    description:
      'AI code review from the terminal, with severity-grouped findings and fix loops.',
    category: 'codeReview',
  },
  {
    id: 'sentry',
    marketplace: OFFICIAL_MARKETPLACE_NAME,
    marketplaceSource: OFFICIAL_MARKETPLACE_SOURCE,
    displayName: 'Sentry',
    description: 'Triage Sentry issues, traces, and releases inline.',
    category: 'observability',
  },
  {
    id: 'supabase',
    marketplace: OFFICIAL_MARKETPLACE_NAME,
    marketplaceSource: OFFICIAL_MARKETPLACE_SOURCE,
    displayName: 'Supabase',
    description:
      'Operate Supabase Postgres, Auth, RLS, and edge functions from chat.',
    category: 'database',
  },
  {
    id: 'vercel',
    marketplace: OFFICIAL_MARKETPLACE_NAME,
    marketplaceSource: OFFICIAL_MARKETPLACE_SOURCE,
    displayName: 'Vercel',
    description: 'Manage Vercel projects, deployments, env vars, and logs.',
    category: 'devops',
  },
  {
    id: 'netlify-skills',
    marketplace: OFFICIAL_MARKETPLACE_NAME,
    marketplaceSource: OFFICIAL_MARKETPLACE_SOURCE,
    displayName: 'Netlify',
    description: 'Build, deploy, and inspect Netlify sites and functions.',
    category: 'devops',
  },
  {
    id: 'figma',
    marketplace: OFFICIAL_MARKETPLACE_NAME,
    marketplaceSource: OFFICIAL_MARKETPLACE_SOURCE,
    displayName: 'Figma',
    description:
      'Pull frames, component metadata, and design context from Figma into code.',
    category: 'frontend',
  },
  {
    id: 'playwright',
    marketplace: OFFICIAL_MARKETPLACE_NAME,
    marketplaceSource: OFFICIAL_MARKETPLACE_SOURCE,
    displayName: 'Playwright',
    description:
      'Drive a real browser to author and debug Playwright tests.',
    category: 'browser',
  },
  {
    id: 'chrome-devtools-mcp',
    marketplace: OFFICIAL_MARKETPLACE_NAME,
    marketplaceSource: OFFICIAL_MARKETPLACE_SOURCE,
    displayName: 'Chrome DevTools',
    description:
      'Browse, screenshot, and inspect web pages over the Chrome DevTools Protocol.',
    category: 'browser',
  },
  {
    id: 'stripe',
    marketplace: OFFICIAL_MARKETPLACE_NAME,
    marketplaceSource: OFFICIAL_MARKETPLACE_SOURCE,
    displayName: 'Stripe',
    description:
      'Read Stripe data, build payment integrations, and inspect events.',
    category: 'payments',
  },
]

/**
 * Look up a catalog entry by its full plugin id (`name@marketplace`).
 * Used by the install endpoint to recover the marketplace source from
 * just the user-clicked plugin id.
 */
export function getCatalogEntry(
  id: string,
  marketplace: string,
): CatalogPlugin | undefined {
  return PLUGIN_CATALOG.find(
    (entry) => entry.id === id && entry.marketplace === marketplace,
  )
}
