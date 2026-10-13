import {strToU8,zipSync} from 'fflate';

const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relationships='http://schemas.openxmlformats.org/package/2006/relationships';
const office='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export function spreadsheetParts({sheetCount=2,external=false,formula=true,truncated=false}={}){
 const parts={
  '[Content_Types].xml':`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
  '_rels/.rels':`<Relationships xmlns="${relationships}"><Relationship Id="office" Type="${office}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  'xl/workbook.xml':`<workbook xmlns="${ns}" xmlns:r="${office}"><sheets>${Array.from({length:sheetCount},(_,index)=>`<sheet name="${index?'Bilan '+(index+1):'Notes'}" sheetId="${index+1}" r:id="sheet${index+1}"/>`).join('')}</sheets></workbook>`,
  'xl/_rels/workbook.xml.rels':`<Relationships xmlns="${relationships}">${Array.from({length:sheetCount},(_,index)=>`<Relationship Id="sheet${index+1}" Type="${office}/worksheet" Target="worksheets/sheet${index+1}.xml"/>`).join('')}<Relationship Id="shared" Type="${office}/sharedStrings" Target="sharedStrings.xml"/>${external?`<Relationship Id="evil" Type="${office}/hyperlink" Target="https://example.invalid/file" TargetMode="External"/>`:''}</Relationships>`,
  'xl/sharedStrings.xml':`<sst xmlns="${ns}"><si><t>Étudiant</t></si><si><r><t>Algèbre </t></r><r><t>linéaire</t></r><rPh><t>Ignore phonetics</t></rPh></si><si><t>&lt;script&gt;window.xlsxExecuted=true&lt;/script&gt;</t></si></sst>`,
 };
 for(let index=0;index<sheetCount;index++)parts[`xl/worksheets/sheet${index+1}.xml`]=index===0?`<worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Note</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>18</v></c><c r="C2" t="b"><v>1</v></c>${formula?'<c r="D2"><f>1+2</f><v>3</v></c><c r="E2"><f>HYPERLINK("javascript:window.xlsxExecuted=true")</f></c>':''}</row><row r="3"><c r="A3" t="s"><v>2</v></c></row>${truncated?'<row r="500"><c r="CV500"><v>last shown</v></c><c r="CW500"><v>hidden column</v></c></row><row r="501"><c r="A501"><v>hidden row</v></c></row>':''}</sheetData></worksheet>`:`<worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Bilan ${index+1}</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>`;
 return parts;
}
export function spreadsheetZip(parts=spreadsheetParts(),options={level:6}){return zipSync(Object.fromEntries(Object.entries(parts).map(([name,value])=>[name,typeof value==='string'?strToU8(value):value])),options);}
