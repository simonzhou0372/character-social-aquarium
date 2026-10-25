import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  test: {
    maxWorkers: 4,
    minWorkers: 1,
    include: ['tests/*.test.ts'],
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
  },
});
