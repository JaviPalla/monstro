"use strict";

const { execFileSync } = require("child_process");
const config = require("./config");

const GQL_URL = "https://api.github.com/graphql";
const REST_URL = "https://api.github.com";

let cachedToken = null;
let cachedTokenSource = null;

function resolveToken() {
  if (cachedToken) return { token: cachedToken, source: cachedTokenSource };

  if (process.env.GITHUB_TOKEN) {
    cachedToken = process.env.GITHUB_TOKEN.trim();
    cachedTokenSource = "env:GITHUB_TOKEN";
    return { token: cachedToken, source: cachedTokenSource };
  }
  try {
    const out = execFileSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000 }).trim();
    if (out) {
      cachedToken = out;
      cachedTokenSource = "gh CLI";
      return { token: cachedToken, source: cachedTokenSource };
    }
  } catch {
    /* gh no disponible o sin login: probamos config */
  }
  const stored = config.load().token;
  if (stored) {
    cachedToken = stored;
    cachedTokenSource = "config.json";
    return { token: cachedToken, source: cachedTokenSource };
  }
  return { token: null, source: null };
}

function invalidateTokenCache() {
  cachedToken = null;
  cachedTokenSource = null;
}

async function gql(query, variables) {
  const { token } = resolveToken();
  if (!token) throw new Error("NO_TOKEN");
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "pulpo-app",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.errors?.length) throw new Error(payload.errors[0].message);
  return payload.data;
}

async function rest(method, path, body) {
  const { token } = resolveToken();
  if (!token) throw new Error("NO_TOKEN");
  const res = await fetch(`${REST_URL}${path}`, {
    method,
    headers: {
      Authorization: `bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "pulpo-app",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
  return json;
}

const PR_LIST_FIELDS = `
  id number title url isDraft state createdAt updatedAt
  baseRefName headRefName isCrossRepository
  headRepository { nameWithOwner }
  author { login avatarUrl }
  mergeable mergeStateStatus reviewDecision
  additions deletions changedFiles
  comments { totalCount }
  labels(first: 6) { nodes { name color } }
  reviewRequests(first: 10) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } }
  }
  latestReviews(first: 10) { nodes { author { login } state } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

async function viewer() {
  const data = await gql(`query { viewer { login avatarUrl } }`);
  return data.viewer;
}

async function listPRs(repoFullName, states) {
  const [owner, name] = repoFullName.split("/");
  const data = await gql(
    `query ($owner: String!, $name: String!, $states: [PullRequestState!]) {
       repository(owner: $owner, name: $name) {
         pullRequests(states: $states, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
           nodes { ${PR_LIST_FIELDS} }
         }
       }
     }`,
    { owner, name, states },
  );
  if (!data.repository) throw new Error(`Repo no accesible: ${repoFullName}`);
  return data.repository.pullRequests.nodes;
}

async function prDetail(repoFullName, number) {
  const [owner, name] = repoFullName.split("/");
  const data = await gql(
    `query ($owner: String!, $name: String!, $number: Int!) {
       repository(owner: $owner, name: $name) {
         pullRequest(number: $number) {
           ${PR_LIST_FIELDS}
           bodyHTML
           commits(last: 1) {
             nodes { commit { statusCheckRollup { state contexts(first: 30) { nodes {
               __typename
               ... on CheckRun { name conclusion status detailsUrl }
               ... on StatusContext { context state targetUrl }
             } } } } }
           }
         }
       }
     }`,
    { owner, name, number },
  );
  return data.repository.pullRequest;
}

/** Merge SIEMPRE con merge commit. Squash y rebase-merge no existen en esta casa. */
async function mergePR(repoFullName, number, { deleteBranch, headRefName, isCrossRepository }) {
  const result = await rest("PUT", `/repos/${repoFullName}/pulls/${number}/merge`, {
    merge_method: "merge",
  });
  let branchDeleted = false;
  if (deleteBranch && !isCrossRepository) {
    try {
      await rest("DELETE", `/repos/${repoFullName}/git/refs/heads/${encodeURIComponent(headRefName)}`);
      branchDeleted = true;
    } catch {
      /* la rama puede estar protegida o ya borrada: no es fatal */
    }
  }
  return { merged: result.merged === true, sha: result.sha, branchDeleted };
}

/** Update branch SIEMPRE con rebase (así se hacen los pull aquí). */
async function updateBranchRebase(prNodeId) {
  const data = await gql(
    `mutation ($id: ID!) {
       updatePullRequestBranch(input: { pullRequestId: $id, updateMethod: REBASE }) {
         pullRequest { number mergeStateStatus }
       }
     }`,
    { id: prNodeId },
  );
  return data.updatePullRequestBranch.pullRequest;
}

module.exports = {
  resolveToken,
  invalidateTokenCache,
  viewer,
  listPRs,
  prDetail,
  mergePR,
  updateBranchRebase,
};
