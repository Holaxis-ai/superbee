import { currentHost } from './runtime-context.js';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import type { HostCommandEnvironment, HostCommandDeps, ResolvedHostCommand } from './runtime-types.js';
export type { HostCommandEnvironment, HostCommandDeps, ResolvedHostCommand } from './runtime-types.js';
export { HostCommandError } from './host-command-error.js';
export type HostCommandExecOptions = ExecFileSyncOptionsWithStringEncoding & {readonly windowsVerbatimArguments?:boolean};
export function resolveHostCommand(command:string,input:HostCommandEnvironment,deps:Pick<HostCommandDeps,'resolvePath'>={}):ResolvedHostCommand {return currentHost().resolveCommand(command,input,deps);}
export function runHostCommand(command:ResolvedHostCommand,args:readonly string[],input:HostCommandEnvironment,deps:Pick<HostCommandDeps,'execFile'>={}):string {return currentHost().runCommand(command,args,input,deps);}
