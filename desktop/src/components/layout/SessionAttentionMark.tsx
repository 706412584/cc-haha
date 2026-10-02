/**
 * "This session is waiting for you". The tab strip and both sidebar views draw
 * it through this one component, so `sessionNeedsAttention` keeping them in step
 * in state is matched by them staying in step in pixels.
 *
 * A glyph, not a coloured dot. A session parked on a permission card is still
 * running as far as `chatState` goes, and the running marker is a dot; warning
 * and brand are within 1.4–1.7:1 of each other in most themes, so a dot against
 * a dot leaves colour alone to tell "working" from "needs you", which is no
 * answer for anyone who cannot rely on it. The filled triangle has a different
 * outline from every dot in the app.
 *
 * It pulses three times on arrival and then holds still. This state can sit
 * for hours, and `pulse-dot` dips to 0.3 opacity — a thin glyph would spend half
 * of every cycle unreadable, and an animation that never ends is not something
 * to leave running beside someone's work (WCAG 2.2.2). Reduced-motion users
 * already get the slower 3s cycle from the global rule.
 *
 * `role="img"`, not `status`: a live region announces changes to its content,
 * and an empty span's aria-label is not one, so `status` promised an
 * announcement nothing delivers. The inner ligature text is hidden for the same
 * reason — left in, a screen reader would say "warning" next to the label.
 *
 * The colour is `--color-on-warning-container`, the darker of the two warning
 * tokens, not `--color-warning`. This is a bare graphic with no text beside it
 * to fall back on, so it has to clear 3:1 on every ground it can sit on, and
 * `--color-warning` does not: it is 2.92:1 on warm-classic's hovered sidebar
 * row. The two are the same colour in the ink themes, where nothing changes.
 * `contrast.test.ts` measures all four grounds in all six themes.
 */
export function SessionAttentionMark({ label }: { label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex text-[var(--color-on-warning-container)]"
    >
      <span
        aria-hidden="true"
        className="material-symbols-outlined animate-pulse-dot text-[14px] leading-none"
        style={{ fontVariationSettings: "'FILL' 1", animationIterationCount: 3 }}
      >
        warning
      </span>
    </span>
  )
}
