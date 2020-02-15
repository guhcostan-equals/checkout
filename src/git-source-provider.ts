import * as assert from 'assert'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as fsHelper from './fs-helper'
import * as gitCommandManager from './git-command-manager'
import * as githubApiHelper from './github-api-helper'
import * as io from '@actions/io'
import * as path from 'path'
import * as refHelper from './ref-helper'
import * as stateHelper from './state-helper'
import {default as uuid} from 'uuid/v4'
import {IGitCommandManager} from './git-command-manager'
import {IGitSourceSettings} from './git-source-settings'

const hostname = 'github.com'
const extraHeaderKey = `http.https://${hostname}/.extraheader`
const sshCommandKey = 'core.sshCommand'

export async function getSource(settings: IGitSourceSettings): Promise<void> {
  // Repository URL
  core.info(
    `Syncing repository: ${settings.repositoryOwner}/${settings.repositoryName}`
  )
  const repositoryUrl = `https://${hostname}/${encodeURIComponent(
    settings.repositoryOwner
  )}/${encodeURIComponent(settings.repositoryName)}`
  const sshRepositoryUrl = settings.sshKey
    ? `ssh://git@${hostname}/${encodeURIComponent(
        settings.repositoryOwner
      )}/${encodeURIComponent(settings.repositoryName)}.git`
    : ''

  // Remove conflicting file path
  if (fsHelper.fileExistsSync(settings.repositoryPath)) {
    await io.rmRF(settings.repositoryPath)
  }

  // Create directory
  let isExisting = true
  if (!fsHelper.directoryExistsSync(settings.repositoryPath)) {
    isExisting = false
    await io.mkdirP(settings.repositoryPath)
  }

  // Git command manager
  const git = await getGitCommandManager(settings)

  // Prepare existing directory, otherwise recreate
  if (isExisting) {
    await prepareExistingDirectory(
      git,
      settings.repositoryPath,
      repositoryUrl,
      settings.clean
    )
  }

  if (!git) {
    // Downloading using REST API
    core.info(`The repository will be downloaded using the GitHub REST API`)
    core.info(
      `To create a local Git repository instead, add Git ${gitCommandManager.MinimumGitVersion} or higher to the PATH`
    )
    await githubApiHelper.downloadRepository(
      settings.authToken,
      settings.repositoryOwner,
      settings.repositoryName,
      settings.ref,
      settings.commit,
      settings.repositoryPath
    )
  } else {
    // Save state for POST action
    stateHelper.setRepositoryPath(settings.repositoryPath)

    // Initialize the repository
    if (
      !fsHelper.directoryExistsSync(path.join(settings.repositoryPath, '.git'))
    ) {
      await git.init()
      await git.remoteAdd('origin', sshRepositoryUrl || repositoryUrl)
    }

    // Disable automatic garbage collection
    if (!(await git.tryDisableAutomaticGarbageCollection())) {
      core.warning(
        `Unable to turn off git automatic garbage collection. The git fetch operation may trigger garbage collection and cause a delay.`
      )
    }

    // Remove possible previous auth settings
    await removeGitConfig(git, extraHeaderKey)
    await removeGitConfig(git, sshCommandKey)

    try {
      // Config http extra header
      await configureAuthToken(git, settings.authToken)

      // Configure ssh auth
      await configureSsh(git, settings)

      // LFS install
      if (settings.lfs) {
        await git.lfsInstall()
      }

      // Fetch
      const refSpec = refHelper.getRefSpec(settings.ref, settings.commit)
      await git.fetch(settings.fetchDepth, refSpec)

      // Checkout info
      const checkoutInfo = await refHelper.getCheckoutInfo(
        git,
        settings.ref,
        settings.commit
      )

      // LFS fetch
      // Explicit lfs-fetch to avoid slow checkout (fetches one lfs object at a time).
      // Explicit lfs fetch will fetch lfs objects in parallel.
      if (settings.lfs) {
        await git.lfsFetch(checkoutInfo.startPoint || checkoutInfo.ref)
      }

      // Checkout
      await git.checkout(checkoutInfo.ref, checkoutInfo.startPoint)

      // Dump some info about the checked out commit
      await git.log1()
    } finally {
      if (!settings.persistCredentials) {
        await removeGitConfig(git, extraHeaderKey)
      }
    }
  }
}

export async function cleanup(repositoryPath: string): Promise<void> {
  // Repo exists?
  if (
    !repositoryPath ||
    !fsHelper.fileExistsSync(path.join(repositoryPath, '.git', 'config'))
  ) {
    return
  }

  let git: IGitCommandManager
  try {
    git = await gitCommandManager.CreateCommandManager(repositoryPath, false)
  } catch {
    return
  }

  // Remove extraheader
  await removeGitConfig(git, extraHeaderKey)
}

