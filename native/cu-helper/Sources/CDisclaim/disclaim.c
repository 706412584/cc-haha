#include "cdisclaim.h"

#include <dlfcn.h>
#include <mach-o/dyld.h>   // _NSGetExecutablePath
#include <signal.h>
#include <spawn.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

// int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);
typedef int (*disclaim_fn)(posix_spawnattr_t *, int);

// The disclaimed child's pid, so our signal handlers can forward to it.
static volatile pid_t g_child_pid = 0;

static void cuhelper_forward_signal(int sig) {
    pid_t c = g_child_pid;
    if (c > 0) {
        kill(c, sig);
    }
}

void cuhelper_disclaim_reexec(int argc, char **argv) {
    (void)argc;

    // Already the disclaimed copy → just proceed (this is the real worker).
    if (getenv("CU_HELPER_DISCLAIMED") != NULL) {
        return;
    }

    // Resolve the private API at runtime. Missing (older macOS / removed) →
    // fall back to running un-disclaimed (functional, just unfixed).
    disclaim_fn set_disclaim =
        (disclaim_fn)dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
    if (set_disclaim == NULL) {
        return;
    }

    // Our own absolute executable path (argv[0] may be relative).
    char exec_path[4096];
    uint32_t path_size = (uint32_t)sizeof(exec_path);
    if (_NSGetExecutablePath(exec_path, &path_size) != 0) {
        return;  // buffer too small (implausible) → fall back
    }

    posix_spawnattr_t attr;
    if (posix_spawnattr_init(&attr) != 0) {
        return;
    }
    if (set_disclaim(&attr, 1) != 0) {
        posix_spawnattr_destroy(&attr);
        return;  // API present but refused → fall back
    }

    // Mark the child so it does NOT re-exec again, then spawn ourselves. The
    // child inherits fd 0/1/2 untouched (no file actions), so its readiness /
    // JSON output on stdout is byte-for-byte preserved.
    setenv("CU_HELPER_DISCLAIMED", "1", 1);

    pid_t child = 0;
    int rc = posix_spawn(&child, exec_path, NULL, &attr, argv, environ);
    posix_spawnattr_destroy(&attr);

    if (rc != 0 || child <= 0) {
        // Spawn failed → undo the marker and run un-disclaimed in THIS process.
        unsetenv("CU_HELPER_DISCLAIMED");
        return;
    }

    // We are the supervisor now. Forward the trappable signals used for
    // TCC-facing one-shot work. Commands that need a hard SIGKILL timeout must
    // skip this supervisor entirely; SIGKILL cannot be forwarded and does not
    // automatically reap a reparented worker. Never write to stdout here.
    g_child_pid = child;
    signal(SIGTERM, cuhelper_forward_signal);
    signal(SIGINT, cuhelper_forward_signal);
    signal(SIGHUP, cuhelper_forward_signal);

    int status = 0;
    while (waitpid(child, &status, 0) < 0) {
        // EINTR (a signal we forwarded interrupted the wait) → retry.
    }

    if (WIFEXITED(status)) {
        _exit(WEXITSTATUS(status));
    }
    if (WIFSIGNALED(status)) {
        _exit(128 + WTERMSIG(status));
    }
    _exit(0);
}
