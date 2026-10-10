import './env.js';
import { createApp } from './app.js';
const port = Number(process.env.PORT || 3001);
let app;
try {app=await createApp({schema:process.env.CAMPUS_DB_SCHEMA,migrate:process.env.CAMPUS_DB_MIGRATE!=='false',seed:process.env.CAMPUS_DB_SEED!=='false'});}
catch {console.error('CampusLink API startup failed. Check server configuration and database availability.');process.exit(1);}
const server = app.listen(port, '0.0.0.0', () => console.log(`CampusLink API ready on port ${port}`));
let shuttingDown=false;
function shutdown() { if(shuttingDown)return;shuttingDown=true;server.close(async()=>{await app.locals.close();process.exit(0);});app.locals.endStreams(); }
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);
