import * as assert from 'assert'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as fsHelper from './fs-helper'
import * as io from '@actions/io'
import * as path from 'path'
import {IGitCommandManager} from './git-command-manager'

export async function prepareExistingDirectory(
  git: IGitCommandManager | undefined,
  repositoryPath: string,
  repositoryUrl: string,
  clean: boolean,
  ref: string
): Promise<void> {
  assert.ok(repositoryPath, 'Expected repositoryPath to be defined')
  assert.ok(repositoryUrl, 'Expected repositoryUrl to be defined')

  // Check whether using git or REST API
  if (!git) {
    throw new Error(
      'Git command manager is not defined. Cannot prepare existing directory.'
    )    
  }
  // Fetch URL does not match
  else if (
    !fsHelper.directoryExistsSync(path.join(repositoryPath, '.git')) ||
    repositoryUrl !== (await git.tryGetFetchUrl())
  ) {
    throw new Error(
      `The repository at '${repositoryPath}' does not match the expected URL '${repositoryUrl}'. Please remove the directory and try again.`)
  } else {
    // Delete any index.lock and shallow.lock left by a previously canceled run or crashed git process
    const lockPaths = [
      path.join(repositoryPath, '.git', 'index.lock'),
      path.join(repositoryPath, '.git', 'shallow.lock')
    ]
    for (const lockPath of lockPaths) {
      try {
        await io.rmRF(lockPath)
      } catch (error) {
        core.debug(
          `Unable to delete '${lockPath}'. ${(error as any)?.message ?? error}`
        )
      }
    }

    try {
      core.startGroup('Removing previously created refs, to avoid conflicts')
      // Checkout detached HEAD
      if (!(await git.isDetached())) {
        await git.checkoutDetach()
      }

      // Remove all refs/heads/*
      let branches = await git.branchList(false)
      for (const branch of branches) {
        await git.branchDelete(false, branch)
      }

      // Remove any conflicting refs/remotes/origin/*
      // Example 1: Consider ref is refs/heads/foo and previously fetched refs/remotes/origin/foo/bar
      // Example 2: Consider ref is refs/heads/foo/bar and previously fetched refs/remotes/origin/foo
      if (ref) {
        ref = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`
        if (ref.startsWith('refs/heads/')) {
          const upperName1 = ref.toUpperCase().substr('REFS/HEADS/'.length)
          const upperName1Slash = `${upperName1}/`
          branches = await git.branchList(true)
          for (const branch of branches) {
            const upperName2 = branch.substr('origin/'.length).toUpperCase()
            const upperName2Slash = `${upperName2}/`
            if (
              upperName1.startsWith(upperName2Slash) ||
              upperName2.startsWith(upperName1Slash)
            ) {
              await git.branchDelete(true, branch)
            }
          }
        }
      }
      core.endGroup()

      // Check for submodules and delete any existing files if submodules are present
      if (!(await git.submoduleStatus())) {
        throw new Error('Bad Submodules found, removing existing files')
      }

      // Clean
      if (clean) {
        core.startGroup('Cleaning the repository')
        if (!(await git.tryClean())) {
          throw new Error(
            `The clean command failed. This might be caused by: 1) path too long, 2) permission issue, or 3) file in use. For further investigation, manually run 'git clean -ffdx' on the directory '${repositoryPath}'.`
          )
        } else if (!(await git.tryReset())) {
          throw new Error(
            `The reset command failed. This might be caused by: 1) path too long, 2) permission issue, or 3) file in use. For further investigation, manually run 'git reset --hard' on the directory '${repositoryPath}'.`
        }
        core.endGroup()        
      }
    } catch (error) {
      throw new Error(
        `Unable to prepare the existing repository. The repository will be recreated instead.`
      )
    }
  }
}
