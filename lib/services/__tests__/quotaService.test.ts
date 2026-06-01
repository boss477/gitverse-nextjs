/**
 * @jest-environment node
 *
 * Tests for QuotaService
 */

jest.mock("@/lib/prisma", () => {
  return {
    __esModule: true,
    default: {
      rateLimit: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      aiQuota: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({}),
      },
    },
  };
});

import { QuotaService } from "../quotaService";
import prisma from "@/lib/prisma";

describe("QuotaService", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (prisma.rateLimit.count as jest.Mock).mockReset();
    (prisma.rateLimit.create as jest.Mock).mockReset();
    (prisma.rateLimit.deleteMany as jest.Mock).mockReset().mockResolvedValue({ count: 0 });
    (prisma.aiQuota.findUnique as jest.Mock).mockReset();
    (prisma.aiQuota.upsert as jest.Mock).mockReset();
    (prisma.aiQuota.update as jest.Mock).mockReset();
    (prisma.aiQuota.updateMany as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("checkWebhookRateLimit", () => {
    it("allows request when under limit", async () => {
      (prisma.rateLimit.count as jest.Mock).mockResolvedValue(0);
      (prisma.rateLimit.create as jest.Mock).mockResolvedValue({});

      const result = await QuotaService.checkWebhookRateLimit("key1", 10, 60000);

      expect(result).toBe(true);
      expect(prisma.rateLimit.create).toHaveBeenCalled();
    });

    it("rejects request when at limit", async () => {
      (prisma.rateLimit.count as jest.Mock).mockResolvedValue(10);

      const result = await QuotaService.checkWebhookRateLimit("key1", 10, 60000);

      expect(result).toBe(false);
      expect(prisma.rateLimit.create).not.toHaveBeenCalled();
    });

    it("handles unique constraint violation as rate-limited", async () => {
      (prisma.rateLimit.count as jest.Mock).mockResolvedValue(9);
      (prisma.rateLimit.create as jest.Mock).mockRejectedValue(
        Object.assign(new Error("Unique constraint"), { code: "P2002" })
      );

      const result = await QuotaService.checkWebhookRateLimit("key1", 10, 60000);

      expect(result).toBe(false);
    });

    it("allows request when DB fails (fail-open)", async () => {
      (prisma.rateLimit.count as jest.Mock).mockRejectedValue(
        new Error("Connection failed")
      );

      const result = await QuotaService.checkWebhookRateLimit("key1", 10, 60000);

      expect(result).toBe(true);
    });
  });

  describe("checkAndReserveQuota", () => {
    it("allows request when quota is available", async () => {
      (prisma.aiQuota.upsert as jest.Mock).mockResolvedValue({
        id: "1",
        installationId: BigInt(1),
        requestsUsed: 0,
      });
      (prisma.aiQuota.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      const result = await QuotaService.checkAndReserveQuota(BigInt(1));

      expect(result).toBe(true);
      expect(prisma.aiQuota.upsert).toHaveBeenCalled();
    });

    it("rejects request when quota is exhausted", async () => {
      (prisma.aiQuota.upsert as jest.Mock).mockResolvedValue({
        id: "1",
        installationId: BigInt(1),
        requestsUsed: 250,
      });
      (prisma.aiQuota.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prisma.aiQuota.findUnique as jest.Mock).mockResolvedValue({
        id: "1",
        installationId: BigInt(1),
        requestsUsed: 250,
        quotaWindowEnd: new Date(Date.now() + 86400000),
      });

      const result = await QuotaService.checkAndReserveQuota(BigInt(1));

      expect(result).toBe(false);
    });

    it("resets window when expired and reserves", async () => {
      (prisma.aiQuota.upsert as jest.Mock).mockResolvedValue({
        id: "1",
        installationId: BigInt(1),
        requestsUsed: 250,
      });
      (prisma.aiQuota.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prisma.aiQuota.findUnique as jest.Mock).mockResolvedValue({
        id: "1",
        installationId: BigInt(1),
        requestsUsed: 250,
        quotaWindowEnd: new Date(Date.now() - 1000),
      });
      (prisma.aiQuota.update as jest.Mock).mockResolvedValue({});

      const result = await QuotaService.checkAndReserveQuota(BigInt(1));

      expect(result).toBe(true);
      expect(prisma.aiQuota.update).toHaveBeenCalled();
    });

    it("fails closed on DB errors", async () => {
      (prisma.aiQuota.upsert as jest.Mock).mockRejectedValue(
        new Error("DB connection failed")
      );

      const result = await QuotaService.checkAndReserveQuota(BigInt(1));

      expect(result).toBe(false);
    });

    it("uses default max of 250 when env not set", async () => {
      delete process.env.AI_QUOTA_PER_WINDOW;
      (prisma.aiQuota.upsert as jest.Mock).mockResolvedValue({
        id: "1",
        installationId: BigInt(1),
        requestsUsed: 0,
      });
      (prisma.aiQuota.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await QuotaService.checkAndReserveQuota(BigInt(1));

      expect(prisma.aiQuota.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ requestsUsed: { lt: 250 } }),
        })
      );
    });

    it("uses custom max from env", async () => {
      process.env.AI_QUOTA_PER_WINDOW = "100";
      (prisma.aiQuota.upsert as jest.Mock).mockResolvedValue({
        id: "1",
        installationId: BigInt(1),
        requestsUsed: 0,
      });
      (prisma.aiQuota.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await QuotaService.checkAndReserveQuota(BigInt(1));

      expect(prisma.aiQuota.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ requestsUsed: { lt: 100 } }),
        })
      );

      delete process.env.AI_QUOTA_PER_WINDOW;
    });
  });

  describe("recordTokenUsage", () => {
    it("increments token count", async () => {
      (prisma.aiQuota.update as jest.Mock).mockResolvedValue({});

      await QuotaService.recordTokenUsage(BigInt(1), 500);

      expect(prisma.aiQuota.update).toHaveBeenCalledWith({
        where: { installationId: BigInt(1) },
        data: { tokensConsumed: { increment: 500 } },
      });
    });

    it("handles errors gracefully", async () => {
      (prisma.aiQuota.update as jest.Mock).mockRejectedValue(new Error("DB error"));

      await expect(QuotaService.recordTokenUsage(BigInt(1), 500)).resolves.toBeUndefined();
    });
  });

  describe("markWarningPosted", () => {
    it("sets warningPosted to true", async () => {
      (prisma.aiQuota.update as jest.Mock).mockResolvedValue({});

      await QuotaService.markWarningPosted(BigInt(1));

      expect(prisma.aiQuota.update).toHaveBeenCalledWith({
        where: { installationId: BigInt(1) },
        data: { warningPosted: true },
      });
    });

    it("handles errors gracefully", async () => {
      (prisma.aiQuota.update as jest.Mock).mockRejectedValue(new Error("DB error"));

      await expect(QuotaService.markWarningPosted(BigInt(1))).resolves.toBeUndefined();
    });
  });

  describe("hasWarningBeenPosted", () => {
    it("returns true when warning has been posted", async () => {
      (prisma.aiQuota.findUnique as jest.Mock).mockResolvedValue({ warningPosted: true });

      const result = await QuotaService.hasWarningBeenPosted(BigInt(1));

      expect(result).toBe(true);
    });

    it("returns false when warning has not been posted", async () => {
      (prisma.aiQuota.findUnique as jest.Mock).mockResolvedValue({ warningPosted: false });

      const result = await QuotaService.hasWarningBeenPosted(BigInt(1));

      expect(result).toBe(false);
    });

    it("returns true on DB error (assume posted to avoid spamming)", async () => {
      (prisma.aiQuota.findUnique as jest.Mock).mockRejectedValue(new Error("DB error"));

      const result = await QuotaService.hasWarningBeenPosted(BigInt(1));

      expect(result).toBe(true);
    });
  });
});
