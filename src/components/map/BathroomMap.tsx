import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import type { LatLngExpression, LatLngTuple, LeafletMouseEvent } from 'leaflet';
import { useEffect, useMemo } from 'react';
import {
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import { Link } from 'react-router-dom';
import type { BathroomWithStats } from '@/types/db';
import { Stars } from '@/components/ui/Stars';

// Geographic center of the contiguous US — a neutral default when we have
// nothing to anchor on (empty map / fresh "add a bathroom" picker).
const DEFAULT_CENTER: LatLngTuple = [39.8283, -98.5795];
const DEFAULT_ZOOM = 4;

/**
 * Rating → pin color. Meaning is never carried by color alone: the pin also
 * prints the numeric rating, and the Marker carries a descriptive `title`.
 */
function pinColor(avg: number | null): string {
  if (avg == null) return '#547b9b'; // porcelain-500 — unrated
  if (avg >= 4) return '#16a34a'; // green-600
  if (avg >= 3) return '#f5a524'; // star
  if (avg >= 2) return '#f97316'; // orange-500
  return '#dc2626'; // red-600
}

function teardrop(color: string, inner: string): L.DivIcon {
  const html = `
    <svg width="30" height="40" viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg"
         style="filter: drop-shadow(0 2px 2px rgba(0,0,0,0.35))">
      <path d="M15 1C7.3 1 1 7.3 1 15c0 9.6 14 24 14 24s14-14.4 14-24C29 7.3 22.7 1 15 1Z"
            fill="${color}" stroke="#ffffff" stroke-width="1.5" />
      ${inner}
    </svg>`;
  return L.divIcon({
    html,
    className: 'watrloo-pin',
    iconSize: [30, 40],
    iconAnchor: [15, 40],
    popupAnchor: [0, -38],
  });
}

function ratingIcon(avg: number | null): L.DivIcon {
  const color = pinColor(avg);
  const label = avg == null ? '·' : avg.toFixed(1);
  const inner = `
    <circle cx="15" cy="15" r="8.5" fill="#ffffff" />
    <text x="15" y="15.5" text-anchor="middle" dominant-baseline="central"
          font-family="ui-sans-serif, system-ui, sans-serif"
          font-size="8.5" font-weight="700" fill="${color}">${label}</text>`;
  return teardrop(color, inner);
}

function placeIcon(): L.DivIcon {
  return teardrop('#0284c7', '<circle cx="15" cy="15" r="4.5" fill="#ffffff" />');
}

/** Fit the viewport to all pins whenever the set of coordinates changes. */
function FitBounds({ points }: { points: LatLngTuple[] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView(points[0], 15);
    } else {
      map.fitBounds(points, { padding: [48, 48] });
    }
  }, [map, points]);
  return null;
}

/** Recompute size after mount so the map paints correctly inside flex/grid. */
function ResizeFix() {
  const map = useMap();
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 0);
    return () => clearTimeout(t);
  }, [map]);
  return null;
}

function ClickToPlace({ onSelect }: { onSelect: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e: LeafletMouseEvent) {
      onSelect(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

export interface BathroomMapProps {
  bathrooms: BathroomWithStats[];
  center?: LatLngExpression;
  zoom?: number;
  /** Fire when a rating pin is clicked (the Popup opens regardless). */
  onPinClick?: (bathroom: BathroomWithStats) => void;
  /** Fit the view to all pins after they load (read-only map page). */
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
  const points = useMemo<LatLngTuple[]>(
    () => bathrooms.map((b) => [b.lat, b.lng]),
    [bathrooms],
  );

  const initialCenter: LatLngExpression =
    center ?? (selected ? [selected.lat, selected.lng] : points[0]) ?? DEFAULT_CENTER;
  const initialZoom = zoom ?? (selected ? 15 : DEFAULT_ZOOM);

  return (
    <>
      <MapContainer
        center={initialCenter}
        zoom={initialZoom}
        scrollWheelZoom
        className={className ?? 'h-full w-full'}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ResizeFix />
        {fit && !selectable && <FitBounds points={points} />}

        {bathrooms.map((b) => (
          <Marker
            key={b.id}
            position={[b.lat, b.lng]}
            icon={ratingIcon(b.stats.avg_rating)}
            title={`${b.name} — ${
              b.stats.review_count > 0 && b.stats.avg_rating != null
                ? `${b.stats.avg_rating.toFixed(1)} stars`
                : 'not yet rated'
            }`}
            eventHandlers={onPinClick ? { click: () => onPinClick(b) } : undefined}
          >
            <Popup>
              <div className="flex flex-col gap-1">
                <span className="font-semibold text-porcelain-950">{b.name}</span>
                {b.stats.review_count > 0 && b.stats.avg_rating != null ? (
                  <span className="flex items-center gap-1.5">
                    <Stars value={b.stats.avg_rating} size={14} />
                    <span className="text-xs text-porcelain-700">
                      {b.stats.avg_rating.toFixed(1)} ({b.stats.review_count})
                    </span>
                  </span>
                ) : (
                  <span className="text-xs text-porcelain-600">No reviews yet</span>
                )}
                <Link
                  to={`/bathrooms/${b.id}`}
                  className="text-xs font-medium text-flush-600 hover:underline"
                >
                  View details →
                </Link>
              </div>
            </Popup>
          </Marker>
        ))}

        {selectable && onSelect && <ClickToPlace onSelect={onSelect} />}
        {selectable && selected && (
          <Marker
            position={[selected.lat, selected.lng]}
            icon={placeIcon()}
            draggable
            title="Bathroom location — drag to adjust"
            eventHandlers={
              onSelect
                ? {
                    dragend(e) {
                      const p = (e.target as L.Marker).getLatLng();
                      onSelect(p.lat, p.lng);
                    },
                  }
                : undefined
            }
          />
        )}
      </MapContainer>
    </>
  );
}
