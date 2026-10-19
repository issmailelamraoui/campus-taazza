// randomUUID is restricted to secure contexts. LAN development can still use
// getRandomValues to produce a genuine UUID rather than a timestamp identifier.
export function requestId() {
 const source=globalThis.crypto;
 if(typeof source?.randomUUID==='function')return source.randomUUID();
 const bytes=new Uint8Array(16);
 if(typeof source?.getRandomValues!=='function')throw new Error('Le navigateur ne peut pas créer un identifiant sécurisé.');
 source.getRandomValues(bytes);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
