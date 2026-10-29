import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Use provider-reported workflow names, not filenames or example defaults.
export function renderActionsCaller(template, workflows) {
  if (!Array.isArray(workflows) || !workflows.length) throw Error('Explicit approved workflows required');
  const names = workflows.map(w => {
    if (!/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(w.path) || w.path === '.github/workflows/kairo.yml' ||
        typeof w.name !== 'string' || !w.name.trim() || /[\r\n*?\[\]]/.test(w.name)) throw Error('Invalid approved workflow');
    return w.name;
  });
  if (new Set(names).size !== names.length) throw Error('Ambiguous workflow names');
  if ((template.match(/^    workflows: \[Project CI, Deployment\]$/gm) || []).length !== 1) throw Error('Unexpected caller template');
  return template.replace('    workflows: [Project CI, Deployment]', `    workflows: ${JSON.stringify(names)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workflows = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const template = (await readFile(new URL('../examples/workflows/actions-public-caller.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  process.stdout.write(renderActionsCaller(template, workflows));
}
