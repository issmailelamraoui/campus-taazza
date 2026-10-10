// Create an actual small PDF in the browser, without a document service.
export function makeDemoPdf(title,moduleName='') {
 const ascii=s=>String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7E]/g,'-').replace(/[\\()]/g,'\\$&');
 const lines=['CampusLink Taza - Document de demonstration',title,moduleName,'','Ce PDF illustre la consultation et le telechargement local.','Il ne constitue pas un cours officiel de l universite.','','1. Relire les notions essentielles de ce module.','2. Relever les questions a poser a votre enseignant.','3. Echanger avec les etudiants dans le Chat de filiere.'];
 const content='BT /F1 12 Tf 50 780 Td '+lines.map((line,i)=>`${i?'0 -28 Td ':''}(${ascii(line).slice(0,95)}) Tj`).join(' ')+' ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
 let pdf='%PDF-1.4\n';const offsets=[];objects.forEach((obj,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;});const xref=pdf.length;
 pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return pdf;
}
export function matchesScope(item,selection){return Boolean(selection&&item.facultyId===selection.facultyId&&(!item.filiereId||item.filiereId===selection.filiereId));}
export const normalizeSearch=text=>String(text).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
