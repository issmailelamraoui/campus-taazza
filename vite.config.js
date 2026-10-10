import { defineConfig } from 'vite';
export default defineConfig({ esbuild: { jsx: 'automatic' }, server: { port: 5180, strictPort: true, proxy: { '/api': { target: process.env.CAMPUS_API_TARGET || 'http://127.0.0.1:3001', changeOrigin: false } } }, build: { sourcemap: true } });
