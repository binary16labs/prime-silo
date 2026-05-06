import {
  findParamSpec,
  formatAllowedValues,
  getStoredParamValue,
  loadParamSpecs,
  normalizeParamName,
  validateConfigValue
} from "../../server/lib/utils/runtime_params.js";
import { getProjectEnvFilePath, writeDotEnvValue } from "../../server/lib/utils/env_files.js";

async function listServerConfigParams(projectRoot, commandsDir) {
  void commandsDir;
  const paramSpecs = await loadParamSpecs(projectRoot);

  return paramSpecs.map((spec) => ({
    ...spec,
    value: getStoredParamValue(projectRoot, spec.name)
  }));
}

async function getServerConfigParam(projectRoot, commandsDir, rawParamName) {
  void commandsDir;
  const spec = await findParamSpec(projectRoot, rawParamName);

  return {
    ...spec,
    value: getStoredParamValue(projectRoot, spec.name)
  };
}

async function setServerConfigParam(projectRoot, commandsDir, rawParamName, rawValue) {
  void commandsDir;
  const spec = await findParamSpec(projectRoot, rawParamName);
  const value = validateConfigValue(spec, rawValue);

  writeDotEnvValue(getProjectEnvFilePath(projectRoot), spec.name, value);

  return {
    ...spec,
    value
  };
}

export {
  formatAllowedValues,
  getServerConfigParam,
  listServerConfigParams,
  normalizeParamName,
  setServerConfigParam
};
