import { describe, it } from 'vitest'

describe('repro: schedule delivery/receipt double-write window', () => {
  // BLOCKED SEAM: schedule delivery cannot activate in this facility's
  // headless composition. `ScheduleService.inject` requires the
  // `sessionController` service (packages/schedule/schedule/src/index.ts:101),
  // which is the Host Web Session controller (packages/api/session-controller);
  // the `dsh-headless` bundle composes no session controller, and the schedule
  // package documents this exactly: "Schedule cannot be mounted alone in a
  // headless or SDK-only composition: delivery requires the Host Web Session
  // controller and a Session persistence backend, because a delivery commits
  // only after the Session acknowledges session/flush"
  // (packages/schedule/schedule/README.md, "Use this package"). The
  // outbox-delivered checkpoint is therefore implemented at the agent-team
  // `team/message/delivered` session event instead (see README failpoint
  // table); reproducing the schedule double-write window needs a Web-profile
  // composition with a browser-free session controller, deferred until such a
  // composition exists.
  it.skip('cannot run headless: schedule delivery requires the Host Web session controller', () => {})
})
