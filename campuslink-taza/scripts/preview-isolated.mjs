// Review the production frontend with the real API and disposable metadata.
// Identity and file storage are test doubles: no provider accounts or R2 writes.
import {createTestApp} from '../tests/backend-helpers.mjs';
const port=Number(process.env.CAMPUS_ISOLATED_PORT||5180);
const environment=await createTestApp({appOrigin:`http://localhost:${port}`});
const server=environment.app.listen(port,'127.0.0.1');
let stopping=false;
async function stop(){if(stopping)return;stopping=true;environment.app.locals.endStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await environment.close();}
server.on('listening',()=>console.log(`CampusLink isolated preview: http://localhost:${port}\nSynthetic accounts: admin / Admin2026! or yassine / Campus2026!\nTemporary PostgreSQL schema; identity and file storage remain isolated.`));
server.on('error',async error=>{console.error(error.code||'Preview failed');await stop();process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop().then(()=>process.exit(0)).catch(()=>process.exit(1)));
