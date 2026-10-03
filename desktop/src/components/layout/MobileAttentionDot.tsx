import { StatusDot } from '@/components/ui/Badge'
import { useTranslation } from '../../i18n'
import { sessionNeedsAttention } from '../../lib/sessionAttention'
import { useChatStore } from '../../stores/chatStore'

/**
 * A dot in the corner of the phone header's hamburger when a session other than
 * the one on screen is waiting for the person.
 *
 * The phone has no tab strip: the sidebar drawer behind that button is the only
 * way to change session, so it is the only place the marks on the session rows
 * can be found from. On H5 neither a notification click nor `requestAttention`
 * exists, so without this the drawer would have to be opened on a guess.
 *
 * Its own session is left out — the card is already in front of the person —
 * and every session counts, not only ones with a tab, because the drawer lists
 * them all. It renders inside a `relative` wrapper around the button.
 */
export function MobileAttentionDot({ activeSessionId }: { activeSessionId: string | null }) {
  const t = useTranslation()
  const waitingElsewhere = useChatStore((state) =>
    Object.entries(state.sessions).some(
      ([sessionId, session]) => sessionId !== activeSessionId && sessionNeedsAttention(session),
    ))

  if (!waitingElsewhere) return null

  return (
    <>
      <StatusDot
        tone="warning"
        size="md"
        data-testid="mobile-attention-dot"
        className="pointer-events-none absolute right-2 top-2"
      />
      <span className="sr-only">{t('sidebar.sessionNeedsAttention')}</span>
    </>
  )
}
