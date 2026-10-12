/** @type {import('next').NextConfig} */
const nextConfig = {
  // AWS SDK clients are large and Node-only; keep them out of the server bundle.
  serverExternalPackages: ['@aws-sdk/client-sns', '@anthropic-ai/bedrock-sdk', 'ring-client-api'],
};

module.exports = nextConfig;
