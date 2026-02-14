/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Incluir data/eval en el bundle de las serverless functions (Vercel no lo incluye por defecto)
  experimental: {
    outputFileTracingIncludes: {
      '/api/prompt-optimize': ['./data/eval/**'],
    },
  },
}

module.exports = nextConfig
