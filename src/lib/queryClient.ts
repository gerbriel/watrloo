import { QueryClient } from '@tanstack/react-query';

/**
 * Bathroom data is barely-changing reference data — a review posted now doesn't
 * need to appear on someone else's map within seconds. A generous `staleTime`
 * is what turns map panning and back-navigation into cache hits instead of
 * round trips.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      // A 4xx from PostgREST (bad request, RLS denial) will never succeed on
      // retry. Only retry things that plausibly fail transiently.
      retry: (failureCount, error) => {
        const status = (error as { status?: number } | null)?.status;
        if (typeof status === 'number' && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: { retry: 0 },
  },
});

/** Centralized keys so invalidation after a write can't miss a cache entry. */
export const queryKeys = {
  bathrooms: (search?: string) => ['bathrooms', search ?? ''] as const,
  bathroom: (id: string) => ['bathroom', id] as const,
  reviews: (bathroomId: string) => ['reviews', bathroomId] as const,
  myReview: (bathroomId: string, userId: string) =>
    ['review', bathroomId, userId] as const,
  myRoles: (userId: string) => ['roles', userId] as const,
  reports: (status: string) => ['reports', status] as const,
  adminReviews: () => ['admin', 'reviews'] as const,
  adminBathrooms: () => ['admin', 'bathrooms'] as const,
  // Business tier
  myBusinesses: (userId: string) => ['businesses', 'mine', userId] as const,
  business: (id: string) => ['business', id] as const,
  businessListings: (businessId: string) => ['business', businessId, 'listings'] as const,
  businessMembers: (businessId: string) => ['business', businessId, 'members'] as const,
  reviewResponse: (reviewId: string) => ['reviewResponse', reviewId] as const,
  claimForBathroom: (bathroomId: string) => ['claim', bathroomId] as const,
  adminAccessRequests: () => ['admin', 'accessRequests'] as const,
  adminClaims: () => ['admin', 'claims'] as const,
  openAccessRequestCount: () => ['admin', 'accessRequestCount'] as const,
};
