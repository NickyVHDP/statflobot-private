/** @type {import('next').NextConfig} */
const nextConfig = {
  // The stripe webhook handler needs the raw body
  async headers() {
    return [
      {
        source: '/api/webhooks/stripe',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
      },
    ];
  },
};

export default nextConfig;
