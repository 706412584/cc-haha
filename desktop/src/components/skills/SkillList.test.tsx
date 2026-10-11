import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSkillStore } from '../../stores/skillStore'
import { SkillList } from './SkillList'

const fetchSkills = vi.fn()
const fetchSkillDetail = vi.fn()

describe('SkillList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          title: 'Active session',
          createdAt: '2026-04-20T00:00:00.000Z',
          modifiedAt: '2026-04-20T00:00:00.000Z',
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
      ],
      activeSessionId: 'session-1',
      isLoading: false,
      error: null,
    })
    useSkillStore.setState({
      skills: [],
      selectedSkill: null,
      selectedSkillReturnTab: 'skills',
      isLoading: false,
      isDetailLoading: false,
      error: null,
      fetchSkills,
      fetchSkillDetail,
      clearSelection: vi.fn(),
    })
  })

  it('renders browser summary and grouped skill cards', () => {
    useSkillStore.setState({
      skills: [
        {
          name: 'alpha',
          displayName: 'Alpha Skill',
          description: 'First skill description',
          source: 'user',
          userInvocable: true,
          version: '1.0.0',
          contentLength: 400,
          hasDirectory: true,
        },
        {
          name: 'beta',
          description: 'Second skill description',
          source: 'project',
          userInvocable: false,
          contentLength: 200,
          hasDirectory: true,
        },
        {
          name: 'telegram:access',
          displayName: 'Telegram Access',
          description: 'Plugin-provided access workflow',
          source: 'plugin',
          pluginName: 'telegram',
          userInvocable: true,
          contentLength: 280,
          hasDirectory: true,
        },
      ],
    })

    render(<SkillList />)

    // The host page head names the browser; the list opens on search and its
    // numbers rather than a second title block.
    expect(screen.queryByText('Browse installed skills')).not.toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Search skills' })).toBeInTheDocument()
    expect(screen.getByText('Total skills')).toBeInTheDocument()
    expect(screen.getByText('Alpha Skill')).toBeInTheDocument()
    expect(screen.getByText('Second skill description')).toBeInTheDocument()
    expect(screen.getAllByText('Plugin').length).toBeGreaterThan(0)
    expect(screen.getByText('Telegram Access')).toBeInTheDocument()
  })

  it('filters installed skills locally by keyword and clears the search', () => {
    useSkillStore.setState({
      skills: [
        {
          name: 'alpha',
          displayName: 'Alpha Skill',
          description: 'First skill description',
          source: 'user',
          userInvocable: true,
          contentLength: 400,
          hasDirectory: true,
        },
        {
          name: 'telegram:access',
          displayName: 'Telegram Access',
          description: 'Plugin-provided access workflow',
          source: 'plugin',
          pluginName: 'telegram',
          userInvocable: true,
          contentLength: 280,
          hasDirectory: true,
        },
      ],
    })

    render(<SkillList />)

    const searchInput = screen.getByPlaceholderText('Search skills by name, description, or source...')
    fireEvent.change(searchInput, { target: { value: 'telegram' } })

    expect(screen.getByText('Telegram Access')).toBeInTheDocument()
    expect(screen.queryByText('Alpha Skill')).not.toBeInTheDocument()
    expect(screen.getByText('1 of 2 skills match')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Clear skill search'))

    expect(screen.getByText('Telegram Access')).toBeInTheDocument()
    expect(screen.getByText('Alpha Skill')).toBeInTheDocument()
  })

  it('uses the active session workDir for project-scoped skills', () => {
    render(<SkillList />)

    expect(fetchSkills).toHaveBeenCalledWith('/workspace/project')
  })

  it('flags skills from the cross-client .agents directory', () => {
    useSkillStore.setState({
      skills: [
        {
          name: 'native',
          displayName: 'Native Skill',
          description: 'Lives in .claude/skills',
          source: 'user',
          rootFlavor: 'claude',
          userInvocable: true,
          contentLength: 400,
          hasDirectory: true,
        },
        {
          name: 'shared',
          displayName: 'Shared Skill',
          description: 'Lives in .agents/skills',
          source: 'user',
          rootFlavor: 'agents',
          userInvocable: true,
          contentLength: 400,
          hasDirectory: true,
        },
      ],
    })

    render(<SkillList />)

    // Only the `.agents` entry is badged — badging `.claude` would put a label
    // on every skill an existing user already has.
    const badges = screen.getAllByText('.agents')
    expect(badges).toHaveLength(1)
    expect(screen.getByRole('button', { name: /Shared Skill/ })).toContainElement(badges[0]!)
  })

  it('tells a repository-supplied .agents skill apart from one in the home directory', () => {
    // The same badge covers both scopes, so a hint that always names
    // ~/.agents/skills would describe a skill that shipped with the repository
    // as though the user had installed it themselves.
    useSkillStore.setState({
      skills: [
        {
          name: 'mine',
          displayName: 'Home Skill',
          description: 'Installed by another tool under $HOME',
          source: 'user',
          rootFlavor: 'agents',
          userInvocable: true,
          contentLength: 400,
          hasDirectory: true,
        },
        {
          name: 'theirs',
          displayName: 'Repo Skill',
          description: 'Shipped inside the checked-out project',
          source: 'project',
          rootFlavor: 'agents',
          userInvocable: true,
          contentLength: 400,
          hasDirectory: true,
        },
      ],
    })

    render(<SkillList />)

    const hintOf = (name: RegExp) =>
      screen.getByRole('button', { name }).querySelector('[title]')?.getAttribute('title') ?? ''

    expect(hintOf(/Home Skill/)).toContain('~/.agents/skills/')
    expect(hintOf(/Repo Skill/)).not.toContain('~/.agents/skills/')
    expect(hintOf(/Repo Skill/)).toMatch(/project/i)
  })

  it('leaves skills without a rootFlavor unbadged', () => {
    // Older servers omit the field entirely; the list must not break or
    // mislabel them.
    useSkillStore.setState({
      skills: [
        {
          name: 'legacy',
          displayName: 'Legacy Skill',
          description: 'Server predating rootFlavor',
          source: 'user',
          userInvocable: true,
          contentLength: 400,
          hasDirectory: true,
        },
      ],
    })

    render(<SkillList />)

    expect(screen.getByText('Legacy Skill')).toBeInTheDocument()
    expect(screen.queryByText('.agents')).not.toBeInTheDocument()
  })

  it('offers the recommended catalog with a localized description and installs on click', () => {
    // Fork feature restored after the upstream merge dropped it: the curated
    // catalog must render, use the localized description when a key exists,
    // and fall back to the server text otherwise.
    const installSkill = vi.fn()
    useSkillStore.setState({
      skills: [
        {
          name: 'alpha',
          displayName: 'Alpha Skill',
          description: 'First skill description',
          source: 'user',
          userInvocable: true,
          contentLength: 400,
          hasDirectory: true,
        },
      ],
      catalog: [
        {
          name: 'karpathy-guidelines',
          displayName: 'Karpathy Guidelines',
          description: 'Server English description',
          category: 'Engineering',
          source: 'bundled',
          installed: false,
        },
        {
          name: 'brand-new-skill',
          displayName: 'Brand New Skill',
          description: 'Untranslated catalog entry',
          category: 'Something New',
          source: 'bundled',
          installed: false,
        },
        {
          name: 'already-there',
          displayName: 'Already Installed',
          description: 'Ships with the app',
          category: 'Engineering',
          source: 'bundled',
          installed: true,
        },
      ],
      installingName: null,
      fetchCatalog: vi.fn(),
      installSkill,
    })

    render(<SkillList />)

    expect(screen.getByText('Recommended skills')).toBeInTheDocument()
    // Localized via CATALOG_DESC_KEY; the raw server text must not leak.
    expect(screen.queryByText('Server English description')).not.toBeInTheDocument()
    expect(screen.getByText('Brand New Skill')).toBeInTheDocument()
    expect(screen.getByText('Untranslated catalog entry')).toBeInTheDocument()
    // A category without a mapping falls back to the server value.
    expect(screen.getByText('Something New')).toBeInTheDocument()
    // Installed entries show their state instead of an install button.
    expect(screen.getByText('Installed')).toBeInTheDocument()

    const installButtons = screen.getAllByRole('button', { name: 'Install' })
    expect(installButtons).toHaveLength(2)
    fireEvent.click(installButtons[0]!)
    expect(installSkill).toHaveBeenCalledWith('karpathy-guidelines', '/workspace/project')
  })

  it('keeps the recommended catalog reachable with zero installed skills', () => {
    // Regression: the page used to early-return an empty state, hiding the
    // catalog from a first-time user with nothing installed yet.
    useSkillStore.setState({
      skills: [],
      catalog: [
        {
          name: 'karpathy-guidelines',
          displayName: 'Karpathy Guidelines',
          description: 'Server English description',
          category: 'Engineering',
          source: 'bundled',
          installed: false,
        },
      ],
      installingName: null,
      fetchCatalog: vi.fn(),
      installSkill: vi.fn(),
    })

    render(<SkillList />)

    expect(screen.getByText('Karpathy Guidelines')).toBeInTheDocument()
    // The empty notice renders inline instead of replacing the whole page.
    expect(screen.getByText('No skills installed')).toBeInTheDocument()
  })
})
