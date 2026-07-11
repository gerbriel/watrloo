// Wires an ad element to the offer lifecycle: viewport-confirmed impression,
// dwell-time accounting, click confirmation. Client-side viewport pattern per
// docs/growth/oss-research/1-ethicalads.md §C: IntersectionObserver at
// threshold 0.5 (rootMargin "-3px" fudge factor), confirm the view once on the
// first qualifying intersection, accumulate dwell seconds on a 1s interval
// only while intersecting AND the page is visible, and flush the total once
// on visibilitychange-hidden or unmount, capped at 300s. All events are
// fire-and-forget; nothing here can break the page. If looksLikeBot() we send
// no events at all — the ad still renders, only the accounting is skipped.
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { confirmAdClick, confirmAdView, recordAdViewTime } from '@/lib/api/adserving';
import { looksLikeBot } from '@/lib/ads/ivt';

export interface AdOfferHandlers {
  /** Attach to the ad card's root element. */
  ref: RefObject<HTMLDivElement | null>;
  /** Call from the ad's click handler (before navigation). */
  onAdClick: () => void;
}

/** Dwell-time cap, in seconds (matches the server-side write-once cap). */
const MAX_DWELL_SECONDS = 300;

export function useAdOffer(offerId: string | null): AdOfferHandlers {
  const ref = useRef<HTMLDivElement | null>(null);
  const clickedRef = useRef(false);

  useEffect(() => {
    if (!offerId) return;
    // SSR / ancient-browser guard: no window, no observer, no accounting.
    if (
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return;
    }
    if (looksLikeBot()) return;
    const el = ref.current;
    if (!el) return;

    let viewed = false;
    let intersecting = false;
    let seconds = 0;
    let flushed = false;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          intersecting = entry.isIntersecting;
        }
        if (intersecting && !viewed) {
          viewed = true;
          confirmAdView(offerId);
        }
      },
      { threshold: 0.5, rootMargin: '-3px' },
    );
    observer.observe(el);

    const interval = window.setInterval(() => {
      if (
        intersecting &&
        document.visibilityState === 'visible' &&
        seconds < MAX_DWELL_SECONDS
      ) {
        seconds += 1;
      }
    }, 1000);

    // Exactly-once flush (the server treats view time as write-once anyway).
    const flush = () => {
      if (flushed || seconds <= 0) return;
      flushed = true;
      recordAdViewTime(offerId, Math.min(seconds, MAX_DWELL_SECONDS));
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(interval);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      flush();
    };
  }, [offerId]);

  const onAdClick = useCallback(() => {
    if (clickedRef.current || !offerId) return;
    if (typeof window === 'undefined' || looksLikeBot()) return;
    clickedRef.current = true;
    confirmAdClick(offerId);
  }, [offerId]);

  return { ref, onAdClick };
}
