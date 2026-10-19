import { defineConfig } from 'vite';
import { labsWorkerPolicy, pythonFramePolicy } from './shared/labs-security.js';
import { configureApiProxy } from './scripts/dev-api-proxy.js';
const runtimeHeaders=()=>({
 name:'campus-labs-worker-policy',
 configureServer(server){server.middlewares.use(workerPolicy);},
 configurePreviewServer(server){server.middlewares.use(workerPolicy);},
});
function workerPolicy(req,res,next){
 const path=req.url?.split('?')[0];
 if(path?.startsWith('/labs-runtime/')){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('X-Content-Type-Options','nosniff');
  const origin=new URL(`http://${req.headers.host}`).origin;
  if(path==='/labs-runtime/runner.js')res.setHeader('Content-Security-Policy',labsWorkerPolicy(origin));
  if(path==='/labs-runtime/python-frame.html')res.setHeader('Content-Security-Policy',pythonFramePolicy(origin));
 }
 next();
}
export default defineConfig({
 plugins:[runtimeHeaders()],
 define:{'import.meta.env.CAMPUS_ANALYTICS_ENABLED':JSON.stringify(process.env.CAMPUS_WEB_ANALYTICS===undefined?process.env.VERCEL==='1':process.env.CAMPUS_WEB_ANALYTICS==='1')},
 esbuild:{jsx:'automatic'},
 server:{port:Number(process.env.CAMPUS_WEB_PORT||5180),strictPort:true,proxy:{'/api':{target:process.env.CAMPUS_API_TARGET||'http://127.0.0.1:3001',changeOrigin:false,configure:configureApiProxy}}},
 build:{sourcemap:true},
});
