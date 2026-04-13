# Exec-Plan Parsing Guide

How to extract feature data from exec-plan documents.

## Exec-plan format

Exec-plans follow the structure defined in `docs/exec-plans/plan-template.md` (project-specific). They contain one or more features, each with structured subsections describing what to build and how to verify it.

## Document structure

```markdown
# Plan Title

## Authority references
Reference documents that define correct behavior, terminology, or interfaces.

## Implementation sequence
Ordered list of features with dependency notes.

## Feature 1: {Name}

### User story
As a <role>, I want <capability>, so that <outcome>.

### Specification
Detailed technical specification of the feature.

### Deliverable standard
Concrete quality criteria. Each item is verifiable.

### Test scenarios
Specific test cases that must pass.

### Checklist
- [ ] Item 1
- [ ] Item 2

## Feature 2: {Name}
...
```

## Feature identification

Features are delimited by `## Feature N: {Name}` headings (level 2).

The `[feature-identifier]` argument matches by:

| Identifier type | Example              | Match rule                                        |
|-----------------|----------------------|---------------------------------------------------|
| Number          | `1`                  | Feature number from heading                       |
| Name substring  | `Playbook`           | Case-insensitive substring match on heading name  |
| Full heading    | `Feature 1: Playbook`| Exact match after stripping "Feature N: " prefix  |

If no identifier is given, list all features with their numbers and names, then ask the user to select.

## Extracting feature data

For the target feature, extract these subsections:

### User story
- Location: `### User story` under the feature heading
- Purpose: Describes who needs what and why
- Usage: Injected into Generator and Reviewer prompts for context

### Specification
- Location: `### Specification` under the feature heading
- Purpose: Technical requirements — what to build
- Usage: Primary input to the Generator. Also used by the Reviewer as the ground truth

### Deliverable standard
- Location: `### Deliverable standard` under the feature heading
- Purpose: Verifiable quality criteria — what "done" looks like
- Usage: The Reviewer checks each item. The advisory review references it. Phase 7 cross-references it against the implementation

### Test scenarios
- Location: `### Test scenarios` under the feature heading
- Purpose: Specific test cases that must pass
- Usage: The Reviewer verifies coverage. The Generator should implement tests for each scenario

### Checklist
- Location: `### Checklist` under the feature heading
- Purpose: Granular completion tracking
- Usage: Phase 7 marks items `[x]` as they are verified. This is the final completion signal

## Authority references

- Location: `## Authority references` (document-level, outside any feature)
- Purpose: External documents that define correct behavior, APIs, data models, terminology
- Usage: Included in all Generator and Reviewer prompts so the subagent can validate against authoritative sources
- Format: Typically a list of file paths or URLs with brief descriptions

## Implementation sequence

- Location: `## Implementation sequence` (document-level)
- Purpose: Dependency ordering — which features must be built first
- Usage: If the target feature depends on unfinished features, warn the user during Phase 1 (PARSE). The PLAN phase (Phase 2) should account for any prerequisites

## Handling missing subsections

Not every exec-plan has every subsection. Rules:

- **Missing user story**: Use the specification heading as a fallback. Note the absence in the summary.
- **Missing deliverable standard**: Use the specification and test scenarios as the quality bar. Warn the user that the bar is implicit.
- **Missing test scenarios**: Proceed, but the evaluation phase will have no ground-truth test coverage to check. The Reviewer should note this.
- **Missing checklist**: Phase 7 (DONE) will use the deliverable standard items instead.
- **Missing authority references**: Proceed without them. No injection into prompts.
- **Missing implementation sequence**: Assume features are independent. No dependency warnings.

## Parsing strategy

1. Read the entire file
2. Split on `## Feature \d+:` headings
3. For each feature block, split on `### ` headings to extract subsections
4. For the target feature, collect all subsection content as raw text
5. For document-level sections (authority references, implementation sequence), collect from the top of the file before the first feature heading
6. Present a structured summary to the user for confirmation
