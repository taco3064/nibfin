import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
// Initialize through the supported public entry before instrumenting internals.
import '../src/index.mjs';
import {singleAttemptArtifactClient} from '../src/custody-upload.mjs';

// Narrow official-interface doubles; real SDK serialization is test:artifact-sdk.
test('production SDK composition uses single-shot RPC/blob configuration and stops on ambiguity',async()=>{
  for (const failure of [null,'create','blob','finalize']) {
    const counts={create:0,blob:0,finalize:0};
    const sdk={version:'2.3.2',backend:()=>({workflowRunBackendId:'run',workflowJobRunBackendId:'job'}),
      expiration:days=>{assert.equal(days,1);return 'expiry';},
      specification:(files,root)=>{assert.deepEqual(files,['file']);assert.equal(root,'root');return 'spec';},
      zip:(spec,compression)=>{assert.equal(spec,'spec');assert.equal(compression,6);return Readable.from([Buffer.from('zip')]);},
      rpc:options=>{assert.deepEqual(options,{maxAttempts:1});return {
        CreateArtifact:async r=>{counts.create++;assert.deepEqual(r,{workflowRunBackendId:'run',workflowJobRunBackendId:'job',name:'response',version:4,expiresAt:'expiry'});
          if(failure==='create')throw Error('lost');return {ok:true,signedUploadUrl:'https://storage.invalid/?private'};},
        FinalizeArtifact:async r=>{counts.finalize++;assert.equal(r.size,'3');assert.match(r.hash.value,/^sha256:[a-f0-9]{64}$/);
          if(failure==='finalize')throw Error('lost');return {ok:true,artifactId:'42'};}};},
      BlobClient:class {constructor(url,credential,options){assert.equal(credential,undefined);assert.deepEqual(options,{retryOptions:{maxTries:1}});}
        getBlockBlobClient(){return {uploadData:async(bytes,options)=>{counts.blob++;assert.equal(bytes.toString(),'zip');
          assert.equal(options.maxSingleShotSize,32*1024*1024);if(failure==='blob')throw Error('lost');}};}}
    };
    const call=()=>singleAttemptArtifactClient(sdk).uploadArtifact('response',['file'],'root',{retentionDays:1,compressionLevel:6});
    if(failure)await assert.rejects(call);else assert.equal((await call()).id,'42');
    assert.deepEqual(counts,{create:1,blob:failure==='create'?0:1,finalize:['create','blob'].includes(failure)?0:1});
    assert.throws(()=>singleAttemptArtifactClient({...sdk,version:'fake'}));
  }
});
