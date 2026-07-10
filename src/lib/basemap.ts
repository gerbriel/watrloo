import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';
import type { StyleSpecification } from 'maplibre-gl';

/**
 * The basemap is a single static .pmtiles archive plus its font/sprite assets,
 * both served from storage we control. Nothing here calls a third-party tile
 * API: MapLibre fetches byte ranges out of the archive over plain HTTP.
 *
 * Both URLs are optional. With neither set the app still runs — the map falls
 * back to plain pins on a flat background — so a fresh clone works without any
 * basemap infrastructure. See docs/BASEMAP.md.
 */
const BASEMAP_URL = import.meta.env.VITE_BASEMAP_URL as string | undefined;
const ASSETS_URL = import.meta.env.VITE_BASEMAP_ASSETS_URL as string | undefined;

/** True when a real basemap is configured; false means degraded-but-working. */
export const hasBasemap = Boolean(BASEMAP_URL && ASSETS_URL);

export type MapTheme = 'light' | 'dark';

let protocolRegistered = false;

/** Teach MapLibre the `pmtiles://` scheme. Safe to call repeatedly. */
export function registerPmtilesProtocol(): void {
  if (protocolRegistered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  protocolRegistered = true;
}

/** Resolve the theme the map should paint in: explicit choice, else the OS. */
export function currentMapTheme(): MapTheme {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light' || attr === 'dark') return attr;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Watch both signals that can change the map's theme: the OS preference and the
 * `data-theme` attribute our toggle stamps on `<html>`. Returns an unsubscribe.
 */
export function onMapThemeChange(cb: (theme: MapTheme) => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const emit = () => cb(currentMapTheme());

  media.addEventListener('change', emit);
  const observer = new MutationObserver(emit);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  return () => {
    media.removeEventListener('change', emit);
    observer.disconnect();
  };
}

/** No basemap configured: a flat background. Pins still render on top. */
function fallbackStyle(theme: MapTheme): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': theme === 'dark' ? '#1a2531' : '#eaf1f6' },
      },
    ],
  };
}

/**
 * OpenStreetMap data is ODbL — attribution is a license condition, not a nicety.
 * MapLibre surfaces `attribution` from the source in its AttributionControl.
 */
const ATTRIBUTION =
  '<a href="https://protomaps.com" target="_blank" rel="noreferrer">Protomaps</a> © <a href="https://openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';

export function buildMapStyle(theme: MapTheme): StyleSpecification {
  if (!hasBasemap) return fallbackStyle(theme);

  return {
    version: 8,
    // Glyphs and sprites are self-hosted alongside the archive. Pointing these
    // at protomaps.github.io would quietly reintroduce a third-party dependency.
    glyphs: `${ASSETS_URL}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSETS_URL}/sprites/v4/${theme}`,
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${BASEMAP_URL}`,
        attribution: ATTRIBUTION,
      },
    },
    layers: layers('protomaps', namedFlavor(theme), { lang: 'en' }),
  };
}
