import {extname} from 'node:path';
export const EDUCATIONAL_EXTENSIONS=new Set('.pdf .png .jpg .jpeg .webp .gif .doc .docx .ppt .pptx .xls .xlsx .odt .ods .odp .txt .md .rtf .tex .py .ipynb .c .cpp .h .hpp .js .jsx .ts .tsx .html .css .xml .svg .json .csv .sql .java .zip .rar .7z .tar .gz'.split(' '));
const failure=()=>{throw Object.assign(new Error('Fichier non pris en charge ou contenu invalide.'),{status:400});};
export function detectFile(buffer,filename) {
  const extension=extname(filename).toLowerCase(),magic=buffer.subarray(0,12);
  if(!EDUCATIONAL_EXTENSIONS.has(extension)||!buffer.length)return failure();
  if(extension==='.pdf')return magic.subarray(0,5).toString()==='%PDF-'?'application/pdf':failure();
  if(['.jpg','.jpeg'].includes(extension))return magic[0]===255&&magic[1]===216&&magic[2]===255?'image/jpeg':failure();
  if(extension==='.png')return magic.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':failure();
  if(extension==='.gif')return /^GIF8[79]a/.test(magic.toString())?'image/gif':failure();
  if(extension==='.webp')return magic.subarray(0,4).toString()==='RIFF'&&magic.subarray(8,12).toString()==='WEBP'?'image/webp':failure();
  const legacy={'.doc':'application/msword','.xls':'application/vnd.ms-excel','.ppt':'application/vnd.ms-powerpoint'};
  if(legacy[extension])return magic.subarray(0,8).equals(Buffer.from([208,207,17,224,161,177,26,225]))?legacy[extension]:failure();
  const zip=magic[0]===80&&magic[1]===75&&[[3,4],[5,6],[7,8]].some(([a,b])=>magic[2]===a&&magic[3]===b);
  const office={'.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.odt':'application/vnd.oasis.opendocument.text','.ods':'application/vnd.oasis.opendocument.spreadsheet','.odp':'application/vnd.oasis.opendocument.presentation'};
  if(office[extension])return zip?office[extension]:failure();
  if(extension==='.zip')return zip?'application/zip':failure();
  if(extension==='.rar')return magic.subarray(0,6).equals(Buffer.from([82,97,114,33,26,7]))?'application/vnd.rar':failure();
  if(extension==='.7z')return magic.subarray(0,6).equals(Buffer.from([55,122,188,175,39,28]))?'application/x-7z-compressed':failure();
  if(extension==='.gz')return magic[0]===31&&magic[1]===139?'application/gzip':failure();
  if(extension==='.tar')return buffer.length>=512&&buffer.subarray(257,262).toString()==='ustar'?'application/x-tar':failure();
  if(buffer.includes(0))return failure();
  try{new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{return failure();}
  return 'text/plain'; // Uploaded code and markup are inert text, never executed.
}
export function mayInlineFile(mime,filename) {
  const extension=extname(filename || '').toLowerCase();
  return mime==='application/pdf'&&extension==='.pdf'||['image/png','image/jpeg','image/gif','image/webp'].includes(mime)&&['.png','.jpg','.jpeg','.gif','.webp'].includes(extension);
}
