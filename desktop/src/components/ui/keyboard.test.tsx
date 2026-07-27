import type { ReactElement } from 'react'
import { render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { Badge, StatusDot } from './Badge'
import { Button } from './Button'
import { Card } from './Card'
import { Checkbox } from './Checkbox'
import { EmptyState } from './EmptyState'
import { ErrorState } from './ErrorState'
import { IconButton } from './IconButton'
import { Input } from './Input'
import { LoadingState } from './LoadingState'
import { Progress } from './Progress'
import { SearchField } from './SearchField'
import { SegmentedControl } from './SegmentedControl'
import { SelectField } from './SelectField'
import { Skeleton } from './Skeleton'
import { Spinner } from './Spinner'
import { Switch } from './Switch'
import { TextArea } from './TextArea'

/**
 * Keyboard reachability across the library.
 *
 * Independent QA left `A11Y-01` (a full keyboard tab-order audit) unrun, and
 * these components now back roughly 500 controls — a decoration that picks up a
 * tab stop, or a control that loses one, would spread everywhere before anyone
 * noticed. Per-component suites assert their own semantics; this asserts the
 * one property they must all share.
 */

const NATIVELY_FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]'

/** Elements a keyboard user can reach with Tab, in DOM order. */
function tabStops(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(NATIVELY_FOCUSABLE)].filter((el) => {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false
    const tabIndex = el.getAttribute('tabindex')
    if (tabIndex !== null && Number(tabIndex) < 0) return false
    // `sr-only` inputs (the Switch's hidden checkbox) are still reachable —
    // they are visually hidden, not removed from the sequence.
    return true
  })
}

describe('keyboard reachability', () => {
  const interactive: Array<[string, ReactElement, number]> = [
    ['Button', <Button>Save</Button>, 1],
    ['IconButton', <IconButton icon={<span />} label="Close" />, 1],
    ['Checkbox', <Checkbox label="Include archived" />, 1],
    ['Switch', <Switch label="Auto update" checked onChange={() => {}} />, 1],
    ['Input', <Input label="Port" />, 1],
    ['TextArea', <TextArea label="Prompt" />, 1],
    [
      'SelectField',
      <SelectField label="Transport" options={[{ value: 'a', label: 'A' }]} value="a" onChange={() => {}} />,
      1,
    ],
    // The field plus its clear button, which must be reachable rather than
    // mouse-only.
    ['SearchField', <SearchField label="Search" clearLabel="Clear" value="abc" onChange={() => {}} />, 2],
    [
      'EmptyState with an action',
      <EmptyState title="Nothing here" action={{ label: 'Create', onClick: () => {} }} />,
      1,
    ],
    ['ErrorState with a retry', <ErrorState title="Failed" onRetry={() => {}} retryLabel="Retry" />, 1],
  ]

  it.each(interactive)('%s exposes exactly %i tab stop(s)', (_name, element, expected) => {
    const { container } = render(element)
    expect(tabStops(container)).toHaveLength(expected)
  })

  const decorative: Array<[string, ReactElement]> = [
    ['Badge', <Badge>Ready</Badge>],
    ['StatusDot', <StatusDot tone="success" />],
    ['Spinner', <Spinner />],
    ['Skeleton', <Skeleton />],
    ['Progress', <Progress label="Uploading" value={40} />],
    ['LoadingState', <LoadingState label="Loading" />],
    ['EmptyState without an action', <EmptyState title="Nothing here" />],
    ['ErrorState without a retry', <ErrorState title="Failed" />],
    ['Card', <Card>Body</Card>],
  ]

  it.each(decorative)('%s takes no tab stop', (_name, element) => {
    const { container } = render(element)
    expect(tabStops(container)).toHaveLength(0)
  })

  it('drops disabled controls out of the tab sequence', () => {
    // `disabled` also has to reach the DOM node; styling it alone leaves the
    // control reachable and operable by keyboard.
    const cases: ReactElement[] = [
      <Button disabled>Save</Button>,
      <IconButton icon={<span />} label="Close" disabled />,
      <Checkbox label="Include archived" disabled />,
      <Switch label="Auto update" checked onChange={() => {}} disabled />,
      <Input label="Port" disabled />,
      <TextArea label="Prompt" disabled />,
    ]

    for (const element of cases) {
      const { container, unmount } = render(element)
      expect(tabStops(container)).toHaveLength(0)
      unmount()
    }
  })

  it('leaves a loading button out of the tab sequence too', () => {
    const { container } = render(<Button loading>Saving</Button>)
    expect(tabStops(container)).toHaveLength(0)
  })

  it('keeps a segmented control to one tab stop regardless of size', () => {
    // Roving tabindex: the group is one stop and arrows move within it. A naive
    // implementation puts every segment in the sequence, so a 6-item filter
    // costs six tabs to pass.
    for (const count of [2, 4, 6]) {
      const items = Array.from({ length: count }, (_, i) => ({ value: `v${i}`, label: `Item ${i}` }))
      const { container, unmount } = render(
        <SegmentedControl items={items} value="v0" onChange={() => {}} label="Filter" />,
      )
      expect(tabStops(container)).toHaveLength(1)
      unmount()
    }
  })

  it('gives every reachable control a visible focus treatment', () => {
    // A control that is reachable but shows nothing on focus is worse than one
    // that is unreachable: the user cannot tell where they are.
    //
    // Two valid shapes. Most controls style themselves. `Switch` hides its
    // native checkbox with `peer sr-only` and paints the focus ring on the
    // track beside it, so the indicator lives on a sibling under
    // `peer-focus-visible:` — checking only the focused node would call that a
    // failure when the ring is in fact drawn.
    const hasOwnFocusStyle = (el: HTMLElement) => /focus-visible:|focus:/.test(el.className)
    const hasPeerFocusStyle = (el: HTMLElement) =>
      el.classList.contains('peer')
      && [...(el.parentElement?.children ?? [])].some(
        (sibling) => sibling !== el && /peer-focus-visible:|peer-focus:/.test(sibling.className),
      )

    for (const [name, element] of interactive) {
      const { container, unmount } = render(element)
      for (const stop of tabStops(container)) {
        expect(
          hasOwnFocusStyle(stop) || hasPeerFocusStyle(stop),
          `${name}: ${stop.tagName.toLowerCase()} is focusable with no focus indicator, on itself or a peer`,
        ).toBe(true)
      }
      unmount()
    }
  })
})
