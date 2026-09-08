import Foundation

/// Native fail-closed app policy used after target resolution has produced a
/// real bundle identifier. The list mirrors the complete union of the four
/// exact bundle-ID sets exported from `deniedApps.ts`; display-name substring
/// policy deliberately remains outside this native resolver seam.
enum AppTargetPolicy {
    enum Decision: Equatable, Sendable {
        case allow
        case deny
    }

    /// Process identities that Computer Use must never inspect or control.
    /// Keep these independent from the mirrored generic policy set below: the
    /// host and helper remain denied even if the cross-language policy changes.
    static let intrinsicDeniedBundleIDs: Set<String> = [
        "com.claude-code-haha.desktop",
        "dev.cchaha.cu-helper",
    ]

    /// Keep this as one string-literal set so the TypeScript parity test can
    /// parse and compare it directly with the authoritative four-set union.
    static let deniedBundleIDs: Set<String> = [
        // BROWSER_BUNDLE_IDS
        "com.apple.Safari",
        "com.apple.SafariTechnologyPreview",
        "com.google.Chrome",
        "com.google.Chrome.beta",
        "com.google.Chrome.dev",
        "com.google.Chrome.canary",
        "com.microsoft.edgemac",
        "com.microsoft.edgemac.Beta",
        "com.microsoft.edgemac.Dev",
        "com.microsoft.edgemac.Canary",
        "org.mozilla.firefox",
        "org.mozilla.firefoxdeveloperedition",
        "org.mozilla.nightly",
        "org.chromium.Chromium",
        "com.brave.Browser",
        "com.brave.Browser.beta",
        "com.brave.Browser.nightly",
        "com.operasoftware.Opera",
        "com.operasoftware.OperaGX",
        "com.operasoftware.OperaDeveloper",
        "com.vivaldi.Vivaldi",
        "company.thebrowser.Browser",
        "company.thebrowser.dia",
        "org.torproject.torbrowser",
        "com.duckduckgo.macos.browser",
        "ru.yandex.desktop.yandex-browser",
        "ai.perplexity.comet",
        "com.sigmaos.sigmaos.macos",
        "com.kagi.kagimacOS",

        // TERMINAL_BUNDLE_IDS
        "com.apple.Terminal",
        "com.googlecode.iterm2",
        "dev.warp.Warp-Stable",
        "dev.warp.Warp-Beta",
        "com.github.wez.wezterm",
        "org.alacritty",
        "io.alacritty",
        "net.kovidgoyal.kitty",
        "co.zeit.hyper",
        "com.mitchellh.ghostty",
        "org.tabby",
        "com.termius-dmg.mac",
        "com.microsoft.VSCode",
        "com.microsoft.VSCodeInsiders",
        "com.vscodium",
        "com.todesktop.230313mzl4w4u92",
        "com.exafunction.windsurf",
        "dev.zed.Zed",
        "dev.zed.Zed-Preview",
        "com.jetbrains.intellij",
        "com.jetbrains.intellij.ce",
        "com.jetbrains.pycharm",
        "com.jetbrains.pycharm.ce",
        "com.jetbrains.WebStorm",
        "com.jetbrains.CLion",
        "com.jetbrains.goland",
        "com.jetbrains.rubymine",
        "com.jetbrains.PhpStorm",
        "com.jetbrains.datagrip",
        "com.jetbrains.rider",
        "com.jetbrains.AppCode",
        "com.jetbrains.rustrover",
        "com.jetbrains.fleet",
        "com.google.android.studio",
        "com.axosoft.gitkraken",
        "com.sublimetext.4",
        "com.sublimetext.3",
        "org.vim.MacVim",
        "com.neovim.neovim",
        "org.gnu.Emacs",
        "com.apple.dt.Xcode",
        "org.eclipse.platform.ide",
        "org.netbeans.ide",
        "com.microsoft.visual-studio",
        "com.apple.ScriptEditor2",
        "com.apple.Automator",
        "com.apple.shortcuts",

        // TRADING_BUNDLE_IDS
        "com.webull.desktop.v1",
        "com.webull.trade.mac.v1",
        "com.tastytrade.desktop",
        "com.tradingview.tradingviewapp.desktop",
        "com.fidelity.activetrader",
        "com.fmr.activetrader",
        "com.install4j.5889-6375-8446-2021",
        "com.binance.BinanceDesktop",
        "com.electron.exodus",
        "org.pythonmac.unspecified.Electrum",
        "com.ledger.live",
        "io.trezor.TrezorSuite",

        // POLICY_DENIED_BUNDLE_IDS
        "com.apple.TV",
        "com.apple.Music",
        "com.apple.iBooksX",
        "com.apple.podcasts",
        "com.spotify.client",
        "com.amazon.music",
        "com.tidal.desktop",
        "com.deezer.deezer-desktop",
        "com.pandora.desktop",
        "com.electron.pocket-casts",
        "au.com.shiftyjelly.PocketCasts",
        "tv.plex.desktop",
        "tv.plex.htpc",
        "tv.plex.plexamp",
        "com.amazon.aiv.AIVApp",
        "net.kovidgoyal.calibre",
        "com.amazon.Kindle",
        "com.amazon.Lassen",
        "com.kobo.desktop.Kobo",
    ]

    static func decision(bundleID: String) -> Decision {
        if intrinsicDeniedBundleIDs.contains(bundleID)
            || deniedBundleIDs.contains(bundleID) {
            return .deny
        }
        return .allow
    }
}
