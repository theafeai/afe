import type { VercelClient } from "./client.ts";
import type { VercelDeployment, VercelDeploymentListItem, VercelProject } from "./types.ts";

/**
 * Which projects of a connected team Afe observes. Stored in the connection's
 * `config.projectSelection`. A new connection observes nothing until the user
 * chooses (`none`); `all` must be chosen explicitly.
 */
export type ProjectSelection =
  { mode: "none" } | { mode: "all" } | { mode: "selected"; projectIds: string[] };

export const NO_PROJECTS: ProjectSelection = { mode: "none" };

/** Reads a selection from stored config; anything unrecognised means "none" (fail closed). */
export function parseProjectSelection(value: unknown): ProjectSelection {
  if (!value || typeof value !== "object") return NO_PROJECTS;
  const v = value as { mode?: unknown; projectIds?: unknown };
  if (v.mode === "all") return { mode: "all" };
  if (v.mode === "selected" && Array.isArray(v.projectIds)) {
    const ids = v.projectIds.filter((id): id is string => typeof id === "string" && id !== "");
    return ids.length === 0 ? NO_PROJECTS : { mode: "selected", projectIds: [...new Set(ids)] };
  }
  return NO_PROJECTS;
}

/**
 * Parses the body of `PUT /api/connections/vercel/:id/projects`:
 * `{ "projects": "all" }` or `{ "projectIds": ["prj_…"] }` (empty = none).
 */
export function parseSelectionRequest(body: unknown): ProjectSelection | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { projects?: unknown; projectIds?: unknown };
  if (b.projects === "all" && b.projectIds === undefined) return { mode: "all" };
  if (b.projects === undefined && Array.isArray(b.projectIds)) {
    if (!b.projectIds.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id))) {
      return null;
    }
    return parseProjectSelection({ mode: "selected", projectIds: b.projectIds });
  }
  return null;
}

export function isProjectSelected(selection: ProjectSelection, projectId: string): boolean {
  if (selection.mode === "all") return true;
  if (selection.mode === "selected") return selection.projectIds.includes(projectId);
  return false;
}

export class ProjectNotSelectedError extends Error {
  constructor(readonly projectId: string) {
    super(`Vercel project ${projectId} is not selected for this connection`);
    this.name = "ProjectNotSelectedError";
  }
}

/**
 * The only way connector jobs should read deployment data: every call is
 * limited to the selected projects, so data of unselected projects is never
 * requested from Vercel (and anything that slips through is dropped).
 */
export class ScopedVercelReader {
  constructor(
    private readonly client: VercelClient,
    private readonly teamId: string | null,
    private readonly selection: ProjectSelection,
  ) {}

  /** The selected projects that still exist in the team. */
  async listSelectedProjects(): Promise<VercelProject[]> {
    if (this.selection.mode === "none") return [];
    const projects = await this.client.listProjects(this.teamId);
    return projects.filter((p) => isProjectSelected(this.selection, p.id));
  }

  /** Deployments of one selected project. Throws for unselected projects without calling Vercel. */
  async listDeployments(
    projectId: string,
    range: { since?: number; until?: number; max?: number } = {},
  ): Promise<VercelDeploymentListItem[]> {
    if (!isProjectSelected(this.selection, projectId)) throw new ProjectNotSelectedError(projectId);
    const items = await this.client.listDeployments({ teamId: this.teamId, projectId, ...range });
    return items.filter((d) => d.projectId === undefined || d.projectId === projectId);
  }

  /** Deployments of all selected projects (one request per project, or team-wide for "all"). */
  async listAllSelectedDeployments(
    range: { since?: number; until?: number; max?: number } = {},
  ): Promise<VercelDeploymentListItem[]> {
    if (this.selection.mode === "none") return [];
    if (this.selection.mode === "all") {
      return this.client.listDeployments({ teamId: this.teamId, ...range });
    }
    const out: VercelDeploymentListItem[] = [];
    for (const projectId of this.selection.projectIds) {
      out.push(...(await this.listDeployments(projectId, range)));
    }
    return out;
  }

  /** The selection this reader enforces. */
  get projectSelection(): ProjectSelection {
    return this.selection;
  }

  /** One selected project, including `targets` and `lastAliasRequest`. */
  async getProject(projectId: string): Promise<VercelProject> {
    if (!isProjectSelected(this.selection, projectId)) throw new ProjectNotSelectedError(projectId);
    return this.client.getProject(projectId, this.teamId);
  }

  /**
   * One page of deployments, newest first. `projectId` null lists the whole
   * team and is only allowed when observing all projects. Items of unselected
   * projects are dropped.
   */
  async listDeploymentsPage(
    projectId: string | null,
    range: { since?: number; until?: number },
  ): Promise<{ deployments: VercelDeploymentListItem[]; next: number | null }> {
    if (projectId === null) {
      if (this.selection.mode !== "all") throw new ProjectNotSelectedError("*");
    } else if (!isProjectSelected(this.selection, projectId)) {
      throw new ProjectNotSelectedError(projectId);
    }
    const page = await this.client.listDeploymentsPage({
      teamId: this.teamId,
      ...(projectId ? { projectId } : {}),
      ...range,
    });
    return {
      next: page.next,
      deployments: page.deployments.filter((d) =>
        d.projectId === undefined
          ? projectId !== null
          : isProjectSelected(this.selection, d.projectId) &&
            (projectId === null || d.projectId === projectId),
      ),
    };
  }

  /**
   * One deployment. The caller must say which project it expects (from a
   * webhook or a list item), so an unselected project's deployment is never
   * fetched; a response for a different project is discarded.
   */
  async getDeployment(id: string, projectId: string): Promise<VercelDeployment> {
    if (!isProjectSelected(this.selection, projectId)) throw new ProjectNotSelectedError(projectId);
    const deployment = await this.client.getDeployment(id, this.teamId);
    if (!isProjectSelected(this.selection, deployment.projectId)) {
      throw new ProjectNotSelectedError(deployment.projectId);
    }
    return deployment;
  }
}
