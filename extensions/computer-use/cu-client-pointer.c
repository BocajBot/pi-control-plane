/*
 * LD_PRELOAD shim: make an unmodified X client (xdotool) act on a chosen
 * MPX master pointer instead of the core pointer.
 *
 * Core-protocol and XTEST requests act on the client's ClientPointer. This
 * sets it right after the display is opened, from CU_CLIENT_POINTER (the
 * master pointer device id). Unset/invalid -> no-op.
 *
 * Build: gcc -shared -fPIC -O2 -o cu-client-pointer.so cu-client-pointer.c -ldl -lX11 -lXi
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <X11/Xlib.h>
#include <X11/extensions/XInput2.h>

Display *XOpenDisplay(const char *name) {
  static Display *(*real)(const char *);
  if (!real) real = (Display * (*)(const char *)) dlsym(RTLD_NEXT, "XOpenDisplay");
  Display *d = real(name);
  const char *id = getenv("CU_CLIENT_POINTER");
  if (d && id && atoi(id) > 0) {
    int major = 2, minor = 0;
    if (XIQueryVersion(d, &major, &minor) != Success ||
        XISetClientPointer(d, None, atoi(id)) != Success) {
      fprintf(stderr, "cu-client-pointer: could not set client pointer %s\n", id);
      exit(70);
    }
    XSync(d, False);
  }
  return d;
}
