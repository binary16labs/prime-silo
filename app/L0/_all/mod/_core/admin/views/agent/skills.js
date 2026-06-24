import * as sharedSkills from "/mod/_core/skillset/skills.js";

export async function loadAdminSkill(name) {
  const skillData = await sharedSkills.loadSkill({
    path: name
  });
  const loadedSkill = {
    __spaceAdminSkill: true,
    ...skillData,
    skillName: sharedSkills.normalizeSkillPath(name)
  };

  // Dynamically import JS helper if it exists in the same folder
  const skillName = skillData.path.split("/").pop();
  const helperPath = `${skillData.modulePath}/ext/skills/${skillData.path}/${skillName}.js`;
  try {
    const helper = await import(/* @vite-ignore */ helperPath);
    if (helper) {
      Object.assign(loadedSkill, helper);
    }
  } catch (_err) {
    // Ignore if the skill does not have a JS helper
  }

  loadedSkill.loadResponseText = sharedSkills.getSkillLoadResponseText(loadedSkill);
  sharedSkills.registerLoadedSkill(loadedSkill);
  return loadedSkill;
}

export function installAdminSkillRuntime() {
  const adminRuntime = {
    ...(globalThis.space.admin && typeof globalThis.space.admin === "object"
      ? globalThis.space.admin
      : {}),
    loadSkill: loadAdminSkill
  };
  const sharedRuntime = {
    ...(globalThis.space.skills && typeof globalThis.space.skills === "object"
      ? globalThis.space.skills
      : {}),
    load: loadAdminSkill
  };

  globalThis.space.admin = adminRuntime;
  globalThis.space.skills = sharedRuntime;

  return {
    admin: adminRuntime,
    skills: sharedRuntime
  };
}
