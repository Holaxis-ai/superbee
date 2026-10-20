/** Self-contained so the parent and its bundled fresh child use the same bounded inode read. */
export async function boundedLocalFileBytes(file:string,maximum:number):Promise<Buffer> {
  const {constants}=await import('node:fs');
  const {open,lstat}=await import('node:fs/promises');
  const handle=await open(file,constants.O_RDONLY|constants.O_NONBLOCK|(constants.O_NOFOLLOW??0));
  try {
    const before=await handle.stat({bigint:true});
    if(!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)) throw Error('file_shape_or_limit');
    const bytes=Buffer.alloc(Number(before.size)); let offset=0;
    while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,null);if(!read.bytesRead)throw Error('input_changed');offset+=read.bytesRead;}
    if((await handle.read(Buffer.alloc(1),0,1,null)).bytesRead)throw Error('input_changed');
    const after=await handle.stat({bigint:true}),named=await lstat(file,{bigint:true});
    if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||!named.isFile()||named.dev!==after.dev||named.ino!==after.ino)throw Error('input_changed');
    return bytes;
  } finally {await handle.close();}
}
