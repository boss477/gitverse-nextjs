import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { analysisJobService } from "@/lib/services/analysisJobService";
import { repositoryService } from "@/lib/services/repositoryService";

export const runtime = "nodejs";

function isAuthorized(request: NextRequest): boolean {
  const configuredSecret = process.env.ANALYSIS_RUNNER_SECRET;

  // Fail-closed: if no secret is configured in production, deny all requests.
  // An unset secret must never silently open access in any deployed environment.
  if (!configuredSecret) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        "[run-analysis] ANALYSIS_RUNNER_SECRET is not set. " +
          "All requests are rejected in production until the secret is configured."
      );
      return false;
    }
    // Allow unauthenticated calls only in local development.
    return true;
  }

  // Secret is configured -- verify it on every request, regardless of HTTP method.
  // Vercel Cron sends plain GET requests; the recommended approach is to set
  // CRON_SECRET equal to ANALYSIS_RUNNER_SECRET so Vercel automatically
  // injects "Authorization: Bearer <CRON_SECRET>" on each cron invocation.
  const authHeader = request.headers.get("authorization");
  if (authHeader === `Bearer ${configuredSecret}`) return true;

  // Also accept the value in the custom header for non-cron callers
  // (e.g. a GitHub Actions workflow or an internal service).
  const headerSecret = request.headers.get("x-analysis-runner-secret");
  if (headerSecret === configuredSecret) return true;

  return false;
}

async function runOnce(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workerId = `serverless:${process.env.VERCEL_REGION || "local"}:${crypto.randomBytes(6).toString("hex")}`;

  const job = await analysisJobService.claimNextJob({ workerId });
  if (!job) {
    return new NextResponse(null, { status: 204 });
  }

  try {
    await analysisJobService.updateProgress({
      jobId: job.id,
      workerId,
      update: {
        progressPercent: job.progressPercent ?? 0,
        progressMessage: job.progressMessage ?? "Processing",
      },
    });

    await repositoryService.analyzeRepository(job.repositoryId, {
      onProgress: async (update) => {
        await analysisJobService.updateProgress({
          jobId: job.id,
          workerId,
          update,
        });
      },
    });

    await analysisJobService.markDone({ jobId: job.id, workerId });

    return NextResponse.json({ ok: true, jobId: job.id, status: "DONE" });
  } catch (error: any) {
    const message = String(error?.message || error || "Unknown error");

    await analysisJobService.markFailed({
      jobId: job.id,
      workerId,
      error: message,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
    });

    return NextResponse.json(
      { ok: false, jobId: job.id, status: "FAILED", error: message },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  return runOnce(request);
}

export async function GET(request: NextRequest) {
  return runOnce(request);
}
