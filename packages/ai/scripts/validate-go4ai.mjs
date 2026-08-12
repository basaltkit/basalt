// Live validation of the OpenAI-compatible (go4ai) provider + the planning pipeline.
//
// Run it with your real key (nothing is hard-coded here). PROJECT defaults to the
// current directory; override it to point at the app you want to plan against:
//
//   AI_PROVIDER=openai \
//   AI_BASE_URL=https://ai.go4ai.io/v1 \
//   AI_API_KEY=sk_inf_xxx \
//   AI_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0 \
//   PROJECT=/path/to/your/app \
//   node packages/ai/scripts/validate-go4ai.mjs "Add a patients module"
//
import {
  createProvider,
  providerEnvFromProcess,
  detectProject,
  createPlan,
  renderPlan,
  runMake,
  renderMakeResult,
} from '../dist/index.js'

const PROJECT = process.env.PROJECT ?? process.cwd()
const request = process.argv.slice(2).join(' ') || 'Add a patients module'
const io = { log: (m) => console.log(m) }

const provider = createProvider(providerEnvFromProcess())
console.log(`Provider: ${provider.name}  model: ${provider.model}\n`)

// 1) Connectivity — a tiny round-trip proves auth + endpoint + model.
console.log('1) Connectivity check...')
const ping = await provider.generate({
  messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
  maxTokens: 16,
})
console.log(`   → ${JSON.stringify(ping.trim())}\n`)

// 2) Real end-to-end plan, grounded in the actual project.
console.log('2) ai:plan (live)...\n')
const ctx = detectProject(PROJECT)
const plan = await createPlan(provider, ctx, request)
renderPlan(plan, io)

// 3) Execute the plan in DRY-RUN — scaffold + domain fields, nothing written.
console.log('\n3) ai:make --dry-run (live plan → generated files, nothing written)...\n')
const result = await runMake(ctx, plan, { dryRun: true, baseDir: PROJECT })
renderMakeResult(result, io)
