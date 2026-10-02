import { createApp } from './app.js';
const port = Number(process.env.PORT || 3001);
const app = createApp({dataDir:process.env.CAMPUS_DATA_DIR});
const server = app.listen(port, '0.0.0.0', () => console.log(`CampusLink API ready on port ${port}`));
let shuttingDown=false;
function shutdown() { if(shuttingDown)return;shuttingDown=true;server.close(()=>{app.locals.close();process.exit(0);});app.locals.endStreams(); }
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);
