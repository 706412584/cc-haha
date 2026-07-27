import { useEffect, useState } from 'react'

import { Badge, StatusDot, type Tone } from '@/components/ui/Badge'
import { Button, type ButtonSize, type ButtonVariant } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dropdown } from '@/components/ui/Dropdown'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton, type IconButtonSize, type IconButtonTone } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/LoadingState'
import { MobileBottomSheet } from '@/components/ui/MobileBottomSheet'
import { Modal } from '@/components/ui/Modal'
import { Progress } from '@/components/ui/Progress'
import { SearchField } from '@/components/ui/SearchField'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { SelectField } from '@/components/ui/SelectField'
import { SkeletonCards, SkeletonRows } from '@/components/ui/Skeleton'
import { Spinner } from '@/components/ui/Spinner'
import { Switch } from '@/components/ui/Switch'
import { TextArea } from '@/components/ui/TextArea'
import { Tooltip } from '@/components/ui/Tooltip'
import { BrandSeal } from '@/components/composite/BrandSeal'
import { THEME_MODES } from '@/types/settings'

/**
 * A dev-only page rendering every `components/ui` primitive under each theme.
 *
 * Unit tests assert structure and ARIA; they cannot tell whether a token
 * resolves to a readable color, whether an overlay lands above the thing it is
 * supposed to cover, or whether an entrance animation actually plays. This page
 * is where those get checked by eye, and it takes no backend to open.
 *
 * Reachable at `/gallery.html` under `bun run dev` only — it is not referenced
 * from the app and never enters the production bundle.
 */

/** Sourced from the type rather than restated, so a new palette shows up here. */
const THEMES = THEME_MODES
const TONES: Tone[] = ['neutral', 'brand', 'success', 'warning', 'danger', 'info']
const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'tonal', 'tonal-outline', 'ghost', 'danger', 'danger-outline', 'link', 'inverse']
const SIZES: ButtonSize[] = ['xs', 'sm', 'base', 'md', 'lg']
const ICON_SIZES: IconButtonSize[] = ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl']
const ICON_TONES: IconButtonTone[] = ['default', 'secondary', 'muted', 'brand', 'danger']

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-[var(--color-border)] py-6">
      <div>
        <h2 className="text-base font-semibold text-[var(--color-text-primary)]">{title}</h2>
        {note && <p className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">{note}</p>}
      </div>
      {children}
    </section>
  )
}

