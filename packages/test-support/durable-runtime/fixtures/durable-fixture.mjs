/**
 * Durable-runtime failpoint fixture: a plain-ESM Cordis plugin the spawned
 * headless dsh host loads through an absolute file URL in the temporary
 * profile's cordis.patch.yml (same pattern as the Agent Teams team-llm
 * fixture). It registers a deterministic LLM adapter on the shipped default
 * provider route, one side-effect tool, and the failpoint checkpoints of
 * `@deepseek-ai/dsh-durable-runtime`.
 *
 * Control: `<runtime>/control/failpoint.json` holds
 * `{name, once?, match?: {tool?}}` and is read fresh at every checkpoint; an
 * absent file disarms every checkpoint. Evidence: every ledger append opens
 * `<runtime>/ledger/effects.jsonl`, writes one JSON row, fsyncs, and closes,
 * so a record visible to the test process survived the host's SIGKILL.
 * `match.tool` compares against the `durable_effect` call's `name` argument.
 */

import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

/** Cordis plugin name. */
export const name = 'durable-fixture'
/** Services the checkpoints and registrations require. */
export const inject = ['llm', 'tools', 'sessions']

/** Registered name of the fixture side-effect tool. */
const TOOL_NAME = 'durable_effect'

/** Session event type observed for the outbox-delivered checkpoint (agent-team bundle). */
const TEAM_DELIVERED_EVENT = 'team/message/delivered'

let nextCall = 0

