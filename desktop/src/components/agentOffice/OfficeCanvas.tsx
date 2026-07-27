import { useEffect, useRef, useState } from 'react'
import type { Agent } from './types/agent'
import type { AgentOfficeCopy } from './officeCopy'
import { OfficeScene, type OfficeAgentClick } from './scene/OfficeScene'
import { resolveOfficeThemePalette } from './officeTheme'
import { isThemeMode, type ThemeMode } from '../../types/settings'

type AgentMenuState = {
  agent: Agent
  rosterNo: number
  x: number
  y: number
  agents: Agent[]
  pickingTarget: boolean
}

const EMOTE_ACTIONS = [
  { key: 'determined', animation: 'emotes/determined' },
  { key: 'thinking', animation: 'emotes/thinking' },
  { key: 'idea', animation: 'emotes/idea' },
  { key: 'excited', animation: 'emotes/excited' },
  { key: 'hooray', animation: 'emotes/hooray' },
  { key: 'wave', animation: 'emotes/wave' },
  { key: 'laugh', animation: 'emotes/laugh' },
  { key: 'confused', animation: 'emotes/confused' },
] as const

function interpolateName(template: string, name: string): string {
  return template.replace('{name}', name)
}

function appliedTheme(): ThemeMode {
  const value = document.documentElement.getAttribute('data-theme')
  return isThemeMode(value) ? value : 'warm-classic'
}

