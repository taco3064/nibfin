// Synthetic daemon response decoder. This is not host-isolation evidence.
export function dockerObservation(args,image) {
  const many=key=>args.flatMap((v,i)=>v===key?[args[i+1]]:v.startsWith(key+'=')?[v.slice(key.length+1)]:[]);
  const one=key=>many(key)[0];
  const memory=one('--memory');
  return {Config:{User:one('--user'),Env:many('--env'),Entrypoint:[one('--entrypoint')],Cmd:args.slice(args.indexOf(image)+1)},
    HostConfig:{Privileged:false,ReadonlyRootfs:true,CapDrop:many('--cap-drop'),CapAdd:[],SecurityOpt:many('--security-opt'),
      Memory:parseInt(memory)*(memory.endsWith('g')?1073741824:1048576),PidsLimit:Number(one('--pids-limit')),NanoCpus:Number(one('--cpus'))*1e9,
      NetworkMode:one('--network'),Devices:[],PortBindings:{},PidMode:'',IpcMode:'private'},
    Mounts:many('--mount').map(value=>{
      const spec=Object.fromEntries(value.split(',').map(v=>v.includes('=')?v.split('='):[v,true]));
      return {Type:'bind',Source:spec.src,Destination:spec.dst,RW:!spec.readonly};
    })};
}
