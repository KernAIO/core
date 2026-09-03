// Rewritten at image build by `scripts/extra-modules.mjs` from KERN_EXTRA_MODULES. Do not edit:
// with the variable empty the script writes this exact file back, so a normal build changes nothing.
import type { ServerModule } from '@kernhq/kernel'

/** Modules a self-hoster built into this image beside the first-party set. Empty in the published images. */
export const extraModules: ServerModule[] = []
