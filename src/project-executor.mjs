import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve from DSH's running entry point, so its scope registry, permission
// pipeline and service symbols remain shared. Bundling another SDK copy would
// silently create separate scope identities. No package download occurs here.
export async function loadHostRuntime() {
  const entry = process.argv[1];
  if (!entry || !isAbsolute(entry)) throw Error('无法定位当前 DSH 运行时的会话作用域接口。');
  const hostRequire = createRequire(pathToFileURL(entry));
  const scope = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-scope')).href);
  if (typeof scope.createScope !== 'function') throw Error('当前 DSH 没有兼容的会话作用域接口。');
  return { createScope: scope.createScope };
}
