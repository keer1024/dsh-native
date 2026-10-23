param([int]$TargetPid)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TokIl {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint acc, bool inherit, int pid);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr h, uint acc, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr tok, int cls, IntPtr buf, int len, out int ret);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr h);
  public static string Get(int pid) {
    IntPtr p = OpenProcess(0x0400, false, pid);
    if (p == IntPtr.Zero) return "OpenProcess failed: " + Marshal.GetLastWin32Error();
    IntPtr tok;
    if (!OpenProcessToken(p, 0x0008, out tok)) return "OpenProcessToken failed: " + Marshal.GetLastWin32Error();
    int ret;
    GetTokenInformation(tok, 25, IntPtr.Zero, 0, out ret);
    IntPtr buf = Marshal.AllocHGlobal(ret);
    try {
      if (!GetTokenInformation(tok, 25, buf, ret, out ret)) return "GetTokenInformation failed: " + Marshal.GetLastWin32Error();
      IntPtr sid = Marshal.ReadIntPtr(buf);
      IntPtr str;
      if (!ConvertSidToStringSid(sid, out str)) return "ConvertSidToStringSid failed: " + Marshal.GetLastWin32Error();
      string s = Marshal.PtrToStringUni(str);
      LocalFree(str);
      return s;
    } finally {
      CloseHandle(tok); CloseHandle(p); Marshal.FreeHGlobal(buf);
    }
  }
}
'@
[TokIl]::Get($TargetPid)
