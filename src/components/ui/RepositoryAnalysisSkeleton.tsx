import { Skeleton } from "./Skeleton";

export const RepositoryAnalysisSkeleton: React.FC = () => {
  return (
    <div className="space-y-6">
      {/* Header skeleton */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
        <Skeleton className="h-9 w-9 sm:h-10 sm:w-10 flex-shrink-0" />
        <div className="flex-1 min-w-0 space-y-2">
          <Skeleton className="h-8 w-48 sm:w-64" />
          <Skeleton className="h-4 w-32 sm:w-48" />
          <div className="flex items-center gap-2 mt-2">
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
        <Skeleton className="h-9 w-9 sm:h-10 sm:w-10 flex-shrink-0" />
      </div>

      {/* Tab navigation skeleton */}
      <div className="glass rounded-lg p-2">
        <div className="flex gap-2 overflow-x-auto">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-24 sm:w-28 flex-shrink-0" />
          ))}
        </div>
      </div>

      {/* Content skeleton */}
      <div className="space-y-4">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-4/6" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-4 w-3/6" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    </div>
  );
};
