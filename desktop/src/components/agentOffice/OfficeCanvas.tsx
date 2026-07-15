import { useEffect, useRef, useState } from 'react'
import type { Agent } from './types/agent'
import { OfficeScene, type OfficeAgentClick } from './scene/OfficeScene'

type AgentMenuState = {
  agent: Agent
  rosterNo: number
  x: number
  y: number
  agents: Agent[]
  pickingTarget: boolean
}

const EMOTE_ACTIONS = [
  { label: '坚定', animation: 'emotes/determined' },
  { label: '思考', animation: 'emotes/thinking' },
  { label: '灵感', animation: 'emotes/idea' },
  { label: '兴奋', animation: 'emotes/excited' },
  { label: '欢呼', animation: 'emotes/hooray' },
  { label: '挥手', animation: 'emotes/wave' },
  { label: '大笑', animation: 'emotes/laugh' },
  { label: '困惑', animation: 'emotes/confused' },
] as const

export function OfficeCanvas({ agents }: { agents: Agent[] }) {
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

    const scene = new OfficeScene({ onAgentClick: handleAgentClick })
    sceneRef.current = scene
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
    return () => {
      disposed = true
      observer.disconnect()
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
      `${targetName}，同步一下当前进度。`,
    )
    setMenu(null)
  }

  return (
    <div
      ref={hostRef}
      data-testid="agent-office-canvas"
      className="relative h-full min-h-[420px] w-full overflow-hidden bg-white"
    >
      {initError ? (
        <div role="alert" className="absolute inset-0 z-30 flex items-center justify-center bg-white/90 p-6">
          <div className="max-w-sm rounded-xl border border-red-200 bg-white p-4 text-center shadow-lg">
            <p className="text-sm text-red-700">{initError}</p>
            <button
              type="button"
              className="mt-3 rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700"
              onClick={() => initializeRef.current()}
            >
              重试
            </button>
          </div>
        </div>
      ) : null}
      {menu ? (
        <div
          data-agent-action-menu
          className="absolute z-20 max-h-[min(420px,calc(100%-24px))] w-[260px] overflow-auto rounded-xl border border-black/10 bg-white/95 p-2 text-neutral-800 shadow-2xl backdrop-blur-xl"
          style={{ left: menu.x, top: menu.y }}
        >
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-black/10 px-2 pb-2 pt-1">
            <strong className="truncate text-sm">{menu.agent.name}</strong>
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500">
              {menu.agent.state}
            </span>
          </div>

          {!menu.pickingTarget ? (
            <>
              <button
                type="button"
                className="w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-neutral-100"
                onClick={() => setMenu((current) => current ? { ...current, pickingTarget: true } : null)}
              >
                互动…
              </button>
              <div className="mt-2 border-t border-black/10 pt-2">
                <p className="px-2 pb-1 text-[11px] font-medium text-neutral-400">表情动作</p>
                <div className="grid grid-cols-2 gap-1">
                  {EMOTE_ACTIONS.map((action) => (
                    <button
                      key={action.animation}
                      type="button"
                      className="rounded-lg px-2 py-1.5 text-left text-xs hover:bg-neutral-100"
                      onClick={() => {
                        sceneRef.current?.playAgentAnimation(
                          menu.agent.id,
                          action.animation,
                          action.label,
                        )
                        setMenu(null)
                      }}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div>
              <button
                type="button"
                className="mb-1 w-full rounded-lg px-2 py-2 text-left text-sm text-neutral-500 hover:bg-neutral-100"
                onClick={() => setMenu((current) => current ? { ...current, pickingTarget: false } : null)}
              >
                返回动作
              </button>
              {menu.agents
                .map((agent, index) => ({ agent, rosterNo: index + 1 }))
                .filter(({ agent }) => agent.id !== menu.agent.id)
                .map(({ agent, rosterNo }) => (
                  <button
                    key={agent.id}
                    type="button"
                    className="w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-neutral-100"
                    onClick={() => startInteraction(rosterNo, agent.name)}
                  >
                    和 {agent.name} 互动
                  </button>
                ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
