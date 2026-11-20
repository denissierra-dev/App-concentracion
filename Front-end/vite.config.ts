import { URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'none'",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const PREVIEW_CSP_HEADER = `${PRODUCTION_CSP}; frame-ancestors 'none'`;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const;

function resolveProxyTarget(rawTarget: string | undefined): string {
  const candidate = rawTarget?.trim() || 'http://localhost:3001';
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid API proxy protocol: ${parsed.protocol}`);
  }
  return parsed.origin;
}

/**
 * Injects the strict Content-Security-Policy meta tag only into production builds
 * so Vite HMR remains functional during `vite dev` while production HTML is locked down.
 */
function strictProductionCspPlugin(): Plugin {
  return {
    name: 'deep-work-strict-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const cspTag = `    <meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />\n`;
      return html.replace('    <title>', `${cspTag}    <title>`);
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), react(), strictProductionCspPlugin()],
  server: {
    port: 5173,
    strictPort: true,
    headers: {
      ...SECURITY_HEADERS,
    },
    proxy: {
      '/api': {
        target: resolveProxyTarget(process.env.VITE_API_PROXY_TARGET),
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Security-Policy': PREVIEW_CSP_HEADER,
    },
    proxy: {
      '/api': {
        target: resolveProxyTarget(process.env.VITE_API_PROXY_TARGET),
        changeOrigin: true,
      },
    },
  },
});
