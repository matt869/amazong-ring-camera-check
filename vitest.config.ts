import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Same "@/..." imports as the app (tsconfig paths), so route handlers can be tested directly.
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
});
