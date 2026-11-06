/* Linux crash-injection helper for the Rizz observer benchmarks.
 *
 * LD_PRELOAD this into one `rizz` process. It counts libc write/fsync/rename
 * calls whose path contains RIZZ_KILL_NEEDLE and raises SIGKILL on hit number
 * RIZZ_KILL_AT. RIZZ_KILL_WHEN=before kills before that syscall runs;
 * RIZZ_KILL_WHEN=after kills after the syscall returns, before the caller
 * continues. RIZZ_KILL_ARM, when set, is a file that must exist before hits
 * are counted (used so `rizz serve` can finish startup first).
 *
 * This is process-crash injection at syscall boundaries. It is not a power-fail
 * simulator. A hit count of zero means the process is not reaching these libc
 * wrappers (for example io_uring); the harness treats that as a failed run.
 */

#define _GNU_SOURCE

#include <dlfcn.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <unistd.h>

static pthread_mutex_t hit_mu = PTHREAD_MUTEX_INITIALIZER;
static int hit_count = 0;
static int kill_at = 0;
static int kill_after = 0;
static volatile sig_atomic_t ready = 0;
static char needle[256];
static char arm_path[PATH_MAX];
static char count_path[PATH_MAX];

static ssize_t (*real_write)(int, const void *, size_t);
static ssize_t (*real_writev)(int, const struct iovec *, int);
static ssize_t (*real_pwrite)(int, const void *, size_t, off_t);
static int (*real_fsync)(int);
static int (*real_fdatasync)(int);
static int (*real_ftruncate)(int, off_t);
static int (*real_rename)(const char *, const char *);
static int (*real_renameat)(int, const char *, int, const char *);
static int (*real_renameat2)(int, const char *, int, const char *, unsigned int);

static void copy_env(char *dest, size_t dest_len, const char *key) {
  const char *value = getenv(key);
  if (value == NULL) {
    dest[0] = '\0';
    return;
  }
  snprintf(dest, dest_len, "%s", value);
}

__attribute__((constructor)) static void killhook_init(void) {
  copy_env(needle, sizeof needle, "RIZZ_KILL_NEEDLE");
  copy_env(arm_path, sizeof arm_path, "RIZZ_KILL_ARM");
  copy_env(count_path, sizeof count_path, "RIZZ_KILL_COUNT");
  const char *at = getenv("RIZZ_KILL_AT");
  const char *when = getenv("RIZZ_KILL_WHEN");
  if (at != NULL) kill_at = atoi(at);
  if (when != NULL && strcmp(when, "after") == 0) kill_after = 1;
  real_write = dlsym(RTLD_NEXT, "write");
  real_writev = dlsym(RTLD_NEXT, "writev");
  real_pwrite = dlsym(RTLD_NEXT, "pwrite");
  if (real_pwrite == NULL) real_pwrite = dlsym(RTLD_NEXT, "pwrite64");
  real_fsync = dlsym(RTLD_NEXT, "fsync");
  real_fdatasync = dlsym(RTLD_NEXT, "fdatasync");
  real_ftruncate = dlsym(RTLD_NEXT, "ftruncate");
  real_rename = dlsym(RTLD_NEXT, "rename");
  real_renameat = dlsym(RTLD_NEXT, "renameat");
  real_renameat2 = dlsym(RTLD_NEXT, "renameat2");
  ready = 1;
}

static int armed(void) {
  if (arm_path[0] == '\0') return 1;
  return access(arm_path, F_OK) == 0;
}

static int text_has_needle(const char *text) {
  if (text == NULL || needle[0] == '\0') return 0;
  return strstr(text, needle) != NULL;
}

static int fd_has_needle(int fd) {
  char link[64];
  char path[PATH_MAX];
  int wrote = snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
  if (wrote <= 0 || wrote >= (int)sizeof link) return 0;
  ssize_t got = readlink(link, path, sizeof path - 1);
  if (got < 0) return 0;
  path[got] = '\0';
  return text_has_needle(path);
}

static void dump_count(int count) {
  if (count_path[0] == '\0') return;
  int fd = (int)syscall(SYS_openat, AT_FDCWD, count_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) return;
  char buf[16];
  int len = snprintf(buf, sizeof buf, "%08d\n", count);
  if (len > 0) syscall(SYS_write, fd, buf, (size_t)len);
  syscall(SYS_close, fd);
}

