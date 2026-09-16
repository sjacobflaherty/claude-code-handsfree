// disclaim <cmd> [args...]: exec cmd as its own responsible process.
//
// macOS charges a microphone or speech-recognition request to the app that owns the
// process tree, and kills the requesting process with SIGABRT when that app's Info.plist
// lacks the usage string, instead of prompting. Cursor and VS Code declare no
// NSSpeechRecognitionUsageDescription, so hear started from their terminals dies at once.
// Terminal.app is Apple's and exempt, which is why it works there. With responsibility
// disclaimed, hear is judged by its own embedded Info.plist, which declares both strings,
// and macOS prompts once naming hear. The call is the one Chromium uses for its helpers.
#include <dlfcn.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
typedef int (*setdisclaim_t)(posix_spawnattr_t *, int);

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: disclaim <cmd> [args...]\n");
    return 2;
  }
  // Private to libSystem, so resolved at run time and reported when a macOS release drops it.
  setdisclaim_t setdisclaim = (setdisclaim_t)dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
  if (!setdisclaim) {
    fprintf(stderr, "disclaim: responsibility_spawnattrs_setdisclaim is not in libSystem on this macOS\n");
    return 3;
  }
  posix_spawnattr_t attrs;
  posix_spawnattr_init(&attrs);
  posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETEXEC);
  if (setdisclaim(&attrs, 1) != 0) {
    fprintf(stderr, "disclaim: responsibility_spawnattrs_setdisclaim failed\n");
    return 3;
  }
  pid_t pid;
  // SETEXEC replaces this process, so a return means the spawn failed.
  int rc = posix_spawnp(&pid, argv[1], NULL, &attrs, argv + 1, environ);
  fprintf(stderr, "disclaim: %s: %s\n", argv[1], strerror(rc));
  return 127;
}
