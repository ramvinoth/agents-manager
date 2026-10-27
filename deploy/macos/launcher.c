/*
 * Harman.app's executable: runs the viewer as its child so macOS privacy
 * settings (Screen Recording, Accessibility) list and grant "Harman" rather
 * than the Python interpreter. TCC charges a process's access to its
 * responsible app, and a child spawned here stays this app's responsibility.
 *
 *   Harman <command> [args…]   spawn the command, forward stop signals, exit as it exits
 *   Harman --request-access    ask macOS for both permissions once, which adds
 *                              Harman to both lists; run it via `open -a`
 */
#include <ApplicationServices/ApplicationServices.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>

extern char **environ;

static volatile pid_t child = 0;

static void forward(int sig) {
    if (child > 0) kill(child, sig);
}

static int request_access(void) {
    CGRequestScreenCaptureAccess();
    const void *keys[] = {kAXTrustedCheckOptionPrompt};
    const void *values[] = {kCFBooleanTrue};
    CFDictionaryRef options = CFDictionaryCreate(NULL, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    AXIsProcessTrustedWithOptions(options);
    CFRelease(options);
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--request-access") == 0) return request_access();
    if (argc < 2) {
        fprintf(stderr, "usage: %s <command> [args...] | --request-access\n", argv[0]);
        return 64;
    }
    struct sigaction sa = {0};
    sa.sa_handler = forward;
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);

    pid_t pid;
    int err = posix_spawnp(&pid, argv[1], NULL, NULL, &argv[1], environ);
    if (err) {
        fprintf(stderr, "Harman: cannot start %s: %s\n", argv[1], strerror(err));
        return 127;
    }
    child = pid;
    int status;
    while (waitpid(pid, &status, 0) < 0) {}
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    return 128 + WTERMSIG(status);
}
