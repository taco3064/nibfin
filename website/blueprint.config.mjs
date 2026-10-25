import { defineBlueprint } from '@kekkai/blueprint';
export default defineBlueprint({
  name: 'Nibfin website presentation', framework: 'react',
  architecture: {
    alias: '@site', sourceRoot: 'src/modules',
    modules: [
      { name: 'status', dependsOn: ['policy'], does: 'Render truthful release verification status using Flowbite.' },
      { name: 'policy', does: 'Describe the public product boundary without presentation dependencies.' },
    ],
    layers: [{ name: 'components', does: 'Reusable static presentation only.', layout: 'file' }],
    layerFiles: '{module}/{layer}/**/*.{ts,tsx}',
  },
  rules: { moduleDependencySync: 'error', cycles: 'error' },
  emit: { agents: [], lint: { severity: 'error' } },
});
