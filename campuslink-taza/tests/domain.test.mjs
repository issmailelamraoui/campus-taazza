import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDemoPdf,matchesScope,normalizeSearch} from '../src/utils.js';
import {getFilieres,filiereBelongsToFaculty,getChatSemester,SEMESTER_CHAT_GROUPS} from '../src/data/studies.js';
import {translations} from '../src/i18n.js';

test('student content is restricted to their faculty and assigned programme',()=>{
 const selection={facultyId:'flaa',filiereId:'french_studies'};
 assert.equal(matchesScope({facultyId:'flaa',filiereId:'french_studies'},selection),true);
 assert.equal(matchesScope({facultyId:'flaa',filiereId:null},selection),true);
 assert.equal(matchesScope({facultyId:'flaa',filiereId:'arabic_studies'},selection),false);
 assert.equal(matchesScope({facultyId:'feg',filiereId:'economics'},selection),false);
 assert.equal(matchesScope({facultyId:'flaa'},null),false);
});
test('academic associations preserve the existing four faculty structures',()=>{
 assert.equal(getFilieres('fsa').length,8);assert.equal(getFilieres('flaa').length,4);
 assert.equal(getFilieres('feg').length,2);assert.equal(getFilieres('fsjp').length,3);
 assert.equal(filiereBelongsToFaculty('flaa','french_studies'),true);
 assert.equal(filiereBelongsToFaculty('flaa','information_systems'),false);
 assert.deepEqual(getFilieres('unknown'),[]);
 assert.deepEqual(SEMESTER_CHAT_GROUPS.flatMap(x=>x.semesters),[1,2,3,4,5,6]);
 assert.equal(getChatSemester(6),5);assert.equal(getChatSemester('S2'),1);
});
test('generated local PDF contains valid cross-reference offsets and escaped content',()=>{
 const pdf=makeDemoPdf('Méthodologie (partie 1) \\ exemple','Linguistique');
 assert.ok(pdf.startsWith('%PDF-1.4\n'));assert.ok(pdf.endsWith('%%EOF\n'));
 const xref=Number(pdf.match(/startxref\n(\d+)/)[1]);assert.ok(pdf.slice(xref).startsWith('xref'));
 const rows=pdf.slice(xref).split('\n').slice(3,8);
 rows.forEach((row,index)=>assert.ok(pdf.slice(Number(row.slice(0,10))).startsWith(`${index+1} 0 obj`)));
 const stream=pdf.match(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/);
 assert.equal(stream[2].length,Number(stream[1]));assert.match(pdf,/Methodologie/);assert.match(pdf,/\\\(partie 1\\\)/);
});
test('global search matches accent-independent queries and Arabic text',()=>{
 assert.equal(normalizeSearch('  MÉTHODOLOGIE  '),'methodologie');
 assert.ok(normalizeSearch('الإعلانات الجامعية').includes(normalizeSearch('الجامعية')));
});
test('all interface translation keys exist in French, English, and Arabic',()=>{
 for(const language of ['en','ar'])assert.deepEqual(Object.keys(translations[language]).sort(),Object.keys(translations.fr).sort());
});
