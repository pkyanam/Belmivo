import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Only explicit Markdown links in the final reply can become outbound artifacts. */
export function linkedArtifacts(text:string, directory?:string):string[] {
  if(!directory)return[];
  const root=resolve(directory), paths=new Set<string>();
  const links=/(?:!?)\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\)\n]+))\s*\)/g;
  for(const match of text.matchAll(links)) {
    const path=(match[1]??match[2]??'').trim();
    if(!isAbsolute(path)||path.includes('\0')) continue;
    const target=resolve(path), rel=relative(root,target);
    if(rel && !rel.startsWith(`..${sep}`) && rel!=='..' && !isAbsolute(rel)) paths.add(target);
    if(paths.size>=5)break;
  }
  return [...paths];
}
