'use client';

import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import CompareRepositories from '@/pages/compare';

export default function ComparePage() {
  return (
    <ProtectedRoute>
      <CompareRepositories />
    </ProtectedRoute>
  );
}
