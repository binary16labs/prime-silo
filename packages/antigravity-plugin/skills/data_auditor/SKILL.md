---
name: data-auditor
description: Performs data auditing and generation of move-analysis validations over Pypes executions.
---

# Data Auditor Skill

This skill allows an agent to audit stateless data pipelines defined by Pypes JSON execution contracts.
It extracts the agentic reasoning and planning logic previously bundled inside the Pypes execution engine, turning it into a portable skill.

## Capabilities

1. **Contract Analysis**: Analyze a `.json` Pypes execution contract.
2. **Move Analysis**: Evaluate historical data to determine statistically significant drift (move analysis thresholding).
3. **Execution Oversight**: Use the local Pypes environment to dry-run contracts and inspect the provenance.

## When to use

Use this skill when the user requests an audit of a dataset, wants to generate a new Pypes execution contract, or needs to debug a pipeline validation failure.

## Execution

- To dry-run, construct a Pypes execution contract in memory and run the local Pypes validators.
- Analyze the `ValidationResult` returned by the core engine.
- Report any threshold breaches or completeness issues to the user.
