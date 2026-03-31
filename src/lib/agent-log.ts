import { prisma } from './prisma'
import { broadcastToProject } from './sse'

export interface LogActionParams {
  projectId: string
  taskId?: string
  agentId: string
  action: string
  message?: string
  data?: Record<string, unknown>
}

/**
 * Log an agent action to the database and broadcast via SSE.
 */
export async function logAction(params: LogActionParams) {
  const { projectId, taskId, agentId, action, message, data } = params

  const content = (message || data)
    ? JSON.stringify({ message, ...data })
    : null

  const record = await prisma.agentAction.create({
    data: {
      projectId,
      taskId: taskId ?? null,
      agentId,
      action,
      content,
    },
  })

  broadcastToProject(projectId, {
    type: 'agent_action',
    data: {
      ...record,
      timestamp: record.timestamp.toISOString(),
    } as any,
    timestamp: new Date().toISOString(),
  })

  return record
}

/**
 * Update a project's status and log the transition.
 */
export async function updateProjectStatus(
  projectId: string,
  status: string,
  agentId: string
) {
  const project = await prisma.project.update({
    where: { id: projectId },
    data: { status: status as any },
  })

  await logAction({
    projectId,
    agentId,
    action: 'project_status_changed',
    message: `Project status → ${status}`,
    data: { newStatus: status },
  })

  broadcastToProject(projectId, {
    type: 'project_status_changed',
    data: project as any,
    timestamp: new Date().toISOString(),
  })

  return project
}

/**
 * Update a task's status and log the transition.
 */
export async function updateTaskStatus(
  taskId: string,
  projectId: string,
  status: string,
  agentId: string
) {
  const task = await prisma.task.update({
    where: { id: taskId },
    data: { status: status as any },
  })

  await logAction({
    projectId,
    taskId,
    agentId,
    action: 'task_status_changed',
    message: `Task "${task.title}" → ${status}`,
    data: { newStatus: status },
  })

  broadcastToProject(projectId, {
    type: 'task_status_changed',
    data: task as any,
    timestamp: new Date().toISOString(),
  })

  return task
}
