import { currentHost } from './runtime-context.js';
/** POSIX shell literals remain portable total rendering data. */
export function renderPosixToken(value:string):string {return `'${value.replaceAll("'", "'\\''")}'`;}
export function isRenderableToken(value:string,_platform?:string):boolean {return currentHost().renderShellToken(value)!==undefined;}
export function renderShellToken(value:string,_platform?:string):string {
 const result=currentHost().renderShellToken(value);
 if(result===undefined) throw new Error('value has no inert single-argument rendering for the host command shells');
 return result;
}
