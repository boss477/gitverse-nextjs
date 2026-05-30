import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { GitHubAppService } from "@/lib/services/githubAppService";
import { GitHubService } from "@/lib/services/githubService";
import {
  formatPRReviewMarkdown,
  reviewPullRequest,
} from "@/lib/services/prReviewService";
import { recoverStuckEvents } from "@/lib/services/webhookRecoveryService";
import { isAxiosError } from "axios";
import { sanitizeError } from "@/lib/middleware";
import crypto from "crypto";
import { QuotaService } from "@/lib/services/quotaService";
import { IssueTriageService } from "@/lib/services/issue-triage";
import { ImpactAnalysisService } from "@/lib/services/impact-analysis";
import { SelfHealingService } from "@/lib/services/self-healing";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes max duration for Vercel

const MAX_CONCURRENT_JOBS = 3;
let activeJobs = 0;

function isInternalAuthorized(request: NextRequest): boolean {
  const authHeader = request.headers.get("authorization");
  const secret = process.env.GITHUB_WEBHOOK_SECRET || process.env.JWT_SECRET || "";
  
  if (!secret) return false;
  
  const expectedToken = `Bearer ${crypto.createHash('sha256').update(secret).digest('hex')}`;
  
  try {
    const a = Buffer.from(expectedToken);
    const b = Buffer.from(authHeader || "");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  if (!isInternalAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await recoverStuckEvents();
    return NextResponse.json({ ok: true, ...result });
  } catch (error: any) {
    console.error("Recovery failed:", error);
    return NextResponse.json(
      { error: "Recovery failed", details: sanitizeError(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  if (!isInternalAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    return NextResponse.json(
      { ok: true, queued: true, reason: "concurrency_limit", activeJobs },
      { status: 202 }
    );
  }

  const { eventId } = await request.json().catch(() => ({}));

  if (!eventId) {
    return NextResponse.json({ error: "eventId is required" }, { status: 400 });
  }

  const webhookEvent = await prisma.webhookEvent.findUnique({
    where: { id: eventId },
  });

  if (!webhookEvent) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  if (webhookEvent.status !== "pending") {
    return NextResponse.json(
      { ok: true, ignored: true, reason: "already_processed" },
      { status: 200 }
    );
  }

  await prisma.webhookEvent.update({
    where: { id: eventId },
    data: { status: "processing" },
  });

  activeJobs++;

  let prUrl: string | null = null;
  let owner: string | undefined;
  let repo: string | undefined;
  let number: number | undefined;

  try {
    const payload = webhookEvent.payload as any;
    owner = payload.repository?.owner?.login;
    repo = payload.repository?.name;
    number = payload.pull_request?.number;
    const owner = payload.repository?.owner?.login;
    const repo = payload.repository?.name;
    const pullNumber = payload.pull_request?.number;
    const issueNumber = payload.issue?.number;
    const number = pullNumber || issueNumber;
    const installationId = payload.installation?.id;

    if (!owner || !repo || !number || !installationId) {
      throw new Error("Missing required fields in payload");
    }

    const repoFullName = `${owner}/${repo}`;

    const enabledRepo = await prisma.gitHubRepo.findFirst({
      where: {
        repoFullName,
        enabled: true,
        OR: [
          { installationId: BigInt(installationId) },
          { installationId: null },
        ],
      },
      orderBy: [{ updatedAt: "desc" }],
    });

    if (!enabledRepo) {
      await prisma.webhookEvent.update({
        where: { id: eventId },
        data: { status: "completed", error: "Repo not enabled" },
      });
      return NextResponse.json({ ok: true, ignored: true, reason: "repo_not_enabled" });
    }

    await prisma.gitHubRepo.updateMany({
      where: {
        repoFullName,
        enabled: true,
        installationId: null,
      },
      data: { installationId: BigInt(installationId) },
    });

    const app = new GitHubAppService();
    const installationToken = await app.getInstallationAccessToken(installationId);

    let github: GitHubService;
    try {
      github = new GitHubService(installationToken);
      const pr = await github.getPullRequest(owner, repo, number);
      const headSha = pr?.head?.sha;
      if (!headSha) {
        throw new Error("Missing head SHA from GitHub PR response");
      }
    const github = new GitHubService(installationToken);

    // 1. AI Kill Switch Check
    if (process.env.DISABLE_AI_ANALYSIS === "true") {
      await prisma.webhookEvent.update({
        where: { id: eventId },
        data: { status: "completed", error: "AI analysis is globally disabled" },
      });
      return NextResponse.json({ ok: true, ignored: true, reason: "ai_disabled" });
    }

    // 2. Installation Quota Enforcement
    const hasQuota = await QuotaService.checkAndReserveQuota(BigInt(installationId));
    if (!hasQuota) {
      await prisma.webhookEvent.update({
        where: { id: eventId },
        data: { status: "rate_limited", error: "AI usage quota exhausted" },
      });

      const warningPosted = await QuotaService.hasWarningBeenPosted(BigInt(installationId));
      if (!warningPosted) {
        const comment = "⚠️ **GitVerse AI Quota Exhausted**\n\nThe AI analysis quota has been temporarily exhausted for this installation. Automatic PR reviews will resume when the quota window resets.";
        try {
          await github.postPullRequestComment(owner, repo, number, comment);
          await QuotaService.markWarningPosted(BigInt(installationId));
        } catch (e) {
          console.error("Failed to post quota warning comment:", e);
        }
      }
      return NextResponse.json({ ok: true, ignored: true, reason: "quota_exhausted" });
    }

    if (webhookEvent.event === "issues") {
      if (!issueNumber) throw new Error("Missing issue number");
      const issueTitle = payload.issue?.title || "Unknown Title";
      const issueBody = payload.issue?.body || "";

      const repositoryFiles = await prisma.file.findMany({
        where: { repositoryId: enabledRepo.id },
        select: { path: true },
      });

      const triageService = new IssueTriageService();
      await triageService.triageIssue({
        owner,
        repo,
        issueNumber,
        title: issueTitle,
        body: issueBody,
        repositoryFiles,
        githubToken: installationToken,
      });

      await prisma.webhookEvent.update({
        where: { id: eventId },
        data: { status: "completed" },
      });

      return NextResponse.json({ ok: true, message: "Issue triaged" });
    }

    const pr = await github.getPullRequest(owner, repo, number);
    const headSha = pr?.head?.sha;
    if (!headSha) {
      throw new Error("Missing head SHA from GitHub PR response");
    }

      const prRecord = await prisma.pullRequest.upsert({
        where: {
          repoId_prNumber: {
            repoId: enabledRepo.id,
            prNumber: number,
          },
        },
        create: {
          repoId: enabledRepo.id,
          prNumber: number,
          title: pr.title,
          author: pr.user?.login || "unknown",
          headSha,
          htmlUrl: pr.html_url,
          status: "OPEN",
        },
        update: {
          title: pr.title,
          author: pr.user?.login || "unknown",
          headSha,
          htmlUrl: pr.html_url,
          status: "OPEN",
        },
      });

      let reviewRow: any = null;
      try {
        reviewRow = await prisma.pRReview.create({
          data: {
            pullRequestId: prRecord.id,
            headSha,
            reviewText: "(processing)",
            rawJson: {},
          },
          select: { id: true, pullRequestId: true, headSha: true },
        });
      } catch (e: any) {
        if (e?.code === "P2002") {
          await prisma.webhookEvent.update({
            where: { id: eventId },
            data: { status: "completed", error: "Already reviewed (deduped)" },
          });
          return NextResponse.json({ ok: true, ignored: true, reason: "already_reviewed" });
        }
        throw e;
      }

      try {
        const { review, prUrl: reviewPrUrl } = await reviewPullRequest({
          owner,
          repo,
          number,
          githubToken: installationToken,
        });

        prUrl = reviewPrUrl;
        const comment = formatPRReviewMarkdown({ review, prUrl });
        let postedUrl: string | null = null;
        let postError: any = null;
    try {
      const { review, prUrl, tokensConsumed } = await reviewPullRequest({
        owner,
        repo,
        number,
        githubToken: installationToken,
      });

      if (tokensConsumed) {
        await QuotaService.recordTokenUsage(BigInt(installationId), tokensConsumed);
      }

      const comment = formatPRReviewMarkdown({ review, prUrl });
      let postedUrl: string | null = null;
      let postError: any = null;

        try {
          const posted = await github.postPullRequestComment(owner, repo, number, comment);
          postedUrl = posted?.html_url || null;
        } catch (err: unknown) {
          if (isAxiosError(err)) {
            const status = err.response?.status;
            const data = err.response?.data as any;
            if (status === 403) {
              postError = {
                status,
                message: String(data?.message || err.message || "Forbidden"),
                documentation_url: data?.documentation_url,
                url: err.config?.url,
              };
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }

        await prisma.pRReview.update({
          where: { id: reviewRow.id },
          data: {
            reviewText: comment,
            rawJson: {
              ...(review as any),
              _githubPost: { ok: Boolean(postedUrl), postedUrl, error: postError },
            } as any,
          },
        });

        await prisma.webhookEvent.update({
          where: { id: eventId },
          data: { status: "completed" },
        });
      // Execute dependency impact analysis
      try {
        const impactService = new ImpactAnalysisService();
        await impactService.analyzePR({
          owner,
          repo,
          pullNumber: number,
          githubToken: installationToken,
        });
      } catch (impactErr) {
        console.error("Dependency impact analysis failed:", impactErr);
      }

      // Execute self-healing patches
      try {
        const selfHealingService = new SelfHealingService();
        await selfHealingService.processAndPostPatches({
          owner,
          repo,
          pullNumber: number,
          headSha,
          githubToken: installationToken,
          reviewResponse: review,
        });
      } catch (selfHealErr) {
        console.error("Self-healing patch generation failed:", selfHealErr);
      }

      await prisma.webhookEvent.update({
        where: { id: eventId },
        data: { status: "completed" },
      });

        return NextResponse.json({ ok: true, posted: postedUrl, postError });
      } catch (innerError: any) {
        if (reviewRow) {
          await prisma.pRReview.delete({ where: { id: reviewRow.id } }).catch(() => null);
        }
        throw innerError;
      }
    } finally {
      github = undefined as any;
    }
  } catch (error: any) {
    const errorDetails = sanitizeError(error);
    console.error("Worker processing error:", errorDetails);

    const currentRetryCount = (webhookEvent as any).retryCount ?? 0;
    const maxRetries = (webhookEvent as any).maxRetries ?? 3;
    const shouldRetry = currentRetryCount < maxRetries;

    const retryDelay = shouldRetry
      ? Math.min(60_000 * Math.pow(2, currentRetryCount), 30 * 60_000)
      : 0;

    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: {
        status: shouldRetry ? "failed" : "failed",
        error: String(error?.message || error),
        retryCount: currentRetryCount,
        nextRetryAt: shouldRetry ? new Date(Date.now() + retryDelay) : null,
      },
    });

    return NextResponse.json(
      { error: "Failed to process event", details: errorDetails },
      { status: 500 }
    );
  } finally {
    activeJobs = Math.max(0, activeJobs - 1);
  }
}
