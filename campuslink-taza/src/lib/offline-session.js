const DATABASE='campuslink-offline-session-v1';
const MAX_AGE=24*60*60*1000;
let epoch=0;
function database(){return new Promise((resolve,reject)=>{const request=indexedDB.open(DATABASE,1);request.onupgradeneeded=()=>request.result.createObjectStore('session');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
export async function saveOfflineSession(snapshot){
 const owner=epoch;if(!snapshot?.user||snapshot.user.accountStatus!=='approved'||snapshot.user.mustChangePassword||snapshot.user.must_change_password)return;
 const db=await database();if(owner!==epoch){db.close();return;}
 const transaction=db.transaction('session','readwrite');const minimal={...snapshot,messages:[],notifications:[],announcements:[],channels:[],members:[],events:[],unreadCount:0,offlineSession:true};
 transaction.objectStore('session').put({savedAt:Date.now(),snapshot:minimal},'active');
 await new Promise((resolve,reject)=>{transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);});db.close();
}
export async function loadOfflineSession(){
 const db=await database();const value=await new Promise((resolve,reject)=>{const request=db.transaction('session').objectStore('session').get('active');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});db.close();
 if(!value||Date.now()-value.savedAt>MAX_AGE||value.savedAt>Date.now()||value.snapshot?.user?.accountStatus!=='approved'||value.snapshot.user.mustChangePassword||value.snapshot.user.must_change_password)return null;return value.snapshot;
}
export async function clearOfflineSession(){epoch++;try{const db=await database();const transaction=db.transaction('session','readwrite');transaction.objectStore('session').clear();await new Promise(resolve=>{transaction.oncomplete=resolve;transaction.onerror=resolve;});db.close();}catch{}}
if(typeof window!=='undefined')window.addEventListener('campus-session-cleared',()=>{clearOfflineSession();});
