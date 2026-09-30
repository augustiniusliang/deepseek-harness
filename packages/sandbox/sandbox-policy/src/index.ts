/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox fallbacks plus per-session resolution: the file-effect
 * {@link SandboxMode}, the `workspace-write` root, and the override kits (the
 * `sandbox/mode` and `sandbox/extra-roots` events, their folds, and their
 * write paths; the folds are the `sandboxMode` and `sandboxExtraRoots`
 * session-projection units registered here, while the events and write paths
 * come from `./session-mode.ts` and `./session-extra-roots.ts`).
 * Before each agent request, the owner also contributes the resolved policy to
 * the cache-safe runtime-context snapshot. The agent loop logs that snapshot as
 * model history, so replay reconstructs the same mode and root the enforcing
 * consumers resolve without rewriting the stable system prompt.
 *
 * Enforcing filesystem, one-shot bash, and terminal backends read the SAME
 * resolved policy here. The context describes that policy without inventorying
 * capabilities, while each backend retains its own enforcement dialect and each
 * tool owns its operation-specific denial and escalation guidance. The service
 * reads session state once at each operation boundary; executors and providers
 * remain session-free.
 *
 * @module @deepseek-ai/dsh-sandbox-policy
 */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { SandboxExtraRoots } from './types.ts'

export { SANDBOX_MODES, setSandboxMode } from './session-mode.ts'
export { setExtraWritableRoots } from './session-extra-roots.ts'
export type * from './types.ts'

/**
 * Preserve execution-world spelling; enforcing providers resolve filesystem
 * identity on their host. A path claimed by a registered world backend
 * (see {@link SandboxPolicyService.registerPathClaim}) skips host absolute
 * validation: the host's `isAbsolute` rejects that world's spelling (a POSIX
 * WSL path on a Windows host), and the owning backend's filesystem enforces
 * its own absoluteness and fencing.
 */
function resolveWorkspaceRoot(path: string, claimedByWorld = false): string {
  if (!isAbsolute(path) && !claimedByWorld) throw new Error('sandbox-policy: workspace root must be an absolute execution-world path')
  return path
}

