import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash}from'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat}from'node:fs/promises';
import {tmpdir}from'node:os';
import {join}from'node:path';
import {canonical,digest}from'../src/core.mjs';
import {verifyDeliveryInputs,selectDeliveryInput,materializeDeliveryInput}from'../src/delivery-input.mjs';
function fixture(){
 const keys=generateKeyPairSync('ed25519'),bytes=Buffer.from('Actual provider release readback, not a verdict');
 const issue={id:'I_1',repository:'owner/repo',scopeHash:digest('original')},current={...issue,scopeHash:digest('current')};
 const grant={recordId:'grant',manifest:{issues:[issue]},policy:{controlMode:'owner-project'}};
 const payload={schemaVersion:1,kind:'owner-delivery-input',grantRecordId:grant.recordId,manifestHash:digest(grant.manifest),policyHash:digest(grant.policy),issueId:issue.id,repository:issue.repository,scopeSource:'github-issue',scopeHash:current.scopeHash,shapeHash:null,purpose:'Exact current Scope supplemental release data',files:[{name:'publication.json',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
 const signed=p=>({payload:p,signature:sign(null,Buffer.from(canonical(p)),keys.privateKey).toString('base64')});
 return{grant,issue,current,payload,signed,key:keys.publicKey.export({type:'spki',format:'pem'}),bytes};
}
test('current Scope data is available before Shape and to later independent roles, never a stale Scope',()=>{
 const f=fixture(),records=verifyDeliveryInputs([f.signed(f.payload)],f.grant,f.key);
 assert.equal(selectDeliveryInput(records,f.current)?.scopeHash,f.current.scopeHash);
 assert.equal(selectDeliveryInput(records,f.current,digest('new Shape'))?.shapeHash,null);
 assert.equal(selectDeliveryInput(records,f.issue),null);
 assert.equal(selectDeliveryInput(records,{...f.current,id:'I_other'}),null);
 const tampered=f.signed(f.payload);tampered.payload={...f.payload,scopeHash:f.issue.scopeHash};
 assert.throws(()=>verifyDeliveryInputs([tampered],f.grant,f.key));
 for(const change of[p=>({...p,shapeHash:digest('pretend Shape')}),p=>({...p,manifestHash:digest('foreign')})])assert.throws(()=>verifyDeliveryInputs([f.signed(change(f.payload))],f.grant,f.key));
 const nonOwner={...f.grant,policy:{controlMode:'other'}};
 assert.throws(()=>verifyDeliveryInputs([f.signed({...f.payload,policyHash:digest(nonOwner.policy)})],nonOwner,f.key));
});
test('legacy exact-Shape input remains unavailable before Shape and cannot cross requirements',()=>{
 const f=fixture(),p={...f.payload,scopeHash:f.issue.scopeHash,shapeHash:digest('approved Shape')};delete p.scopeSource;
 const records=verifyDeliveryInputs([f.signed(p)],f.grant,f.key);
 assert.equal(selectDeliveryInput(records,f.issue),null);
 assert.equal(selectDeliveryInput(records,f.issue,p.shapeHash)?.shapeHash,p.shapeHash);
 assert.equal(selectDeliveryInput(records,f.current,p.shapeHash),null);
 assert.throws(()=>selectDeliveryInput(records,f.issue,digest('different Shape')));
});
test('Scope supplemental data retains exact bytes and binding in its read-only mount receipt',async t=>{
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'nibfin-scope-inputs-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const [record]=verifyDeliveryInputs([f.signed(f.payload)],f.grant,f.key);
 await mkdir(join(root,'delivery-input-blobs'));await writeFile(join(root,'delivery-input-blobs',record.files[0].sha256),f.bytes);
 const mounted=await materializeDeliveryInput(root,'execution',record);
 assert.equal(mounted.receipt.scopeHash,f.current.scopeHash);assert.equal(mounted.receipt.scopeSource,'github-issue');
 assert.deepEqual(await readFile(join(mounted.directory,'publication.json')),f.bytes);
 assert.equal((await stat(join(mounted.directory,'publication.json'))).mode&0o222,0);
});
