import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GitHub } from '../src/github.mjs';
const source={repository:'owner/private',path:'grant.json',ref:'main'};
function fixture(){const bytes=Buffer.from(JSON.stringify({text:'x'.repeat(1100000)}));const sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');const descriptor={type:'file',encoding:'none',content:'',sha,size:bytes.length};const blob={sha,size:bytes.length,encoding:'base64',content:bytes.toString('base64')};const g=new GitHub();const paths=[];g.api=async p=>{paths.push(p);return p.includes('/contents/')?descriptor:blob;};return{g,bytes,descriptor,blob,paths};}
test('large authority reads the exact same-repository Git blob and preserves signed JSON',async()=>{const f=fixture();assert.equal(await f.g.text(source),f.bytes.toString());assert.deepEqual(f.paths,[`/repos/owner/private/contents/grant.json?ref=main`,`/repos/owner/private/git/blobs/${f.descriptor.sha}`]);});
for(const [name,change] of Object.entries({sha:f=>f.blob.sha='a'.repeat(40),size:f=>f.blob.size++,bytes:f=>f.blob.content=Buffer.alloc(f.bytes.length,120).toString('base64'),encoding:f=>f.blob.encoding='none',malformed:f=>f.blob.content='!invalid',oversized:f=>f.descriptor.size=4*1024*1024+1,descriptor:f=>f.descriptor.content='unexpected'}))test(`large authority rejects ${name} drift`,async()=>{const f=fixture();change(f);await assert.rejects(()=>f.g.text(source));});
test('small inline authority uses its existing single authenticated read',async()=>{const f=fixture();f.descriptor.encoding='base64';f.descriptor.content=Buffer.from('original').toString('base64');assert.equal(await f.g.text(source),'original');assert.equal(f.paths.length,1);});
