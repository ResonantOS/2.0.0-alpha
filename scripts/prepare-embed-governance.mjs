import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const root=new URL('../',import.meta.url);
export async function prepareEmbedGovernance({check=false}={}) {
  const pairs=['trace-redaction-core.js','trace-redaction.js','embed-governance-contract.js'].map(name=>['src/core/'+name,'browser-first/resonantos-side-panel-extension/src/lib/generated/'+name]);
  pairs.push(['src/core/trace-redaction-core.js','browser-first/resonantos-side-panel-extension/src/lib/trace-redaction-core.js']);
  for (const [source,target] of pairs) {
    const bytes=await readFile(new URL(source,root));
    if (check) {
      if (!bytes.equals(await readFile(new URL(target,root)))) throw new Error('Generated governance source differs.');
    } else {
      await mkdir(new URL('.',new URL(target,root)),{recursive:true});
      await writeFile(new URL(target,root),bytes);
    }
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await prepareEmbedGovernance({check:process.argv.includes('--check')});
