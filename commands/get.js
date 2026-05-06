import {
  formatAllowedValues,
  getServerConfigParam,
  listServerConfigParams
} from "./lib/server_config.js";

function parseGetArgs(args) {
  if (args.length > 1) {
    throw new Error('Usage: node space get [param]');
  }

  return {
    paramName: args[0] || ""
  };
}

function printParamList(entries) {
  entries.forEach((entry, index) => {
    if (index > 0) {
      console.log("");
    }

    console.log(`${entry.name}=${entry.value}`);
    console.log(`type: ${entry.type}`);
    console.log(`description: ${entry.description}`);
    console.log(`allowed: ${formatAllowedValues(entry.allowed)}`);
  });
}

export const help = {
  name: "get",
  summary: "Read server config parameters from the project .env file.",
  usage: ["node space get", "node space get <param>"],
  description:
    "Reads server config parameters defined in commands/params.yaml. With no parameter it lists every available parameter, its current .env value, type, description, and allowed values.",
  arguments: [
    {
      name: "<param>",
      description: "Optional server config parameter name such as HOST or PORT."
    }
  ],
  examples: ["node space get", "node space get HOST", "node space get PORT"]
};

export async function execute(context) {
  const { paramName } = parseGetArgs(context.args);

  if (paramName) {
    const entry = await getServerConfigParam(context.projectRoot, context.commandsDir, paramName);
    console.log(`${entry.name}=${entry.value}`);
    return 0;
  }

  const entries = await listServerConfigParams(context.projectRoot, context.commandsDir);
  printParamList(entries);
  return 0;
}
