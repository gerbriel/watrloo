// AGENT UNIT — implement per instructions. Preserve this export signature.
// Layer-1 invalid-traffic pre-filter (client side), per
// docs/growth/oss-research/6-ivt.md. If this returns true, the caller simply
// does not send the ad event — cheapest possible filtering.
//
// POSTURE: this is NOT a security control (a determined bot can skip our JS
// entirely) and it must NEVER be used to gate real users out of the product.
// Its only job is to avoid *sending* ad_impression/ad_click analytics events
// for the obviously-automated slice of traffic (WebDriver/CDP tools,
// headless browsers, PhantomJS-style shells) so the ledger stays small. Each
// signal below only fires on a strong, well-known automation fingerprint
// mirrored from fingerprintjs/BotD's detector list (MIT-licensed — see the
// research doc's §1.1/§4). A missing or throwing DOM API is always treated
// as "no signal" (fail user-friendly: bad signal => not a bot), never as
// evidence of anything. Signal #8 from the research doc (Notification
// permission vs. Permissions API contradiction) is async and intentionally
// left out here so this stays a cheap, synchronous, exception-proof check.

/** Runs `check`, swallowing any thrown error as "no signal" so a single
 * flaky/missing DOM API can never make looksLikeBot() throw. */
function safeCheck(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

// Automation globals BotD checks for (PhantomJS, NightmareJS, Selenium,
// CEF/CefSharp, Chromium automation harnesses).
const AUTOMATION_GLOBALS = [
  'callPhantom',
  '_phantom',
  '__nightmare',
  '_selenium',
  'callSelenium',
  '_Selenium_IDE_Recorder',
  'CefSharp',
  'awesomium',
  'domAutomation',
];

function hasWebdriverFlag(): boolean {
  return navigator.webdriver === true; // signal 1
}

function hasHeadlessUaHint(): boolean {
  return /Headless|PhantomJS|Electron|slimerjs/i.test(navigator.userAgent); // signal 2
}

function hasAutomationGlobal(): boolean {
  return AUTOMATION_GLOBALS.some((prop) => prop in window); // signal 3
}

function hasAutomationDomAttribute(): boolean {
  return document.documentElement
    .getAttributeNames()
    .some((attr) => /selenium|webdriver|driver/i.test(attr)); // signal 4
}

function isDesktopChromeUa(): boolean {
  const ua = navigator.userAgent;
  return /Chrome\//.test(ua) && !/Android|Mobile/i.test(ua);
}

function hasEmptyPluginsOnDesktopChrome(): boolean {
  // Real desktop Chrome always exposes >=1 plugin (e.g. the PDF viewer);
  // zero plugins on a UA claiming desktop Chrome is a headless tell.
  return isDesktopChromeUa() && navigator.plugins.length === 0; // signal 5
}

function hasInconsistentLanguages(): boolean {
  return !navigator.languages || navigator.languages.length === 0; // signal 6
}

function hasZeroWindowMetrics(): boolean {
  return window.outerWidth === 0 && window.outerHeight === 0; // signal 7
}

const SIGNAL_CHECKS: ReadonlyArray<{ readonly name: string; readonly check: () => boolean }> = [
  { name: 'webdriver', check: hasWebdriverFlag },
  { name: 'headless-ua', check: hasHeadlessUaHint },
  { name: 'automation-global', check: hasAutomationGlobal },
  { name: 'automation-dom-attribute', check: hasAutomationDomAttribute },
  { name: 'empty-plugins-desktop-chrome', check: hasEmptyPluginsOnDesktopChrome },
  { name: 'inconsistent-languages', check: hasInconsistentLanguages },
  { name: 'zero-window-metrics', check: hasZeroWindowMetrics },
];

function environmentIsBrowserLike(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof document !== 'undefined'
  );
}

// Sync, ~0ms; run once per page load and cache the result.
let cached: boolean | null = null;

export function looksLikeBot(): boolean {
  if (!environmentIsBrowserLike()) return false; // SSR / non-DOM: no signal available, assume human
  if (cached !== null) return cached;
  cached = SIGNAL_CHECKS.some(({ check }) => safeCheck(check));
  return cached;
}

/** Debugging helper — names of every cheap bot signal currently firing.
 * Not on looksLikeBot()'s hot path (always re-evaluates, uncached); safe to
 * call anywhere for diagnostics. */
export function botSignals(): string[] {
  if (!environmentIsBrowserLike()) return [];
  return SIGNAL_CHECKS.filter(({ check }) => safeCheck(check)).map(({ name }) => name);
}
