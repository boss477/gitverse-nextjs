"use client";

import { useEffect } from "react";
import { useSessionExpiry } from "@/hooks/useSessionExpiry";
import { useToast } from "@/hooks/use-toast";

export function SessionExpiryHandler() {
  useSessionExpiry();
  const { toast } = useToast();

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      toast({
        title: "Session Expired",
        description: detail?.message ?? "Your session has expired. Please log in again.",
        variant: "destructive",
      });
    };
    window.addEventListener("session-expired", handler);
    return () => window.removeEventListener("session-expired", handler);
  }, [toast]);

  return null;
}
