// Extraction is not OCR: a glyph can render correctly while the PDF omits its
// Unicode mapping. Keep the original Unicode and report evidence of unsafe
// text; never guess a replacement from the glyph's apparent language or shape.
export const PDF_TEXT_EXTRACTION_OPTIONS=Object.freeze({disableNormalization:true});
const mathCharacters=/[\p{Sm}\u0370-\u03ff\u1f00-\u1fff\u2070-\u209f\u2100-\u214f\u00b2\u00b3\u00b9\u00bc-\u00be]/u;

function unicodeIssues(text){
 const issues=new Set();
 for(const character of text){
  const code=character.codePointAt(0);
  if(code===0xfffd)issues.add('replacement-character');
  if(code<=8||code>=0xb&&code<=0xc||code>=0xe&&code<=0x1f||code>=0x7f&&code<=0x9f)issues.add('control-characters');
  if(code>=0xe000&&code<=0xf8ff||code>=0xf0000&&code<=0xffffd||code>=0x100000&&code<=0x10fffd)issues.add('private-use');
  if(code>=0xd800&&code<=0xdfff||code>=0xfdd0&&code<=0xfdef||(code&0xffff)===0xfffe||(code&0xffff)===0xffff)issues.add('invalid-unicode');
 }
 return [...issues];
}
function fontInfo(fonts,name){return fonts instanceof Map?fonts.get(name):fonts?.[name];}
function knownUnmappedFont(font){
 return font?.unicodeReliable===false||font?.hasToUnicode===false&&/Identity-[HV]/i.test(String(font.encoding||''));
}

export function assessPDFText(value,{fonts,unreliableFonts=[]}={}){
 const items=typeof value==='string'?[{str:value}]:Array.isArray(value?.items)?value.items:typeof value?.str==='string'?[value]:[{str:String(value??'')}];
 const issues=new Set(),unsafeFonts=new Set(unreliableFonts),strings=[];
 let hasMath=false;
 for(const item of items){
  if(typeof item?.str!=='string')continue;
  strings.push(item.str+(item.hasEOL?'\n':''));
  const found=unicodeIssues(item.str);for(const issue of found)issues.add(issue);
  if(found.length&&item.fontName)unsafeFonts.add(item.fontName);
  const font=fontInfo(fonts,item.fontName)||fontInfo(value?.styles,item.fontName);
  if(knownUnmappedFont(font)&&item.str.trim()){if(item.fontName)unsafeFonts.add(item.fontName);issues.add('unmapped-font');}
  hasMath ||= mathCharacters.test(item.str)||/math|symbol/i.test(String(font?.name||font?.fontFamily||''));
 }
 for(const item of items)if(item?.str?.trim()&&item.fontName&&unsafeFonts.has(item.fontName))issues.add('unmapped-font');
 return {text:strings.join(''),reliable:issues.size===0,issues:[...issues],hasMath,unreliableFonts:[...unsafeFonts]};
}
