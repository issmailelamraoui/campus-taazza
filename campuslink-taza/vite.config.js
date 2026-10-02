import { defineConfig } from 'vite';
export default defineConfig({server:{port:5173,proxy:{'/api':{target:process.env.CAMPUS_API_TARGET||'http://127.0.0.1:3001',changeOrigin:false}}},build:{sourcemap:true}});
