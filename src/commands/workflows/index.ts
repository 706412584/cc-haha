import type { Command } from '../../commands.js'
import { areWorkflowsEnabled } from '../../utils/workflows/enabled.js'

const workflows = {
  type: 'local-jsx',
  name: 'workflows',
  description: 'Watch and manage dynamic workflow runs',
  isEnabled: () => areWorkflowsEnabled(),
  load: () => import('./workflows.js'),
} satisfies Command

export default workflows
