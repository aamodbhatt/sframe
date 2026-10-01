import {compiledVerifierPlugin} from './scripts/compiled-verifier-plugin.mjs';
import {defineConfig} from 'vitest/config';
export default defineConfig({plugins: [compiledVerifierPlugin()], test: {environment: 'node', include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'apps/**/*.test.ts'], reporters: ['default']}});
