import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Identity } from './server';

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const ack = z.array(z.string()).optional().describe('ids of agentboard channel events this call handles (acknowledges them)');

const escalation = z
  .object({
    preset: z.enum(['default', 'cautious', 'autonomous', 'custom']),
    text: z.string().optional(),
    rules: z.array(z.object({ when: z.string(), action: z.enum(['ask', 'decide', 'fyi']), note: z.string().optional() })).optional(),
  })
  .optional();

const preauth = z
  .array(
    z.object({
      action: z.enum(['git.push', 'git.push_branch', 'git.merge', 'send_message', 'deploy', 'other']),
      scope: z.string(),
      quote: z.string().describe("the user's exact words granting it"),
    }),
  )
  .optional();

const action = z.enum(['git.merge', 'git.push', 'git.push_branch', 'worktree.cleanup']);

/** Tool schemas per role (SPEC §5.4/§5.5 as amended by §18). */
export const MANAGER_TOOLS = {
  create_task: {
    description: 'Create a task the user gave you in chat. (Tasks added on the board already exist: use update_task.)',
    input: {
      title: z.string().max(200),
      description: z.string(),
      kind: z.enum(['code', 'research', 'ops', 'mixed']),
      repo: z.string().optional().describe('absolute path or repos.json key'),
      base_branch: z.string().optional(),
      priority: z.number().int().min(1).max(5).optional(),
      escalation,
      pre_authorized: preauth,
      skills_hint: z.array(z.string()).optional(),
      depends_on: z.array(z.string()).optional(),
      mcp_servers: z.array(z.string()).optional(),
      ack,
    },
  },
  update_task: {
    description: 'Update a task: normalise escalation rules, set status (planned, cancelled, running for rework), notes, auto_allow rules.',
    input: {
      task_id: z.string(),
      patch: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        priority: z.number().int().min(1).max(5).optional(),
        escalation,
        status: z.enum(['planned', 'cancelled', 'running', 'inbox']).optional(),
        notes: z.string().optional(),
        skills_hint: z.array(z.string()).optional(),
        auto_allow: z.array(z.string()).optional(),
        depends_on: z.array(z.string()).optional(),
        kind: z.enum(['code', 'research', 'ops', 'mixed']).optional(),
        repo: z.string().optional(),
        base_branch: z.string().optional(),
        pre_authorized: preauth,
      }),
      ack,
    },
  },
  list_tasks: { description: 'List tasks.', input: { status: z.array(z.string()).optional(), limit: z.number().int().max(200).optional() } },
  get_task: { description: 'Full task with progress, outcome and usage totals.', input: { task_id: z.string() } },
  spawn_worker: {
    description: 'Start a worker for a task. Returns immediately (status "spawning"); a worker_spawned or spawn_failed event follows.',
    input: {
      task_id: z.string(),
      name: z.string().optional().describe('meaningful kebab-case name, e.g. "login-tests"'),
      brief_markdown: z.string(),
      skills: z.array(z.string()).default([]),
      model: z.string().optional(),
      mcp_servers: z.array(z.string()).optional(),
      extra_allow: z.array(z.string()).optional(),
      add_dirs: z.array(z.string()).optional(),
      ack,
    },
  },
  stop_worker: {
    description: 'Stop a worker session (graceful: Esc + 60 s grace, then terminate).',
    input: { worker: z.string().describe('worker name or id'), reason: z.string(), mode: z.enum(['graceful', 'force']).optional(), ack },
  },
  list_workers: { description: 'Workers with name, task, state, last activity and usage.', input: { include_finished: z.boolean().optional() } },
  get_worker_output: { description: 'Last lines of a worker terminal (ANSI stripped).', input: { worker: z.string(), lines: z.number().int().max(300).optional() } },
  decide_permission: {
    description: 'Answer a permission_request event.',
    input: { request_id: z.string(), decision: z.enum(['allow', 'deny']), message: z.string().optional(), remember: z.object({ pattern: z.string(), scope: z.enum(['once', 'task']) }).optional(), ack },
  },
  decide_approval: {
    description: 'Decide a REVERSIBLE approval_request yourself. Irreversible ones must go to escalate(kind="approval", ticket).',
    input: { ticket: z.string(), decision: z.enum(['granted', 'denied']), message: z.string().optional(), ack },
  },
  escalate: {
    description: 'Ask the user. Persisted first; the app alerts the user (coalesced).',
    input: {
      task_id: z.string(),
      worker: z.string().optional(),
      kind: z.enum(['decision', 'approval', 'stuck', 'merge']),
      ticket: z.string().optional().describe('approval ticket R<n> when kind=approval'),
      question: z.string(),
      options: z.array(z.object({ key: z.string(), label: z.string(), consequence: z.string().optional(), action: action.optional() })).min(1).max(6).optional(),
      recommendation: z.object({ option_key: z.string(), rationale: z.string() }).optional(),
      irreversible: z.boolean(),
      urgency: z.enum(['normal', 'urgent']).optional(),
      blocks: z.object({ summary: z.string(), workers: z.array(z.string()).optional(), tasks: z.array(z.string()).optional() }).optional(),
      detail_md: z.string().max(20_000).optional(),
      ack,
    },
  },
  list_attention: { description: 'Attention items (open, snoozed, answered, applied, withdrawn).', input: { status: z.array(z.string()).optional() } },
  ack_attention: { description: 'Confirm you acted on an answered item.', input: { attention_id: z.string(), action_taken: z.string(), ack } },
  record_chat_answer: {
    description: 'Record an answer the user gave in the manager chat. quote must be their exact words.',
    input: { attention_id: z.string(), option_key: z.string().optional(), text: z.string().optional(), quote: z.string() },
  },
  execute_approved: {
    description: 'Run an approved git action (merge/push/cleanup). Requires an answered attention item whose chosen option carries this action, or a pre-authorisation.',
    input: { attention_id: z.string().optional(), task_id: z.string().optional(), preauth_index: z.number().int().optional(), action, ack },
  },
  report_to_user: { description: 'Post a report (shown in the app; never an OS alert).', input: { task_id: z.string(), summary_md: z.string(), kind: z.enum(['completion', 'fyi']), ack } },
  list_skills: { description: 'Skills in ~/.claude/skills and registered repos.', input: { query: z.string().optional() } },
  get_skill: { description: 'Read a skill.', input: { name: z.string() } },
  write_skill: {
    description: 'Create or update a skill (SKILL.md).',
    input: {
      name: z.string(),
      description: z.string().max(1024),
      body_md: z.string(),
      scope: z.enum(['user', 'project']).default('user'),
      task_id: z.string().optional().describe('for scope=project: the task whose worktree receives the skill'),
      update: z.boolean().optional(),
    },
  },
  usage_status: { description: 'Usage: plan windows, pause state, per-session usage.', input: {} },
  ack_event: { description: 'Acknowledge agentboard channel events that need no other action.', input: { event_ids: z.array(z.string()) } },
} as const;

