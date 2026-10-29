import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {extractPdfText,indexDocument,installDocumentSearchRoutes} from '../server/document-search.js';
import {mathematicalPDFFixture,MATH_PDF_LINES} from './fixtures/pdf-math-fixtures.mjs';
// Compact text-layer fixtures exercise authoritative /ToUnicode handling.
// The representative embedded-font visual fixtures are tested separately.
function mappedPdf(values){
 const mappings=values.map((value,index)=>`<${(65+index).toString(16).padStart(2,'0')}> <${[...value].map(c=>{const code=c.codePointAt(0);if(code<=0xffff)return code.toString(16).padStart(4,'0');const n=code-0x10000;return (0xd800+(n>>10)).toString(16)+(0xdc00+(n&1023)).toString(16);}).join('')}>`).join('\n');
 const cmap=`/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Fixture) /Ordering (Unicode) /Supplement 0 >> def /CMapName /Fixture def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange ${values.length} beginbfchar\n${mappings}\nendbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
 const stream=`BT /F1 12 Tf 50 700 Td (${values.map((_,i)=>String.fromCharCode(65+i)).join('')}) Tj ET`;
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,`<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`];
 let pdf='%PDF-1.4\n';const offsets=[0];for(const [index,object]of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;}
 const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(pdf);
}
test('embedded-font probability fixtures preserve mapped symbols and quarantine broken mappings',async()=>{
 const valid=await extractPdfText(mathematicalPDFFixture());
 assert.deepEqual(valid.unreliablePages,[]);assert.equal(valid.status,'ready');
 const text=valid.pages.map(page=>page.text).join('\n');for(const line of MATH_PDF_LINES)assert.ok(text.includes(line),line);
 const invalid=await extractPdfText(mathematicalPDFFixture({unreliable:true}));assert.deepEqual(invalid.unreliablePages,[1]);assert.deepEqual(invalid.pages,[]);
});
test('server extraction preserves mathematical ToUnicode mappings and distinguishes unsafe pages',async()=>{
 const expression=['α','β','θ','λ','μ','σ','Ω','∈','∉','⊂','∪','∩','∅','ℝ','ℕ','ℤ','ℚ','∫','∑','√','²','₁','≤','𝔼'];
 const valid=await extractPdfText(mappedPdf(expression));assert.equal(valid.status,'ready');assert.deepEqual(valid.unreliablePages,[]);
 assert.equal(valid.pages[0].text.replace(/\s+/g,''),expression.join(''));
 for(const corrupted of ['\ufffd','\ue05a','\u0003','\u0087']){
  const unsafe=await extractPdfText(mappedPdf(['A',corrupted,'B']));assert.deepEqual(unsafe.unreliablePages,[1]);assert.deepEqual(unsafe.pages,[]);assert.equal(unsafe.textBytes,0);
 }
});
test('unsafe explicit indexing rejects honestly before a transaction or index write',async()=>{
 const data=mappedPdf(['x','\u0003','y']),resource={id:1,version:1,mime:'application/pdf',filename:'probability.pdf',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),object_key:'isolated-test.pdf'};
 let transactions=0,reauthorizations=0;
 const db={prepare(sql){assert.match(sql,/SELECT i\.\*/);return{get:async()=>undefined};},transaction(){transactions++;throw Error('No write is allowed for unreliable text');}};
 await assert.rejects(indexDocument(resource,{db,storage:{get:async()=>({contentLength:data.length,body:Readable.from(data)})},assertCurrent:async()=>{reauthorizations++;return resource;}}),error=>error.status===422&&error.code==='PDF_TEXT_UNRELIABLE');
 assert.equal(transactions,0);assert.equal(reauthorizations,0);
});
test('historical unsafe snippets are hidden without rewriting old indexes or leaking foreign matches',async()=>{
 const routes=new Map(),safe={id:1,version:1,mime:'application/pdf',title:'Probability',filename:'course.pdf',module:'Statistics',semester:3,sha256:'a'.repeat(64)};
 const rows=[{resource_id:1,document_version:1,page:1,text:'analyse of P(A ∩ B)',source_sha256:safe.sha256},{resource_id:1,document_version:1,page:2,text:'analyse \u0087\u0d4c',source_sha256:safe.sha256},{resource_id:2,document_version:1,page:3,text:'analyse \ue000',source_sha256:safe.sha256}];
 const db={prepare(sql){assert.match(sql,/SELECT p\.resource_id/);return{all:async()=>rows};}};
 installDocumentSearchRoutes({get:(path,...handlers)=>routes.set(path,handlers.at(-1)),post(){}},{db,requireFaculty(){},assertResource:async id=>{if(id!==1)throw Object.assign(Error('Private'),{status:403});return safe;},storage:{}});
 let response;const res={set(){return this;},json(value){response=value;return this;}};
 await routes.get('/api/document-search')({query:{q:'analyse'},user:{faculty_id:'fsa'}},res);
 assert.equal(response.matches.length,1);assert.equal(response.matches[0].page,1);assert.equal(response.unreliableTextSkipped,1);assert.match(response.matches[0].excerpt,/P\(A ∩ B\)/);
});
