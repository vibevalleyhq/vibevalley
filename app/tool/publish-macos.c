#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

// Keep each artifact continuously present. A failed second publication restores the first before returning.
static int publish(const char *source, const char *target, int *swapped) {
  struct stat st;
  *swapped = lstat(target, &st) == 0;
  if (!*swapped && errno != ENOENT) return -1;
  return *swapped ? renamex_np(source, target, RENAME_SWAP) : rename(source, target);
}

int main(int argc, char **argv) {
  if (argc != 5) return 2;
  sigset_t signals, previous;
  sigemptyset(&signals);
  sigaddset(&signals, SIGHUP);
  sigaddset(&signals, SIGINT);
  sigaddset(&signals, SIGTERM);
  sigprocmask(SIG_BLOCK, &signals, &previous);
  int first, second;
  if (publish(argv[1], argv[2], &first) != 0) {
    fprintf(stderr, "publish app: %s\n", strerror(errno));
    return 1;
  }
  if (publish(argv[3], argv[4], &second) != 0) {
    int error = errno;
    int restored = first ? renamex_np(argv[1], argv[2], RENAME_SWAP) : rename(argv[2], argv[1]);
    fprintf(stderr, "publish DMG: %s; app rollback %s\n", strerror(error), restored == 0 ? "succeeded" : "FAILED: preserve staging");
    return restored == 0 ? 1 : 3;
  }
  sigprocmask(SIG_SETMASK, &previous, NULL);
  return 0;
}
