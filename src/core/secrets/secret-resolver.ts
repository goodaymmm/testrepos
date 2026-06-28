import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SecretProviderName = "env" | "windows_credential";

export type SecretReference =
  | {
      provider: "env";
      name: string;
    }
  | {
      provider: "windows_credential";
      target: string;
    };

export type ResolvedSecret =
  | {
      status: "present";
      value: string;
      provider: SecretProviderName;
      source: string;
    }
  | {
      status: "missing";
      provider?: SecretProviderName;
      source?: string;
      reason?: string;
    };

export type SecretResolver = {
  resolve(reference: SecretReference): Promise<ResolvedSecret>;
};

export type SecretLookupOptions = {
  env: NodeJS.ProcessEnv;
  envName?: string;
  references?: SecretReference[];
  resolver?: SecretResolver;
};

export function createDefaultSecretResolver(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  windowsCredentialReader?: (target: string) => Promise<string | undefined>;
} = {}): SecretResolver {
  const env = options.env ?? process.env;
  const windowsCredentialReader =
    options.windowsCredentialReader ?? readWindowsCredentialSecret;
  const platform = options.platform ?? process.platform;

  return {
    async resolve(reference) {
      if (reference.provider === "env") {
        const value = env[reference.name]?.trim();
        return value === undefined || value.length === 0
          ? {
              status: "missing",
              provider: "env",
              source: reference.name,
              reason: "env var is missing"
            }
          : {
              status: "present",
              value,
              provider: "env",
              source: reference.name
            };
      }

      if (platform !== "win32") {
        return {
          status: "missing",
          provider: "windows_credential",
          source: reference.target,
          reason: "windows credential provider is unavailable on this platform"
        };
      }

      const value = await windowsCredentialReader(reference.target);
      return value === undefined || value.trim().length === 0
        ? {
            status: "missing",
            provider: "windows_credential",
            source: reference.target,
            reason: "windows credential was not found"
          }
        : {
            status: "present",
            value: value.trim(),
            provider: "windows_credential",
            source: reference.target
          };
    }
  };
}

export async function resolveSecret(
  options: SecretLookupOptions
): Promise<ResolvedSecret> {
  const references = [
    ...(options.envName === undefined
      ? []
      : [{ provider: "env" as const, name: options.envName }]),
    ...(options.references ?? [])
  ];
  const resolver =
    options.resolver ?? createDefaultSecretResolver({ env: options.env });

  for (const reference of references) {
    const resolved = await resolver.resolve(reference);
    if (resolved.status === "present") {
      return resolved;
    }
  }

  return {
    status: "missing",
    source: options.envName,
    reason: "secret is missing"
  };
}

async function readWindowsCredentialSecret(
  target: string
): Promise<string | undefined> {
  const script = String.raw`
$ErrorActionPreference = "Stop"
$target = $env:KAIRON_SECRET_TARGET
if ([string]::IsNullOrWhiteSpace($target)) { exit 3 }

$signature = @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
  public uint Flags;
  public uint Type;
  public string TargetName;
  public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize;
  public IntPtr CredentialBlob;
  public uint Persist;
  public uint AttributeCount;
  public IntPtr Attributes;
  public string TargetAlias;
  public string UserName;
}

public static class NativeCredential {
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, uint type, int reservedFlag, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr credentialPtr);
}
"@

Add-Type -TypeDefinition $signature
$credentialPtr = [IntPtr]::Zero
if (-not [NativeCredential]::CredRead($target, 1, 0, [ref]$credentialPtr)) {
  exit 2
}

try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($credentialPtr, [type][CREDENTIAL])
  if ($credential.CredentialBlobSize -eq 0 -or $credential.CredentialBlob -eq [IntPtr]::Zero) {
    exit 2
  }

  $bytes = New-Object byte[] $credential.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $credential.CredentialBlobSize)
  [Text.Encoding]::Unicode.GetString($bytes).TrimEnd([char]0)
} finally {
  if ($credentialPtr -ne [IntPtr]::Zero) {
    [NativeCredential]::CredFree($credentialPtr)
  }
}
`;

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64")
      ],
      {
        env: {
          ...process.env,
          KAIRON_SECRET_TARGET: target
        },
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024
      }
    );
    const value = stdout.trim();
    return value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}
