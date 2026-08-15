/**
 * `/deep-research` — the bundled workflow.
 *
 * Investigates one question across many sources: fan out searches on distinct
 * angles, deep-read what they surface, then have independent verifiers vote on
 * every claim before it reaches the report. The voting stage is the point —
 * a single research pass reports whatever the first plausible page said.
 */
export const DEEP_RESEARCH_SCRIPT = `export const meta = {
  name: 'deep-research',
  description: 'Research a question across many sources and return a cited, cross-checked report',
  whenToUse: 'Use for questions that need several independent sources weighed against each other.',
  phases: [
    { title: 'Survey', detail: 'search the question from several angles' },
    { title: 'Read', detail: 'deep-read the most promising sources' },
    { title: 'Verify', detail: 'independent verifiers vote on each claim' },
    { title: 'Report', detail: 'synthesize a cited report' },
  ],
}

const question = typeof args === 'string' ? args : (args && args.question) || ''
if (!question) return { error: 'deep-research needs a question. Run /deep-research <question>.' }

const ANGLE_SCHEMA = {
  type: 'object',
  required: ['angles'],
  properties: {
    angles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['angle', 'query'],
        properties: { angle: { type: 'string' }, query: { type: 'string' } },
      },
    },
  },
}

const SOURCE_SCHEMA = {
  type: 'object',
  required: ['sources'],
  properties: {
    sources: {
      type: 'array',
      items: {
        type: 'object',
        required: ['url', 'title', 'why'],
        properties: { url: { type: 'string' }, title: { type: 'string' }, why: { type: 'string' } },
      },
    },
  },
}

const CLAIM_SCHEMA = {
  type: 'object',
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'url'],
        properties: {
          claim: { type: 'string' },
          url: { type: 'string' },
          quote: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'reason'],
  properties: {
    verdict: { type: 'string', enum: ['supported', 'refuted', 'unverifiable'] },
    reason: { type: 'string' },
  },
}

phase('Survey')
const plan = await agent(
  'Break this research question into 4 distinct search angles that would surface DIFFERENT sources, ' +
    'not rephrasings of each other. Question: ' + question,
  { label: 'plan angles', phase: 'Survey', schema: ANGLE_SCHEMA },
)

const angles = (plan && plan.angles ? plan.angles : []).slice(0, 4)
if (angles.length === 0) return { error: 'could not decompose the question into search angles' }
log(angles.length + ' angles: ' + angles.map(a => a.angle).join(', '))

const perAngle = await pipeline(
  angles,
  angle =>
    agent(
      'Use WebSearch to find the best sources for this angle on "' + question + '".\\n' +
        'Angle: ' + angle.angle + '\\nSuggested query: ' + angle.query + '\\n' +
        'Return the 3 most credible, most specific sources. Prefer primary sources over summaries.',
      { label: angle.angle, phase: 'Survey', schema: SOURCE_SCHEMA },
    ),
  found =>
    parallel(
      (found && found.sources ? found.sources : []).slice(0, 3).map(source => () =>
        agent(
          'WebFetch ' + source.url + ' and extract every claim in it that bears on: ' + question + '\\n' +
            'Quote the sentence each claim comes from. Do not infer beyond the text. ' +
            'If the page does not load or does not address the question, return an empty claims array.',
          { label: source.title, phase: 'Read', schema: CLAIM_SCHEMA },
        ),
      ),
    ),
)

const claims = []
const seen = new Set()
for (const batch of perAngle.flat().filter(Boolean)) {
  for (const claim of batch.claims || []) {
    const key = (claim.claim || '').toLowerCase().replace(/\\s+/g, ' ').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    claims.push(claim)
  }
}
log(claims.length + ' distinct claims to verify')
if (claims.length === 0) return { question, claims: [], unverified: [], note: 'no claims found' }

phase('Verify')
const judged = await pipeline(claims, (claim, _original, index) =>
  parallel(
    ['does an independent source confirm this', 'does any source contradict this'].map(
      (lens, lensIndex) => () =>
        agent(
          'Verify this claim independently of where it came from.\\n' +
            'Claim: ' + claim.claim + '\\nOriginally from: ' + claim.url + '\\n' +
            'Lens: ' + lens + '\\n' +
            'Search for and read at least one source OTHER than the original. ' +
            'Answer "unverifiable" if you cannot reach a source — do not guess, and do not ' +
            'treat a failed fetch as a refutation.',
          { label: 'claim ' + (index + 1) + '.' + (lensIndex + 1), phase: 'Verify', schema: VERDICT_SCHEMA },
        ),
    ),
  ).then(votes => ({ claim, votes: votes.filter(Boolean) })),
)

const supported = []
const unverified = []
for (const entry of judged.filter(Boolean)) {
  const votes = entry.votes
  const refuted = votes.filter(v => v.verdict === 'refuted').length
  const confirms = votes.filter(v => v.verdict === 'supported').length
  if (refuted > confirms) continue
  if (confirms === 0) {
    unverified.push({ claim: entry.claim.claim, url: entry.claim.url, reason: (votes[0] && votes[0].reason) || 'no verifier reached a source' })
    continue
  }
  supported.push({ claim: entry.claim.claim, url: entry.claim.url, quote: entry.claim.quote })
}

phase('Report')
const report = await agent(
  'Write a cited report answering: ' + question + '\\n\\n' +
    'Use ONLY these cross-checked claims, citing the URL after each statement:\\n' +
    JSON.stringify(supported, null, 2) +
    '\\n\\nThese claims could not be verified — list them at the end under "Unverified", do not treat them as fact:\\n' +
    JSON.stringify(unverified, null, 2) +
    '\\n\\nBe direct. Lead with the answer. Markdown, no preamble.',
  { label: 'synthesize', phase: 'Report' },
)

return { question, report, supported, unverified }
`
