export type LinuxBubblewrapProcMode = "procfs" | "readonly_bind";

export function linuxBubblewrapPlatformBaselineArgs(procMode: LinuxBubblewrapProcMode = "procfs"): string[] {
  return [
    "--unshare-user",
    "--unshare-pid",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    ...(procMode === "procfs" ? ["--proc", "/proc"] : ["--ro-bind", "/proc", "/proc"]),
  ];
}
