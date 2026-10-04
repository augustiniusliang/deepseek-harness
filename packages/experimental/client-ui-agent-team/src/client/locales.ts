/** Agent Teams Web dictionaries. */

/** Locale namespace owned by the Agent Teams Web UI. */
export const NS = 'agent-team'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  trigger: '智能体团队',
  loading: '正在加载团队…',
  unavailable: 'Team 暂不可用',
  failure: '团队持久记录无效：{message}',
  empty: '暂无共享任务，可以通过对话创建',
  roster: '成员',
  tasks: '共享任务',
  model: '模型',
  open: '打开成员会话',
  current: '当前会话',
  owner: 'Owner',
  unowned: '未分配',
  waitingFor: '等待',
  writeScopes: '写入范围',
  'task.expand': '展开',
  'task.collapse': '收起',
  'memberStatus.running': '运行中',
  'memberStatus.inactive': '未运行',
  'memberStatus.provisioning': '准备中',
  'memberStatus.failed': '失败',
  'taskStatus.blocked': '依赖未完成',
  'taskStatus.ready': '可启动',
  'taskStatus.starting': '正在启动',
  'taskStatus.running': '运行中',
  'taskStatus.waiting': '等待 Agent',
  'taskStatus.failed': 'Agent 失败',
  'taskStatus.completed': '已完成',
} satisfies Record<string, string>

/** Agent Teams locale key union. */
export type TeamKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  trigger: 'Agent Team',
  loading: 'Loading Team…',
  unavailable: 'Team is unavailable',
  failure: 'Invalid persisted Team record: {message}',
  empty: 'No shared tasks yet. Create them through the conversation.',
  roster: 'Members',
  tasks: 'Shared tasks',
  model: 'Model',
  open: 'Open member conversation',
  current: 'Current chat',
  owner: 'Owner',
  unowned: 'Unowned',
  waitingFor: 'Waiting for',
  writeScopes: 'Write scopes',
  'task.expand': 'Show more',
  'task.collapse': 'Show less',
  'memberStatus.running': 'Running',
  'memberStatus.inactive': 'Inactive',
  'memberStatus.provisioning': 'Provisioning',
  'memberStatus.failed': 'Failed',
  'taskStatus.blocked': 'Dependencies incomplete',
  'taskStatus.ready': 'Ready to start',
  'taskStatus.starting': 'Starting',
  'taskStatus.running': 'Running',
  'taskStatus.waiting': 'Waiting for agent',
  'taskStatus.failed': 'Agent failed',
  'taskStatus.completed': 'Completed',
} satisfies Record<TeamKey, string>