export function ComponentGallery() {
  const [theme, setTheme] = useState<(typeof THEMES)[number]>('white')
  const [modalOpen, setModalOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [segment, setSegment] = useState('all')
  const [checked, setChecked] = useState(true)
  const [switched, setSwitched] = useState(true)
  const [model, setModel] = useState('sonnet')
  const [transport, setTransport] = useState('stdio')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light'
  }, [theme])

  return (
    <div className="min-h-screen bg-[var(--color-background)] px-8 py-6 text-[var(--color-text-primary)]">
      <header className="sticky top-0 z-[var(--z-sticky)] -mx-8 mb-2 border-b border-[var(--color-border)] bg-[var(--color-background)] px-8 py-4">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-lg font-bold">components/ui gallery</h1>
          <SegmentedControl
            items={THEMES.map((value) => ({ value, label: value }))}
            value={theme}
            onChange={setTheme}
            label="Theme"
            data-testid="theme-switch"
          />
        </div>
      </header>

      <Section title="Button" note="Every variant x size. Tab through to check the focus ring.">
        <div className="flex flex-col gap-2">
          {VARIANTS.map((variant) => (
            <div key={variant} className="flex flex-wrap items-center gap-2">
              <code className="w-32 shrink-0 text-xs text-[var(--color-text-tertiary)]">{variant}</code>
              {SIZES.map((size) => (
                <Button key={size} variant={variant} size={size}>{size}</Button>
              ))}
              <Button variant={variant} loading>loading</Button>
              <Button variant={variant} disabled>disabled</Button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="IconButton" note="Icon-only controls; each has a required accessible name.">
        <div className="flex flex-col gap-2">
          {ICON_TONES.map((tone) => (
            <div key={tone} className="flex flex-wrap items-center gap-2">
              <code className="w-32 shrink-0 text-xs text-[var(--color-text-tertiary)]">{tone}</code>
              {ICON_SIZES.map((size) => (
                <IconButton key={size} icon="settings" label={`Settings ${size}`} tone={tone} size={size} />
              ))}
              <IconButton icon="close" label="Filled" tone={tone} filled />
              <IconButton icon="tune" label="Bordered" tone={tone} bordered />
              <IconButton icon="refresh" label="Circle" tone={tone} shape="circle" />
              <IconButton icon="sync" label="Loading" tone={tone} loading />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-2">
            <code className="w-32 shrink-0 text-xs text-[var(--color-text-tertiary)]">states</code>
            <IconButton icon="delete" label="Danger on hover only" tone="muted" hoverTone="danger" />
            <IconButton icon="filter_alt" label="Pressed off" pressed={false} />
            <IconButton icon="filter_alt" label="Pressed on" pressed />
            <IconButton icon="close" label="Solid danger" tone="danger" solid size="2xs" shape="circle" />
            <IconButton icon="check" label="Solid brand" tone="brand" solid />
            <IconButton icon="more_horiz" label="Solid default" solid />
          </div>
          {/* `solid` has to stay legible over arbitrary content — this strip
              stands in for a user-supplied image behind a remove badge. */}
          <div
            className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] p-2"
            style={{ backgroundImage: 'linear-gradient(45deg, #8b5cf6, #ec4899, #f59e0b)' }}
          >
            <code className="w-32 shrink-0 text-xs text-white">solid over image</code>
            <IconButton icon="close" label="Remove" tone="danger" solid size="2xs" shape="circle" />
            <IconButton icon="close" label="Remove tinted" tone="danger" filled size="2xs" shape="circle" />
          </div>
          <div
            className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface-sidebar)] p-2"
          >
            <code className="w-32 shrink-0 text-xs text-[var(--color-text-tertiary)]">on sidebar</code>
            {/* The sidebar hover token differs from surface-hover in all three
                themes; hover these against the sidebar fill to check it. */}
            {ICON_TONES.map((tone) => (
              <IconButton key={tone} icon="folder" label={`Sidebar ${tone}`} tone={tone} surface="sidebar" />
            ))}
          </div>
        </div>
      </Section>

      <Section title="Badge / StatusDot" note="Contrast check: the label must stay readable on its own fill in all three themes.">
        <div className="flex flex-wrap items-center gap-2">
          {TONES.map((tone) => <Badge key={tone} tone={tone}>{tone}</Badge>)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {TONES.map((tone) => <Badge key={tone} tone={tone} variant="outline">{tone}</Badge>)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {TONES.map((tone) => <Badge key={tone} tone={tone} size="md" bordered>{tone}</Badge>)}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {TONES.map((tone) => (
            <span key={tone} className="flex items-center gap-1.5 text-xs">
              <StatusDot tone={tone} pulse />
              {tone}
            </span>
          ))}
        </div>
      </Section>

      <Section title="Form controls">
        <div className="grid max-w-3xl grid-cols-2 gap-4">
          <Input label="Server name" placeholder="my-server" />
          <Input label="Port" error="Must be a number" defaultValue="abc" />
          <Input label="Disabled" disabled defaultValue="locked" />
          <Input label="With hint" hint="Between 1024 and 65535" />
          <SelectField
            label="Transport"
            options={[{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'HTTP' }]}
            value={transport}
            onChange={setTransport}
          />
          <SearchField label="Search sessions" clearLabel="Clear search" value={search} onChange={setSearch} />
          <TextArea label="System prompt" hint="Markdown is supported" />
          <TextArea label="Broken" error="Cannot be empty" />
        </div>
        <div className="flex flex-wrap items-center gap-8">
          <Checkbox label="Include archived" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <Checkbox label="Indeterminate" indeterminate />
          <Checkbox label="Disabled" disabled />
          <div className="w-64"><Switch label="Auto update" description="Checks on launch." checked={switched} onChange={setSwitched} /></div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <SegmentedControl
            items={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'done', label: 'Done' }]}
            value={segment}
            onChange={setSegment}
            label="Filter (solid)"
          />
          <SegmentedControl
            items={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }]}
            value={segment}
            onChange={setSegment}
            label="Filter (raised)"
            appearance="raised"
          />
          <SegmentedControl
            items={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }]}
            value={segment}
            onChange={setSegment}
            label="Filter (underline)"
            appearance="underline"
          />
        </div>
      </Section>

      <Section title="States">
        <div className="grid grid-cols-3 gap-4">
          <EmptyState title="No sessions yet" description="Start one from the sidebar." action={{ label: 'New session', onClick: () => {} }} />
          <ErrorState title="Could not load plugins" detail="HTTP 502 from the gateway." onRetry={() => {}} retryLabel="Try again" />
          <ErrorState title="Fatal" detail="Strong tone." tone="strong" />
          <LoadingState label="Loading sessions" variant="dashed" size="lg" />
          <div className="flex flex-col gap-3">
            <LoadingState label="Loading" variant="inline" />
            <Spinner size={24} tone="brand" />
            <Progress label="Uploading" value={35} />
            <Progress label="Complete" value={100} tone="auto" />
            <Progress label="Working" indeterminate />
          </div>
          <SkeletonRows label="Loading rows" count={2} divided />
        </div>
        <SkeletonCards label="Loading cards" count={3} withAvatar className="grid-cols-3" />
      </Section>

      <Section title="Card">
        <div className="flex flex-wrap gap-3">
          <Card>base</Card>
          <Card surface="low">low</Card>
          <Card surface="lowest">lowest</Card>
          <Card surface="high">high</Card>
          <Card border="dashed">dashed</Card>
          <Card interactive>interactive (hover / focus)</Card>
          <Card shadow="card">shadow=card</Card>
          <Card shadow="composer">shadow=composer</Card>
          <Card interactive lift>lift (hover raises 2px)</Card>
        </div>
      </Section>

      <Section title="BrandSeal" note="The cc-haha mark, a vector rebuild of the app icon. It sheds parts as it shrinks — sparkles only at xl, cursor drops at sm — so check each size against its neighbours.">
        <div className="flex flex-wrap items-end gap-4">
          <BrandSeal size="sm" />
          <BrandSeal size="md" />
          <BrandSeal size="lg" />
          <BrandSeal size="xl" />
        </div>
      </Section>

      <Section
        title="Overlays"
        note="Layering check: open the sheet, then raise a toast — the toast must stay visible. Open the modal, then the dropdown inside it."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => setModalOpen(true)}>Open Modal</Button>
          <Button variant="secondary" onClick={() => setSheetOpen(true)}>Open BottomSheet</Button>
          <Tooltip content="This is a tooltip. It should flip near the viewport edge.">
            <Button variant="ghost">Hover / focus me</Button>
          </Tooltip>
          <Dropdown
            items={[
              { value: 'sonnet', label: 'Sonnet', description: 'Balanced' },
              { value: 'opus', label: 'Opus', description: 'Most capable' },
              { value: 'haiku', label: 'Haiku', description: 'Fastest', disabled: true },
            ]}
            value={model}
            onChange={setModel}
            label="Model"
            trigger={<Button variant="secondary">Model: {model}</Button>}
          />
        </div>

        <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Dialog with a dropdown inside">
          <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
            The dropdown below must render above this dialog. Escape should close only the dropdown first.
          </p>
          <Dropdown
            items={[{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'HTTP' }]}
            value={transport}
            onChange={setTransport}
            label="Transport"
            trigger={<Button variant="secondary">Transport: {transport}</Button>}
          />
        </Modal>

        <MobileBottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Bottom sheet">
          <p className="text-sm text-[var(--color-text-secondary)]">
            A toast raised while this is open must appear above it.
          </p>
        </MobileBottomSheet>
      </Section>

      <Section title="Overlay entrance animations" note="These classes replaced tailwindcss-animate; a static render means they are dead again.">
        <div className="flex flex-wrap gap-3">
          {['animate-overlay-in', 'animate-overlay-in-top', 'animate-overlay-in-bottom', 'animate-overlay-in-right'].map((cls) => (
            <div
              key={cls}
              className={`${cls} rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container)] px-3 py-2 text-xs`}
            >
              {cls}
            </div>
          ))}
        </div>
      </Section>
    </div>
  )
}
