import fs from "node:fs/promises";
import { experimental_execHostFile } from "@get-bb/plugin-sdk/process";
import { z } from "zod";
import {
  EMPTY_FAMILY_WEEKLY,
  type AccountQuota,
  type LimitWindow,
} from "./contracts.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import { parseReset } from "./quota.js";
import {
  ensureAntigravityProfileDir,
  resolveAgyBinary,
} from "./antigravity-login.js";

const USAGE_TIMEOUT_MS = 15_000;
const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10_080;

const agyBucketSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    window: z.string().optional(),
    remaining_fraction: z.number().optional(),
    remaining_amount: z.number().optional(),
    disabled: z.boolean().optional(),
    reset_time: z.string().nullable().optional(),
  })
  .passthrough();

const agyGroupSchema = z
  .object({
    name: z.string().min(1),
    buckets: z.array(agyBucketSchema).default([]),
  })
  .passthrough();

const agyUsageResponseSchema = z
  .object({
    status: z.string().optional(),
    error: z.unknown().optional(),
    command: z
      .object({
        name: z.literal("usage"),
        data: z
          .object({
            groups: z.array(agyGroupSchema).default([]),
            buckets: z.array(agyBucketSchema).optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

type AgyBucket = z.infer<typeof agyBucketSchema>;

export type ExecAntigravityUsage = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

function isAuthErrorText(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("not signed in") ||
    lower.includes("authentication required") ||
    lower.includes("authentication failed") ||
    lower.includes("unauthenticated") ||
    lower.includes("token expired") ||
    lower.includes("session expired") ||
    lower.includes("invalid_grant") ||
    lower.includes("reauthenticate")
  );
}

function classifyBucketSlot(
  bucket: AgyBucket,
): { slot: "primary" | "secondary"; windowMinutes: number } | null {
  const win = bucket.window?.trim().toLowerCase();
  const name = bucket.name.trim().toLowerCase();
  if (
    win === "5h" ||
    win === "five-hour" ||
    name.startsWith("five hour") ||
    name.includes("5-hour") ||
    name.includes("5h")
  ) {
    return { slot: "primary", windowMinutes: FIVE_HOUR_MINUTES };
  }
  if (win === "weekly" || name.includes("weekly")) {
    return { slot: "secondary", windowMinutes: WEEKLY_MINUTES };
  }
  return null;
}

function utilizationFromBucket(bucket: AgyBucket): number {
  const remaining =
    bucket.remaining_fraction !== undefined &&
    Number.isFinite(bucket.remaining_fraction)
      ? bucket.remaining_fraction
      : 0;
  return Math.max(0, Math.min(1, 1 - remaining));
}

export function parseAntigravityUsageOutput(
  stdout: string,
  accountId: string,
  previous: AccountQuota,
  now: number,
): AccountQuota {
  const trimmed = stdout.trim();
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    if (isAuthErrorText(trimmed)) {
      return {
        ...previous,
        accountId,
        error: "Antigravity login expired or revoked. Sign in again.",
      };
    }
    return previous;
  }

  const parsed = agyUsageResponseSchema.safeParse(raw);
  if (!parsed.success) {
    if (isAuthErrorText(trimmed)) {
      return {
        ...previous,
        accountId,
        error: "Antigravity login expired or revoked. Sign in again.",
      };
    }
    return previous;
  }

  const data = parsed.data.command.data;
  const buckets: AgyBucket[] =
    data.groups.length > 0
      ? data.groups.flatMap((group) => group.buckets)
      : (data.buckets ?? []);

  const bySlot = new Map<
    "primary" | "secondary",
    {
      windowMinutes: number;
      utilization: number;
      resetAt: number | null;
      rejected: boolean;
    }
  >();

  for (const bucket of buckets) {
    if (bucket.disabled === true) continue;
    if (
      bucket.remaining_fraction === undefined &&
      bucket.remaining_amount !== undefined
    ) {
      continue;
    }
    const classified = classifyBucketSlot(bucket);
    if (classified === null) continue;
    const utilization = utilizationFromBucket(bucket);
    const resetAt = parseReset(bucket.reset_time ?? null);
    const rejected = utilization >= 1;
    const existing = bySlot.get(classified.slot);
    if (existing === undefined) {
      bySlot.set(classified.slot, {
        windowMinutes: classified.windowMinutes,
        utilization,
        resetAt,
        rejected,
      });
      continue;
    }
    const takeBucketReset =
      (rejected && !existing.rejected) ||
      (rejected &&
        existing.rejected &&
        resetAt !== null &&
        (existing.resetAt === null || resetAt > existing.resetAt)) ||
      (!rejected &&
        !existing.rejected &&
        utilization > existing.utilization &&
        resetAt !== null);
    bySlot.set(classified.slot, {
      windowMinutes: classified.windowMinutes,
      utilization: Math.max(existing.utilization, utilization),
      resetAt: takeBucketReset ? resetAt : existing.resetAt,
      rejected: existing.rejected || rejected,
    });
  }

  const limitWindows: LimitWindow[] = [];
  for (const slot of ["primary", "secondary"] as const) {
    const agg = bySlot.get(slot);
    if (agg === undefined) continue;
    limitWindows.push({
      slot,
      windowMinutes: agg.windowMinutes,
      utilization: agg.utilization,
      resetAt: agg.resetAt,
      status: agg.rejected ? "rejected" : "allowed",
      observedAt: now,
      source: "usage",
    });
  }

  return {
    accountId,
    usageRestriction: null,
    extraUsage: null,
    representativeClaim: null,
    familyWeekly: EMPTY_FAMILY_WEEKLY,
    limitWindows,
    observedAt: now,
    heldUntil: null,
    error: null,
  };
}

async function defaultExecUsage(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await experimental_execHostFile(
    command,
    [...args],
    {
      env: options.env,
      timeout: options.timeout,
      maxBuffer: 1024 * 1024,
    },
  );
  return { stdout, stderr };
}

export function createAntigravityAdapter(options: {
  profilesDir: string;
  agyCommand?: string;
  env?: NodeJS.ProcessEnv;
  execUsage?: ExecAntigravityUsage;
}): ProviderAdapter {
  const execUsage = options.execUsage ?? defaultExecUsage;

  return {
    provider: "antigravity",
    upstreamName: "Antigravity",
    parseRequest(body) {
      return {
        family: "other",
        affinityId: null,
        parentAffinityId: null,
        forAccount: () => body,
      };
    },
    upstreamUrl() {
      throw new Error(
        "Antigravity accounts route through isolated CLI profiles rather than the HTTP proxy.",
      );
    },
    requestHeaders() {
      return new Headers();
    },
    quotaFromHeaders(_accountId, _headers, previous) {
      return previous;
    },
    isQuotaRejection() {
      return false;
    },
    async refreshSecret(context) {
      return { secret: context.secret, refreshed: false };
    },
    async refreshUsage(context) {
      const secret = await context.accounts.readSecret(context.account.id);
      if (secret.kind !== "antigravity-profile") return;
      const profile = await ensureAntigravityProfileDir(
        options.profilesDir,
        context.account.id,
        secret.tokenJson,
        secret.revision,
      );
      const baseEnv = { ...(options.env ?? process.env) };
      const binary = resolveAgyBinary(options.agyCommand ?? "agy", baseEnv);
      const env: NodeJS.ProcessEnv = {
        ...baseEnv,
        HOME: profile.profileHome,
        USERPROFILE: profile.profileHome,
        NO_COLOR: "1",
      };
      const previous = context.quotas.get(context.account.id);
      try {
        const { stdout, stderr } = await execUsage(
          binary,
          ["-p", "/usage", "--output-format", "json"],
          { env, timeout: USAGE_TIMEOUT_MS },
        );
        try {
          const updatedToken = await fs.readFile(profile.tokenPath, "utf8");
          if (
            updatedToken.trim().length > 0 &&
            updatedToken !== secret.tokenJson
          ) {
            await context.accounts.writeSecret(context.account.id, {
              kind: "antigravity-profile",
              tokenJson: updatedToken,
              revision: secret.revision,
            });
          }
        } catch {}
        const combined = `${stdout}\n${stderr}`;
        const next = parseAntigravityUsageOutput(
          stdout,
          context.account.id,
          previous,
          context.now(),
        );
        if (next === previous && isAuthErrorText(combined)) {
          context.quotas.put({
            ...previous,
            error: "Antigravity login expired or revoked. Sign in again.",
          });
          return;
        }
        context.quotas.put(next);
      } catch (error) {
        const stdout =
          error &&
          typeof error === "object" &&
          "stdout" in error &&
          typeof error.stdout === "string"
            ? error.stdout
            : "";
        const stderr =
          error &&
          typeof error === "object" &&
          "stderr" in error &&
          typeof error.stderr === "string"
            ? error.stderr
            : "";
        const message = error instanceof Error ? error.message : String(error);
        if (isAuthErrorText(`${message}\n${stdout}\n${stderr}`)) {
          context.quotas.put({
            ...previous,
            error: "Antigravity login expired or revoked. Sign in again.",
          });
        }
      }
    },
    errorResponse(status, message, headers) {
      return Response.json(
        { error: { type: "api_error", message } },
        { status, headers },
      );
    },
  };
}
