#include "cpty.h"

#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#include <util.h>

int vv_pty_spawn(
    const char *executable,
    char *const argv[],
    char *const envp[],
    const char *cwd,
    unsigned short cols,
    unsigned short rows,
    int *master_fd_out
) {
  struct winsize ws;
  memset(&ws, 0, sizeof(ws));
  ws.ws_col = cols > 0 ? cols : 80;
  ws.ws_row = rows > 0 ? rows : 24;

  int master_fd = -1;
  pid_t pid = forkpty(&master_fd, NULL, NULL, &ws);
  if (pid < 0) {
    return -1;
  }

  if (pid == 0) {
    signal(SIGINT, SIG_DFL);
    signal(SIGQUIT, SIG_DFL);
    signal(SIGTERM, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
    signal(SIGCHLD, SIG_DFL);
    signal(SIGPIPE, SIG_DFL);

    sigset_t mask;
    sigemptyset(&mask);
    sigprocmask(SIG_SETMASK, &mask, NULL);

    if (cwd != NULL && cwd[0] != '\0') {
      if (chdir(cwd) != 0) {
        const char *home = getenv("HOME");
        if (home == NULL || chdir(home) != 0) {
          (void)chdir("/");
        }
      }
    }

    execve(executable, argv, envp);
    _exit(127);
  }

  int fd_flags = fcntl(master_fd, F_GETFD);
  if (fd_flags >= 0) {
    (void)fcntl(master_fd, F_SETFD, fd_flags | FD_CLOEXEC);
  }
  int fl_flags = fcntl(master_fd, F_GETFL);
  if (fl_flags >= 0) {
    (void)fcntl(master_fd, F_SETFL, fl_flags | O_NONBLOCK);
  }

  *master_fd_out = master_fd;
  return (int)pid;
}

int vv_pty_resize(int master_fd, unsigned short cols, unsigned short rows) {
  struct winsize ws;
  memset(&ws, 0, sizeof(ws));
  ws.ws_col = cols > 0 ? cols : 80;
  ws.ws_row = rows > 0 ? rows : 24;
  return ioctl(master_fd, TIOCSWINSZ, &ws);
}

int vv_pty_wait_nonblock(int pid, int *exit_code_out) {
  int status = 0;
  pid_t r;
  do {
    r = waitpid((pid_t)pid, &status, WNOHANG);
  } while (r < 0 && errno == EINTR);

  if (r == 0) {
    return 0;
  }
  if (r < 0) {
    *exit_code_out = 0;
    return -1;
  }
  if (WIFEXITED(status)) {
    *exit_code_out = WEXITSTATUS(status);
  } else if (WIFSIGNALED(status)) {
    *exit_code_out = 128 + WTERMSIG(status);
  } else {
    *exit_code_out = 0;
  }
  return 1;
}

static int read_proc_cmdline(pid_t pid, char *out, size_t out_len) {
  if (out_len == 0) return -1;
  out[0] = '\0';

  int mib[3] = {CTL_KERN, KERN_PROCARGS2, (int)pid};
  size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0 || size < sizeof(int) || size > 262144) {
    return -1;
  }

  char *buf = (char *)malloc(size);
  if (buf == NULL) return -1;
  if (sysctl(mib, 3, buf, &size, NULL, 0) != 0 || size < sizeof(int)) {
    free(buf);
    return -1;
  }

  int argc = 0;
  memcpy(&argc, buf, sizeof(int));
  if (argc <= 0) {
    free(buf);
    return -1;
  }

  size_t pos = sizeof(int);
  while (pos < size && buf[pos] != '\0') pos++;
  while (pos < size && buf[pos] == '\0') pos++;

  size_t written = 0;
  int seen = 0;
  int limit = argc < 4 ? argc : 4;
  while (pos < size && seen < limit) {
    const char *arg = buf + pos;
    size_t arg_len = strnlen(arg, size - pos);
    if (arg_len == 0) break;
    if (written > 0 && written + 1 < out_len) {
      out[written++] = ' ';
    }
    size_t copy = arg_len;
    if (written + copy >= out_len) {
      copy = out_len - 1 - written;
    }
    if (copy > 0) {
      memcpy(out + written, arg, copy);
      written += copy;
    }
    out[written] = '\0';
    seen++;
    pos += arg_len + 1;
  }

  free(buf);
  return written > 0 ? 0 : -1;
}

void vv_pty_inspect(
    int master_fd,
    int shell_pid,
    char *cwd_buf,
    size_t cwd_len,
    char *cmd_buf,
    size_t cmd_len
) {
  if (cwd_len > 0) cwd_buf[0] = '\0';
  if (cmd_len > 0) cmd_buf[0] = '\0';

  pid_t fg = master_fd >= 0 ? tcgetpgrp(master_fd) : -1;
  pid_t target = fg > 0 ? fg : (pid_t)shell_pid;

  struct proc_vnodepathinfo vpi;
  memset(&vpi, 0, sizeof(vpi));
  int n = proc_pidinfo(target, PROC_PIDVNODEPATHINFO, 0, &vpi, sizeof(vpi));
  if (n <= 0 && target != (pid_t)shell_pid) {
    n = proc_pidinfo((pid_t)shell_pid, PROC_PIDVNODEPATHINFO, 0, &vpi, sizeof(vpi));
  }
  if (n > 0 && cwd_len > 0) {
    strncpy(cwd_buf, vpi.pvi_cdir.vip_path, cwd_len - 1);
    cwd_buf[cwd_len - 1] = '\0';
  }

  if (cmd_len > 0) {
    if (read_proc_cmdline(target, cmd_buf, cmd_len) != 0) {
      (void)proc_name(target, cmd_buf, (uint32_t)cmd_len);
    }
  }
}
