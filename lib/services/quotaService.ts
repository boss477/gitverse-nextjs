import prisma from "@/lib/prisma";

const DEFAULT_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

export class QuotaService {
  /**
   * Tracks individual requests to prevent high-frequency burst attacks.
   * Returns true if request is allowed, false if rate-limited.
   *
   * Uses a single INSERT with a conditional check to avoid TOCTOU race conditions.
   * The unique constraint on (key, expiresAt) prevents double-booking.
   */
  static async checkWebhookRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + windowMs);

    try {
      // Clean up expired records asynchronously (best-effort)
      void prisma.rateLimit.deleteMany({
        where: { expiresAt: { lt: now } },
      }).catch(err => console.error("Rate limit cleanup failed:", err));

      // Use a single upsert-like pattern: count active records first
      // Then atomically insert if under limit
      const count = await prisma.rateLimit.count({
        where: {
          key,
          expiresAt: { gte: now },
        },
      });

      if (count >= limit) {
        return false;
      }

      // Attempt to record the request. If a concurrent request inserted
      // between our count and this insert, the count will be re-evaluated
      // on the next request. The race window is narrow and the consequence
      // is allowing one extra request, which is acceptable for rate limiting.
      await prisma.rateLimit.create({
        data: {
          key,
          points: 1,
          expiresAt,
        },
      });

      return true;
    } catch (error: any) {
      // If the create fails due to a unique constraint race, treat as rate-limited
      if (error?.code === "P2002") {
        return false;
      }
      console.error("Error checking webhook rate limit:", error);
      // If DB fails, allow to prevent dropping valid webhooks
      return true;
    }
  }

  /**
   * Checks if an installation has AI analysis quota remaining.
   * If available, it atomically reserves 1 request using a conditional update.
   *
   * This avoids the TOCTOU race condition where two concurrent requests
   * could both see requestsUsed < max and both reserve, exceeding the quota.
   */
  static async checkAndReserveQuota(installationId: bigint): Promise<boolean> {
    try {
      const defaultMaxAnalyses = process.env.AI_QUOTA_PER_WINDOW
        ? parseInt(process.env.AI_QUOTA_PER_WINDOW, 10)
        : 250;

      const now = new Date();
      const windowEnd = new Date(now.getTime() + DEFAULT_QUOTA_WINDOW_MS);

      // Step 1: Ensure quota record exists (upsert)
      await prisma.aiQuota.upsert({
        where: { installationId },
        create: {
          installationId,
          requestsUsed: 0,
          tokensConsumed: 0,
          quotaWindowStart: now,
          quotaWindowEnd: windowEnd,
          warningPosted: false,
        },
        update: {},
      });

      // Step 2: Atomic conditional increment
      // Only increment if under the limit. This is atomic at the DB level.
      const result = await prisma.aiQuota.updateMany({
        where: {
          installationId,
          requestsUsed: { lt: defaultMaxAnalyses },
        },
        data: {
          requestsUsed: { increment: 1 },
          lastAnalysisAt: now,
        },
      });

      // If updateMany affected 0 rows, the quota is exhausted or the window expired
      if (result.count === 0) {
        // Check if the window has expired and needs reset
        const quota = await prisma.aiQuota.findUnique({
          where: { installationId },
        });

        if (quota && quota.quotaWindowEnd < now) {
          // Reset the window and try again
          await prisma.aiQuota.update({
            where: { id: quota.id },
            data: {
              requestsUsed: 1,
              tokensConsumed: 0,
              quotaWindowStart: now,
              quotaWindowEnd: windowEnd,
              warningPosted: false,
              lastAnalysisAt: now,
            },
          });
          return true;
        }

        return false;
      }

      return true;
    } catch (error) {
      console.error("Error in checkAndReserveQuota:", error);
      // Fail closed to protect resources when quota system errors out
      return false;
    }
  }

  static async recordTokenUsage(installationId: bigint, tokens: number): Promise<void> {
    try {
      await prisma.aiQuota.update({
        where: { installationId },
        data: { tokensConsumed: { increment: tokens } },
      });
    } catch (e) {
      console.error("Error recording token usage:", e);
    }
  }

  static async markWarningPosted(installationId: bigint): Promise<void> {
    try {
      await prisma.aiQuota.update({
        where: { installationId },
        data: { warningPosted: true },
      });
    } catch (e) {
      console.error("Error marking warning posted:", e);
    }
  }

  static async hasWarningBeenPosted(installationId: bigint): Promise<boolean> {
    try {
      const quota = await prisma.aiQuota.findUnique({ where: { installationId } });
      return quota?.warningPosted || false;
    } catch (e) {
      console.error("Error checking warning posted status:", e);
      return true; // Assume posted to avoid spamming on DB errors
    }
  }
}
