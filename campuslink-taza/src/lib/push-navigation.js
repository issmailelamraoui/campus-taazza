const KEY='campuslink-prototype-v1:pending-push';
const valid=value=>typeof value==='string'&&/^[1-9]\d{0,14}$/.test(value)&&Number.isSafeInteger(Number(value));
export function capturePushNavigation(location=window.location) {
  if(location.pathname!=='/app/notifications')return;
  const id=new URLSearchParams(location.search).get('push');
  if(valid(id))try{sessionStorage.setItem(KEY,JSON.stringify({id,at:Date.now()}));}catch{}
}
export function pendingPushNavigation() {
  try{const value=JSON.parse(sessionStorage.getItem(KEY));if(valid(value?.id)&&Date.now()-value.at<30*60*1000)return value.id;}catch{}
  return null;
}
export function clearPushNavigation() {try{sessionStorage.removeItem(KEY);}catch{}}
