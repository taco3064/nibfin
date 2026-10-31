import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hookConfigurationAreas, parseCandidateObligations as parse, reconcileCandidateObligations as reconcile,
  validateHookObservation, validateCandidateFiles as files} from '../src/index.mjs';
const artifact = {path:'out/core.tgz', purpose:'Required distribution'};
const hook = (path, event) => ({path,event});
const body = (artifacts = [artifact], hooks = [], prose = 'Candidate hooks applicability: No applicable configured hooks.') =>
  `${prose}\n\`\`\`nibfin-candidate\n${JSON.stringify({artifacts,hooks})}\n\`\`\``;
const observation = (hooks = []) => ({areas:hookConfigurationAreas.map(area => ({area,status:'resolved',
  evidenceReference:`fixture:${area}`,detail:'Reviewed full configuration and effective settings'})),
  hooks:hooks.map(item => ({...item,evidenceReference:`fixture:${item.path}`,applicability:'Configured supported event',prerequisites:[]}))});
const evidence = (hooks = []) => ({scopeEvidenceReference:'fixture:frozen-scope',
  requiredArtifacts:[{...artifact,evidenceReference:'fixture:scope-artifact'}],hookObservation:observation(hooks)});

test('inventory cardinality, fences, JSON and strict schema', () => {
  assert.equal(parse(body()).ok,true);
  assert.equal(parse(body([artifact],[], 'Hooks is empty because repository configuration has no applicable hooks.')).ok,true);
  for (const invalid of ['', body()+'\n'+body(), body().slice(0,-3), '```nibfin-candidate\n{\n```',
    '````markdown\n'+body()+'\n````', body().split('\n').map(line => '    '+line).join('\n'),
    '> '+body().replaceAll('\n','\n> ')]) assert.equal(parse(invalid).ok,false,invalid);
  for (const value of [null, [], {}, {artifacts:[],hooks:[],extra:1}, {artifacts:{},hooks:[]},
    {artifacts:[],hooks:'x'}, {artifacts:[{path:'a'}],hooks:[]},
    {artifacts:[{path:'a',purpose:' '}],hooks:[]}, {artifacts:[{...artifact,extra:1}],hooks:[]},
    {artifacts:[],hooks:[{path:'h',event:'post-commit'}]}, {artifacts:[],hooks:[{path:'h',event:2}]}]) {
    assert.equal(parse('```nibfin-candidate\n'+JSON.stringify(value)+'\n```').ok,false);
  }
  assert.equal(parse(body().replaceAll('```','~~~')).ok,true);
  assert.equal(parse('```js\nCandidate hooks applicability: hidden\n```\n'+body([artifact],[], '')).ok,false);
});

test('canonical paths and duplicate paths reject; cross-kind reuse allowed', () => {
  for (const path of ['', '../a','a/../b','/tmp/a','C:/a','C:a','//server/a','a\\b','a\n','a\x7f','a//b','./a','a/.','a/']) {
    assert.equal(parse(body([{path,purpose:'p'}])).ok,false,JSON.stringify(path));
  }
  assert.equal(parse(body([artifact,artifact])).ok,false);
  assert.equal(parse(body([artifact],[hook('h','pre-commit'),hook('h','commit-msg')])).ok,false);
  assert.equal(parse(body([artifact],[hook(artifact.path,'pre-commit')])).ok,true);
});

test('Scope reconciliation, independent applicability, empty lists and deferred files', () => {
  const parsed = parse(body());
  assert.equal(reconcile(parsed,evidence()).ok,true);
  assert.equal(reconcile(parsed).ok,false);
  assert.equal(reconcile(parsed,{...evidence(),requiredArtifacts:[]}).ok,false);
  assert.equal(reconcile(parse(body([])),evidence()).ok,false);
  assert.equal(reconcile(parsed,{...evidence(),hookObservation:null}).ok,false);
  const empty = parse(body([],[], 'Candidate artifacts applicability: Scope requires no extra output.\nCandidate hooks applicability: No applicable hooks.'));
  assert.equal(empty.ok,true);
  assert.equal(reconcile(empty,{...evidence(),requiredArtifacts:[]}).ok,true);
  const markdown=parse(body([],[], '`artifacts` is empty because Scope requires tracked Markdown only.\n`hooks` is empty based on the independently inspected repository setup.'));
  assert.equal(markdown.ok,true);assert.equal(reconcile(markdown,{...evidence(),requiredArtifacts:[]}).ok,true);
  assert.equal(reconcile(markdown,{...evidence(),requiredArtifacts:[artifact]}).ok,false,'readable explanations cannot hide a required artifact');
  for (const kind of ['artifacts','hooks']) assert.equal(parse(body([],[],`Candidate ${kind} applicability: reason`)).ok,false);
  assert.equal(parse(body([],[], 'Candidate artifacts applicability: \nCandidate hooks applicability: reason')).ok,false);
});

