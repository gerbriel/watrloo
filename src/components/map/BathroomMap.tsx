import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BathroomWithStats } from '@/types/db';
import {
  buildMapStyle,
  currentMapTheme,
  hasBasemap,
  onMapThemeChange,
  registerPmtilesProtocol,
} from '@/lib/basemap';

/** Geographic center of the contiguous US: a neutral default with no pins. */
const DEFAULT_CENTER: [number, number] = [-98.5795, 39.8283]; // [lng, lat]
const DEFAULT_ZOOM = 3.5;

registerPmtilesProtocol();

/**
 * Rating → pin color. Color never carries the meaning alone: the pin also
 * prints the numeric rating, and each marker gets an aria-label.
 */
function pinColor(avg: number | null): string {
  if (avg == null) return '#547b9b'; // porcelain-500 — unrated
  if (avg >= 4) return '#16a34a'; // green-600
  if (avg >= 3) return '#f5a524'; // star
  if (avg >= 2) return '#f97316'; // orange-500
  return '#dc2626'; // red-600
}

function teardropSvg(color: string, inner: string): string {
  return `
    <svg width="30" height="40" viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg"
         style="display:block;filter:drop-shadow(0 2px 2px rgba(0,0,0,.35))">
      <path d="M15 1C7.3 1 1 7.3 1 15c0 9.6 14 24 14 24s14-14.4 14-24C29 7.3 22.7 1 15 1Z"
            fill="${color}" stroke="#fff" stroke-width="1.5" />
      ${inner}
    </svg>`;
}

function ratingPinElement(avg: number | null): HTMLElement {
  const color = pinColor(avg);
  const label = avg == null ? '·' : avg.toFixed(1);
  const el = document.createElement('div');
  el.style.cursor = 'pointer';
  el.innerHTML = teardropSvg(
    color,
    `<circle cx="15" cy="15" r="8.5" fill="#fff" />
     <text x="15" y="15.5" text-anchor="middle" dominant-baseline="central"
           font-family="ui-sans-serif, system-ui, sans-serif"
           font-size="8.5" font-weight="700" fill="${color}">${label}</text>`,
  );
  return el;
}

function placePinElement(): HTMLElement {
  const el = document.createElement('div');
  el.style.cursor = 'grab';
  el.innerHTML = teardropSvg('#0284c7', '<circle cx="15" cy="15" r="4.5" fill="#fff" />');
  return el;
}

/** Popup body, built as DOM so the detail link can route without a page load. */
function popupContent(
  bathroom: BathroomWithStats,
  navigate: (to: string) => void,
): HTMLElement {
  const { name, stats, id } = bathroom;
  const root = document.createElement('div');
  root.className = 'flex flex-col gap-1';

  const title = document.createElement('span');
  title.className = 'font-semibold text-porcelain-950';
  title.textContent = name;
  root.append(title);

  const rated = stats.review_count > 0 && stats.avg_rating != null;
  const meta = document.createElement('span');
  meta.className = 'text-xs text-porcelain-700';
  meta.textContent = rated
    ? `★ ${stats.avg_rating!.toFixed(1)} · ${stats.review_count} review${
        stats.review_count === 1 ? '' : 's'
      }`
    : 'No reviews yet';
  root.append(meta);

  const link = document.createElement('a');
  link.href = `/bathrooms/${id}`;
  link.className = 'text-xs font-medium text-flush-600 hover:underline';
  link.textContent = 'View details →';
  link.addEventListener('click', (e) => {
    // Let modified clicks (new tab) behave natively.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(`/bathrooms/${id}`);
  });
  root.append(link);

  return root;
}

export interface BathroomMapProps {
  bathrooms: BathroomWithStats[];
  /** [lng, lat] — MapLibre's order, not Leaflet's. */
  center?: [number, number];
  zoom?: number;
  /** Fire when a rating pin is clicked (the popup opens regardless). */
  onPinClick?: (bathroom: BathroomWithStats) => void;
  /** Fit the view to all pins once they load (read-only map page). */
  fit?: boolean;
  /** Picker mode: clicking or dragging drops a pin and reports its coords. */
  selectable?: boolean;
  onSelect?: (lat: number, lng: number) => void;
  /** The currently placed picker pin, if any. */
  selected?: { lat: number; lng: number } | null;
  className?: string;
}

