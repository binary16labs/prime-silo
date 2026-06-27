---
name: prime-silo-setup
description: Initializes a new repository or workspace utilizing the Prime-Silo framework.
---

# Prime-Silo Setup Skill

Use this skill when a user asks you to set up a new project or repository using Prime-Silo.

## Instructions

1.  **Locate Workspace**: Identify where the user wants to initialize the project.
2.  **Initialize Manifests Directory**: Create the required Prime-Silo structure:
    -   `config/` for `prime-silo.config.json`
    -   `L1/group/manifests/` for deterministic workflows
    -   `L2/user/manifests/` for personal workflows
    -   `agent_sandbox/views/`, `agent_sandbox/drafts/` for agent write access
3.  **Create Initial Configuration**: Generate a default `prime-silo.config.json`.
4.  **Inform User**: Remind the user that agents can only write to the `agent_sandbox/` directory without human signature approval.
