import {existsSync} from 'node:fs';
export function browserOptions(){const candidate=process.env.CAMPUS_CHROMIUM||'/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';return {headless:true,args:['--no-sandbox'],...(existsSync(candidate)?{executablePath:candidate}:{})};}
