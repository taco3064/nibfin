import test from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {Duplex} from 'node:stream';
import {once} from 'node:events';
import {publicAddress,connectDestination,tlsServerName,createEgressGateway,endpointProfiles} from '@nibfin/core';
import {codexFixture} from '../tooling/codex-fixture.mjs';
function hello(host) {
  const name=Buffer.from(host),names=Buffer.alloc(5+name.length);names.writeUInt16BE(3+name.length);names[2]=0;names.writeUInt16BE(name.length,3);name.copy(names,5);
  const extension=Buffer.alloc(4+names.length);extension.writeUInt16BE(0);extension.writeUInt16BE(names.length,2);names.copy(extension,4);
  const fixed=Buffer.alloc(43);fixed[0]=22;fixed[1]=3;fixed[2]=1;fixed[5]=1;fixed[9]=3;fixed[10]=3;
  const suffix=Buffer.from([0,0,2,0x13,1,1,0,0,extension.length]);
  const bytes=Buffer.concat([fixed,suffix,extension]);bytes.writeUInt16BE(bytes.length-5,3);bytes.writeUIntBE(bytes.length-9,6,3);return bytes;
}
test('endpoint/port and public-address checks deny private, metadata, aliases and reserved ranges including expanded IPv6',()=>{
  for(const address of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0',
    '224.1.2.3','198.18.1.1','192.0.2.1','::1','fe80::1','fc00::1','::ffff:127.0.0.1','2001:0db8:0000::1','2002:7f00:1::'])assert.equal(publicAddress(address),false,address);
  for(const address of ['8.8.8.8','1.1.1.1','2001:4860:4860::8888','2606:4700:4700::1111'])assert.equal(publicAddress(address),true,address);
  assert.deepEqual(endpointProfiles['dependency-download'],['registry.npmjs.org']);assert.deepEqual(endpointProfiles.hooks,[]);
  const allow=endpointProfiles.claude;
  assert.equal(connectDestination('api.anthropic.com:443',allow),'api.anthropic.com');
  for(const destination of ['api.anthropic.com:80','api.anthropic.com:444','api.anthropic.com.:443','api.anthropic.com.evil.com:443',
    '127.0.0.1:443','169.254.169.254:443','example.com:443','api.github.com:443','https://api.anthropic.com:443','API.ANTHROPIC.COM:443'])assert.throws(()=>connectDestination(destination,allow));
});

test('TLS ClientHello SNI is checked before any tunnel payload is forwarded',()=>{
  const bytes=hello('api.anthropic.com');assert.equal(tlsServerName(bytes),'api.anthropic.com');
  assert.equal(tlsServerName(bytes.subarray(0,bytes.length-1)),null);
  assert.throws(()=>tlsServerName(Buffer.from('GET / HTTP/1.1\r\n')));
  const malformed=Buffer.from(bytes);malformed[43]=255;assert.throws(()=>tlsServerName(malformed));
});

test('production proxy pins public DNS, checks every new connection/redirect and rejects rebinding and alternate SNI',async()=>{
  let resolutions=0,dials=0;const received=[];
  const server=createEgressGateway({endpoints:['registry.npmjs.org'],resolve:async()=>{
    resolutions++;return [{address:resolutions===2?'169.254.169.254':'1.1.1.1',family:4}];},dial:options=>{
      dials++;assert.deepEqual(options,{host:'1.1.1.1',family:4,port:443});
      const stream=new Duplex({read(){},write(bytes,_encoding,done){received.push(bytes);done();}});
      queueMicrotask(()=>stream.emit('connect'));return stream;
    }});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const clients=[];
  async function attempt(authority,sni) {
    const client=connect({host:'127.0.0.1',port:server.address().port});clients.push(client);
    const data=[];client.on('error',()=>{});client.on('data',b=>data.push(b));
    await once(client,'connect');client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    for(let n=0;n<50&&!data.length&&!client.destroyed;n++)await new Promise(r=>setTimeout(r,5));
    if(data.length&&sni)client.write(hello(sni));
    await new Promise(r=>setTimeout(r,20));return client;
  }
  try {
    await attempt('registry.npmjs.org:443','registry.npmjs.org');assert.equal(dials,1);assert.equal(received.length,1);
    await attempt('registry.npmjs.org:443','registry.npmjs.org');assert.equal(dials,1,'private rebound must not be dialed');
    await attempt('registry.npmjs.org:443','evil.example');assert.equal(dials,1,'shared-CDN alternate SNI must not be dialed');
    const before=resolutions;
    for(const target of ['unrelated.example:443','127.0.0.1:443','api.github.com:443','registry.npmjs.org:80'])await attempt(target);
    assert.equal(resolutions,before,'denied redirects/endpoints must not even resolve');
  }finally{clients.forEach(c=>c.destroy());server.close();await once(server,'close');}
});

test('actual adapter launch uses internal network and owned gateway; missing enforcement and direct-route bypass block',async()=>{
  const f=codexFixture('deliver');
  try {
    assert.equal((await f.life.start(f.input)).start.status,'started');
    const network=f.calls.find(c=>c.args[2]==='network'&&c.args[3]==='create');assert(network.args.includes('--internal'));
    const role=f.calls.find(c=>c.args.at(-1)==='execute'),net=role.args[role.args.indexOf('--network')+1];
    assert.equal(net,network.args.at(-1));assert.notEqual(net,'bridge');
    const gateway=f.calls.find(c=>c.args.at(-1)==='/gateway.mjs');assert(gateway);assert(gateway.args.includes('--read-only'));
    assert.equal(gateway.args[gateway.args.indexOf('--network')+1],'bridge');
    assert.doesNotMatch(JSON.stringify(gateway),/LOGIN-SENTINEL|auth.json|GH_TOKEN/);
    const container=[...f.containers.values()].find(c=>!c.probe);container.NetworkSettings.Networks.bridge={};
    assert.equal((await f.life.termination(f.input.execution.id)).termination.status,'unknown');
    assert.equal((await f.life.cleanup()).status,'unresolved');delete container.NetworkSettings.Networks.bridge;
    await f.collect();await f.life.termination(f.input.execution.id);assert.equal((await f.life.cleanup()).status,'completed');
  }finally{await f.dispose();}
  const absent=codexFixture();try{
    const {createLinuxCodexBackend}=await import('@nibfin/core');const config={...absent.config};delete config.egress;
    const backend=createLinuxCodexBackend(config);assert.equal((await backend.readiness()).login,'unavailable');
    assert.equal(backend.diagnostic(),'egress-enforcement-unavailable');assert.equal(absent.calls.some(c=>c.args.at(-1)==='execute'),false);
  }finally{await absent.dispose();}
});
