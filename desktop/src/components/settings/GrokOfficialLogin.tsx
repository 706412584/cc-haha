import { useEffect, useState } from 'react'
import { Copy, LogIn, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useHahaGrokOAuthStore } from '../../stores/hahaGrokOAuthStore'
import { useTranslation } from '../../i18n'
import { copyTextToClipboard } from '@/lib/clipboard'
import { getDesktopHost } from '../../lib/desktopHost'
import { hahaGrokOAuthApi } from '../../api/hahaGrokOAuth'

export function GrokOfficialLogin() {
  const t = useTranslation()
  const [manualAuthorizeUrl, setManualAuthorizeUrl] = useState<string | null>(null)
  const [isAwaitingAuthorization, setIsAwaitingAuthorization] = useState(false)
  const { status, isLoading, error, fetchStatus, login, logout, startPolling, stopPolling } =
    useHahaGrokOAuthStore()

  useEffect(() => {
    void fetchStatus()
    return () => stopPolling()
  }, [fetchStatus, stopPolling])

  useEffect(() => {
    if (status?.loggedIn) setManualAuthorizeUrl(null)
  }, [status?.loggedIn])

  useEffect(() => {
    if (!status?.loggedIn || !isAwaitingAuthorization) return
    setIsAwaitingAuthorization(false)
    void getDesktopHost().shell.open(hahaGrokOAuthApi.successUrl()).catch((err) => {
      console.error('[GrokOfficialLogin] success page open failed:', err)
    })
  }, [isAwaitingAuthorization, status?.loggedIn])

  const handleLogin = async () => {
    setManualAuthorizeUrl(null)
    try {
      const { authorizeUrl } = await login()
      setManualAuthorizeUrl(authorizeUrl)
      try {
        await getDesktopHost().shell.open(authorizeUrl)
        setManualAuthorizeUrl(null)
        setIsAwaitingAuthorization(true)
        startPolling()
      } catch (err) {
        console.error('[GrokOfficialLogin] shellOpen failed:', err)
        useHahaGrokOAuthStore.setState({
          error: t('settings.grokOfficialLogin.openBrowserFailed'),
        })
      }
    } catch {
      // Store owns request errors.
    }
  }

  const handleCopyAuthorizeUrl = async () => {
    if (!manualAuthorizeUrl) return
    if (await copyTextToClipboard(manualAuthorizeUrl)) {
      setManualAuthorizeUrl(null)
      setIsAwaitingAuthorization(true)
      useHahaGrokOAuthStore.setState({ error: null })
      startPolling()
    } else {
      useHahaGrokOAuthStore.setState({
        error: t('settings.grokOfficialLogin.copyLinkFailed'),
      })
    }
  }

  const manualAuthorizeButton = manualAuthorizeUrl ? (
    <Button
      variant="secondary"
      size="sm"
      onClick={handleCopyAuthorizeUrl}
      icon={<Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      className="self-start"
    >
      {t('settings.grokOfficialLogin.copyAuthorizeUrl')}
    </Button>
  ) : null

  if (status === null) {
    return (
      <div data-testid="grok-official-login" className="flex flex-col gap-2 text-xs">
        {error ? (
          <div className="text-[var(--color-error)]">{t('settings.grokOfficialLogin.errorPrefix')}{error}</div>
        ) : (
          <div className="text-[var(--color-text-tertiary)]">{t('common.loading')}</div>
        )}
        {manualAuthorizeButton}
      </div>
    )
  }

  if (status.loggedIn) {
    return (
      <div data-testid="grok-official-login" className="flex items-center gap-3 text-sm">
        <span className="text-[var(--color-success)]">
          {t('settings.grokOfficialLogin.loggedInPrefix')} {status.email || t('settings.grokOfficialLogin.accountUnknown')}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={logout}
          disabled={isLoading}
          icon={<LogOut className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          {isLoading ? t('settings.grokOfficialLogin.logoutProcessing') : t('settings.grokOfficialLogin.logoutButton')}
        </Button>
      </div>
    )
  }

  return (
    <div data-testid="grok-official-login" className="flex flex-col gap-2">
      <div className="text-sm text-[var(--color-text-secondary)]">{t('settings.grokOfficialLogin.intro')}</div>
      <Button
        onClick={handleLogin}
        disabled={isLoading}
        icon={<LogIn className="h-4 w-4" aria-hidden="true" />}
        className="self-start"
      >
        {isLoading ? t('settings.grokOfficialLogin.loginStarting') : t('settings.grokOfficialLogin.loginButton')}
      </Button>
      {error && <div className="text-xs text-[var(--color-error)]">{t('settings.grokOfficialLogin.errorPrefix')}{error}</div>}
      {manualAuthorizeButton}
    </div>
  )
}