test('ordered observations cover hooksPath, lifecycle/Husky and workspace-managed sources', () => {
  const configured = [hook('.githooks/pre-commit','pre-commit'),hook('packages/a/check','pre-commit'),
    hook('.husky/prepare-commit-msg','prepare-commit-msg'),hook('packages/b/message','commit-msg')];
  const data = evidence(configured);
  data.hookObservation.areas.find(x => x.area === 'effective-git').detail = 'core.hooksPath=.githooks from explicit effective configuration';
  data.hookObservation.areas.find(x => x.area === 'package-lifecycle').detail = 'package.json prepare configures Husky; setup statically reviewed';
  data.hookObservation.areas.find(x => x.area === 'workspaces').detail = 'All workspace manifests and chained sources reviewed in source order';
  assert.equal(reconcile(parse(body([artifact],configured)),data).ok,true);
  assert.equal(reconcile(parse(body([artifact],configured.map(({path,event}) => ({event,path})))),data).ok,true);
  assert.equal(reconcile(parse(body()),data).ok,false);
  assert.equal(reconcile(parse(body([artifact],configured.slice(1))),data).ok,false);
  assert.equal(reconcile(parse(body([artifact],[configured[1],configured[0],...configured.slice(2)])),data).ok,false);
  assert.equal(parse(body([artifact],[configured[3],configured[0]])).ok,false);
  assert.equal(reconcile(parse(body([artifact],[hook(configured[0].path,'commit-msg')])),data).ok,false);
  for (const area of hookConfigurationAreas) {
    const obs = observation(); obs.areas = obs.areas.filter(x => x.area !== area);
    assert.equal(validateHookObservation(obs).ok,false,area);
  }
  for (const name of ['dynamic shell setup','missing tool','credentials','network','signing','installation','external effects']) {
    const obs = observation(configured);
    obs.hooks[0].prerequisites = [{name,status:'unresolved',evidenceReference:'fixture:restriction'}];
    const check = reconcile(parse(body()),{...evidence(),hookObservation:obs});
    assert.equal(check.ok,false);
    assert.ok(check.diagnostics.some(x => x.code === 'prerequisite' && x.reason.includes(name)));
  }
  const unavailable = observation(); unavailable.areas[0].status = 'unresolved';
  assert.equal(validateHookObservation(unavailable).ok,false);
  const duplicate = observation(); duplicate.areas.push(duplicate.areas[0]);
  assert.equal(validateHookObservation(duplicate).ok,false);
});

test('mandatory ignored artifacts and filesystem boundary checks', () => {
  const root = mkdtempSync(join(tmpdir(),'nibfin-obligations-'));
  const inventory = parse(body()).inventory;
  const options = {root,permittedPaths:['out']};
  try {
    mkdirSync(join(root,'out'));
    writeFileSync(join(root,'.gitignore'),'/out/\n');
    assert.equal(files(inventory,options).ok,false);
    writeFileSync(join(root,artifact.path),'archive');
    assert.equal(files(inventory,options).ok,true);
    writeFileSync(join(root,'.gitignore'),'');
    assert.equal(files(inventory,options).ok,true);
    assert.equal(files(inventory,{root,permittedPaths:['other']}).ok,false);
    assert.equal(files(inventory,{root,permittedPaths:['out/core']} ).ok,false);
    assert.equal(files(inventory,{root,permittedPaths:[]}).ok,false);
    const check = path => files({artifacts:[{path,purpose:'fixture'}],hooks:[]},options).ok;
    assert.equal(check('out'),false);
    symlinkSync(join(root,artifact.path),join(root,'out/link'));
    assert.equal(check('out/link'),false);
    symlinkSync(join(root,'out'),join(root,'linked'));
    assert.equal(files({artifacts:[{path:'linked/core.tgz',purpose:'fixture'}],hooks:[]},{root,permittedPaths:['linked']}).ok,false);
    assert.equal(files(inventory,{root:join(root,'linked'),permittedPaths:['out']}).ok,false);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