export const WORKER_TOOLS = {
  report_progress: { description: 'Report a milestone (shown on the board).', input: { summary: z.string().max(500), percent: z.number().min(0).max(100).optional() } },
  request_approval: {
    description: 'Ask for approval of an irreversible action. Returns immediately; your manager will tell you the outcome.',
    input: {
      action_kind: z.enum(['git.push', 'git.merge', 'delete', 'deploy', 'send_message', 'spend', 'other']),
      summary: z.string(),
      exact_command_or_tool: z.string(),
      why: z.string(),
      reversible_alternative: z.string().optional(),
    },
  },
  done: {
    description: 'Finish your task. Then stop and wait.',
    input: {
      outcome: z.enum(['success', 'partial', 'failed']),
      summary_md: z.string(),
      artifacts: z.array(z.object({ path: z.string(), desc: z.string().optional() })).optional(),
      branch: z.string().optional(),
      follow_ups: z.array(z.string()).optional(),
      verification: z.string(),
    },
  },
} as const;

export const FALLBACK_B_TOOLS = {
  ask_manager: { description: 'Ask your manager a question (returns immediately; the answer arrives as a message).', input: { question: z.string() } },
  report_to_manager: { description: 'Send your manager a message.', input: { text: z.string() } },
} as const;

type Schemas = typeof MANAGER_TOOLS & typeof WORKER_TOOLS & typeof FALLBACK_B_TOOLS;
export type ToolName = keyof Schemas;

export interface ToolHandlers {
  callTool(id: Identity, name: ToolName, args: Record<string, unknown>): Promise<unknown>;
}

export function registerTools(server: McpServer, id: Identity, h: ToolHandlers, opts: { fallbackB: boolean }): void {
  const sets: Record<string, { description: string; input: Record<string, z.ZodTypeAny> }>[] =
    id.role === 'manager' ? [MANAGER_TOOLS] : opts.fallbackB ? [WORKER_TOOLS, FALLBACK_B_TOOLS] : [WORKER_TOOLS];
  for (const set of sets) {
    for (const [name, def] of Object.entries(set)) {
      server.registerTool(name, { description: def.description, inputSchema: def.input }, async (args: Record<string, unknown>) => {
        try {
          const result = await h.callTool(id, name as ToolName, args ?? {});
          return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result ?? { ok: true }) }] };
        } catch (e) {
          const err = e instanceof ToolError ? { code: e.code, message: e.message, ...e.extra } : { code: 'INTERNAL', message: String((e as Error)?.message ?? e) };
          return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: err }) }] };
        }
      });
    }
  }
}