export function BathroomMap({
  bathrooms,
  center,
  zoom,
  onPinClick,
  fit = false,
  selectable = false,
  onSelect,
  selected = null,
  className,
}: BathroomMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const pickMarkerRef = useRef<maplibregl.Marker | null>(null);
  const navigate = useNavigate();

  // `onSelect` is read inside a map event handler registered once. Keep it in a
  // ref so a re-render with a new callback identity doesn't require re-binding.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // --- Create the map exactly once. -----------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildMapStyle(currentMapTheme()),
      center: center ?? (selected ? [selected.lng, selected.lat] : DEFAULT_CENTER),
      zoom: zoom ?? (selected ? 15 : DEFAULT_ZOOM),
      attributionControl: false,
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    const unsubscribeTheme = onMapThemeChange((theme) => {
      // Markers are DOM overlays, so they survive a style swap untouched.
      map.setStyle(buildMapStyle(theme));
    });

    return () => {
      unsubscribeTheme();
      map.remove();
      mapRef.current = null;
    };
    // Initial camera and `selected` seed the first frame only; later changes are
    // handled by the effects below. Re-running this would destroy the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Picker: click to place. Registered once, reads the latest callback. ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectable) return;

    const handler = (e: maplibregl.MapMouseEvent) => {
      onSelectRef.current?.(e.lngLat.lat, e.lngLat.lng);
    };
    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [selectable]);

  // --- Rating pins: rebuild when the set of bathrooms changes. ---------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const marker of markersRef.current) marker.remove();
    markersRef.current = [];

    for (const bathroom of bathrooms) {
      const rated = bathroom.stats.review_count > 0 && bathroom.stats.avg_rating != null;
      const element = ratingPinElement(bathroom.stats.avg_rating);
      element.setAttribute('role', 'button');
      element.setAttribute('tabindex', '0');
      element.setAttribute(
        'aria-label',
        `${bathroom.name} — ${
          rated ? `${bathroom.stats.avg_rating!.toFixed(1)} out of 5 stars` : 'not yet rated'
        }`,
      );

      const marker = new maplibregl.Marker({ element, anchor: 'bottom' })
        .setLngLat([bathroom.lng, bathroom.lat])
        .setPopup(
          new maplibregl.Popup({ offset: 34, closeButton: true }).setDOMContent(
            popupContent(bathroom, navigate),
          ),
        )
        .addTo(map);

      if (onPinClick) element.addEventListener('click', () => onPinClick(bathroom));
      // Keyboard parity: Enter/Space opens the popup a mouse click would.
      element.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          marker.togglePopup();
        }
      });

      markersRef.current.push(marker);
    }

    return () => {
      for (const marker of markersRef.current) marker.remove();
      markersRef.current = [];
    };
  }, [bathrooms, onPinClick, navigate]);

  // --- Picker pin: create, move, and keep draggable. -------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectable) return;

    if (!selected) {
      pickMarkerRef.current?.remove();
      pickMarkerRef.current = null;
      return;
    }

    if (!pickMarkerRef.current) {
      const marker = new maplibregl.Marker({
        element: placePinElement(),
        anchor: 'bottom',
        draggable: true,
      })
        .setLngLat([selected.lng, selected.lat])
        .addTo(map);

      marker.on('dragend', () => {
        const { lat, lng } = marker.getLngLat();
        onSelectRef.current?.(lat, lng);
      });
      pickMarkerRef.current = marker;
    } else {
      pickMarkerRef.current.setLngLat([selected.lng, selected.lat]);
    }
  }, [selectable, selected]);

  // --- Fit the viewport to every pin. ---------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fit || selectable || bathrooms.length === 0) return;

    if (bathrooms.length === 1) {
      map.easeTo({ center: [bathrooms[0].lng, bathrooms[0].lat], zoom: 15 });
      return;
    }

    const bounds = new maplibregl.LngLatBounds();
    for (const b of bathrooms) bounds.extend([b.lng, b.lat]);
    map.fitBounds(bounds, { padding: 56, maxZoom: 16, duration: 0 });
  }, [bathrooms, fit, selectable]);

  return (
    <div className={className ?? 'h-full w-full'} style={{ position: 'relative' }}>
      <div ref={containerRef} className="h-full w-full" />
      {!hasBasemap && (
        <p className="absolute bottom-2 left-2 z-10 rounded bg-surface/90 px-2 py-1 text-xs text-muted">
          No basemap configured — showing locations only.
        </p>
      )}
    </div>
  );
}
