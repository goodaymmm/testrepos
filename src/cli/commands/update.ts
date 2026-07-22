import {
  formatUpdateChannelSet,
  formatUpdateChannelView,
  setUpdateChannel,
  showUpdateChannel,
  type SetUpdateChannelOptions
} from "../../update/channel.js";
import {
  applyDownloadedUpdate,
  checkForUpdate,
  downloadUpdate,
  formatUpdateApply,
  formatUpdateCheck,
  formatUpdateDownload,
  rollbackUpdate,
  type UpdateApplyOptions,
  type UpdateDependencies,
  type UpdateNetworkOptions
} from "../../update/downloader.js";

export async function updateChannelShowCommand(projectRoot: string): Promise<string> {
  return formatUpdateChannelView(await showUpdateChannel(projectRoot));
}

export async function updateChannelSetCommand(
  projectRoot: string,
  channel: string,
  options: Omit<SetUpdateChannelOptions, "channel">
): Promise<string> {
  return formatUpdateChannelSet(await setUpdateChannel(projectRoot, {
    channel,
    ...options
  }));
}

export async function updateCheckCommand(
  projectRoot: string,
  currentVersion: string,
  options: UpdateNetworkOptions,
  deps: UpdateDependencies = {}
): Promise<string> {
  return formatUpdateCheck(
    await checkForUpdate(projectRoot, currentVersion, options, deps)
  );
}

export async function updateDownloadCommand(
  projectRoot: string,
  version: string,
  options: UpdateNetworkOptions,
  deps: UpdateDependencies = {}
): Promise<string> {
  return formatUpdateDownload(
    await downloadUpdate(projectRoot, version, options, deps)
  );
}

export async function updateApplyCommand(
  projectRoot: string,
  currentVersion: string,
  downloadId: string,
  options: UpdateApplyOptions,
  deps: UpdateDependencies = {}
): Promise<string> {
  return formatUpdateApply(
    await applyDownloadedUpdate(
      projectRoot,
      currentVersion,
      downloadId,
      options,
      deps
    )
  );
}

export async function updateRollbackCommand(
  projectRoot: string,
  currentVersion: string,
  version: string,
  options: UpdateApplyOptions,
  deps: UpdateDependencies = {}
): Promise<string> {
  return formatUpdateApply(
    await rollbackUpdate(projectRoot, currentVersion, version, options, deps)
  );
}