/** Append one row to the ledger with a durability barrier the SIGKILL cannot outrun. */
function ledgerAppend(runtime, entry) {
  const fd = openSync(join(runtime, 'ledger', 'effects.jsonl'), 'a')
  try {
    writeSync(fd, `${JSON.stringify({ ...entry, at: Date.now() })}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Read the armed failpoint, or `undefined` when no control file is present or parseable. */
function readControl(runtime) {
  try {
    const parsed = JSON.parse(readFileSync(join(runtime, 'control', 'failpoint.json'), 'utf8'))
    return typeof parsed?.name === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Fire one checkpoint: when the armed failpoint matches, commit the deletion
 * of a `once` control file, commit the hit record, then SIGKILL this host —
 * all synchronously, so no host code between the checkpoint and the kill can
 * append further evidence.
 */
function checkFailpoint(runtime, point, toolName) {
  const control = readControl(runtime)
  if (control === undefined || control.name !== point) return
  if (typeof control.match?.tool === 'string' && control.match.tool !== toolName) return
  if (control.once === true) {
    try {
      unlinkSync(join(runtime, 'control', 'failpoint.json'))
    } catch {
      // The control file vanished between read and unlink; the hit still commits.
    }
  }
  ledgerAppend(runtime, { kind: 'failpoint-hit', detail: { name: point } })
  process.kill(process.pid, 'SIGKILL')
}

/** Route a session event through the durability barrier, then fire the checkpoint. */
function flushThenCheck(ctx, runtime, session, point, toolName) {
  void (async () => {
    try {
      await ctx.sessions.flush(session)
    } catch (error) {
      // A rejected flush means the event is not proven durable; the checkpoint stays silent.
      ctx.logger.warn(`durable-fixture: flush before ${point} failed: ${String(error)}`)
      return
    }
    checkFailpoint(runtime, point, toolName)
  })()
}

/** Extract the `durable_effect` `name` argument from a tool/call event's raw JSON. */
function effectNameFromArguments(raw) {
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed?.name === 'string' ? parsed.name : undefined
  } catch {
    return undefined
  }
}

/** Extract the `durable_effect` `name` argument from a parsed execution. */
function effectNameFromExecution(exec) {
  const args = exec.arguments
  return typeof args?.name === 'string' ? args.name : undefined
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function effectCallChunks(specs) {
  const chunks = []
  for (const [index, spec] of specs.entries()) {
    const id = ToolCallId(`durable-fixture-${++nextCall}`)
    const args = JSON.stringify({ name: spec.name, ...(spec.delayMs === undefined ? {} : { delayMs: spec.delayMs }) })
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name: TOOL_NAME, argumentsDelta: args },
      { type: 'block-end', index, block: { type: 'tool-call', id, name: TOOL_NAME, arguments: args } },
    )
  }
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

/** Parse `PARALLEL:A:<delayMs>:B:<delayMs>` into two effect specs. */
function parseParallel(prompt) {
  const match = /^PARALLEL:([A-Za-z0-9_-]+):(\d+):([A-Za-z0-9_-]+):(\d+)$/u.exec(prompt)
  if (match === null) return undefined
  return [
    { name: match[1], delayMs: Number(match[2]) },
    { name: match[3], delayMs: Number(match[4]) },
  ]
}

/** Deterministic keyless adapter: the initial user text selects the whole protocol. */
class DurableFixtureAdapter extends LlmAdapter {
  constructor(runtime) {
    super()
    this.runtime = runtime
  }

  async * stream(options) {
    // Every model attempt is accounted before any chunk so a killed run still
    // proves whether a request reached the model.
    ledgerAppend(this.runtime, { kind: 'model-request' })
    const initial = options.messages.findLast(message => message.role === 'user' && message.source.kind === 'user')
    const prompt = initial?.content[0]?.text?.trim() ?? ''
    const settled = options.messages.some(message => message.role === 'tool')
    let chunks
    if (prompt.startsWith('ECHO:')) {
      chunks = textChunks(prompt.slice('ECHO:'.length))
    } else if (prompt.startsWith('EFFECT:')) {
      const effectName = prompt.slice('EFFECT:'.length)
      chunks = settled ? textChunks(`DONE:${effectName}`) : effectCallChunks([{ name: effectName }])
    } else if (prompt.startsWith('PARALLEL:')) {
      const specs = parseParallel(prompt)
      if (specs === undefined) throw new Error(`durable-fixture: malformed PARALLEL prompt ${JSON.stringify(prompt)}`)
      chunks = settled ? textChunks('DONE:PARALLEL') : effectCallChunks(specs)
    } else {
      throw new Error(`durable-fixture: unrecognized prompt protocol ${JSON.stringify(prompt)}`)
    }
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
    // The complete response's final chunk has been produced but the agent loop
    // has not committed the settled message yet: the model-settled window.
    checkFailpoint(this.runtime, 'model-settled')
  }
}

/**
 * Mount the fixture: adapter, tool, and checkpoint listeners. `config.runtime`
 * is the absolute per-test runtime directory the controller library created.
 */
export function apply(ctx, config) {
  const runtime = config?.runtime
  if (typeof runtime !== 'string' || runtime === '') {
    throw new Error('durable-fixture: config.runtime must be the absolute runtime directory')
  }

  const adapter = new DurableFixtureAdapter(runtime)
  ctx.llm.registerAdapter(['deepseek-official'], adapter)

  // callId → durable_effect `name` argument, so tool/result checkpoints can
  // apply `match.tool` against the logical effect name.
  const effectNames = new Map()

  ctx.tools.register({
    name: TOOL_NAME,
    description: 'Record one named external side effect in the durable fixture ledger, optionally after a delay.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Effect identity recorded in the ledger.' },
        delayMs: { type: 'number', description: 'Optional settle delay in milliseconds before the effect commits.' },
      },
      required: ['name'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      if (typeof args.delayMs === 'number' && args.delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, args.delayMs))
      }
      // The ledger record IS the external side effect: durable before the tool
      // returns, independently accounted across processes.
      ledgerAppend(runtime, { kind: 'tool-effect', detail: { name: args.name } })
      checkFailpoint(runtime, 'external-effect', args.name)
      return `EFFECT_DONE:${String(args.name)}`
    },
  })

  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name === TOOL_NAME) checkFailpoint(runtime, 'dispatch-intent', effectNameFromExecution(exec))
    return next()
  })

  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') {
      flushThenCheck(ctx, runtime, session, 'input-accepted')
      return
    }
    if (event.type === 'agent/inbox/spliced') {
      // The enqueue splice only inserts; a claim splice removes pending input.
      if ((event.data.removedCount ?? 0) > 0) checkFailpoint(runtime, 'input-claimed')
      return
    }
    if (event.type === 'tool/call' && event.data.name === TOOL_NAME) {
      effectNames.set(event.data.callId, effectNameFromArguments(event.data.arguments))
      return
    }
    if (event.type === 'tool/result') {
      const callId = event.data.message.toolCallId
      if (effectNames.has(callId)) flushThenCheck(ctx, runtime, session, 'receipt-stored', effectNames.get(callId))
      return
    }
    if (event.type === TEAM_DELIVERED_EVENT) {
      flushThenCheck(ctx, runtime, session, 'outbox-delivered')
    }
  })
}
