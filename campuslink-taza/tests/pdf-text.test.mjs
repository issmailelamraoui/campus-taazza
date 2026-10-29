import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessPDFText,PDF_TEXT_EXTRACTION_OPTIONS} from '../shared/pdf-text.js';

test('valid mathematical Unicode is preserved without compatibility normalization or guessed substitutions',()=>{
 const text='α β θ λ μ σ Ω Ω µ ∈ ∉ ⊂ ∪ ∩ ∅ ℝ ℕ ℤ ℚ P(A ∩ B) ∫₀¹ f(x) dx ∑ᵢ₌₁ⁿ xᵢ √x x² ≤ ∞ 𝔼[X]';
 const result=assessPDFText(text);assert.equal(result.text,text);assert.equal(result.reliable,true);assert.equal(result.hasMath,true);assert.deepEqual(result.issues,[]);assert.deepEqual(PDF_TEXT_EXTRACTION_OPTIONS,{disableNormalization:true});
});
test('French, Arabic, other real scripts, diacritics, ligatures and directional controls are never guessed to be corrupt',()=>{
 for(const text of ['Probabilité et statistiques : échantillon, œ, ﬁ.','الاحتمالُ P(A) و النهايات ∞','አማርኛ தமிழ் বাংলা हिन्दी','a\u0301\n\tمرحبا\r\n\u200f','🎓 𝒳'])assert.equal(assessPDFText(text).reliable,true,text);
});
test('bad Unicode, private glyph slots and glyph-code controls are unsafe without being silently removed',()=>{
 for(const [text,issue]of [['x\ufffdy','replacement-character'],['x\u0003y','control-characters'],['x\u0087y','control-characters'],['\ue000','private-use'],['\u{f0000}','private-use'],['\u{100000}','private-use'],['\ud800','invalid-unicode'],['\udc00','invalid-unicode'],['\ufdd0','invalid-unicode'],['\u{10ffff}','invalid-unicode']]){
  const result=assessPDFText(text);assert.equal(result.reliable,false);assert.equal(result.text,text);assert.ok(result.issues.includes(issue));
 }
});
test('one proven broken mapping taints that font across a page and can be reused for selected spans',()=>{
 const content={items:[{str:'Une phrase fiable',fontName:'normal',hasEOL:true},{str:'\u001bଵǡ ǥ ǡ \u001b୬',fontName:'math'},{str:'a',fontName:'math'}]};
 const page=assessPDFText(content);assert.equal(page.reliable,false);assert.deepEqual(page.unreliableFonts,['math']);assert.equal(page.text,'Une phrase fiable\n\u001bଵǡ ǥ ǡ \u001b୬a');
 assert.equal(assessPDFText(content.items[2],{unreliableFonts:page.unreliableFonts}).reliable,false);
 assert.equal(assessPDFText(content.items[0],{unreliableFonts:page.unreliableFonts}).reliable,true);
});
test('font names alone do not reject a valid PDF.js Symbol mapping; explicit unmapped composite evidence does',()=>{
 const content={items:[{str:'α ∩ Ω',fontName:'f'}],styles:{f:{fontFamily:'Symbol'}}};
 assert.equal(assessPDFText(content).reliable,true);
 assert.equal(assessPDFText(content,{fonts:{f:{name:'Cambria Math',composite:true,hasToUnicode:false,encoding:'Identity-H'}}}).reliable,false);
 assert.equal(assessPDFText(content,{fonts:new Map([['f',{unicodeReliable:false}]])}).reliable,false);
 assert.equal(assessPDFText({items:[{str:'日本語',fontName:'f'}]},{fonts:{f:{composite:true,hasToUnicode:false,encoding:'UniJIS-UCS2-H'}}}).reliable,true,'A known CMap may recover Unicode without a separate ToUnicode stream.');
});
