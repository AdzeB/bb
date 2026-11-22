import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_APP_DATA_DIR,
  ANTIGRAVITY_APP_DATA_DIR_ENV,
  ANTIGRAVITY_GEMINI_DIR_ENV,
  ANTIGRAVITY_TOKEN_FILENAME,
  ensureAntigravityProfileDir,
  parseAntigravityTokenEmail,
  removeAntigravityProfileDir,
  type AntigravityLoginProcess,
  type SpawnAntigravityLogin,
} from "./antigravity-login.js";
import { parseAntigravityUsageOutput } from "./antigravity-adapter.js";
import {
  EMPTY_FAMILY_WEEKLY,
  accountSchema,
  loginStartSchema,
  statusSchema,
  type AccountQuota,
} from "./contracts.js";
import { createAccountPoolPlugin } from "./server.js";
import {
  usageFetchMethod,
  usageListMethod,
  usageMeasurementSchema,
  usageResourceListSchema,
} from "./usage-contract.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function emptyQuota(accountId: string): AccountQuota {
  return {
    accountId,
    usageRestriction: null,
    extraUsage: null,
    representativeClaim: null,
    familyWeekly: EMPTY_FAMILY_WEEKLY,
    limitWindows: [],
    observedAt: null,
    heldUntil: null,
    error: null,
  };
}

function usagePayload(options: {
  gemini5hRemaining: number;
  geminiWeeklyRemaining: number;
  claude5hRemaining?: number;
  claudeWeeklyRemaining?: number;
  reset5h?: string;
  resetWeekly?: string;
}): string {
  return JSON.stringify({
    conversation_id: "",
    status: "SUCCESS",
    command: {
      name: "usage",
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                id: "gemini-weekly",
                name: "Weekly Limit Remaining",
                window: "weekly",
                remaining_fraction: options.geminiWeeklyRemaining,
                reset_time: options.resetWeekly ?? "2026-11-29T08:00:00Z",
              },
              {
                id: "gemini-5h",
                name: "Five Hour Limit Remaining",
                window: "5h",
                remaining_fraction: options.gemini5hRemaining,
                reset_time: options.reset5h ?? "2026-11-22T13:00:00Z",
              },
            ],
          },
          {
            name: "Claude and GPT models",
            buckets: [
              {
                id: "3p-weekly",
                name: "Weekly Limit Remaining",
                window: "weekly",
                remaining_fraction: options.claudeWeeklyRemaining ?? 1,
                reset_time: options.resetWeekly ?? "2026-11-29T08:00:00Z",
              },
              {
                id: "3p-5h",
                name: "Five Hour Limit Remaining",
                window: "5h",
                remaining_fraction: options.claude5hRemaining ?? 1,
                reset_time: options.reset5h ?? "2026-11-22T13:00:00Z",
              },
            ],
          },
        ],
      },
    },
  });
}

function fakeSpawnLogin(
  accountsToEmit: Array<{ email: string; accessToken: string }>,
): {
  spawnLogin: SpawnAntigravityLogin;
  spawnedArgs: Array<readonly string[]>;
  receivedCodes: string[];
} {
  const queue = [...accountsToEmit];
  const spawnedArgs: Array<readonly string[]> = [];
  const receivedCodes: string[] = [];

  const spawnLogin: SpawnAntigravityLogin = (_command, args) => {
    spawnedArgs.push(args);
    const geminiIdx = args.indexOf("--gemini-dir");
    const geminiDir = geminiIdx >= 0 ? args[geminiIdx + 1] : undefined;
    const next = queue.shift() ?? {
      email: "fallback@example.com",
      accessToken: "tok-fallback",
    };

    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let bufferedStdin = "";

    const proc: AntigravityLoginProcess = {
      stdin: {
        write(chunk: string) {
          bufferedStdin += chunk;
          return true;
        },
        end() {
          receivedCodes.push(bufferedStdin.trim());
          void (async () => {
            if (geminiDir !== undefined) {
              const tokenDir = path.join(geminiDir, ANTIGRAVITY_APP_DATA_DIR);
              await fs.mkdir(tokenDir, { recursive: true, mode: 0o700 });
              await fs.writeFile(
                path.join(tokenDir, ANTIGRAVITY_TOKEN_FILENAME),
                JSON.stringify({
                  auth_method: "personal",
                  id_token_email: next.email,
                  token: {
                    access_token: next.accessToken,
                    refresh_token: `refresh-${next.accessToken}`,
                  },
                }),
                { encoding: "utf8", mode: 0o600 },
              );
            }
            emitter.emit("exit", 0, null);
          })();
        },
      },
      stdout,
      stderr,
      kill() {
        emitter.emit("exit", null, "SIGTERM");
        return true;
      },
      once(event: "exit" | "error", listener: (...args: any[]) => void) {
        emitter.once(event, listener);
        return proc;
      },
    };

    queueMicrotask(() => {
      stdout.write(
        `Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?client_id=test&state=${encodeURIComponent(next.email)}\n\nThen paste the authorization code:\n`,
      );
    });

    return proc;
  };

  return { spawnLogin, spawnedArgs, receivedCodes };
}

