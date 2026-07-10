/// <reference types="vite/client" />

// Fontsource ships CSS-only packages with no type declarations; these
// side-effect imports load the self-hosted @font-face rules. Vite bundles the
// CSS at build time — this just satisfies the typechecker.
declare module '@fontsource-variable/inter';
declare module '@fontsource-variable/space-grotesk';
