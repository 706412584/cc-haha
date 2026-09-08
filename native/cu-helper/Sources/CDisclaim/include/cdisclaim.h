#ifndef CDISCLAIM_H
#define CDISCLAIM_H

// Re-exec THIS process once as its own TCC "responsible process".
//
// macOS attributes Accessibility / Screen Recording grants to a process's
// "responsible process" — which, for a binary launched via posix_spawn /
// fork+exec by a GUI app (here: the Electron sidecar), is the PARENT app, not
// this binary. So granting cu-helper its own row in the Privacy lists is
// ignored: the check resolves to the parent app (Claude Code Haha), which is a
// different (ad-hoc) identity and usually not granted.
//
// The fix: at the very top of main, call this. If we have NOT yet disclaimed
// (env CU_HELPER_DISCLAIMED unset) AND the private API
// `responsibility_spawnattrs_setdisclaim` resolves at runtime, we posix_spawn a
// fresh copy of ourselves with the disclaim attribute set — that copy becomes
// its OWN responsible process, so TCC reads cu-helper's own grant. The original
// process stays alive as a thin supervisor: it forwards SIGTERM/SIGINT/SIGHUP to
// the child (so the daemon is still killable by the TS bridge) and mirrors the
// child's exit code. It writes NOTHING to stdout (the daemon readiness line and
// the CLI single-line JSON are a hard contract on fd 1).
//
// Fail-closed / no-crash: if already disclaimed, or the symbol is missing (old
// macOS), or the spawn fails, this returns immediately and the caller proceeds
// exactly as before (unfixed but functional).
void cuhelper_disclaim_reexec(int argc, char **argv);

#endif /* CDISCLAIM_H */
