/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@erp/db", "@erp/shared", "@erp/validation"],
};

module.exports = nextConfig;