/** Render the policy without claiming which capabilities are mounted. */
function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  switch (policy.mode) {
    case 'read-only':
      return 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'workspace-write': {
      const extras = policy.extraWritableRoots === undefined || policy.extraWritableRoots.length === 0
        ? ''
        : ` Additional writable roots: ${JSON.stringify(policy.extraWritableRoots)}.`
      return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}.${extras} Some platform temporary areas may also be writable.`
    }
    case 'danger-full-access':
      return 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
    /* v8 ignore next 4 -- SandboxMode is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
    default: {
      const mode: never = policy.mode
      throw new Error(`unreachable sandbox mode: ${String(mode)}`)
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicyService
  }
}

/**
 * Plugin config: the deployment's sandbox default. All optional — `Config`
 * supplies the defaults (`mode: 'read-only'` is the fail-safe default; a
 * deployment that wants a workspace-writable agent opts in explicitly). The
 * runner choice is NOT here (it is the `ctx.sandbox` provider's config), nor
 * is any per-family knob: this is the one shared policy home.
 */
export interface Config {
  /** File-sandbox mode a session starts from (default: `read-only`). */
  mode?: SandboxMode
  /**
   * Absolute fallback root for agentless calls and sessions without a cwd (default:
   * `process.cwd()`). Normal agent calls use their session cwd instead.
   */
  workspaceRoot?: string
}

/** Inputs that select the sandbox policy for one capability call. */
export interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}

/** The sandbox-mode projection's state schema (state equals the public shape). */
const sandboxModeStateSchema = zod.union([
  zod.literal('read-only'),
  zod.literal('workspace-write'),
  zod.literal('danger-full-access'),
]).nullable()

type SandboxModeState = zod.infer<typeof sandboxModeStateSchema>
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Last logged sandbox-mode override, or null before one (deployment default applies at resolve time). */
    sandboxMode: SandboxModeState
  }
}

/** The extra-roots projection's state schema (state equals the public shape). */
const extraWritableRootsStateSchema: zod.ZodType<SandboxExtraRoots> = zod.array(zod.string()).nullable()

/**
 * The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment
 * default mode, fallback workspace root, and current request-time policy
 * section. Tool layers call {@link resolve} for each execution so a session's
 * mode log and immutable cwd travel together to every enforcing capability.
 */
export class SandboxPolicyService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('read-only'),
    // No schema default: process.cwd() is resolved in the constructor so the
    // stored root is always absolute regardless of how it was supplied.
    workspaceRoot: z.string(),
  })

  static inject = ['sessionProjections']

  /** The deployment default mode — the fallback beneath a session override. */
  readonly defaultMode: SandboxMode
  /** The absolute `workspace-write` fallback root for calls without a session cwd. */
  readonly workspaceRoot: string
  /** World-owned path claims; a claimed path skips host absolute validation at resolve time. */
  private readonly pathClaims = new Set<(path: string) => boolean>()
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // schemastery (static Config) already filled `mode`; the cast records that
    // runtime fact. `workspaceRoot` has NO schema default, so its fallback to
    // the process cwd is real branching, resolved absolute either way.
    this.defaultMode = config.mode as SandboxMode
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())

    ctx.sessionProjections.register({
      key: 'sandboxMode',
      stateVersion: 1,
      stateSchema: sandboxModeStateSchema,
      init: () => null,
      apply: (state, event) => (event.type === 'sandbox/mode' ? event.data.mode : state),
    })

    ctx.sessionProjections.register({
      key: 'sandboxExtraRoots',
      stateVersion: 1,
      stateSchema: extraWritableRootsStateSchema,
      init: () => null,
      apply: (state, event) => (event.type === 'sandbox/extra-roots' ? event.data.roots : state),
      // State IS the wire value (the logged list, or null), and the fold
      // returns a new list only when an event replaces it, so the registry's
      // reference comparison publishes exactly the changes that happened.
      wire: { viewSchema: extraWritableRootsStateSchema, view: state => state },
    })

    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'sandbox:policy',
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY'),
        text: (context) => {
          const session = context.agent?.session
          return session === undefined
            ? ''
            : renderPolicyContext(this.resolve({ session }))
        },
      })
    })
  }

  /**
   * Resolve the complete policy for one capability call. An approved explicit
   * mode outranks the session's last `sandbox/mode` event, which outranks the
   * deployment default. A session cwd is its workspace-write boundary; the
   * configured root is the fallback for agentless calls and sessions without a
   * cwd. The session's last `sandbox/extra-roots` event supplies the extra
   * writable roots; the field is absent when no event or an empty list was
   * logged, which is exactly the single-root policy. A workspace root claimed
   * by a registered execution world skips host absolute-path validation (see
   * {@link registerPathClaim}).
   * @param request - optional session and approved mode override.
   * @returns the fully resolved per-call mode and absolute workspace root.
   */
  resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const { session } = request
    const extraRoots = session === undefined
      ? undefined
      : this.ctx.sessionProjections.stateOf(session, 'sandboxExtraRoots') ?? undefined
    const workspaceRoot = session?.header.cwd ?? this.workspaceRoot
    return {
      mode: request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode,
      workspaceRoot: resolveWorkspaceRoot(workspaceRoot, this.claimedByWorld(workspaceRoot)),
      ...session === undefined ? {} : { sessionId: session.id },
      ...extraRoots === undefined || extraRoots.length === 0 ? {} : { extraWritableRoots: [...extraRoots] },
    }
  }

  /**
   * Register an execution world's path ownership claim. While registered, a
   * claimed workspace root skips this host's absolute-path validation at
   * resolve time — the claiming world's backend enforces its own path grammar
   * and fencing. The world registry wires its ownership here; this service
   * never imports the world side (the dependency points one way).
   * @param claim - predicate reporting whether a path belongs to the caller's world.
   * @returns the claim's disposer.
   */
  registerPathClaim(claim: (path: string) => boolean): () => void {
    this.pathClaims.add(claim)
    return () => {
      this.pathClaims.delete(claim)
    }
  }

  /** Whether any registered world claims a path. */
  private claimedByWorld(path: string): boolean {
    for (const claim of this.pathClaims) {
      if (claim(path)) return true
    }
    return false
  }

  /**
   * Read the session override without applying the deployment default.
   * @param session - session whose log supplies the override.
   * @returns the last logged mode, or `undefined` without one.
   */
  overrideOf(session: Session): SandboxMode | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'sandboxMode') ?? undefined
  }
}

export default SandboxPolicyService
