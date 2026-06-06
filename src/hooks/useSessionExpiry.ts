"use client";

import { useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

export function useSessionExpiry() {
  const { status } = useSession();
  const router = useRouter();
  const wasAuthenticated = useRef(false);

  useEffect(() => {
    if (status === "authenticated") {
      wasAuthenticated.current = true;
    }

    if (status === "unauthenticated" && wasAuthenticated.current) {
      wasAuthenticated.current = false;
      if (typeof window !== "undefined") {
        localStorage.removeItem("gitverse_token");
        window.dispatchEvent(new CustomEvent("session-expired", {
          detail: { message: "Your session has expired. Please log in again." },
        }));
      }
      router.push("/login");
    }
  }, [status, router]);
}