export function OfficeCanvas({
  agents,
  copy,
  selectedSourceKey = null,
  onSelectAgent,
}: {
  agents: Agent[]
  copy: AgentOfficeCopy
  selectedSourceKey?: string | null
  onSelectAgent?: (sourceKey: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<OfficeScene | null>(null)
  const agentsRef = useRef(agents)
  const latestSizeRef = useRef<{ width: number; height: number } | null>(null)
  const initializeRef = useRef<() => void>(() => {})
  const [initError, setInitError] = useState<string | null>(null)
  const [menu, setMenu] = useState<AgentMenuState | null>(null)

  agentsRef.current = agents

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const handleAgentClick = (event: OfficeAgentClick) => {
      if (event.agent.sourceKey) onSelectAgent?.(event.agent.sourceKey)
      const rect = host.getBoundingClientRect()
      const menuWidth = 260
      const menuHeight = Math.min(420, rect.height - 24)
      setMenu({
        agent: event.agent,
        rosterNo: event.rosterNo,
        x: Math.max(12, Math.min(event.clientX - rect.left, rect.width - menuWidth - 12)),
        y: Math.max(12, Math.min(event.clientY - rect.top, rect.height - menuHeight - 12)),
        agents: sceneRef.current?.getAgents() ?? [],
        pickingTarget: false,
      })
    }

    const scene = new OfficeScene({
      onAgentClick: handleAgentClick,
      ambientCopy: copy,
    })
    sceneRef.current = scene
    scene.setThemePalette(resolveOfficeThemePalette(appliedTheme()))
    const reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const applyReducedMotion = () => scene.setReducedMotion(reducedMotionQuery?.matches ?? false)
    applyReducedMotion()
    reducedMotionQuery?.addEventListener('change', applyReducedMotion)
    scene.syncAgents(agentsRef.current)
    let initializing = false
    let initialized = false
    let disposed = false

    const initialize = () => {
      const size = latestSizeRef.current
      if (!size || initializing || initialized || disposed) return
      initializing = true
      setInitError(null)
      void scene.init(host, size.width, size.height).then(() => {
        if (disposed) return
        initializing = false
        initialized = true
        const latestSize = latestSizeRef.current
        if (latestSize) scene.resize(latestSize.width, latestSize.height)
      }).catch((error: unknown) => {
        if (disposed) return
        initializing = false
        setInitError(error instanceof Error ? error.message : String(error))
      })
    }
    initializeRef.current = initialize

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      if (width <= 0 || height <= 0) return

      latestSizeRef.current = { width, height }
      if (initialized) scene.resize(width, height)
      else initialize()
    })

    observer.observe(host)
    const themeObserver = new MutationObserver(() => {
      scene.setThemePalette(resolveOfficeThemePalette(appliedTheme()))
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => {
      disposed = true
      observer.disconnect()
      themeObserver.disconnect()
      reducedMotionQuery?.removeEventListener('change', applyReducedMotion)
      latestSizeRef.current = null
      initializeRef.current = () => {}
      scene.destroy()
      sceneRef.current = null
    }
  }, [])

  useEffect(() => {
    sceneRef.current?.syncAgents(agents)
  }, [agents])

  useEffect(() => {
    sceneRef.current?.setAmbientCopy(copy)
  }, [copy])

  useEffect(() => {
    sceneRef.current?.setSelectedSourceKey(selectedSourceKey)
  }, [selectedSourceKey])

  useEffect(() => {
    const closeMenu = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-agent-action-menu]')) return
      setMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }

    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  const startInteraction = (targetRosterNo: number, targetName: string) => {
    if (!menu || targetRosterNo === menu.rosterNo) return
    sceneRef.current?.requestDeskVisit(
      menu.rosterNo,
      targetRosterNo,
      interpolateName(copy.visitMessage, targetName),
    )
    setMenu(null)
  }

  return (
    <div
      ref={hostRef}
      data-testid="agent-office-canvas"
      className="relative h-full min-h-[420px] w-full overflow-hidden bg-[var(--color-surface-container-lowest)]"
    >
      <p className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-glass)] px-3 py-1 text-[10px] text-[var(--color-text-secondary)] shadow-sm backdrop-blur">
        {copy.interactionHint}
      </p>
      <div className="sr-only" role="group" aria-label={copy.agentRosterLabel}>
        {agents.filter((agent) => agent.sourceKey).map((agent) => (
          <button
            key={agent.id}
            type="button"
            aria-pressed={selectedSourceKey === agent.sourceKey}
            onClick={() => agent.sourceKey && onSelectAgent?.(agent.sourceKey)}
          >
            {agent.name} · {copy.agentState[agent.state]}
          </button>
        ))}
      </div>
      {initError ? (
        <div role="alert" className="absolute inset-0 z-30 flex items-center justify-center bg-[var(--color-surface-glass)] p-6">
          <div className="max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-4 text-center shadow-lg">
            <p className="text-sm text-[var(--color-error)]">{initError}</p>
            <button
              type="button"
              className="mt-3 rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-on-primary)] hover:bg-[var(--color-primary-container)]"
              onClick={() => initializeRef.current()}
            >
              {copy.retry}
            </button>
          </div>
        </div>
      ) : null}
      {menu ? (
        <div
          data-agent-action-menu
          className="absolute z-20 max-h-[min(420px,calc(100%-24px))] w-[260px] overflow-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-glass)] p-2 text-[var(--color-text-primary)] shadow-2xl backdrop-blur-xl"
          style={{ left: menu.x, top: menu.y }}
        >
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-2 pb-2 pt-1">
            <strong className="truncate text-sm">{menu.agent.name}</strong>
            <span className="rounded-full bg-[var(--color-surface-container)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
              {copy.agentState[menu.agent.state]}
            </span>
          </div>

          {!menu.pickingTarget ? (
            <>
              <button
                type="button"
                className="w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-[var(--color-surface-hover)]"
                onClick={() => setMenu((current) => current ? { ...current, pickingTarget: true } : null)}
              >
                {copy.interact}
              </button>
              <div className="mt-2 border-t border-[var(--color-border)] pt-2">
                <p className="px-2 pb-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">{copy.emotesHeading}</p>
                <div className="grid grid-cols-2 gap-1">
                  {EMOTE_ACTIONS.map((action) => (
                    <button
                      key={action.animation}
                      type="button"
                      className="rounded-lg px-2 py-1.5 text-left text-xs hover:bg-[var(--color-surface-hover)]"
                      onClick={() => {
                        sceneRef.current?.playAgentAnimation(
                          menu.agent.id,
                          action.animation,
                          copy.emotes[action.key],
                        )
                        setMenu(null)
                      }}
                    >
                      {copy.emotes[action.key]}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div>
              <button
                type="button"
                className="mb-1 w-full rounded-lg px-2 py-2 text-left text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                onClick={() => setMenu((current) => current ? { ...current, pickingTarget: false } : null)}
              >
                {copy.backToActions}
              </button>
              {menu.agents
                .map((agent, index) => ({ agent, rosterNo: index + 1 }))
                .filter(({ agent }) => agent.id !== menu.agent.id)
                .map(({ agent, rosterNo }) => (
                  <button
                    key={agent.id}
                    type="button"
                    className="w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-[var(--color-surface-hover)]"
                    onClick={() => startInteraction(rosterNo, agent.name)}
                  >
                    {interpolateName(copy.interactWith, agent.name)}
                  </button>
                ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
