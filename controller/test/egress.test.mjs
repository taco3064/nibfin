import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { clientHelloHost, publicIPv4, createProxy } from '../src/egress-proxy.mjs';
import { CodexAgent } from '../src/agent.mjs';

function hello(host) {
  const name=Buffer.from(host), sni=Buffer.alloc(5+name.length);
  sni.writeUInt16BE(name.length+3,0); sni.writeUInt16BE(name.length,3);name.copy(sni,5);
  const extension=Buffer.alloc(4+sni.length);extension.writeUInt16BE(sni.length,2);sni.copy(extension,4);
  const body=Buffer.alloc(34+1+4+2+2+extension.length);
  body.writeUInt16BE(0x0303,0);let p=35;body.writeUInt16BE(2,p);p+=2;body.writeUInt16BE(0x1301,p);p+=2;body[p++]=1;body[p++]=0;body.writeUInt16BE(extension.length,p);extension.copy(body,p+2);
  const record=Buffer.alloc(9+body.length);record[0]=22;record.writeUInt16BE(0x0301,1);record.writeUInt16BE(body.length+4,3);record[5]=1;record.writeUIntBE(body.length,6,3);body.copy(record,9);return record;
}
test('TLS hostname verification rejects malformed records and preserves actual SNI',()=>{
  const bytes=hello('chatgpt.com');assert.equal(clientHelloHost(bytes),'chatgpt.com');
  assert.equal(clientHelloHost(bytes.subarray(0,10)),null);
  assert.equal(clientHelloHost(hello('example.com')),'example.com');
  const bad=Buffer.from(bytes);bad[0]=23;assert.throws(()=>clientHelloHost(bad));
});
test('proxy rejects arbitrary destinations before DNS or an upstream connection',async t=>{
  const server=createProxy();await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  for(const path of ['example.com:443','1.1.1.1:443','chatgpt.com:80','chatgpt.com.evil.test:443','auth.openai.com:443@evil.test','registry.npmjs.org:80','registry.npmjs.org.evil.test:443']) {
    const status=await new Promise((resolve,reject)=>{const q=http.request({host:'127.0.0.1',port:server.address().port,method:'CONNECT',path});q.on('connect',(res,s)=>{s.destroy();resolve(res.statusCode)});q.on('error',reject);q.end();});assert.equal(status,403);
  }
});

test('npm registry HTTPS CONNECT is allowed without admitting other package hosts',async t=>{
  const server=createProxy(),sockets=new Set();
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{for(const s of sockets)s.destroy();server.close();});
  for(const [path,expected] of [['registry.npmjs.org:443',200],['registry.yarnpkg.com:443',403]]) {
    const status=await new Promise((resolve,reject)=>{const q=http.request({host:'127.0.0.1',port:server.address().port,method:'CONNECT',path});q.on('connect',(res,s)=>{s.destroy();resolve(res.statusCode);});q.on('error',reject);q.end();});
    assert.equal(status,expected);
  }
});
test('Playwright CDN and Microsoft redirect allow HTTPS without accepting lookalikes or other downloads',async t=>{
  const server=createProxy(),sockets=new Set();
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{for(const s of sockets)s.destroy();server.close();});
  for(const [path,expected] of [
    ['cdn.playwright.dev:443',200],['playwright.download.prss.microsoft.com:443',200],
    ['cdn.playwright.dev:80',403],['cdn.playwright.dev.evil.test:443',403],
    ['playwright.download.prss.microsoft.com.evil.test:443',403],
    ['playwright.download.prss.microsoft.com:443@evil.test',403],
    ['untrusted.playwright.dev:443',403],['download.prss.microsoft.com:443',403],
    ['github.com:443',403],['registry.yarnpkg.com:443',403]
  ]) {
    const status=await new Promise((resolve,reject)=>{const q=http.request({host:'127.0.0.1',port:server.address().port,method:'CONNECT',path});q.on('connect',(res,s)=>{s.destroy();resolve(res.statusCode);});q.on('error',reject);q.end();});
    assert.equal(status,expected,path);
  }
});
test('proxy upstream addresses exclude loopback, LAN, metadata and IPv6',()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.1.1','192.168.1.1','100.64.1.1','::1','::ffff:127.0.0.1'])assert.equal(publicIPv4(ip),false);
  assert.equal(publicIPv4('1.1.1.1'),true);
});
test('a dedicated bridge name alone never authorizes a credential-bearing execution',async()=>{
  const agent=new CodexAgent({network:'custom'},'/core','/state',async()=>assert.fail('must reject before running Docker'));
  await assert.rejects(agent.login('/work','/io'),/Verified egress proxy/);
});
