import { useState, useCallback, useEffect, useRef } from "react";
import axios from "axios";
import { buildApiUrl } from "../services/apiConfig";
export interface Repository {
  id: string;
  name: string;
  url: string;
  description?: string;
  language?: string;
  lastAnalyzed?: string;
  stars?: number;
  commits?: number;
  contributors?: number;
  status?: "completed" | "processing" | "failed";
  createdAt?: string;
  updatedAt?: string;
  [key: string]: any;
}

interface UseRepositoriesReturn {
  repos: Repository[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

const DEFAULT_LIMIT = 10;

export function useRepositories({ limit = DEFAULT_LIMIT } = {}): UseRepositoriesReturn {
  const [repos, setRepos] = useState<Repository[]>([]);
  const cursorRef = useRef<number | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);

  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isFetchingRef = useRef<boolean>(false);
  const initRef = useRef<boolean>(false);
  const abortControllerRef = useRef<AbortController | null>(null); // ✅ Added

  const fetchRepos = useCallback(async (isLoadMore = false) => {
    // Concurrency lock: Prevent duplicate requests
    if (isFetchingRef.current) return;

    // Prevent loadMore if no more items
    if (isLoadMore && !hasMore) return;

    // ✅ Abort any in-flight request before starting a new one
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    isFetchingRef.current = true;

    if (isLoadMore) {
      setIsLoadingMore(true);
    } else {
      setIsLoading(true);
    }

    setError(null);

    try {
      const token = localStorage.getItem("gitverse_token");
      const url = new URL(buildApiUrl("/api/repositories"));
      url.searchParams.set("limit", limit.toString());

      if (isLoadMore && cursor !== undefined) {
        url.searchParams.set("cursor", cursor.toString());
      }
    },
    [hasMore, limit]
  );

      const response = await axios.get(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        signal: abortControllerRef.current.signal, // ✅ Pass signal to axios
      });

      const { data, nextCursor, hasMore: newHasMore } = response.data;

      const newRepos = Array.isArray(data) ? data : [];

      setRepos((prev) => {
        if (!isLoadMore) return newRepos;

        // Frontend Deduplication by ID
        const existingIds = new Set(prev.map((r) => r.id));
        const deduplicatedNew = newRepos.filter(
          (r: Repository) => !existingIds.has(r.id)
        );

        return [...prev, ...deduplicatedNew];
      });

      setCursor(nextCursor);
      setHasMore(newHasMore);
    } catch (err: any) {
      // ✅ Ignore errors caused by intentional abort (component unmount)
      if (axios.isCancel(err) || err?.name === "AbortError") return;
      console.error("Error fetching repositories:", err);
      setError(
        err.response?.data?.error ||
          err.message ||
          "Failed to fetch repositories."
      );
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
      isFetchingRef.current = false;
    }
  }, [cursor, hasMore, limit]);

  // ✅ CLEAN useEffect (no duplicate fetch logic)
  useEffect(() => {
    if (!initRef.current) {
      initRef.current = true;
      fetchRepos();
    }

    // ✅ Cleanup: abort in-flight request when component unmounts
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [fetchRepos]);

  const loadMore = useCallback(async () => {
    await fetchRepos(true);
  }, [fetchRepos]);

  const refresh = useCallback(async () => {
    cursorRef.current = undefined;
    setHasMore(true);
    await fetchRepos(false);
  }, [fetchRepos]);

  return { repos, isLoading, isLoadingMore, hasMore, error, loadMore, refresh };
}