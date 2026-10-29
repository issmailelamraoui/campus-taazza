export function selectionBounds(anchors) {
 const values=(anchors||[]).filter(r=>r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.width>0&&r.height>0);
 if(!values.length)return null;
 const x=Math.max(0,Math.min(...values.map(r=>r.x))),y=Math.max(0,Math.min(...values.map(r=>r.y)));
 const right=Math.min(1,Math.max(...values.map(r=>r.x+r.width))),bottom=Math.min(1,Math.max(...values.map(r=>r.y+r.height)));
 return right>x&&bottom>y?{x,y,width:right-x,height:bottom-y}:null;
}
export function hasMathematicalLayout(anchors,text='') {
 const rects=(anchors||[]).filter(r=>r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.width>0&&r.height>0);
 if(rects.length<2||!(/[\p{Sm}\p{N}\u0370-\u03ff]/u.test(text)||/(?:^|\s)[A-Za-z](?:\s|$)/.test(text)))return false;
 const heights=rects.map(r=>r.height);if(Math.max(...heights)>Math.min(...heights)*1.18)return true;
 const compactMath=/[\p{Sm}\u0370-\u03ff]/u.test(text)||text.length<80&&!/[A-Za-z]{4}/.test(text);
 if(!compactMath)return false;
 return rects.some((a,index)=>rects.slice(index+1).some(b=>{
  const overlap=Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x),dy=Math.abs((a.y+a.height/2)-(b.y+b.height/2));
  return overlap>Math.min(a.width,b.width)*.6&&dy>Math.min(a.height,b.height)*.35&&dy<Math.max(a.height,b.height)*1.8;
 }));
}
// Capture the actual painted page, not HTML fonts or reconstructed formulae.
// PNG preserves thin mathematical strokes; a bounded high-quality JPEG is the
// fallback for photographic pages. Never silently drop a required visual copy.
export function capturePDFRegion(original,anchors,{createCanvas=()=>document.createElement('canvas')}={}) {
 const rect=selectionBounds(anchors),width=original?.naturalWidth||original?.width,height=original?.naturalHeight||original?.height;
 if(!rect||!width||!height)throw new Error('PDF_CAPTURE_UNAVAILABLE');
 const x=Math.max(0,Math.floor(rect.x*width)-3),y=Math.max(0,Math.floor(rect.y*height)-3);
 const w=Math.min(width-x,Math.ceil(rect.width*width)+6),h=Math.min(height-y,Math.ceil(rect.height*height)+6);
 const scale=Math.min(1,1600/w,Math.sqrt(2400000/(w*h)));
 for(const factor of [1,.8,.65]) {
  const canvas=createCanvas();canvas.width=Math.max(1,Math.round(w*scale*factor));canvas.height=Math.max(1,Math.round(h*scale*factor));
  const context=canvas.getContext('2d');if(!context)throw new Error('PDF_CAPTURE_UNAVAILABLE');
  context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
  context.drawImage(original,x,y,w,h,0,0,canvas.width,canvas.height);
  for(const [type,quality]of [['image/png',undefined],['image/jpeg',.92]]) {
   const value=canvas.toDataURL(type,quality);if(value.startsWith('data:image/')&&value.length<=350000)return value;
  }
 }
 throw new Error('PDF_CAPTURE_TOO_LARGE');
}
