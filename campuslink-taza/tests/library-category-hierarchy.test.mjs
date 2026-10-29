import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLibraryModuleFolders, libraryModuleMatches, libraryContributors } from '../src/lib/library-browse.js';
import { resourceFolderOwner, browseResourceDirectory, findResourceConflicts, UNKNOWN_CONTRIBUTOR } from '../src/lib/resources.js';
import { normalizeResource } from '../src/lib/backend.js';
import { resourceCategory } from '../shared/resource-categories.js';
import { suggestOfficialModules, normalizeModuleSearch } from '../src/lib/module-catalog.js';

const scope = { facultyId:'fsa', filiereId:'data_science', semester:5 };
const resource = (id, category, uploaderId, extra={}) => ({...scope,id,moduleId:'12',module:'Probabilités et Statistiques',category,uploaderId,uploader:`Student ${uploaderId}`,path:`${id}.pdf`,...extra});

test('each category generates independent contributor folders and exact file counts', () => {
  const files = [resource(1,'courses','10'),resource(2,'courses','10'),resource(3,'courses','10'),resource(4,'tp','10'),resource(5,'tp','10'),resource(6,'tp','20'),resource(7,'courses','30')];
  assert.deepEqual(libraryContributors(files,'courses').map(item=>[item.id,item.count]),[['10',3],['30',1]]);
  assert.deepEqual(libraryContributors(files,'tp').map(item=>[item.id,item.count]),[['10',2],['20',1]]);
  assert.deepEqual(libraryContributors(files,'td'),[]);
  for (const category of ['courses','tp']) {
    const result=browseResourceDirectory(files,'','10',category);
    assert.equal(result.documents.length,category==='courses'?3:2);
    assert.ok(result.documents.every(item=>item.uploaderId==='10'&&item.category===category));
  }
});

test('user IDs distinguish equal public names and usernames and never use a name as identity', () => {
  const files=[resource(1,'courses','10',{uploader:'Same Name',uploaderUsername:'same'}),resource(2,'courses','20',{uploader:'Same Name',uploaderUsername:'same'})];
  assert.equal(libraryContributors(files,'courses').length,2);
  assert.equal(resourceFolderOwner({uploader:'Same Name',uploaderUsername:'same'}),UNKNOWN_CONTRIBUTOR);
  assert.equal(normalizeResource({id:1,author:{id:42,name:'Public Name'},module_id:12,category:'cours'}).uploaderId,'42');
});

test('ownerless accessible legacy records remain browsable in a reserved unknown-contributor bucket', () => {
  const orphaned=[resource(11,'courses',null,{path:'Legacy/Nested/a.pdf',uploader:'Unverified legacy label'}),resource(12,'courses',null,{path:'Legacy/b.pdf'}),resource(13,'tp',null,{path:'Legacy/Nested/tp.pdf'}),resource(14,'courses','20')];
  const groups=libraryContributors(orphaned,'courses');
  assert.deepEqual(groups.find(item=>item.id===UNKNOWN_CONTRIBUTOR),{id:UNKNOWN_CONTRIBUTOR,name:'',count:2});
  const nested=browseResourceDirectory(orphaned,'Legacy/Nested',UNKNOWN_CONTRIBUTOR,'courses');
  assert.deepEqual(nested.documents.map(item=>item.id),[11]);
  assert.equal(orphaned[0].uploaderId,null,'The navigation token never invents ownership.');
  assert.equal(libraryContributors(orphaned,'tp').find(item=>item.id===UNKNOWN_CONTRIBUTOR).count,1);
});

test('canonical module IDs keep identical labels separate without merging orphaned legacy records', () => {
  const files=[resource(1,'courses','10'),resource(2,'courses','10',{moduleId:'50'}),resource(3,'courses','10',{moduleId:null})];
  const catalog=[{id:12,name:files[0].module,filiere_id:scope.filiereId,semester:5},{id:50,name:files[0].module,filiere_id:scope.filiereId,semester:5}];
  const folders=mergeLibraryModuleFolders(files,catalog,scope);
  assert.equal(folders.length,3);
  assert.deepEqual(folders.find(item=>item.key==='id:12').documents.map(item=>item.id),[1]);
  assert.deepEqual(folders.find(item=>item.key==='id:50').documents.map(item=>item.id),[2]);
  assert.equal(libraryModuleMatches(files[1],'id:12',folders),false);
  assert.equal(libraryModuleMatches(files[0],files[0].module,folders),false);
});