function sdkStubs() {
  return {
    hosts: {
      list: async () => [{ id: "host-one", name: "One" }],
    },
    threads: {
      events: {
        list: async () => [],
      },
    },
    system: {
      providerStates: async () => ({ providers: [] }),
    },
    plugins: {
      list: async () => ({
        plugins: [{ id: "account-pool", enabled: true }],
      }),
    },
  };
}

describe("antigravity profile helpers", () => {
  it("extracts account email from id_token_email or JWT id_token", () => {
    expect(
      parseAntigravityTokenEmail(
        JSON.stringify({ id_token_email: "alice@example.com" }),
      ),
    ).toBe("alice@example.com");

    const jwtPayload = Buffer.from(
      JSON.stringify({ email: "bob@example.com" }),
    ).toString("base64url");
    expect(
      parseAntigravityTokenEmail(
        JSON.stringify({ id_token: `hdr.${jwtPayload}.sig` }),
      ),
    ).toBe("bob@example.com");

    expect(parseAntigravityTokenEmail("not-json")).toBeNull();
  });

  it("materializes profile tokens once per revision and updates on relogin", async () => {
    const root = await tempDir("agy-profiles-");
    const accountId = "11111111-1111-4111-8111-111111111111";

    const first = await ensureAntigravityProfileDir(
      root,
      accountId,
      '{"token":"v1"}',
      1,
    );
    expect(await fs.readFile(first.tokenPath, "utf8")).toBe('{"token":"v1"}');

    await fs.writeFile(first.tokenPath, '{"token":"v1-refreshed"}', "utf8");
    await ensureAntigravityProfileDir(root, accountId, '{"token":"v1"}', 1);
    expect(await fs.readFile(first.tokenPath, "utf8")).toBe(
      '{"token":"v1-refreshed"}',
    );

    await ensureAntigravityProfileDir(root, accountId, '{"token":"v2"}', 2);
    expect(await fs.readFile(first.tokenPath, "utf8")).toBe('{"token":"v2"}');

    await removeAntigravityProfileDir(root, accountId);
    await expect(fs.access(first.profileHome)).rejects.toThrow();
  });

  it("aggregates worst-case 5h and weekly quota windows from agy usage JSON", () => {
    const accountId = "22222222-2222-4222-8222-222222222222";
    const now = Date.parse("2026-11-22T09:00:00Z");
    const quota = parseAntigravityUsageOutput(
      usagePayload({
        gemini5hRemaining: 0.75,
        geminiWeeklyRemaining: 0.9,
        claude5hRemaining: 0,
        claudeWeeklyRemaining: 0.4,
      }),
      accountId,
      emptyQuota(accountId),
      now,
    );
    expect(quota.error).toBeNull();
    expect(quota.observedAt).toBe(now);
    const primary = quota.limitWindows.find((w) => w.slot === "primary");
    const secondary = quota.limitWindows.find((w) => w.slot === "secondary");
    expect(primary).toMatchObject({
      slot: "primary",
      windowMinutes: 300,
      utilization: 1,
      status: "rejected",
      source: "usage",
    });
    expect(secondary).toMatchObject({
      slot: "secondary",
      windowMinutes: 10_080,
      utilization: 0.6,
      status: "allowed",
      source: "usage",
    });
  });

  it("marks auth errors cleanly on quota output", () => {
    const accountId = "33333333-3333-4333-8333-333333333333";
    const quota = parseAntigravityUsageOutput(
      '{"status":"ERROR","error":"authentication required"}',
      accountId,
      emptyQuota(accountId),
      Date.now(),
    );
    expect(quota.error).toContain("Sign in again");
  });
});

