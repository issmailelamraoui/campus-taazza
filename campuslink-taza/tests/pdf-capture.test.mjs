import {test} from 'node:test';
import assert from 'node:assert/strict';
import {capturePDFRegion,selectionBounds,hasMathematicalLayout} from '../src/lib/pdf-capture.js';
import {pdfAssetOptions} from '../src/lib/pdf-options.js';
import {referenceText} from '../src/lib/reading.js';
test('selection bounds preserve multiline/fraction geometry and stay on the source page',()=>{
 assert.deepEqual(selectionBounds([{x:.1,y:.2,width:.3,height:.05},{x:.15,y:.3,width:.2,height:.08}]),{x:.1,y:.2,width:.30000000000000004,height:.18});
 assert.equal(selectionBounds([]),null);assert.equal(selectionBounds([{x:2,y:2,width:1,height:1}]),null);
});
test('superscripts, stacked fractions and indices use a visual clipboard instead of an ambiguous flattened formula',()=>{
 assert.equal(hasMathematicalLayout([{x:0,y:0,width:40,height:12}],'α β ℝ'),false);
 assert.equal(hasMathematicalLayout([{x:0,y:4,width:10,height:12},{x:10,y:0,width:6,height:7}],'x2'),true);
 assert.equal(hasMathematicalLayout([{x:3,y:0,width:12,height:10},{x:3,y:13,width:12,height:10}],'1 2'),true);
 assert.equal(hasMathematicalLayout([{x:0,y:0,width:120,height:12},{x:0,y:18,width:120,height:12}],'An ordinary French paragraph'),false);
});
test('visual capture uses original canvas pixels and lossless PNG for small mathematical regions',()=>{
 const source={width:2000,height:3000},draws=[],canvas={getContext:()=>({fillRect(){},drawImage:(...args)=>draws.push(args)}),toDataURL:type=>type==='image/png'?'data:image/png;base64,YQ==':''};
 const image=capturePDFRegion(source,[{x:.1,y:.2,width:.4,height:.1}],{createCanvas:()=>canvas});
 assert.equal(image,'data:image/png;base64,YQ==');assert.equal(draws.length,1);assert.equal(draws[0][0],source);
 assert.ok(canvas.width>=800&&canvas.height>=300,'Superscripts and fraction lines are not downscaled needlessly');
 assert.ok(draws[0][1]<=200&&draws[0][2]<=600,'Small padding protects ink at the text selection boundary');
});
test('photographic/oversized captures have a bounded fallback and never silently lose the image',()=>{
 let encodes=0;const canvas={getContext:()=>({fillRect(){},drawImage(){}}),toDataURL:type=>{encodes++;return type==='image/jpeg'?'data:image/jpeg;base64,YQ==':'x'.repeat(350001);}};
 assert.match(capturePDFRegion({width:4000,height:5000},[{x:0,y:0,width:1,height:1}],{createCanvas:()=>canvas}),/^data:image\/jpeg/);assert.equal(encodes,2);
 let attempts=0;assert.throws(()=>capturePDFRegion({width:4000,height:5000},[{x:0,y:0,width:1,height:1}],{createCanvas:()=>{attempts++;return {...canvas,toDataURL:()=> 'x'.repeat(350001)};}}),/PDF_CAPTURE_TOO_LARGE/);assert.equal(attempts,3);
 assert.throws(()=>capturePDFRegion(null,[]),/PDF_CAPTURE_UNAVAILABLE/);
});
test('font/mapping/decoder assets remain local, pinned and slash terminated',()=>{
 const options=pdfAssetOptions('6.4.299');for(const key of ['cMapUrl','standardFontDataUrl','wasmUrl','iccUrl'])assert.match(options[key],/^\/pdfjs-assets\/6\.4\.299\/[a-z_]+\/$/);
 assert.equal(options.cMapPacked,true);assert.throws(()=>pdfAssetOptions('../api/private'));
});
test('reference export preserves reliable Unicode and safely links legacy unreadable excerpts without rewriting them',()=>{
 const math='α β θ λ μ σ Ω ∈ ∉ ⊂ ∪ ∩ ∅ ℝ ℕ ℤ ℚ P(A ∩ B) ∫ Σ √ x² xₙ';
 assert.ok(referenceText({selectedText:math,source:{title:'Maths'},resourceId:1,page:2,version:3}).includes(math));
 const old={selectedText:'\u001bଵ\uFFFD',content:'\uE000',source:{title:'Legacy'},resourceId:1,page:2,version:3},before=JSON.stringify(old);
 const exported=referenceText(old,(fr,en)=>en);assert.ok(!exported.includes('\u001b'));assert.match(exported,/verify in the PDF/);assert.match(exported,/document=1&page=2&version=3/);assert.equal(JSON.stringify(old),before);
});
