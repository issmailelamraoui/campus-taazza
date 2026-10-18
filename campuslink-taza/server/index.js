import './env.js';
import { createApp } from './app.js';
import {schemaReadinessDiagnostic} from './schema-readiness.js';
const port = Number(process.env.PORT || 3001);
let app;
try {app=await createApp({schema:process.env.CAMPUS_DB_SCHEMA,migrate:false,seed:false});}
catch(error){console.error(schemaReadinessDiagnostic(error));process.exit(1);}
const server = app.listen(port, '0.0.0.0', () => console.log(`CampusLink API ready on port ${port}`));
let shuttingDown=false;
function shutdown() { if(shuttingDown)return;shuttingDown=true;server.close(async()=>{await app.locals.close();process.exit(0);});app.locals.endStreams(); }
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);