async function getGitCommandManager(
  settings: IGitSourceSettings
): Promise<IGitCommandManager> {
  core.info(`Working directory is '${settings.repositoryPath}'`)
  let git = (null as unknown) as IGitCommandManager
  try {
    return await gitCommandManager.CreateCommandManager(
      settings.repositoryPath,
      settings.lfs
    )
  } catch (err) {
    // Git is required for LFS
    if (settings.lfs) {
      throw err
    }

    // Otherwise fallback to REST API
    return (null as unknown) as IGitCommandManager
  }
}

async function prepareExistingDirectory(
  git: IGitCommandManager,
  repositoryPath: string,
  repositoryUrl: string,
  clean: boolean
): Promise<void> {
  let remove = false

  // Check whether using git or REST API
  if (!git) {
    remove = true
  }
  // Fetch URL does not match
  else if (
    !fsHelper.directoryExistsSync(path.join(repositoryPath, '.git')) ||
    repositoryUrl !== (await git.tryGetFetchUrl())
  ) {
    remove = true
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
        core.debug(`Unable to delete '${lockPath}'. ${error.message}`)
      }
    }

    try {
      // Checkout detached HEAD
      if (!(await git.isDetached())) {
        await git.checkoutDetach()
      }

      // Remove all refs/heads/*
      let branches = await git.branchList(false)
      for (const branch of branches) {
        await git.branchDelete(false, branch)
      }

      // Remove all refs/remotes/origin/* to avoid conflicts
      branches = await git.branchList(true)
      for (const branch of branches) {
        await git.branchDelete(true, branch)
      }

      // Clean
      if (clean) {
        if (!(await git.tryClean())) {
          core.debug(
            `The clean command failed. This might be caused by: 1) path too long, 2) permission issue, or 3) file in use. For futher investigation, manually run 'git clean -ffdx' on the directory '${repositoryPath}'.`
          )
          remove = true
        } else if (!(await git.tryReset())) {
          remove = true
        }

        if (remove) {
          core.warning(
            `Unable to clean or reset the repository. The repository will be recreated instead.`
          )
        }
      }
    } catch (error) {
      core.warning(
        `Unable to prepare the existing repository. The repository will be recreated instead.`
      )
      remove = true
    }
  }

  if (remove) {
    // Delete the contents of the directory. Don't delete the directory itself
    // since it might be the current working directory.
    core.info(`Deleting the contents of '${repositoryPath}'`)
    for (const file of await fs.promises.readdir(repositoryPath)) {
      await io.rmRF(path.join(repositoryPath, file))
    }
  }
}

async function configureAuthToken(
  git: IGitCommandManager,
  authToken: string
): Promise<void> {
  // Configure a placeholder value. This approach avoids the credential being captured
  // by process creation audit events, which are commonly logged. For more information,
  // refer to https://docs.microsoft.com/en-us/windows-server/identity/ad-ds/manage/component-updates/command-line-process-auditing
  const placeholder = `AUTHORIZATION: basic ***`
  await git.config(extraHeaderKey, placeholder)

  // Determine the basic credential value
  const basicCredential = Buffer.from(
    `x-access-token:${authToken}`,
    'utf8'
  ).toString('base64')
  core.setSecret(basicCredential)

  // Replace the value in the config file
  const configPath = path.join(git.getWorkingDirectory(), '.git', 'config')
  let content = (await fs.promises.readFile(configPath)).toString()
  const placeholderIndex = content.indexOf(placeholder)
  if (
    placeholderIndex < 0 ||
    placeholderIndex != content.lastIndexOf(placeholder)
  ) {
    throw new Error('Unable to replace auth placeholder in .git/config')
  }
  content = content.replace(
    placeholder,
    `AUTHORIZATION: basic ${basicCredential}`
  )
  await fs.promises.writeFile(configPath, content)
}

async function configureSsh(
  git: IGitCommandManager,
  settings: ISourceSettings
): promise<void> {
  if (!settings.sshKey) {
    return
  }

  const runnerTemp = process.env['RUNNER_TEMP'] || ''
  assert.ok(runnerTemp, 'RUNNER_TEMP is not defined')
  const uniqueId = uuid()
  const keyPath = path.join(runnerTemp, uniqueId)
}

async function removeGitConfig(
  git: IGitCommandManager,
  configKey: string
): Promise<void> {
  if (
    (await git.configExists(configKey)) &&
    !(await git.tryConfigUnset(configKey))
  ) {
    // Load the config contents
    core.warning(`Failed to remove '${configKey}' from the git config`)
  }
}
