// Fixed credential-free proxy entrypoint. It never loads checkout modules.
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {pathToFileURL} from 'node:url';
export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a,b] = address.split('.').map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || a===169&&b===254 || a===172&&b>=16&&b<=31
      || a===192&&(b===168 || b===0 || b===2) || a===100&&b>=64&&b<=127
      || a===198&&(b===18 || b===19 || b===51) || a===203&&b===0);
  }
  // Deliberately narrow IPv6 global-unicast support; mapped, ULA, scoped and
  // translation addresses fail closed rather than bypass the IPv4 policy.
  if(isIP(address)!==6)return false;
  const normalized=new URL('http://['+address+']/').hostname.slice(1,-1);
  const parts=normalized.split(':');
  return /^[23][a-f0-9]{3}:/i.test(normalized) && !/^2002:/i.test(normalized)
    && !(parts[0]==='2001' && (parseInt(parts[1]||'0',16)<=0x1ff || parts[1]==='db8')); 
}
export function validateEndpoints(value) {
  if (!Array.isArray(value) || value.length>32 || new Set(value).size!==value.length
      || value.some(h=>typeof h!=='string' || h.length>253 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(h)
        || isIP(h) || h.endsWith('.local') || h.endsWith('.internal'))) throw Error('egress:profile');
  return Object.freeze([...value]);
}
export function connectDestination(authority,endpoints) {
  if (typeof authority !== 'string' || !authority.endsWith(':443')) throw Error('egress:policy-denial');
  const host = authority.slice(0,-4);
  if (!endpoints.includes(host)) throw Error('egress:policy-denial');
  return host;
}
/** Parse one TLS ClientHello, bounded by the caller; no arbitrary tunnel protocol,
 * IP literals, absent SNI or a different SNI on an allowed shared CDN address.
 */
export function tlsServerName(bytes) {
  if (bytes.length < 5) return null;
  if (bytes[0]!==22 || bytes.readUInt16BE(3)>16384) throw Error('egress:tls');
  const end = 5 + bytes.readUInt16BE(3);if (bytes.length < end) return null;
  if (bytes[5]!==1 || end<44 || bytes.readUIntBE(6,3)!==end-9) throw Error('egress:tls');
  let i=43;i+=1+bytes[i];
  if (i+2>end) throw Error('egress:tls');i+=2+bytes.readUInt16BE(i);
  if (i+1>end) throw Error('egress:tls');i+=1+bytes[i];
  if (i+2>end) throw Error('egress:tls');const extensionEnd=i+2+bytes.readUInt16BE(i);i+=2;
  if (extensionEnd!==end) throw Error('egress:tls');
  let name=null;
  while (i+4<=end) {
    const type=bytes.readUInt16BE(i),size=bytes.readUInt16BE(i+2);i+=4;
    if (i+size>end) throw Error('egress:tls');
    if (type===0) {
      if (name!==null || size<5 || bytes.readUInt16BE(i)!==size-2 || bytes[i+2]!==0
          || bytes.readUInt16BE(i+3)!==size-5) throw Error('egress:tls');
      name=bytes.subarray(i+5,i+size).toString('ascii');
    }
    // ECH conceals the actual destination; this profile cannot enforce it.
    if (type===0xfe0d) throw Error('egress:tls');
    i+=size;
  }
  if (i!==end || !name) throw Error('egress:tls');return name;
}
/** DNS is resolved for EVERY connect, all answers checked, and a checked literal
 * is dialed. Redirects to another host require another independently checked CONNECT.
 */
export function createEgressGateway({endpoints,resolve=lookup,dial=connect,maxConnections=64}={}) {
  endpoints=validateEndpoints(endpoints);let active=0;
  const server=createServer((req,res)=>{res.writeHead(403);res.end();});
  server.on('connect',async(req,client,head)=>{
    let upstream=null, timer=null, closed=false, counted=false, established=false;
    const close=()=>{if(closed)return;closed=true;clearTimeout(timer);client.destroy();upstream?.destroy();if(counted)active--;};
    // Only fixed categories cross this boundary; never resolver messages, URLs or addresses.
    const reject=kind=>{
      if(closed)return;
      if(established)return close();
      const status={'policy-denial':'403 Forbidden',dns:'502 Bad Gateway',timeout:'504 Gateway Timeout',proxy:'503 Service Unavailable'}[kind];
      clearTimeout(timer);closed=true;if(counted)active--;
      client.end(`HTTP/1.1 ${status}\r\nNibfin-Egress-Error: ${kind}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    };
    client.on('error',close);client.on('close',close);client.on('end',close);
    try {
      const host=connectDestination(req.url,endpoints);
      if (active>=maxConnections)return reject('proxy');active++;counted=true;
      timer=setTimeout(()=>reject('timeout'),10000);
      let addresses;
      try {addresses=await resolve(host,{all:true,verbatim:true});}
      catch(error){return reject(error?.code==='ETIMEDOUT'?'timeout':'dns');}
      if(closed)return;
      if(!Array.isArray(addresses)||!addresses.length)return reject('dns');
      if(addresses.some(a=>!publicAddress(a.address)))return reject('policy-denial');
      established=true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      let hello=head;
      const receive=data=>{
        try {
          hello=Buffer.concat([hello,data]);if(hello.length>65536)throw Error();
          const sni=tlsServerName(hello);if(sni===null)return;
          if(sni!==host)throw Error();client.pause();client.removeListener('data',receive);
          upstream=dial({host:addresses[0].address,port:443,family:addresses[0].family});
          upstream.on('error',close);upstream.on('close',close);
          upstream.once('connect',()=>{clearTimeout(timer);timer=setTimeout(close,300000);
            upstream.write(hello);client.pipe(upstream);upstream.pipe(client);client.resume();});
        }catch{close();}
      };
      client.on('data',receive);if(head.length)receive(Buffer.alloc(0));
    }catch{reject('policy-denial');}
  });
  server.on('clientError',(_error,socket)=>socket.destroy());
  server.headersTimeout=10000;server.requestTimeout=10000;
  return server;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) {
  try {createEgressGateway({endpoints:JSON.parse(process.env.NIBFIN_ENDPOINTS)}).listen(8080,'0.0.0.0');}
  catch {process.exitCode=1;}
}
