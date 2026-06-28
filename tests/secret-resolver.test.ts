import { describe, expect, it } from "vitest";
import {
  createDefaultSecretResolver,
  resolveSecret
} from "../src/core/secrets/secret-resolver.js";

describe("secret resolver", () => {
  it("uses explicit env values before configured providers", async () => {
    const resolver = createDefaultSecretResolver({
      env: { TOKEN: "from-env" },
      platform: "win32",
      windowsCredentialReader: async () => "from-credential"
    });

    await expect(
      resolveSecret({
        env: { TOKEN: "from-env" },
        envName: "TOKEN",
        references: [
          {
            provider: "windows_credential",
            target: "Kairon/TestToken"
          }
        ],
        resolver
      })
    ).resolves.toMatchObject({
      status: "present",
      provider: "env",
      source: "TOKEN",
      value: "from-env"
    });
  });

  it("falls back to Windows Credential Manager when configured", async () => {
    const resolver = createDefaultSecretResolver({
      env: {},
      platform: "win32",
      windowsCredentialReader: async (target) =>
        target === "Kairon/TestToken" ? "from-credential" : undefined
    });

    await expect(
      resolveSecret({
        env: {},
        envName: "TOKEN",
        references: [
          {
            provider: "windows_credential",
            target: "Kairon/TestToken"
          }
        ],
        resolver
      })
    ).resolves.toMatchObject({
      status: "present",
      provider: "windows_credential",
      source: "Kairon/TestToken",
      value: "from-credential"
    });
  });

  it("does not query Windows credentials without an explicit reference", async () => {
    let reads = 0;
    const resolver = createDefaultSecretResolver({
      env: {},
      platform: "win32",
      windowsCredentialReader: async () => {
        reads += 1;
        return "unexpected";
      }
    });

    await expect(
      resolveSecret({
        env: {},
        envName: "TOKEN",
        resolver
      })
    ).resolves.toMatchObject({
      status: "missing"
    });
    expect(reads).toBe(0);
  });

  it("reports Windows credential provider unavailable on non-Windows platforms", async () => {
    const resolver = createDefaultSecretResolver({
      env: {},
      platform: "linux",
      windowsCredentialReader: async () => "unexpected"
    });

    await expect(
      resolver.resolve({
        provider: "windows_credential",
        target: "Kairon/TestToken"
      })
    ).resolves.toMatchObject({
      status: "missing",
      provider: "windows_credential"
    });
  });
});
