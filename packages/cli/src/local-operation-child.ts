/** Fresh-process host. Accepted code has ambient local authority; this is supervision, not a sandbox. */
export async function localOperationChild(readBytes:(file:string,maximum:number)=>Promise<Buffer>): Promise<void> {
  const { spawn } = await import('node:child_process');
  const {createHash}=await import('node:crypto');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const controller = new AbortController();
  let initialized = false;
  let request: any;
  let completed = false;
  const send = (value: unknown) => process.send?.(value);
  process.on('disconnect', () => {
    controller.abort();
    if (!completed) { try { process.kill(-process.pid, 'SIGKILL'); } catch {} }
    process.exit(completed ? 0 : 70);
  });
  process.on('message', async (message: any) => {
    if (message.type === 'abort') { controller.abort(); return; }
    try {
      if (message.type === 'initialize' && !initialized) {
        initialized = true;
        request = message;
        const outputPath = (name: string) => {
          if (typeof name !== 'string' || !name || path.isAbsolute(name) || name.includes('\\') || name.split('/').some(x => x === '..' || x === '.')) throw Error('invalid_output_path');
          return path.join(request.invocation.outputDirectory, name);
        };
        const port = {
          writeJson: async (name: string, value: unknown) => { const text=JSON.stringify(value); if(Buffer.byteLength(text)>request.protocolBytes)throw Error('json_limit'); await fs.writeFile(outputPath(name),text,{mode:0o600,flag:'wx'}); },
          readJson: async (name: string) => { const file = outputPath(name); const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error('invalid_json_output'); return JSON.parse(await fs.readFile(file, 'utf8')); },
          runTool: async ({ tool, argv, signal }: { tool: string; argv: string[]; signal?: AbortSignal }) => {
            if (!Object.hasOwn(request.tools, tool) || !Array.isArray(argv) || argv.length > 128 || argv.some(x => typeof x !== 'string' || x.includes('\0') || x.length > 8192)) throw Error('invalid_tool_request');
            const checkIdentity=async()=>{
              const selected=request.tools[tool];let matches=false;
              try{matches=await fs.realpath(selected.path)===selected.path&&`sha256:${createHash('sha256').update(await readBytes(selected.path,256*1024*1024)).digest('hex')}`===selected.sha256;}catch{}
              if(!matches){send({type:'tool_identity_changed',tool});throw Error('tool_identity_changed');}
            };
            await checkIdentity();
            controller.signal.throwIfAborted();
            return await new Promise((resolve, reject) => {
              const child = spawn(request.tools[tool].path, argv, { shell: false, cwd: request.invocation.outputDirectory, env: { PATH: '/usr/bin:/bin', HOME: request.invocation.outputDirectory, TMPDIR: request.invocation.outputDirectory, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
              let stdout = '', stderr = '', bytes = 0, overflowSent=false;
              const capture = (kind: 'stdout'|'stderr', chunk: Buffer) => { bytes += chunk.length; if (bytes > request.profile.logBytes) { if(!overflowSent){overflowSent=true;send({type:'overflow'});} return; } process.stderr.write(chunk); if (kind === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString(); };
              child.stdout.on('data', chunk => capture('stdout', chunk)); child.stderr.on('data', chunk => capture('stderr', chunk));
              const abort = () => child.kill('SIGTERM');
              controller.signal.addEventListener('abort', abort, { once: true }); signal?.addEventListener('abort', abort, { once: true });
              child.on('error', reject); child.on('close', exitCode => { controller.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort); void checkIdentity().then(()=>resolve({exitCode:exitCode ?? -1,stdout,stderr}),reject); });
            });
          },
        };
        const module = await import(pathToFileURL(request.entryPath).href);
        const capabilities = await module.createLocalCapabilities({port,resources:request.resources,invocation:request.invocation});
        if (!Array.isArray(capabilities) || capabilities.length > 32) throw Error('invalid_capabilities');
        const descriptors = capabilities.map(({execute, mintSources, ...descriptor}: any) => descriptor);
        if(Buffer.byteLength(JSON.stringify(descriptors))>request.protocolBytes)throw Error('descriptor_limit');
        (request as any).capabilities = capabilities;
        send({type:'ready',descriptors});
      } else if (message.type === 'execute' && request?.capabilities) {
        const capabilities = request.capabilities; delete request.capabilities;
        const capability = capabilities.find((row: any) => row.name === request.capabilityName);
        if (!capability || typeof capability.execute !== 'function') throw Error('missing_capability');
        const result = await capability.execute(request.input, {signal:controller.signal,toolCallId:request.invocation.id});
        const serialized = JSON.stringify(result);
        if (Buffer.byteLength(serialized) > request.maximumOutputBytes) throw Error('result_limit');
        completed = true;
        send({type:'result',result});
        process.disconnect();
      }
    } catch (error) { console.error(error); send({type:'failed'}); if(process.connected)process.disconnect(); }
  });
}
