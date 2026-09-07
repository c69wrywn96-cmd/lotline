import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  // Conformance packs, uploads and rendering all stay in ap-southeast-2
  // (ADR-0025). Nothing here may introduce an offshore egress path.
  poweredByHeader: false,
  serverExternalPackages: ['pg'],
};

export default config;