test('moving a file into another semester removes its old folder while preserving other populated modules', () => {
  const first=resource(1,'courses','10'),other=resource(2,'courses','20',{moduleId:'50',module:'Other module'});
  const catalog=[{id:12,name:first.module,faculty_id:'fsa',filiere_id:scope.filiereId,semester:5},
    {id:50,name:other.module,faculty_id:'fsa',filiere_id:scope.filiereId,semester:5},
    {id:13,name:first.module,faculty_id:'fsa',filiere_id:scope.filiereId,semester:3}];
  assert.deepEqual(mergeLibraryModuleFolders([first,other],catalog,scope).map(item=>item.id).sort(),['12','50']);
  const moved={...first,semester:3,moduleId:'13'};
  assert.deepEqual(mergeLibraryModuleFolders([moved,other],catalog,scope).map(item=>item.id),['50']);
  const newFolders=mergeLibraryModuleFolders([moved,other],catalog,{...scope,semester:3});
  assert.deepEqual(newFolders.map(item=>item.id),['13']);
  assert.deepEqual(newFolders[0].documents.map(item=>item.id),[first.id],'Moving the file preserves its resource identity.');
});

test('last-file removal and visibility changes remove virtual module and contributor folders', () => {
  const file=resource(1,'courses','10');
  const catalog=[{id:12,name:file.module,filiere_id:scope.filiereId,semester:5}];
  assert.equal(mergeLibraryModuleFolders([file],catalog,scope).length,1);
  for(const unavailable of [{...file,status:'removed'},{...file,removed:1},{...file,libraryVisible:false},{...file,library_visible:false},{...file,library_visible:0}]) {
    assert.deepEqual(mergeLibraryModuleFolders([unavailable],catalog,scope),[]);
  }
  assert.deepEqual(mergeLibraryModuleFolders([],catalog,scope),[]);
  assert.deepEqual(libraryContributors([{...file,removed:1}],'courses'),[]);
});

test('hiding empty browse folders leaves verified official modules selectable for future uploads', () => {
  const catalog=Object.freeze([Object.freeze({id:12,name:'Probabilités et Statistiques',faculty_id:'fsa',filiere_id:scope.filiereId,semester:5,catalog_status:'official'})]);
  assert.deepEqual(mergeLibraryModuleFolders([],catalog,scope),[]);
  assert.equal(suggestOfficialModules(catalog,'probabilites')[0].id,12);
  assert.equal(catalog[0].catalog_status,'official');
});

test('nested student trees cannot leak another category or uploader and react to visibility changes', () => {
  const files=[resource(1,'courses','10',{path:'Cours/nested/a.pdf'}),resource(2,'tp','10',{path:'Cours/nested/b.pdf'}),resource(3,'courses','20',{path:'Cours/nested/c.pdf'}),resource(4,'courses','10',{libraryVisible:false}),resource(5,'courses','10',{status:'removed'})];
  assert.equal(libraryContributors(files,'courses').find(item=>item.id==='10').count,1);
  const tree=browseResourceDirectory(files.filter(item=>item.libraryVisible!==false),'Cours/nested','10','courses');
  assert.deepEqual(tree.documents.map(item=>item.id),[1]);
  assert.deepEqual(libraryContributors(files.filter(item=>item.id!==1),'courses').map(item=>item.id),['20']);
});

test('legacy category aliases consolidate labels while precise resource type wins', () => {
  for(const category of ['Cours','course','courses'])assert.equal(resourceCategory({category}),'courses');
  assert.equal(resourceCategory({category:'courses',resource_type:'tp'}),'tp');
  assert.equal(resourceCategory({category:'tdtp'}),'tdtp');
  assert.equal(resourceCategory({category:'Cours',resource_type:'document'}),'courses');
  assert.equal(resourceCategory({category:'Annales'}),'annales');
});

test('official suggestions normalize accents and typos without selecting, creating, or conflating numbers', () => {
  const catalog=[{id:1,name:'Analyse numérique',catalog_status:'official'},{id:2,name:'Analyse 1',catalog_status:'official'},{id:3,name:'Analyse 4',catalog_status:'official'},{id:4,name:'analyse nimeriqe',catalog_status:'legacy'}];
  const before=structuredClone(catalog);
  assert.equal(normalizeModuleSearch('  ANALYSE  NUMÉRIQUE  '),'analyse numerique');
  assert.equal(suggestOfficialModules(catalog,'analyse nimeriqe')[0].id,1);
  assert.deepEqual(suggestOfficialModules(catalog,'analyse 1').map(item=>item.id),[2]);
  assert.equal(suggestOfficialModules(catalog,'nouveau module inexistant').length,0);
  assert.deepEqual(catalog,before);
});

test('upload conflicts preserve distinct contributors, canonical modules, and complete nested folders', () => {
  const file=resource(1,'tp','10',{part:'1',academicYear:'2026/2027',path:'TP/part1.pdf'});
  assert.equal(findResourceConflicts([{...file,id:2}],[file]).length,1);
  assert.deepEqual(findResourceConflicts([{...file,id:2,uploaderId:'20'}],[file]),[]);
  assert.deepEqual(findResourceConflicts([{...file,id:2,path:'TP/nested/part1.pdf'}],[file]),[]);
  assert.deepEqual(findResourceConflicts([{...file,id:2,moduleId:'50'}],[file]),[]);
});
