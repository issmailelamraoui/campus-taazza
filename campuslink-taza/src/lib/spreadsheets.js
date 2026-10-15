import {AsyncInflate} from 'fflate';

export const SPREADSHEET_LIMITS=Object.freeze({fileBytes:5*1024*1024,entryBytes:4*1024*1024,totalBytes:32*1024*1024,entries:1000,sheets:20,rows:500,columns:100,previewCharacters:1024*1024});
const invalid=message=>new Error(message||'Ce classeur ne permet pas un aperçu sûr. Téléchargez l’original.');
const aborted=()=>new DOMException('Lecture annulée.','AbortError');
const utf8=new TextDecoder('utf-8',{fatal:true});
function safeName(name){if(!name||name.length>512||/^[\/\\]|\\|[\u0000-\u001f]|^[A-Za-z]:/.test(name)||name.split('/').some(part=>part==='..'||part==='.'||part===''))throw invalid('Le classeur contient un chemin de fichier invalide.');return name;}
function unsafePart(name){return/(?:^|\/)(?:vbaProject|vbaData)\.(?:bin|xml)$/i.test(name)||/^xl\/(?:activeX|embeddings|macrosheets)\//i.test(name)||/\.(?:exe|dll|js|vbs|ps1|bat|com)$/i.test(name);}
export function inspectZipArchive(input){
 const bytes=input instanceof Uint8Array?input:new Uint8Array(input);if(bytes.length>SPREADSHEET_LIMITS.fileBytes)throw invalid('Aperçu XLSX limité aux fichiers de 5 Mo.');if(bytes.length<22)throw invalid('Classeur XLSX incomplet.');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),u16=offset=>view.getUint16(offset,true),u32=offset=>view.getUint32(offset,true);let end=-1;
 for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65557);offset--){if(u32(offset)===0x06054b50&&offset+22+u16(offset+20)===bytes.length){end=offset;break;}}
 if(end<0||u16(end+4)||u16(end+6)||u16(end+8)!==u16(end+10)||u16(end+10)===65535)throw invalid('Archive XLSX non prise en charge.');
 const count=u16(end+10),size=u32(end+12),start=u32(end+16);if(!count||count>SPREADSHEET_LIMITS.entries||start+size!==end||start<0)throw invalid('Le classeur contient trop de fichiers ou une archive invalide.');
 const names=new Set(),offsets=new Set(),entries=[];let cursor=start,total=0;
 for(let index=0;index<count;index++){
  if(cursor+46>end||u32(cursor)!==0x02014b50)throw invalid('Archive XLSX endommagée.');
  const flags=u16(cursor+8),method=u16(cursor+10),crc=u32(cursor+16),compressed=u32(cursor+20),original=u32(cursor+24),nameLength=u16(cursor+28),extraLength=u16(cursor+30),commentLength=u16(cursor+32),disk=u16(cursor+34),localOffset=u32(cursor+42),next=cursor+46+nameLength+extraLength+commentLength;
  if(next>end||disk||flags&1||flags&0x40||![0,8].includes(method)||original>SPREADSHEET_LIMITS.entryBytes||compressed===0xffffffff||original===0xffffffff||localOffset===0xffffffff)throw invalid('Entrée compressée trop grande, chiffrée ou non prise en charge.');
  let rawName;try{rawName=utf8.decode(bytes.subarray(cursor+46,cursor+46+nameLength));}catch{throw invalid('Nom de fichier XLSX illisible.');}
  // Empty ZIP directory entries are harmless and unnecessary to extract.
  const directory=rawName.endsWith('/'),name=safeName(directory?rawName.slice(0,-1):rawName);if(names.has(name)||offsets.has(localOffset)||unsafePart(name))throw invalid('Le classeur contient des doublons ou du contenu actif non pris en charge.');names.add(name);offsets.add(localOffset);
  total+=original;if(total>SPREADSHEET_LIMITS.totalBytes)throw invalid('Le contenu décompressé dépasse la limite de 32 Mo.');
  if(localOffset+30>start||u32(localOffset)!==0x04034b50||u16(localOffset+6)!==flags||u16(localOffset+8)!==method)throw invalid('Archive XLSX endommagée.');
  const localNameLength=u16(localOffset+26),localExtraLength=u16(localOffset+28),dataOffset=localOffset+30+localNameLength+localExtraLength;
  if(dataOffset+compressed>start||localNameLength!==nameLength)throw invalid('Archive XLSX endommagée.');
  for(let i=0;i<nameLength;i++)if(bytes[localOffset+30+i]!==bytes[cursor+46+i])throw invalid('Nom de fichier XLSX incohérent.');
  if(!(flags&8)&&(u32(localOffset+14)!==crc||u32(localOffset+18)!==compressed||u32(localOffset+22)!==original))throw invalid('Taille du fichier XLSX incohérente.');
  if(directory&&(original||compressed))throw invalid('Répertoire XLSX invalide.');
  entries.push({name,method,crc,compressed,original,dataOffset,localOffset,directory});cursor=next;
 }
 if(cursor!==end)throw invalid('Archive XLSX endommagée.');
 const sorted=[...entries].sort((a,b)=>a.localOffset-b.localOffset);for(let i=1;i<sorted.length;i++)if(sorted[i-1].dataOffset+sorted[i-1].compressed>sorted[i].localOffset)throw invalid('Les entrées XLSX se chevauchent.');
 return{bytes,entries,totalBytes:total};
}
const crcTable=Uint32Array.from({length:256},(_,index)=>{let value=index;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const value of bytes)crc=crcTable[(crc^value)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;}
async function inflateEntry(bytes,entry,signal){
 if(signal?.aborted)throw aborted();const compressed=bytes.subarray(entry.dataOffset,entry.dataOffset+entry.compressed);
 if(entry.method===0){if(entry.compressed!==entry.original)throw invalid('Taille XLSX incohérente.');const output=compressed.slice();if(crc32(output)!==entry.crc)throw invalid('Le classeur est endommagé.');return output;}
 if(!compressed.length)throw invalid('Entrée XLSX incomplète.');
 return new Promise((resolve,reject)=>{
  let offset=0,total=0,finished=false;const chunks=[];
  const cleanup=()=>signal?.removeEventListener('abort',cancel);
  const fail=error=>{if(finished)return;finished=true;stream.terminate();cleanup();reject(error);};
  const cancel=()=>fail(aborted());
  const stream=new AsyncInflate((error,chunk,final)=>{
   if(finished)return;if(error){fail(invalid('Compression XLSX endommagée.'));return;}total+=chunk.length;
   if(total>entry.original||total>SPREADSHEET_LIMITS.entryBytes){fail(invalid('La taille décompressée du classeur dépasse la limite.'));return;}chunks.push(chunk);
   if(final){if(total!==entry.original){fail(invalid('Taille XLSX incohérente.'));return;}const output=new Uint8Array(total);let cursor=0;for(const part of chunks){output.set(part,cursor);cursor+=part.length;}if(crc32(output)!==entry.crc){fail(invalid('Le classeur est endommagé.'));return;}finished=true;stream.terminate();cleanup();resolve(output);}
   else queueMicrotask(push);
  });
  // One small compressed chunk at a time bounds output even if ZIP metadata lies.
  function push(){if(finished)return;const next=Math.min(offset+512,compressed.length);try{stream.push(compressed.slice(offset,next),next===compressed.length);offset=next;}catch(error){fail(error);}}
  signal?.addEventListener('abort',cancel,{once:true});push();
 });
}
function decodeXml(bytes){let xml;try{if(bytes[0]===255&&bytes[1]===254)xml=new TextDecoder('utf-16le',{fatal:true}).decode(bytes);else if(bytes[0]===254&&bytes[1]===255)xml=new TextDecoder('utf-16be',{fatal:true}).decode(bytes);else xml=utf8.decode(bytes);}catch{throw invalid('Texte XML du classeur illisible.');}if(/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))throw invalid('Les définitions XML externes ne sont pas autorisées.');return xml.replace(/^\uFEFF/,'');}
export async function extractSpreadsheetXml(input,{signal}={}){
 const{bytes,entries}=inspectZipArchive(input),xml=new Map();for(const entry of entries){if(signal?.aborted)throw aborted();if(entry.directory||!/(?:\.xml|\.rels)$/i.test(entry.name))continue;xml.set(entry.name,decodeXml(await inflateEntry(bytes,entry,signal)));}return xml;
}
export function columnLabel(index){let label='',value=index+1;while(value>0){value--;label=String.fromCharCode(65+value%26)+label;value=Math.floor(value/26);}return label;}
export function cellAddress(value){const match=/^([A-Z]{1,3})([1-9]\d{0,6})$/i.exec(value||'');if(!match)throw invalid('Référence de cellule invalide.');let column=0;for(const char of match[1].toUpperCase())column=column*26+char.charCodeAt(0)-64;const row=Number(match[2]);if(column>16384||row>1048576)throw invalid('Référence de cellule hors limites.');return{row:row-1,column:column-1};}
function xmlDocument(value){if(typeof DOMParser==='undefined')throw invalid('Ce navigateur ne prend pas en charge la lecture des classeurs.');if(!value)throw invalid('Un fichier du classeur est manquant.');if((value.match(/</g)||[]).length>150000)throw invalid('La structure du classeur est trop complexe pour un aperçu.');const doc=new DOMParser().parseFromString(value,'application/xml');if(doc.getElementsByTagNameNS('*','parsererror').length)throw invalid('Le classeur contient un XML endommagé.');return doc;}
const elements=(node,name)=>Array.from(node.getElementsByTagNameNS('*',name));
const child=(node,name)=>Array.from(node.children||[]).find(value=>value.localName===name);
function partPath(source,target){let decoded;try{decoded=decodeURIComponent(target);}catch{throw invalid('Référence de fichier XLSX invalide.');}if(!decoded||/^[A-Za-z][A-Za-z0-9+.-]*:|^\/\/|\\|[\u0000-\u001f?#]/.test(decoded))throw invalid('Les références externes ne sont pas autorisées.');const parts=decoded.startsWith('/')?[]:source.split('/').slice(0,-1);for(const part of decoded.replace(/^\//,'').split('/')){if(part==='..'){if(!parts.length)throw invalid('Référence externe au classeur.');parts.pop();}else if(part&&part!=='.')parts.push(part);}return safeName(parts.join('/'));}
function relationshipSource(path){return path==='_rels/.rels'?'':path.replace(/(?:^|\/)_rels\//,'/').replace(/^\//,'').replace(/\.rels$/,'');}
function allRelationships(xml){const relations=new Map();for(const[path,value]of xml){if(!/\.rels$/i.test(path))continue;const document=xmlDocument(value);if(document.documentElement.localName!=='Relationships')throw invalid('Relations XLSX invalides.');const entries=new Map();for(const relation of elements(document,'Relationship')){if(String(relation.getAttribute('TargetMode')||'').toLowerCase()==='external')throw invalid('Les liens externes du classeur empêchent cet aperçu.');const id=relation.getAttribute('Id'),type=relation.getAttribute('Type')||'',target=partPath(relationshipSource(path),relation.getAttribute('Target')||'');if(!id||entries.has(id))throw invalid('Relations XLSX incohérentes.');entries.set(id,{type,target});}relations.set(path,entries);}return relations;}
function textRuns(node){return elements(node,'t').filter(text=>{let parent=text.parentElement;while(parent&&parent!==node){if(parent.localName==='rPh')return false;parent=parent.parentElement;}return true;}).map(text=>text.textContent||'').join('').slice(0,10000);}
function worksheet(xml,sharedStrings){const doc=xmlDocument(xml);if(doc.documentElement.localName!=='worksheet')throw invalid('Cette feuille n’est pas un tableau pris en charge.');const data=elements(doc,'sheetData')[0];if(!data)throw invalid('Les données de la feuille sont manquantes.');const values=new Map();let maximumRow=-1,maximumColumn=-1,lastRow=-1,truncated=false,formulaCount=0,characters=0;
 for(const row of Array.from(data.children)){if(row.localName!=='row')continue;const declared=row.getAttribute('r');let rowIndex=declared?Number(declared)-1:lastRow+1;if(!Number.isSafeInteger(rowIndex)||rowIndex<0||rowIndex>=1048576)throw invalid('Ligne XLSX invalide.');lastRow=rowIndex;let nextColumn=0;
  for(const cell of Array.from(row.children)){if(cell.localName!=='c')continue;const address=cell.getAttribute('r')?cellAddress(cell.getAttribute('r')):{row:rowIndex,column:nextColumn};nextColumn=address.column+1;if(address.row>=SPREADSHEET_LIMITS.rows||address.column>=SPREADSHEET_LIMITS.columns){truncated=true;continue;}const value=child(cell,'v'),formula=child(cell,'f'),type=cell.getAttribute('t');let text='';
   if(formula)formulaCount++;
   if(type==='inlineStr'){const inline=child(cell,'is');text=inline?textRuns(inline):'';}
   else if(type==='s'&&value){const index=Number(value.textContent);if(!Number.isSafeInteger(index)||index<0||index>=sharedStrings.length)throw invalid('Index de texte partagé XLSX invalide.');text=sharedStrings[index];}
   else if(value){text=type==='b'?(value.textContent==='1'?'TRUE':'FALSE'):value.textContent||'';}
   else if(formula)text='='+String(formula.textContent||'');
   if(text.length>10000)text=text.slice(0,10000);if(characters+text.length>SPREADSHEET_LIMITS.previewCharacters){truncated=true;continue;}characters+=text.length;const key=`${address.row}:${address.column}`;if(values.has(key))throw invalid('Le classeur contient des cellules dupliquées.');values.set(key,text);maximumRow=Math.max(maximumRow,address.row);maximumColumn=Math.max(maximumColumn,address.column);
  }
 }
 const rows=Array.from({length:maximumRow+1},(_,row)=>Array.from({length:maximumColumn+1},(_,column)=>values.get(`${row}:${column}`)||''));return{rows,columns:maximumColumn+1,truncated,formulaCount};
}
export async function parseXlsx(input,{signal}={}){
 const xml=await extractSpreadsheetXml(input,{signal});if(signal?.aborted)throw aborted();const types=xmlDocument(xml.get('[Content_Types].xml'));if(types.documentElement.localName!=='Types')throw invalid('Types de contenu XLSX invalides.');if(/macroEnabled|vbaProject|activeX|oleObject/i.test(types.documentElement.textContent+' '+xml.get('[Content_Types].xml')))throw invalid('Les classeurs contenant des macros ou objets actifs ne sont pas pris en charge.');
 const relations=allRelationships(xml),root=relations.get('_rels/.rels'),office=[...(root?.values()||[])].find(value=>/\/officeDocument$/.test(value.type)),workbookPath=office?.target||'xl/workbook.xml',workbook=xmlDocument(xml.get(workbookPath));if(workbook.documentElement.localName!=='workbook')throw invalid('Structure de classeur XLSX invalide.');
 const base=workbookPath.split('/'),file=base.pop(),relPath=[...base,'_rels',file+'.rels'].join('/'),workbookRelations=relations.get(relPath);if(!workbookRelations)throw invalid('Les feuilles du classeur sont introuvables.');
 const sharedRelation=[...workbookRelations.values()].find(value=>/\/sharedStrings$/.test(value.type)),sharedPath=sharedRelation?.target||'xl/sharedStrings.xml',sharedStrings=xml.has(sharedPath)?elements(xmlDocument(xml.get(sharedPath)),'si').map(textRuns):[];
 const definitions=elements(workbook,'sheet');if(!definitions.length||definitions.length>SPREADSHEET_LIMITS.sheets)throw invalid('Aperçu limité aux classeurs de 20 feuilles.');const seen=new Set(),sheets=[];
 for(const sheet of definitions){if(signal?.aborted)throw aborted();const name=String(sheet.getAttribute('name')||'').slice(0,180),id=Array.from(sheet.attributes).find(attr=>attr.localName==='id')?.value,relation=workbookRelations.get(id);if(!name||seen.has(id)||!relation)throw invalid('Référence de feuille XLSX invalide.');seen.add(id);if(!/\/worksheet$/.test(relation.type))throw invalid('Les feuilles de graphiques ou macros ne sont pas prises en charge.');sheets.push({name,id,...worksheet(xml.get(relation.target),sharedStrings)});await new Promise(resolve=>setTimeout(resolve,0));}
 if(signal?.aborted)throw aborted();return{sheets,limits:SPREADSHEET_LIMITS};
}
export async function fetchSpreadsheet(url,{signal}={}){const response=await fetch(url,{signal,credentials:'same-origin'});if(!response.ok)throw invalid('Le classeur est indisponible.');if(Number(response.headers.get('content-length'))>SPREADSHEET_LIMITS.fileBytes)throw invalid('Aperçu XLSX limité aux fichiers de 5 Mo.');const reader=response.body?.getReader();if(!reader){const buffer=await response.arrayBuffer();if(buffer.byteLength>SPREADSHEET_LIMITS.fileBytes)throw invalid('Aperçu XLSX limité aux fichiers de 5 Mo.');return parseXlsx(new Uint8Array(buffer),{signal});}const parts=[];let total=0;try{for(;;){const{value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>SPREADSHEET_LIMITS.fileBytes){await reader.cancel();throw invalid('Aperçu XLSX limité aux fichiers de 5 Mo.');}parts.push(value);}}finally{reader.releaseLock();}const bytes=new Uint8Array(total);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return parseXlsx(bytes,{signal});}
