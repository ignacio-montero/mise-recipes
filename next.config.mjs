/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output traces only the files the server actually needs, keeping
  // the runtime image small for the 8 GB N95 box. Same trick as Blue Plaques.
  output: "standalone",
  // instrumentation.ts is how the in-process import worker is started exactly
  // once per server process (see docs/ARCHITECTURE.md §2).
  serverExternalPackages: ["@prisma/client", "sharp"],
  // One build worker. Parallel workers each take their own heap, which is what
  // pushes a QEMU cross-build past a small VM's memory ceiling (see Dockerfile).
  experimental: { cpus: 1, workerThreads: false },
};
export default nextConfig;