describe("Account Pooler Antigravity integration", () => {
  it("signs in accounts via CLI and RPC, routes isolated profiles, fails over on exhaustion, and reports usage", async () => {
    const dataDir = await tempDir("agy-pool-server-");
    const fakeLogin = fakeSpawnLogin([
      { email: "first@example.com", accessToken: "tok-1" },
      { email: "second@example.com", accessToken: "tok-2" },
    ]);

    const usageByEmail = new Map<string, string>([
      [
        "first@example.com",
        usagePayload({
          gemini5hRemaining: 0.85,
          geminiWeeklyRemaining: 0.9,
        }),
      ],
      [
        "second@example.com",
        usagePayload({
          gemini5hRemaining: 0.95,
          geminiWeeklyRemaining: 0.98,
        }),
      ],
    ]);

    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    const plugin = createAccountPoolPlugin({
      now: () => Date.parse("2026-11-22T09:00:00Z"),
      spawnAntigravityLogin: fakeLogin.spawnLogin,
      execAntigravityUsage: async (_cmd, _args, options) => {
        const home = options.env.HOME;
        if (!home) throw new Error("Missing HOME");
        const raw = await fs.readFile(
          path.join(
            home,
            ".gemini",
            ANTIGRAVITY_APP_DATA_DIR,
            ANTIGRAVITY_TOKEN_FILENAME,
          ),
          "utf8",
        );
        const email = parseAntigravityTokenEmail(raw) ?? "";
        return {
          stdout: usageByEmail.get(email) ?? "{}",
          stderr: "",
        };
      },
    });
    await plugin(host.bb);
    cleanups.push(() => host.harness.lifecycle.dispose());

    const cliStart = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "antigravity",
      "--login",
      "--priority",
      "10",
      "--json",
    ]);
    expect(cliStart.exitCode).toBe(0);
    const startedCli = JSON.parse(cliStart.stdout) as {
      ok: boolean;
      login: { sessionId: string; authorizeUrl: string };
    };
    expect(startedCli.ok).toBe(true);
    expect(startedCli.login.authorizeUrl).toContain("accounts.google.com");

    const cliComplete = await host.harness.behavior.runCli([
      "account",
      "login-complete",
      "--session",
      startedCli.login.sessionId,
      "--code",
      "auth-code-one",
      "--json",
    ]);
    expect(cliComplete.exitCode).toBe(0);
    const firstAccount = accountSchema.parse(
      (JSON.parse(cliComplete.stdout) as { account: unknown }).account,
    );
    expect(firstAccount.provider).toBe("antigravity");
    expect(firstAccount.email).toBe("first@example.com");

    const rpcStart = loginStartSchema.parse(
      await host.harness.behavior.callRpc("antigravityLogin.start", {
        kind: "add",
        label: "Backup AGY",
        priority: 20,
      }),
    );
    const secondAccount = accountSchema.parse(
      await host.harness.behavior.callRpc("antigravityLogin.complete", {
        sessionId: rpcStart.sessionId,
        pasted: "auth-code-two",
      }),
    );
    expect(secondAccount.email).toBe("second@example.com");
    expect(secondAccount.label).toBe("Backup AGY");
    expect(fakeLogin.receivedCodes).toEqual(["auth-code-one", "auth-code-two"]);

    const env1 = await host.harness.behavior.resolveProviderEnv(
      "antigravity-cli",
      {
        hostId: "host-one",
        projectId: "proj-1",
        threadId: "thread-1",
      },
    );
    const geminiDir1 = env1.find(
      (entry) => entry.name === ANTIGRAVITY_GEMINI_DIR_ENV,
    )?.value;
    const appDataDir1 = env1.find(
      (entry) => entry.name === ANTIGRAVITY_APP_DATA_DIR_ENV,
    )?.value;
    expect(typeof geminiDir1).toBe("string");
    expect(String(geminiDir1)).toContain(firstAccount.id);
    expect(appDataDir1).toBe(ANTIGRAVITY_APP_DATA_DIR);

    usageByEmail.set(
      "first@example.com",
      usagePayload({
        gemini5hRemaining: 0,
        geminiWeeklyRemaining: 0.5,
      }),
    );
    await host.harness.behavior.callRpc("account.refreshUsage", {
      accountId: firstAccount.id,
    });

    const status = statusSchema.parse(
      await host.harness.behavior.callRpc("status.get", null),
    );
    const firstSummary = status.accounts.find((a) => a.id === firstAccount.id);
    expect(firstSummary?.status).toBe("exhausted");

    const env2 = await host.harness.behavior.resolveProviderEnv(
      "antigravity-cli",
      {
        hostId: "host-one",
        projectId: "proj-1",
        threadId: "thread-2",
      },
    );
    const geminiDir2 = env2.find(
      (entry) => entry.name === ANTIGRAVITY_GEMINI_DIR_ENV,
    )?.value;
    expect(String(geminiDir2)).toContain(secondAccount.id);

    const listed = usageResourceListSchema.parse(
      await host.harness.behavior.callRpc(usageListMethod, {}),
    );
    expect(
      listed.resources.filter((r) => r.providerId === "antigravity-cli"),
    ).toHaveLength(2);
    const secondUsage = usageMeasurementSchema.parse(
      await host.harness.behavior.callRpc(usageFetchMethod, {
        resourceId: secondAccount.id,
        refresh: false,
      }),
    );
    expect(secondUsage.usage.status).toBe("ok");
    if (secondUsage.usage.status === "ok") {
      expect(secondUsage.usage.accountEmail).toBe("second@example.com");
      expect(secondUsage.usage.windows.length).toBeGreaterThanOrEqual(2);
    }

    await host.harness.behavior.callRpc("bypass.set", {
      threadId: "thread-2",
      bypassed: true,
    });
    expect(
      await host.harness.behavior.resolveProviderEnv("antigravity-cli", {
        hostId: "host-one",
        projectId: "proj-1",
        threadId: "thread-2",
      }),
    ).toEqual([]);

    await host.harness.behavior.callRpc("routing.set", {
      provider: "antigravity",
      enabled: false,
    });
    expect(
      await host.harness.behavior.resolveProviderEnv("antigravity-cli", {
        hostId: "host-one",
        projectId: "proj-1",
        threadId: "thread-3",
      }),
    ).toEqual([]);

    await host.harness.behavior.callRpc("account.remove", {
      id: firstAccount.id,
    });
    await expect(fs.access(String(geminiDir1))).rejects.toThrow();
  });
});
