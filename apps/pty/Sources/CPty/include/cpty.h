#ifndef VIBEVALLEY_CPTY_H
#define VIBEVALLEY_CPTY_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

int vv_pty_spawn(
    const char *executable,
    char *const argv[],
    char *const envp[],
    const char *cwd,
    unsigned short cols,
    unsigned short rows,
    int *master_fd_out
);

int vv_pty_resize(int master_fd, unsigned short cols, unsigned short rows);

int vv_pty_wait_nonblock(int pid, int *exit_code_out);

void vv_pty_inspect(
    int master_fd,
    int shell_pid,
    char *cwd_buf,
    size_t cwd_len,
    char *cmd_buf,
    size_t cmd_len
);

#ifdef __cplusplus
}
#endif

#endif
