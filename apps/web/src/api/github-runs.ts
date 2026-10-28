import { request } from "./client.ts";

export interface WorkflowStep {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}
export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  steps: WorkflowStep[];
}
export interface WorkflowProgress {
  run: {
    id: number;
    attempt: number;
    name: string;
    status: string | null;
    conclusion: string | null;
    url: string;
  };
  jobs: WorkflowJob[];
  partial: boolean;
  checkedAt: string;
  nextPollMs: number | null;
}
const path = (id: string) => `/api/events/${encodeURIComponent(id)}/github-run`;
export const fetchWorkflowProgress = (id: string, signal: AbortSignal) =>
  request<WorkflowProgress>("GET", path(id), undefined, signal);
export const fetchWorkflowJobLog = (id: string, jobId: number, signal: AbortSignal) =>
  request<{ text: string; jobId: number; attempt: number }>(
    "GET",
    `${path(id)}/jobs/${jobId}/log`,
    undefined,
    signal,
  );
