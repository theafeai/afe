import { FakeVercelApi } from "../src/testing.ts";

export const USER = { id: "usr_alice", username: "alice", name: "Alice" };
export const TEAM = { id: "team_acme", slug: "acme", name: "Acme" };
export const OTHER_TEAM = { id: "team_other", slug: "other", name: "Other" };

/** A team with three projects (one unselected in most tests) and deployments in each. */
export function fakeApi(): FakeVercelApi {
  const api = new FakeVercelApi()
    .addUser(USER)
    .addTeam(TEAM)
    .addTeam(OTHER_TEAM)
    .addProject(TEAM.id, { id: "prj_web", name: "web", updatedAt: 3000 })
    .addProject(TEAM.id, { id: "prj_api", name: "api", updatedAt: 2000 })
    .addProject(TEAM.id, { id: "prj_secret", name: "secret-lab", updatedAt: 1000 })
    .addProject(OTHER_TEAM.id, { id: "prj_x", name: "x", updatedAt: 1000 });
  let t = 1_700_000_000_000;
  for (const projectId of ["prj_web", "prj_api", "prj_secret"]) {
    for (let i = 0; i < 3; i++) {
      t += 1000;
      api.addDeployment(TEAM.id, {
        id: `dpl_${projectId}_${i}`,
        name: projectId.slice(4),
        projectId,
        createdAt: t,
        readyState: "READY",
        target: i === 2 ? "production" : null,
        creator: { uid: USER.id, username: USER.username },
      });
    }
  }
  return api;
}
