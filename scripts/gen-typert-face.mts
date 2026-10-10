/**
 * TEMPORARY single-package face driver (delete after use).
 *
 * The workspace-wide `tsdown --env.DSH_BUILD_FACE host` pass aborts natively on
 * this machine (exit 134) and its `-F` filter does not match a package tsdown
 * has not bundled before, so this drives the same generator the tsdown plugin
 * drives — `WorkspaceTypertGenerator` + the plugin's own `emitArtifacts`
 * layout — for ONE package.
 *
 * Usage: node --import tsx/esm scripts/tmp-gen-sandbox-spec-face.mts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkspaceTypertGenerator } from '../packages/typert/generator/src/workspace.ts'

const ROOT = process.cwd()
const PACKAGE = '@deepseek-ai/dsh-api-sandbox-spec-controller'

const generator = new WorkspaceTypertGenerator(ROOT, { checkDiagnostics: false })
const artifacts = generator.generate([PACKAGE], ['host'])
if (artifacts.length === 0) {
  console.error(`tmp-gen-face: no artifact produced for ${PACKAGE} (is its lib/types built and its ./typert export declared?)`)
  process.exit(1)
}
for (const artifact of artifacts) {
  const output = join(artifact.packageRoot, 'lib')
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, `typert.${artifact.face}.js`), artifact.js)
  writeFileSync(join(output, `typert.${artifact.face}.d.ts`), artifact.dts)
  console.log(`tmp-gen-face: wrote ${artifact.package} ${artifact.face}`)
  if (artifact.remote !== undefined) {
    writeFileSync(join(output, 'typert.remote-client.js'), artifact.remote.js)
    writeFileSync(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
    writeFileSync(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
    console.log('tmp-gen-face: wrote remote-client face')
  }
}
