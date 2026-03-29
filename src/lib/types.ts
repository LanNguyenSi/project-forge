export type ProjectStatus =
  | 'PENDING'
  | 'PLANNING'
  | 'IMPLEMENTING'
  | 'REVIEWING'
  | 'DONE'
  | 'FAILED'

export type TaskStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'IN_REVIEW'
  | 'CHANGES_REQUESTED'
  | 'APPROVED'
  | 'MERGED'
  | 'FAILED'

export type TaskType = 'PLAN' | 'IMPLEMENT' | 'REVIEW'

export type Stack = 'nextjs' | 'express' | 'fastapi' | 'react' | 'other'

export interface Project {
  id: string
  name: string
  description: string
  stack: string
  status: ProjectStatus
  githubRepo: string | null
  githubUrl: string | null
  createdAt: string
  updatedAt: string
  tasks?: Task[]
  actions?: AgentAction[]
}

export interface Task {
  id: string
  projectId: string
  title: string
  description: string
  type: TaskType
  assignedAgent: string | null
  status: TaskStatus
  branchName: string | null
  prUrl: string | null
  prNumber: number | null
  wave: number
  order: number
  retryCount: number
  createdAt: string
  updatedAt: string
  actions?: AgentAction[]
}

export interface AgentAction {
  id: string
  taskId: string | null
  projectId: string
  agentId: string
  action: string
  content: string | null
  timestamp: string
}

export interface CreateProjectRequest {
  name: string
  description: string
  stack: Stack
  targetRepo?: string
}

export interface CreateTaskRequest {
  title: string
  description: string
  type: TaskType
  wave: number
  order: number
}

export interface CompleteTaskRequest {
  agentId: string
  result: string
  prUrl?: string
  prNumber?: number
  branchName?: string
}

export type SSEEventType =
  | 'project_status_changed'
  | 'task_created'
  | 'task_status_changed'
  | 'agent_action'

export interface SSEEvent {
  type: SSEEventType
  data: Project | Task | AgentAction
  timestamp: string
}
