import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { win32 as paths } from 'node:path';
import type { PrivateStateHost, UserStateEnvironment, UserStatePolicy } from '@superbee/cli';

const SUPERSEDED = [['.superbee-state'], ['.config', 'superbee']] as const;
function absolute(value: string): string {
  if (!paths.isAbsolute(value)) throw new Error('private Superbee user-state root must be an absolute path');
  return value;
}

export function userStateEnvironment(input?: string | UserStateEnvironment): UserStateEnvironment {
  if (typeof input === 'object') return input;
  const home = input ?? homedir();
  if (input === undefined || paths.normalize(home).toLocaleLowerCase('en-US') === paths.normalize(homedir()).toLocaleLowerCase('en-US')) {
    return {platform:'win32', home, env:process.env};
  }
  return {platform:'win32', home, env:{...process.env, USERPROFILE:home,
    LOCALAPPDATA: paths.join(home,'AppData','Local'), APPDATA:paths.join(home,'AppData','Roaming')}};
}

export function legacyRoot(input: UserStateEnvironment): string {
  return absolute(paths.join(absolute(input.home), '.agentstate'));
}
export function supersededRoots(input: UserStateEnvironment): readonly string[] {
  return SUPERSEDED.map(parts => absolute(paths.join(absolute(input.home), ...parts)));
}

export function resolveUserStatePolicy(input: UserStateEnvironment): UserStatePolicy {
  const home = absolute(input.home);
  const legacy = legacyRoot(input);
  const superseded = supersededRoots(input);
  const localAppData = input.env.LOCALAPPDATA?.trim() ?? '';
  const normalized = paths.normalize(localAppData);
  const root = paths.parse(normalized).root;
  const driveQualified = /^[A-Za-z]:\\$/u.test(root);
  const deviceNamespace = /^(?:\\\\[?.]\\|\\\?\?\\)/u.test(normalized);
  const genuineUnc = !deviceNamespace && /^\\\\[^\\]+\\[^\\]+\\$/u.test(root);
  if (!localAppData || !paths.isAbsolute(normalized) || (!driveQualified && !genuineUnc)) {
    return {platform:'win32', home, state:'blocked', canonicalRoot:null,
      guardedRoots:[...new Set([legacy,...superseded])], displayRoot:'%LOCALAPPDATA%\\Superbee',
      reason:'LOCALAPPDATA must name an absolute drive-qualified or UNC Windows directory; root-relative, drive-relative, and device paths are not accepted'};
  }
  const canonicalRoot = absolute(paths.join(normalized,'Superbee'));
  return {platform:'win32',home,state:'ready',canonicalRoot,
    guardedRoots:[...new Set([canonicalRoot,...superseded,legacy])],displayRoot:'%LOCALAPPDATA%\\Superbee'};
}

export function displayPath(input: UserStateEnvironment, target: string): string {
  const policy = resolveUserStatePolicy(input);
  if (policy.canonicalRoot !== null) {
    const child = paths.relative(policy.canonicalRoot,target);
    if (!child) return policy.displayRoot;
    if (!child.startsWith('..') && !paths.isAbsolute(child)) return `${policy.displayRoot}\\${child}`;
  }
  const child = paths.relative(policy.home,target);
  if (!child) return '%USERPROFILE%';
  if (!child.startsWith('..') && !paths.isAbsolute(child)) return `%USERPROFILE%\\${child}`;
  return target;
}

export const windowsPrivateStateHost: PrivateStateHost = Object.freeze({
  id:'win32', enforcePrivateMode:false,
  environment:userStateEnvironment, resolvePolicy:resolveUserStatePolicy, legacyRoot, supersededRoots,
  migrationSources: (input: UserStateEnvironment) =>
    [...new Set([...supersededRoots(input),legacyRoot(input)])].map(root => ({root,display:displayPath(input,root),requiresMarker:root !== legacyRoot(input)})),
  displayPath, currentUid:() => undefined,
  privateRead:Object.freeze({flags:constants.O_RDONLY | constants.O_NONBLOCK, inspectBeforeOpen:true}),
  isTransientConfigReplaceError:(error: unknown) => {
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return code === 'EPERM' || code === 'EBUSY';
  },
  sourceInspectionCommand:(_display: string, _detailed: boolean, setupCommand: string) => setupCommand,
  bundleBoundaryRecovery:(rootDisplay: string, setupCommand: string) =>
    `${rootDisplay} lives inside it — choose a project directory outside private state, open it, and run ${setupCommand} init --create-only --dir .superbee`,
});
