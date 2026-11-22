import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  experimental_hostToolchain,
  experimental_spawnHostProcess,
} from "@get-bb/plugin-sdk/process";
import { z } from "zod";
import type { Account, LoginTarget } from "./contracts.js";
import type { OAuthLoginStart } from "./oauth-login.js";

export const ANTIGRAVITY_GEMINI_DIR_ENV = "BB_ANTIGRAVITY_GEMINI_DIR";
export const ANTIGRAVITY_APP_DATA_DIR_ENV = "BB_ANTIGRAVITY_APP_DATA_DIR";
export const ANTIGRAVITY_APP_DATA_DIR = "antigravity-cli";
export const ANTIGRAVITY_TOKEN_FILENAME = "antigravity-oauth-token";

const REVISION_FILENAME = ".pool-revision";
const LOGIN_SESSION_TTL_MS = 10 * 60 * 1_000;
const LOGIN_URL_TIMEOUT_MS = 15_000;
const LOGIN_COMPLETE_TIMEOUT_MS = 30_000;
const GOOGLE_AUTH_URL_PATTERN = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/u;

const storedAntigravityTokenSchema = z
  .object({
    id_token_email: z.string().email().optional(),
    id_token: z.string().min(1).optional(),
    token: z
      .object({
        access_token: z.string().min(1).optional(),
        refresh_token: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface AntigravityProfileAccount {
  label: string;
  email: string | null;
  tokenJson: string;
}

export interface AntigravityLoginProcess {
  stdin: {
    write(chunk: string): boolean;
    end(): void;
  } | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export type SpawnAntigravityLogin = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => AntigravityLoginProcess;

export interface AntigravityLoginOptions {
  profilesDir: string;
  agyCommand?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  urlTimeoutMs?: number;
  completeTimeoutMs?: number;
  spawnLogin?: SpawnAntigravityLogin;
  validateTarget: (target: LoginTarget) => Promise<void>;
  saveLogin: (
    authenticated: AntigravityProfileAccount,
    target: LoginTarget,
  ) => Promise<Account>;
}

interface ActiveLoginSession {
  sessionId: string;
  target: LoginTarget;
  stagingRoot: string;
  tokenPath: string;
  child: AntigravityLoginProcess;
  exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error: Error | null;
  }>;
  outputTail: () => string;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export function resolveAgyBinary(
  command = "agy",
  env: NodeJS.ProcessEnv = process.env,
): string {
  const resolved = experimental_hostToolchain.resolve(command, { env });
  if (resolved !== null) return resolved;
  if (command !== "agy") return command;
  const fallback =
    process.platform === "win32"
      ? path.join(
          env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"),
          "agy",
          "bin",
          "agy.exe",
        )
      : path.join(homedir(), ".local", "bin", "agy");
  try {
    accessSync(fallback, constants.X_OK);
    return fallback;
  } catch {
    return command;
  }
}

function emailFromIdToken(idToken: string | undefined): string | null {
  if (idToken === undefined) return null;
  const payload = idToken.split(".")[1];
  if (payload === undefined || payload.length === 0) return null;
  try {
    const claims = z
      .object({ email: z.string().email().optional() })
      .passthrough()
      .parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return claims.email ?? null;
  } catch {
    return null;
  }
}

export function parseAntigravityTokenEmail(tokenJson: string): string | null {
  try {
    const parsed = storedAntigravityTokenSchema.safeParse(
      JSON.parse(tokenJson),
    );
    if (!parsed.success) return null;
    return parsed.data.id_token_email ?? emailFromIdToken(parsed.data.id_token);
  } catch {
    return null;
  }
}

export function antigravityProfilePaths(
  profilesDir: string,
  accountId: string,
): {
  profileHome: string;
  geminiDir: string;
  appDataDir: string;
  tokenPath: string;
  revisionPath: string;
} {
  const safeId = z.string().uuid().parse(accountId);
  const profileHome = path.join(profilesDir, safeId);
  const geminiDir = path.join(profileHome, ".gemini");
  const appDataDir = path.join(geminiDir, ANTIGRAVITY_APP_DATA_DIR);
  return {
    profileHome,
    geminiDir,
    appDataDir,
    tokenPath: path.join(appDataDir, ANTIGRAVITY_TOKEN_FILENAME),
    revisionPath: path.join(appDataDir, REVISION_FILENAME),
  };
}

export async function ensureAntigravityProfileDir(
  profilesDir: string,
  accountId: string,
  tokenJson: string,
  revision: number,
): Promise<{ profileHome: string; geminiDir: string; tokenPath: string }> {
  const paths = antigravityProfilePaths(profilesDir, accountId);
  await fs.mkdir(profilesDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.profileHome, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.geminiDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.appDataDir, { recursive: true, mode: 0o700 });
  const expectedRevision = String(revision);
  let currentRevision: string | null = null;
  try {
    currentRevision = (await fs.readFile(paths.revisionPath, "utf8")).trim();
  } catch {
    currentRevision = null;
  }
  let tokenExists = false;
  try {
    await fs.access(paths.tokenPath);
    tokenExists = true;
  } catch {
    tokenExists = false;
  }
  if (!tokenExists || currentRevision !== expectedRevision) {
    const tmpToken = `${paths.tokenPath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmpToken, tokenJson, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmpToken, paths.tokenPath);
    await fs.chmod(paths.tokenPath, 0o600);
    const tmpRev = `${paths.revisionPath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmpRev, `${expectedRevision}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tmpRev, paths.revisionPath);
    await fs.chmod(paths.revisionPath, 0o600);
  }
  return {
    profileHome: paths.profileHome,
    geminiDir: paths.geminiDir,
    tokenPath: paths.tokenPath,
  };
}

export async function removeAntigravityProfileDir(
  profilesDir: string,
  accountId: string,
): Promise<void> {
  const paths = antigravityProfilePaths(profilesDir, accountId);
  await fs.rm(paths.profileHome, { recursive: true, force: true });
}

function defaultSpawnLogin(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
): AntigravityLoginProcess {
  return experimental_spawnHostProcess(command, [...args], {
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export class AntigravityLogin {
  private readonly sessions = new Map<string, ActiveLoginSession>();
  private readonly now: () => number;
  private readonly spawnLogin: SpawnAntigravityLogin;

  constructor(private readonly options: AntigravityLoginOptions) {
    this.now = options.now ?? Date.now;
    this.spawnLogin = options.spawnLogin ?? defaultSpawnLogin;
  }

  hasSession(sessionId: string): boolean {
    this.prune();
    return this.sessions.has(sessionId);
  }

  async start(target: LoginTarget): Promise<OAuthLoginStart> {
    this.prune();
    await this.options.validateTarget(target);
    const sessionId = randomUUID();
    const stagingRoot = path.join(
      this.options.profilesDir,
      `.login-${sessionId}`,
    );
    const geminiDir = path.join(stagingRoot, ".gemini");
    const appDataDir = path.join(geminiDir, ANTIGRAVITY_APP_DATA_DIR);
    const tokenPath = path.join(appDataDir, ANTIGRAVITY_TOKEN_FILENAME);
    await fs.mkdir(appDataDir, { recursive: true, mode: 0o700 });

    const env = { ...(this.options.env ?? process.env) };
    const binary = resolveAgyBinary(this.options.agyCommand ?? "agy", env);
    let child: AntigravityLoginProcess;
    try {
      child = this.spawnLogin(
        binary,
        [
          "acp",
          "--gemini-dir",
          geminiDir,
          "--app-data-dir",
          ANTIGRAVITY_APP_DATA_DIR,
          "--login",
        ],
        { env },
      );
    } catch (error) {
      await fs.rm(stagingRoot, { recursive: true, force: true });
      throw new Error(
        `Could not start Antigravity CLI login: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let output = "";
    const appendOutput = (chunk: Buffer | string) => {
      output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (output.length > 32_768) output = output.slice(-32_768);
    };
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error: Error | null;
    }>((resolve) => {
      child.once("error", (error) =>
        resolve({ code: null, signal: null, error }),
      );
      child.once("exit", (code, signal) =>
        resolve({ code, signal, error: null }),
      );
    });

    const authorizeUrl = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            "Timed out waiting for Antigravity CLI to print a Google sign-in URL.",
          ),
        );
      }, this.options.urlTimeoutMs ?? LOGIN_URL_TIMEOUT_MS);
      timeout.unref();

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn();
      };

      const checkChunk = (chunk: Buffer | string) => {
        appendOutput(chunk);
        const match = GOOGLE_AUTH_URL_PATTERN.exec(output);
        if (match !== null) {
          finish(() => resolve(match[0]));
        }
      };

      child.stdout?.on("data", checkChunk);
      child.stderr?.on("data", checkChunk);
      void exited.then((result) => {
        const match = GOOGLE_AUTH_URL_PATTERN.exec(output);
        if (match !== null) {
          finish(() => resolve(match[0]));
          return;
        }
        const detail =
          result.error !== null
            ? result.error.message
            : output.trim() || `exit code ${result.code ?? "unknown"}`;
        finish(() =>
          reject(
            new Error(
              `Antigravity CLI login did not produce a sign-in URL (${detail}).`,
            ),
          ),
        );
      });
    }).catch(async (error: unknown) => {
      try {
        child.kill("SIGTERM");
      } catch {}
      await fs.rm(stagingRoot, { recursive: true, force: true });
      throw error;
    });

    const timer = setTimeout(() => {
      this.cleanupSession(sessionId);
    }, LOGIN_SESSION_TTL_MS);
    timer.unref();

    this.sessions.set(sessionId, {
      sessionId,
      target,
      stagingRoot,
      tokenPath,
      child,
      exited,
      outputTail: () => output.trim(),
      createdAt: this.now(),
      timer,
    });
    return { sessionId, authorizeUrl };
  }

  async complete(input: {
    sessionId: string;
    pasted: string;
  }): Promise<Account> {
    this.prune();
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      throw new Error(
        "Antigravity sign-in session expired or does not exist. Start again.",
      );
    }
    this.sessions.delete(input.sessionId);
    clearTimeout(session.timer);

    const code = input.pasted.trim();
    if (code.length === 0) {
      this.terminateSession(session);
      throw new Error("Paste the Google authorization code or callback URL.");
    }

    try {
      if (session.child.stdin === null) {
        throw new Error(
          "Antigravity CLI login process cannot accept authorization input. Start again.",
        );
      }
      session.child.stdin.write(`${code}\n`);
      session.child.stdin.end();

      const timeoutMs =
        this.options.completeTimeoutMs ?? LOGIN_COMPLETE_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const result = await Promise.race([
        session.exited,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
          timer.unref();
        }),
      ]).finally(() => {
        if (timer !== null) clearTimeout(timer);
      });

      if (result === null) {
        try {
          session.child.kill("SIGTERM");
        } catch {}
        throw new Error(
          "Timed out completing Antigravity CLI sign-in. Start again.",
        );
      }
      if (result.error !== null) {
        throw new Error(
          `Antigravity CLI sign-in failed: ${result.error.message}`,
        );
      }
      if (result.code !== 0) {
        const detail = session.outputTail();
        throw new Error(
          detail.length > 0
            ? `Antigravity CLI sign-in failed: ${detail.split("\n").slice(-3).join(" ")}`
            : `Antigravity CLI sign-in exited with code ${result.code ?? "unknown"}.`,
        );
      }

      let tokenJson: string;
      try {
        tokenJson = await fs.readFile(session.tokenPath, "utf8");
      } catch {
        throw new Error(
          "Antigravity CLI sign-in finished without writing an isolated token file. Ensure OS keyring fallback is not required or retry sign-in.",
        );
      }
      const email = parseAntigravityTokenEmail(tokenJson);
      return await this.options.saveLogin(
        {
          label: email ?? "Antigravity account",
          email,
          tokenJson,
        },
        session.target,
      );
    } finally {
      await fs.rm(session.stagingRoot, { recursive: true, force: true });
    }
  }

  cancel(input: { sessionId: string }): boolean {
    if (!this.sessions.has(input.sessionId)) return false;
    this.cleanupSession(input.sessionId);
    return true;
  }

  dispose(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.cleanupSession(sessionId);
    }
  }

  private prune(): void {
    const cutoff = this.now() - LOGIN_SESSION_TTL_MS;
    for (const [sessionId, session] of this.sessions) {
      if (session.createdAt <= cutoff) {
        this.cleanupSession(sessionId);
      }
    }
  }

  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    clearTimeout(session.timer);
    this.terminateSession(session);
  }

  private terminateSession(session: ActiveLoginSession): void {
    try {
      session.child.kill("SIGTERM");
    } catch {}
    void fs
      .rm(session.stagingRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
}
