// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as Octokit from '@octokit/rest';

import {getPri, getType} from './slo';
import {Flags, Issue, IssueResult, Repo} from './types';
import {octo, repos} from './util';

import Table = require('cli-table');
import {isTriaged, isOutOfSLO, hasLabel, isApi, isPullRequest, hoursOld, getApi} from './slo';
const truncate = require('truncate');
const CSV = require('csv-string');

export async function getIssues(flags?: Flags): Promise<IssueResult[]> {
  const promises = new Array<Promise<IssueResult>>();
  repos.forEach(repo => {
    // if we're filtering by --language, don't even snag the issues
    if (flags && flags.language && repo.language !== flags.language) {
      return;
    }
    promises.push(getRepoIssues(repo, flags));
  });
  return Promise.all(promises);
}

async function getRepoIssues(repo: Repo, flags?: Flags): Promise<IssueResult> {
  const [owner, name] = repo.repo.split('/');
  const result = {issues: new Array<Issue>(), repo};
  let res: Octokit.AnyResponse;
  let i = 1;
  do {
    try {
      res = await octo.issues.getForRepo(
          {owner, repo: name, state: 'open', per_page: 100, page: i});
    } catch (e) {
      console.error(`Error fetching issues for ${repo.repo}.`);
      console.error(e);
      throw e;
    }
    for (const r of res.data as Issue[]) {
      r.language = repo.language;
      r.repo = repo.repo;
      r.type = getType(r);
      r.api = getApi(r);
      r.isOutOfSLO = isOutOfSLO(r);
      r.isTriaged = isTriaged(r);
      r.pri = getPri(r);
      r.isPR = isPullRequest(r);

      let use = true;
      if (flags) {
        if (flags.api && r.api !== flags.api) {
          use = false;
        }
        if (flags.repo && r.repo !== flags.repo) {
          use = false;
        }
        if (flags.api && r.api !== flags.api) {
          use = false;
        }
        if (flags.outOfSlo && !r.isOutOfSLO) {
          use = false;
        }
        if (flags.untriaged && r.isTriaged) {
          use = false;
        }
        if (flags.pri && r.pri !== flags.pri) {
          use = false;
        }
        if (flags.pr && !r.isPR) {
          use = false;
        }
        if (flags.type && r.type !== flags.type) {
          use = false;
        }
      }
      if (use) {
        result.issues.push(r);
      }
    }
    i++;
  } while (res.headers && res.headers.link &&
           res.headers.link.indexOf('rel="last"') > -1);
  return result;
}

export interface IssueOptions {
  csv?: boolean;
  untriaged?: boolean;
  outOfSLO?: boolean;
  repository?: string;
  language?: string;
  api?: string;
  pr?: boolean;
}

export async function tagIssues() {
  const promises = new Array<Promise<void|Octokit.AnyResponse>>();
  const repos = await getIssues();
  repos.forEach(r => {
    r.issues.forEach(i => {
      const [owner, name] = r.repo.repo.split('/');
      i.repo = name;
      i.owner = owner;
      if (!i.isTriaged && !hasLabel(i, 'triage me') &&
          hoursOld(i.created_at) > 16) {
        console.log(`Tagging ${i.repo}#${i.number} with 'triage me'`);
        promises.push(tagIssue(i, 'triage me'));
      } else if (i.isTriaged && hasLabel(i, 'triage me')) {
        console.log(`Un-Tagging ${i.repo}#${i.number} with 'triage me'`);
        promises.push(untagIssue(i, 'triage me'));
      }
      if (i.isOutOfSLO && !hasLabel(i, ':rotating_light:')) {
        console.log(`Tagging ${i.repo}#${i.number} with '🚨'`);
        promises.push(tagIssue(i, ':rotating_light:'));
      } else if (!i.isOutOfSLO && hasLabel(i, ':rotating_light:')) {
        console.log(`Un-tagging ${i.repo}#${i.number} with '🚨'`);
        promises.push(untagIssue(i, ':rotating_light:'));
      }
    });
  });
  await Promise.all(promises);
}

function tagIssue(i: Issue, label: string): Promise<void|Octokit.AnyResponse> {
  return octo.issues
      .addLabels({
        labels: [label],
        number: i.number,
        owner: i.owner,
        repo: i.repo
        // tslint:disable-next-line no-any
      } as any)
      .catch(e => {
        console.error(`Error tagging ${i.repo}#${i.number} with '${label}'`);
        console.error(e);
      });
}

function untagIssue(
    i: Issue, label: string): Promise<void|Octokit.AnyResponse> {
  return octo.issues
      .removeLabel(
          {name: label, number: i.number, owner: i.owner, repo: i.repo})
      .catch(e => {
        console.error(`Error un-tagging ${i.repo}#${i.number} with '${label}'`);
        console.error(e);
      });
}

// tslint:disable-next-line no-any
export async function showIssues(options: Flags) {
  const repos = await getIssues(options);
  const issues = new Array<Issue>();
  repos.forEach(r => {
    r.issues.forEach(i => issues.push(i));
  });
  let table: Table;
  const output = new Array<string>();
  const head = ['Issue', 'Triaged', 'InSLO', 'Title', 'Language', 'API', 'Pri'];

  if (options.csv) {
    output.push(CSV.stringify(head));
  } else {
    table = new Table({head});
  }

  issues.forEach(issue => {
    const values = [
      issue.html_url,
      options.csv ? issue.isTriaged : (issue.isTriaged ? '🦖' : '🚨'),
      options.csv ? !issue.isOutOfSLO : (!issue.isOutOfSLO ? '🦖' : '🚨'),
      truncate(issue.title, 75), issue.language, issue.api || '',
      issue.pri || ''
    ];
    if (options.csv) {
      output.push(CSV.stringify(values));
    } else {
      table.push(values);
    }
  });

  if (table!) {
    output.push(table!.toString());
  }

  output.forEach(l => process.stdout.write(l));
  process.stdout.write('\n');
}
