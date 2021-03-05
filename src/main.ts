import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { GetResponseDataTypeFromEndpointMethod } from "@octokit/types";
import * as yaml from "js-yaml";
import { IMinimatch, Minimatch } from "minimatch";
import {
  ListReposWithAccessToSelfHostedRunnerGroupInOrgResponse,
  ListSelfHostedRunnersGroupResponse,
  RepoTypes,
  RunnerGroup,
  StringOrMatchConfig,
  MatchConfig
} from "./types";

async function run() {
  try {
    core.info("Begin Org Self Hosted Runner Groups Sync");

    const token = core.getInput("org-auth-token", { required: true });
    const configPath = core.getInput("configuration-path", { required: true });
    const repoType = core.getInput("org-repo-type", { required: true });
    let orgName = core.getInput("org-name", { required: false });
    const shouldOverwrite =
      core.getInput("should-overwrite", {
        required: false
      }) == "true";
    const shouldCreateMissingGroups =
      core.getInput("should-create-missing", {
        required: false
      }) == "true";
    const isDryRun = core.getInput("dry-run", { required: false }) == "true";

    if (!(orgName && orgName.trim())) {
      orgName = github.context.repo.owner;
    }

    core.debug(
      `Using the configurations in ${configPath} to manage groups in ${orgName} with the ${repoType} repos`
    );
    core.debug(`Will overwrite manually added repos: ${shouldOverwrite}`);
    core.debug(`Will create new groups: ${shouldCreateMissingGroups}`);
    core.debug(`Is DryRun: ${isDryRun}`);

    const client = new github.GitHub(token);

    // If dry-run is enabled then prevent post requests
    client.hook.wrap("request", async (request, options) => {
      if (isDryRun && options.method != "GET") {
        core.info(
          "Dry Run Enabled: Preventing non-get requests. The request would have been:"
        );
        core.info(
          `${options.method} ${options.url}: ${JSON.stringify(options)}`
        );
        return {
          data: undefined,
          /** Response status number */
          status: 400,

          /** Response headers */
          headers: {}
        } as Octokit.Response<any>;
      } else {
        return request(options);
      }
    });

    // Load up all runners for the github org
    core.debug(`Loading Repos for Org`);
    const listForOrgOptions = client.repos.listForOrg.endpoint.merge({
      org: orgName,
      type: repoType as RepoTypes
    });

    type listRepoResponseType = GetResponseDataTypeFromEndpointMethod<
      typeof client.repos.listForOrg
    >;
    const repositories = (await client.paginate(
      listForOrgOptions
    )) as listRepoResponseType;

    // Get the existing runner groups
    core.debug(`Getting existing runner groups`);
    const existingRunnerGroups = await getExistingRunnerGroups(client, orgName);

    const groupGlobs: Map<string, StringOrMatchConfig[]> = await getGroupGlobs(
      client,
      configPath
    );

    // Validate managed runner groups
    core.debug(`Validating groups`);
    const groupsThatAreValid: Map<RunnerGroup,StringOrMatchConfig[]> = new Map();
    const groupsToAdd: Map<string, StringOrMatchConfig[]> = new Map();
    const invalidGroups: string[] = [];
    for (const [group, globs] of groupGlobs.entries()) {
      core.debug(`validating ${group}`);
      const matchingExistingGroup = existingRunnerGroups.filter(
        g => g.name == group
      )[0];
      if (!matchingExistingGroup) {
        groupsToAdd.set(group, globs);
      } else if (isSupportedRunnerGroup(matchingExistingGroup)) {
        groupsThatAreValid.set(matchingExistingGroup, globs);
      } else {
        invalidGroups.push(group);
      }
    }

    // Sync existing managed runner groups with repos
    core.debug(`Syncing groups`);
    for (const [existingGroup, globs] of groupsThatAreValid.entries()) {
      core.debug(`syncing ${existingGroup.name}`);
      await syncExistingGroupToRepo(
        client,
        orgName,
        existingGroup.id,
        repositories,
        globs,
        shouldOverwrite
      );
    }

    // Create missing managed runner groups with matching repos
    core.debug(`Adding missing groups`);
    if (shouldCreateMissingGroups) {
      for (const [group, globs] of groupsToAdd.entries()) {
        core.debug(`creating ${group}`);
        await addMissingGroupToRepo(
          client,
          orgName,
          group,
          repositories,
          globs
        );
      }
    }
    core.info("Sync is complete")
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
}

function isSupportedRunnerGroup(group: RunnerGroup): boolean {
  core.debug(`    checking to see if ${group.name} is supported`);
  if (group.visibility != "selected") {
    core.warning(
      `the group(${group.name}) must be marked as "selected" visibility for it to be supported`
    );
  }
  core.debug(`    group is supported`);
  return true;
}

async function getGroupGlobs(
  client: github.GitHub,
  configurationPath: string
): Promise<Map<string, StringOrMatchConfig[]>> {
  const configurationContent: string = await fetchContent(
    client,
    configurationPath
  );

  // loads (hopefully) a `{[group:string]: string | StringOrMatchConfig[]}`, but is `any`:
  const configObject: any = yaml.safeLoad(configurationContent);

  // transform `any` => `Map<string,StringOrMatchConfig[]>` or throw if yaml is malformed:
  return getGroupGlobMapFromObject(configObject);
}

async function fetchContent(
  client: github.GitHub,
  repoPath: string
): Promise<string> {
  const response: any = await client.repos.getContents({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    path: repoPath,
    ref: github.context.sha
  });

  return Buffer.from(response.data.content, response.data.encoding).toString();
}

function getGroupGlobMapFromObject(
  configObject: any
): Map<string, StringOrMatchConfig[]> {
  const groupGlobs: Map<string, StringOrMatchConfig[]> = new Map();
  for (const group in configObject) {
    if (typeof configObject[group] === "string") {
      groupGlobs.set(group, [configObject[group]]);
    } else if (configObject[group] instanceof Array) {
      groupGlobs.set(group, configObject[group]);
    } else {
      throw Error(
        `found unexpected type for group ${group} (should be string or array of globs)`
      );
    }
  }

  return groupGlobs;
}

function printPattern(matcher: IMinimatch): string {
  return (matcher.negate ? "!" : "") + matcher.pattern;
}

function toMatchConfig(config: StringOrMatchConfig): MatchConfig {
  if (typeof config === "string") {
    return {
      any: [config]
    };
  }

  return config;
}

function checkGlobs(repoName: string, globs: StringOrMatchConfig[]): boolean {
  for (const glob of globs) {
    core.debug(` checking pattern ${JSON.stringify(glob)}`);
    const matchConfig = toMatchConfig(glob);
    if (checkMatch(repoName, matchConfig)) {
      return true;
    }
  }
  return false;
}

function checkMatch(repoName: string, matchConfig: MatchConfig): boolean {
  if (matchConfig.all !== undefined) {
    if (!checkAll(repoName, matchConfig.all)) {
      return false;
    }
  }

  if (matchConfig.any !== undefined) {
    if (!checkAny(repoName, matchConfig.any)) {
      return false;
    }
  }

  return true;
}

// equivalent to "Array.some()" but expanded for debugging and clarity
function checkAny(repoName: string, globs: string[]): boolean {
  const matchers = globs.map(g => new Minimatch(g));
  core.debug(`  checking "any" patterns`);
  if (isMatch(repoName, matchers)) {
    core.debug(`  "any" patterns matched against ${repoName}`);
    return true;
  }

  core.debug(`  "any" patterns did not match any files`);
  return false;
}

// equivalent to "Array.every()" but expanded for debugging and clarity
function checkAll(repoName: string, globs: string[]): boolean {
  const matchers = globs.map(g => new Minimatch(g));
  core.debug(` checking "all" patterns`);
  if (!isMatch(repoName, matchers)) {
    core.debug(`  "all" patterns did not match against ${repoName}`);
    return false;
  }
  core.debug(`  "all" patterns matched all files`);
  return true;
}

function isMatch(repoName: string, matchers: IMinimatch[]): boolean {
  core.debug(`    matching patterns against repoName ${repoName}`);
  for (const matcher of matchers) {
    core.debug(`   - ${printPattern(matcher)}`);
    if (!matcher.match(repoName)) {
      core.debug(`   ${printPattern(matcher)} did not match`);
      return false;
    }
  }

  core.debug(`   all patterns matched`);
  return true;
}

function getMatchingReposIds(
  repositories: Octokit.ReposListForOrgResponse,
  globs: StringOrMatchConfig[]
): number[] {
  const repositoryIds: number[] = [];
  for (const [n, repo] of repositories.entries()) {
    if (checkGlobs(repo.name, globs)) {
      repositoryIds.push(repo.id);
    }
  }
  return repositoryIds;
}

async function getExistingRunnerGroups(
  client: github.GitHub,
  orgName: string
): Promise<Array<RunnerGroup>> {
  const apiResponse = await client.request(
    "GET /orgs/{org}/actions/runner-groups",
    {
      org: orgName
    }
  );
  const orgRunnerGroupsResponse = apiResponse.data as ListSelfHostedRunnersGroupResponse;
  return orgRunnerGroupsResponse.runner_groups;
}

async function syncExistingGroupToRepo(
  client: github.GitHub,
  orgName: string,
  runnerGroupId: number,
  repositories: Octokit.ReposListForOrgResponse,
  globs: StringOrMatchConfig[],
  shouldOverwrite: boolean
) {
  const repositoryIds: number[] = [];
  if (!shouldOverwrite) {
    const existingRepos = await getSelectedReposForRunnerGroups(
      client,
      orgName,
      runnerGroupId
    );
    if (existingRepos.repositories) {
      for (const [i, repo] of existingRepos.repositories?.entries()) {
        repositoryIds.push(repo.id);
      }
    }
  }

  const matchingRepoIds = getMatchingReposIds(repositories, globs);
  const allRepositoryIds = repositoryIds.concat(matchingRepoIds);

  setSelectedReposForRunnerGroups(
    client,
    orgName,
    runnerGroupId,
    allRepositoryIds
  );
}

async function addMissingGroupToRepo(
  client: github.GitHub,
  orgName: string,
  groupName: string,
  repositories: Octokit.ReposListForOrgResponse,
  globs: StringOrMatchConfig[]
) {
  const matchingRepoIds = getMatchingReposIds(repositories, globs);

  await client.request("POST /orgs/{org}/actions/runner-groups", {
    org: orgName,
    name: groupName,
    selected_repository_ids: matchingRepoIds,
    visibility: "selected"
  });
}

async function getSelectedReposForRunnerGroups(
  client: github.GitHub,
  orgName: string,
  runnerGroupId: number
): Promise<ListReposWithAccessToSelfHostedRunnerGroupInOrgResponse> {
  const apiResponse = await client.request(
    "GET /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories",
    {
      org: orgName,
      runner_group_id: runnerGroupId
    }
  );
  return apiResponse.data as ListReposWithAccessToSelfHostedRunnerGroupInOrgResponse;
}

async function setSelectedReposForRunnerGroups(
  client: github.GitHub,
  orgName: string,
  runnerGroupId: number,
  repositoryIds: number[]
) {
  await client.request(
    "PUT /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories",
    {
      org: orgName,
      runner_group_id: runnerGroupId,
      selected_repository_ids: repositoryIds
    }
  );
}

run();
