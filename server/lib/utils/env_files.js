import fs from "node:fs";
import path from "node:path";

const DOT_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function parseDotEnvValue(rawValue) {
  const trimmedValue = String(rawValue || "").trim();
  if (!trimmedValue) {
    return "";
  }

  const firstChar = trimmedValue[0];
  const lastChar = trimmedValue[trimmedValue.length - 1];

  if (firstChar === '"' && lastChar === '"') {
    try {
      return JSON.parse(trimmedValue);
    } catch {
      return trimmedValue.slice(1, -1);
    }
  }

  if (firstChar === "'" && lastChar === "'") {
    return trimmedValue.slice(1, -1);
  }

  return trimmedValue;
}

function parseDotEnvLine(rawLine) {
  const sourceLine = String(rawLine || "");
  const trimmedLine = sourceLine.trim();

  if (!trimmedLine || trimmedLine.startsWith("#")) {
    return null;
  }

  const match = sourceLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u);
  if (!match) {
    return null;
  }

  return {
    key: match[1],
    rawValue: match[2] || ""
  };
}

function parseDotEnvText(sourceText) {
  const values = {};

  String(sourceText || "")
    .split(/\r?\n/u)
    .forEach((rawLine) => {
      const parsedLine = parseDotEnvLine(rawLine);
      if (!parsedLine || Object.prototype.hasOwnProperty.call(values, parsedLine.key)) {
        return;
      }

      values[parsedLine.key] = parseDotEnvValue(parsedLine.rawValue);
    });

  return values;
}

function formatDotEnvValue(rawValue) {
  const value = String(rawValue ?? "");

  if (!value) {
    return '""';
  }

  if (/^[A-Za-z0-9._/@:+-]+$/u.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function readDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return parseDotEnvText(fs.readFileSync(filePath, "utf8"));
}

function loadDotEnvFile(filePath, env = process.env) {
  const values = readDotEnvFile(filePath);

  Object.entries(values).forEach(([key, value]) => {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      return;
    }

    env[key] = value;
  });
}

function getProjectEnvFilePath(projectRoot) {
  return path.join(projectRoot, ".env");
}

function getProjectEnvLocalFilePath(projectRoot) {
  return path.join(projectRoot, ".env.local");
}

function loadProjectEnvFiles(projectRoot, env = process.env) {
  loadDotEnvFile(getProjectEnvFilePath(projectRoot), env);
  loadDotEnvFile(getProjectEnvLocalFilePath(projectRoot), env);
}

function writeDotEnvValue(filePath, key, rawValue) {
  if (!DOT_ENV_KEY_PATTERN.test(String(key || ""))) {
    throw new Error(`Invalid .env key: ${key}`);
  }

  const nextLine = `${key}=${formatDotEnvValue(rawValue)}`;
  const sourceText = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const lines = sourceText ? sourceText.split(/\r?\n/u) : [];

  if (lines.length && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const nextLines = [];
  let replaced = false;

  lines.forEach((line) => {
    const parsedLine = parseDotEnvLine(line);
    if (!parsedLine || parsedLine.key !== key) {
      nextLines.push(line);
      return;
    }

    if (!replaced) {
      nextLines.push(nextLine);
      replaced = true;
    }
  });

  if (!replaced) {
    nextLines.push(nextLine);
  }

  fs.writeFileSync(filePath, `${nextLines.join("\n")}\n`, "utf8");
}

export {
  formatDotEnvValue,
  getProjectEnvFilePath,
  getProjectEnvLocalFilePath,
  loadDotEnvFile,
  loadProjectEnvFiles,
  parseDotEnvText,
  parseDotEnvValue,
  readDotEnvFile,
  writeDotEnvValue
};
