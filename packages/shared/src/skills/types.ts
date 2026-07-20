//
// Agent Skills — the reusable capability rail (twin of Agent Toolkits).
// A "skill" is curated content injected into a deployed agent. Unlike
// integrations it carries NO secret, so the content is bundled in this
// package (no broker, no fetch); the manifest a deploy writes selects
// skills by id only.

/** Curated skills shipped with the client. Grows over time. */
export type SkillId = 'code-review' | 'resolve-conflicts';

/** Delivery rails, twin of IntegrationDelivery's mcp/cliEnv. */
export type SkillRail = 'skillFile' | 'instruction';

/** `skillFile` payload — a Claude-Code SKILL.md bundle (body + optional files). */
export interface SkillFileDelivery {
  /** The SKILL.md markdown body (WITHOUT frontmatter — frontmatter is generated
   *  at materialize time with `name` set to the namespaced skill id `codeam-<id>` and
   *  `description` from the skill definition). */
  body: string;
  /** Extra files written alongside SKILL.md: relative path → file contents. */
  files?: Record<string, string>;
}

export interface SkillDelivery {
  skillFile?: SkillFileDelivery;
  /** Agent-agnostic instruction body, prepended to the composed prompt by the
   *  backend for agents that do not get the skillFile rail. */
  instruction?: { body: string };
}

export interface SkillDefinition {
  id: SkillId;
  name: string;
  /** One-line; becomes the SKILL.md frontmatter `description` (progressive
   *  disclosure — this is what sits in the model's context until invoked). */
  description: string;
  /** MVP: all curated. 'user' is added with the library fast-follow. */
  source: 'curated';
  delivery: SkillDelivery;
}

/** What a deploy writes to `~/.codeam/skills.json` — ids only, never content. */
export interface SkillsManifestEntry {
  id: SkillId;
}
export interface SkillsManifest {
  skills: SkillsManifestEntry[];
}
