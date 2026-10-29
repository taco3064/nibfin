import {bodyDigest} from './canonical.mjs';

const prefix='<!-- nibfin:requirements:v1:';
const fail=()=>{throw new TypeError('requirements-document:format');};
const text=value=>typeof value==='string'&&value.trim().length>0&&Buffer.byteLength(value)<=1048576;
/** Readable Scope/Shape sections; their delimiters carry no approval or digest.
 * Ordinary edits inside Scope need no metadata update and change its live hash.
 * The nonce only disambiguates literal examples embedded in either section. */
export function formatRequirementsDocument({scope,shape}={}){
  if(!text(scope)||!text(shape))fail();
  const frame=requirementsDocumentFrame(scope);
  if([frame.separator,frame.suffix].some(marker=>shape.includes(marker)))fail();
  const body=frame.prefix+scope+frame.separator+shape+frame.suffix;
  if(!text(body))fail();return body;
}
export function requirementsDocumentFrame(scope){
  if(!text(scope))fail();const nonce=bodyDigest(scope);
  return {prefix:prefix+nonce+' -->\n## Scope\n\n',
    separator:'\n\n<!-- nibfin:shape:v1:'+nonce+' -->\n## Shape\n\n',suffix:'\n\n<!-- nibfin:end:v1:'+nonce+' -->'};
}
export function parseRequirementsDocument(body){
  if(typeof body!=='string'||Buffer.byteLength(body)>1048576)fail();
  if(!body.startsWith(prefix))return {format:'raw-scope',scope:body,shape:null};
  const header=/^<!-- nibfin:requirements:v1:([a-f0-9]{64}) -->\n## Scope\n\n/.exec(body);
  if(!header)fail();
  const nonce=header[1],middle='\n\n<!-- nibfin:shape:v1:'+nonce+' -->\n## Shape\n\n',
    end='\n\n<!-- nibfin:end:v1:'+nonce+' -->',at=body.indexOf(middle,header[0].length);
  if(at<0||body.indexOf(middle,at+middle.length)!==-1||!body.endsWith(end)
    ||body.indexOf(end)!==body.length-end.length)fail();
  const scope=body.slice(header[0].length,at),shape=body.slice(at+middle.length,-end.length);
  if(!text(scope)||!text(shape))fail();return {format:'scope-shape-v1',scope,shape};
}
export function assertRequirementsScope(body,scope){
  const document=parseRequirementsDocument(body);
  if(document.format!=='scope-shape-v1'||document.scope!==scope)fail();return document;
}
