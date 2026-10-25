import tseslint from 'typescript-eslint';
import { emitLint } from '@kekkai/blueprint';
import blueprint from './blueprint.config.mjs';
export default [
  { ignores: ['dist/**', 'out/**', '.astro/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  ...emitLint(blueprint),
];