static void die(void) {
  kill(getpid(), SIGKILL);
  _exit(137);
}

/* Returns the 1-based hit when this call is in the armed phase, else 0.
 * Kills before the syscall when that hit is selected. */
static int enter_match(int matches) {
  if (!ready || !matches || !armed()) return 0;
  pthread_mutex_lock(&hit_mu);
  hit_count += 1;
  int n = hit_count;
  dump_count(n);
  int kill_now = kill_at > 0 && n == kill_at && !kill_after;
  pthread_mutex_unlock(&hit_mu);
  if (kill_now) die();
  return n;
}

static void leave_match(int n) {
  if (n > 0 && kill_after && kill_at > 0 && n == kill_at) die();
}

ssize_t write(int fd, const void *buf, size_t count) {
  if (!ready || real_write == NULL) return syscall(SYS_write, fd, buf, count);
  int n = enter_match(fd_has_needle(fd));
  ssize_t result = real_write(fd, buf, count);
  leave_match(n);
  return result;
}

ssize_t writev(int fd, const struct iovec *iov, int iovcnt) {
  if (!ready || real_writev == NULL) return syscall(SYS_writev, fd, iov, iovcnt);
  int n = enter_match(fd_has_needle(fd));
  ssize_t result = real_writev(fd, iov, iovcnt);
  leave_match(n);
  return result;
}

ssize_t pwrite(int fd, const void *buf, size_t count, off_t offset) {
  if (!ready || real_pwrite == NULL) {
    return syscall(SYS_pwrite64, fd, buf, count, (long long)offset);
  }
  int n = enter_match(fd_has_needle(fd));
  ssize_t result = real_pwrite(fd, buf, count, offset);
  leave_match(n);
  return result;
}

ssize_t pwrite64(int fd, const void *buf, size_t count, off_t offset) {
  if (!ready || real_pwrite == NULL) {
    return syscall(SYS_pwrite64, fd, buf, count, (long long)offset);
  }
  int n = enter_match(fd_has_needle(fd));
  ssize_t result = real_pwrite(fd, buf, count, offset);
  leave_match(n);
  return result;
}

int fsync(int fd) {
  if (!ready || real_fsync == NULL) return (int)syscall(SYS_fsync, fd);
  int n = enter_match(fd_has_needle(fd));
  int result = real_fsync(fd);
  leave_match(n);
  return result;
}

int fdatasync(int fd) {
  if (!ready || real_fdatasync == NULL) return (int)syscall(SYS_fdatasync, fd);
  int n = enter_match(fd_has_needle(fd));
  int result = real_fdatasync(fd);
  leave_match(n);
  return result;
}

int ftruncate(int fd, off_t length) {
  if (!ready || real_ftruncate == NULL) return (int)syscall(SYS_ftruncate, fd, (long long)length);
  int n = enter_match(fd_has_needle(fd));
  int result = real_ftruncate(fd, length);
  leave_match(n);
  return result;
}

int rename(const char *oldpath, const char *newpath) {
  int matches = text_has_needle(oldpath) || text_has_needle(newpath);
  if (!ready || real_rename == NULL) return (int)syscall(SYS_rename, oldpath, newpath);
  int n = enter_match(matches);
  int result = real_rename(oldpath, newpath);
  leave_match(n);
  return result;
}

int renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath) {
  int matches = text_has_needle(oldpath) || text_has_needle(newpath);
  if (!ready || real_renameat == NULL) {
    return (int)syscall(SYS_renameat, olddirfd, oldpath, newdirfd, newpath);
  }
  int n = enter_match(matches);
  int result = real_renameat(olddirfd, oldpath, newdirfd, newpath);
  leave_match(n);
  return result;
}

int renameat2(
  int olddirfd,
  const char *oldpath,
  int newdirfd,
  const char *newpath,
  unsigned int flags
) {
  int matches = text_has_needle(oldpath) || text_has_needle(newpath);
  if (!ready || real_renameat2 == NULL) {
    return (int)syscall(SYS_renameat2, olddirfd, oldpath, newdirfd, newpath, flags);
  }
  int n = enter_match(matches);
  int result = real_renameat2(olddirfd, oldpath, newdirfd, newpath, flags);
  leave_match(n);
  return result;
}
