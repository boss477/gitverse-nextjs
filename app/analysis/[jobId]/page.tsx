"use client";

import { useRouter } from "next/navigation";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { EmptyState } from "@/components/ui";
import { Activity } from "lucide-react";

export default function AnalysisJobPage() {
  const router = useRouter();

  return (
    <DashboardLayout>
      <div className="flex items-center justify-center min-h-[60vh]">
        <EmptyState
          icon={Activity}
          title="No Analysis Jobs Found"
          description="You haven't created any analysis jobs yet."
          actionLabel="Create New Job"
          onAction={() => router.push("/analyze")}
        />
      </div>
    </DashboardLayout>
  );
}
