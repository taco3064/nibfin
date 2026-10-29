import { readdir } from 'node:fs/promises';
import { command } from '../src/process.mjs';
for (const folder of ['src', 'bin', 'scripts', 'test']) {
  for (const file of await readdir(folder)) if (file.endsWith('.mjs')) await command(process.execPath, ['--check', `${folder}/${file}`]);
}
console.log('All JavaScript modules passed syntax checks.');
